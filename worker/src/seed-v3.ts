/**
 * Seed the v3 board: seal a window of spans, then file claims that are really false next to claims
 * that are really true, with nothing on-chain to tell them apart.
 *
 * Usage:
 *   node src/seed-v3.ts --chain 3 --plan                  read-only: spans, subjects, what would be filed
 *   node src/seed-v3.ts --chain 3 --execute [--borrower 0x…]
 *   MARKET_KEY=0x…  the claimant wallet (defaults to the deployer key)
 *
 * WHAT GETS FILED
 * ---------------
 *   lie        EmptySet  "X was never liquidated here" -- X was, inside the range.         24h window
 *   bounty     EmptySet  the same kind of lie, left open for a week for anyone to hunt.     7d window
 *   omission   CompleteSet listing all but one of X's liquidations in the range.            24h window
 *   complete   CompleteSet listing every one of X's liquidations. True. Stands.             1h window
 *   clean      EmptySet  about a real Aave borrower with no liquidation in the range. True. 1h window
 *   borrower   EmptySet  about a wallet this project controls, bonded to cover a desk loan. 15m window
 *
 * Every subject comes from an exhaustive, two-endpoint scan of the claimed range, so "true" means
 * two independent public nodes each listed every matching log and agreed on the count. A claim is
 * only as true as that scan, and the scan is recorded next to it.
 *
 * Every member of a CompleteSet is rebuilt from a public node and checked against the mirror's own
 * root with `tryVerify` before the assertion is sent, so a bad path fails here, not on-chain.
 *
 * The record goes to contracts/test/fixtures/board-v3-<chain>.json: every claim, its role, and for a
 * lie the transaction that makes it false. Anyone can check the board was not marked in secret.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  CC_RPC,
  MIRROR,
  MIRROR_ABI,
  EXPLORER,
  CHAINS,
  LOG_RPCS,
  VENUES,
  SEPOLIA_VENUES,
  AAVE_V3_POOL,
  TOPIC_BORROW,
  privateKey,
  getLogsAdaptive,
  type Venue,
} from './config.ts';
import { receiptLogIndex, verifiedPathFor, topicsFor, pad32 } from './evidence.ts';

const REGISTRY_ABI = [
  'function assertAbsence(uint256[] spanIds, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 window) payable returns (uint256)',
  'function assertComplete(uint256[] spanIds, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 window, (uint64 height, uint32 logIndex, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings)[] proofs) payable returns (uint256)',
  'function claimCount() view returns (uint256)',
  'event AbsenceAsserted(uint256 indexed claimId, address indexed claimant, uint8 kind, uint256[] spanIds, address venue, bytes32 topic0, bytes32 subject, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
];
const SPAN_ABI = [
  'function MAX_SEAL_WINDOW() view returns (uint64)',
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns ((uint64 chainKey, uint64 fromBlock, uint64 toBlock))',
  'function sealSpan(uint64 chainKey, uint64 fromBlock, uint64 toBlock) returns (uint256)',
];

/** How many full seal windows a board spans: 5 x 131,072 = 655,360 mainnet blocks (91 days). */
const SPANS: Record<number, number> = { 3: 5, 1: 2 };

type Role = 'lie' | 'bounty' | 'omission' | 'complete' | 'clean' | 'borrower';
const WINDOW: Record<Role, number> = { lie: 24 * 3600, bounty: 7 * 24 * 3600, omission: 24 * 3600, complete: 3600, clean: 3600, borrower: 15 * 60 };
const BOND: Record<Role, string> = { lie: '2', bounty: '3', omission: '2', complete: '1', clean: '0.5', borrower: '4' };

type Log = { blockNumber: number; transactionHash: string; transactionIndex: number; index: number; topics: string[] };
type Planned = {
  role: Role;
  kind: 0 | 1;
  venue: Venue;
  subject: string; // 20-byte address
  logs: Log[]; // every matching log for (venue, event, subject) in range, per the exhaustive scan
  listed?: Log[]; // CompleteSet members
  omitted?: Log; // the member left out of an omission
};

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendWithRetry<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const msg = String((e as Error).message);
      const transient = /nonce|replacement|underpriced|timeout|ECONNRESET|503|502|429/i.test(msg);
      if (!transient || attempt >= 5) throw e;
      console.log(`    … ${what}: ${msg.slice(0, 80)} — retrying (${attempt})`);
      await sleep(4000 * attempt);
    }
  }
}

async function main() {
  const chain = Number(get('--chain') ?? 3);
  const execute = process.argv.includes('--execute');
  const borrower = get('--borrower');
  if (!CHAINS[chain]) throw new Error(`unknown --chain ${chain}`);
  if (!execute && !process.argv.includes('--plan')) throw new Error('pass --plan (read-only) or --execute');

  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const registryAddr: string = d.contracts.AbsenceRegistryV3;
  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(process.env.MARKET_KEY ?? privateKey(), cc);
  const mirror = new Contract(MIRROR, [...MIRROR_ABI, ...SPAN_ABI], wallet);
  const registry = new Contract(registryAddr, REGISTRY_ABI, wallet);
  const out = new URL(`../../contracts/test/fixtures/board-v3-${CHAINS[chain].slug}.json`, import.meta.url);
  if (execute && existsSync(out)) {
    const prior = JSON.parse(readFileSync(out, 'utf8'));
    if (prior.registry?.toLowerCase() === registryAddr.toLowerCase() && prior.claims?.length && !process.argv.includes('--append')) {
      throw new Error(`${out.pathname} already records ${prior.claims.length} claims on this registry; pass --append to file more`);
    }
  }

  // ---- the window ------------------------------------------------------------------------------
  const maxWindow = Number(await mirror.MAX_SEAL_WINDOW());
  const highest = Number(await mirror.highestMirrored(chain));
  const len = SPANS[chain] * maxWindow;
  // End at the top of the unbroken run under the head, so the claims are as fresh as the archive.
  let top = highest;
  const lowest = Number(await mirror.lowestMirrored(chain));
  {
    // Walk down past any isolated window above a gap: the run must contain [top-len+1, top].
    const probe = Number(await mirror.contiguousFrom(chain, top - len + 1, len));
    if (probe !== len) {
      const run = Number(await mirror.contiguousFrom(chain, lowest, 2n ** 40n));
      top = lowest + run - 1;
    }
  }
  const spanFrom = top - len + 1;
  const held = Number(await mirror.contiguousFrom(chain, spanFrom, len));
  if (held !== len) throw new Error(`archive is not contiguous over ${spanFrom}..${top}: first gap at ${spanFrom + held}`);

  console.log(`seed v3 board — ${CHAINS[chain].name}`);
  console.log('  registry :', registryAddr);
  console.log('  claimant :', wallet.address, `(${formatEther(await cc.getBalance(wallet.address))} tCTC)`);
  console.log(`  window   : ${spanFrom.toLocaleString()}..${top.toLocaleString()} = ${len.toLocaleString()} blocks ≈ ${((len * CHAINS[chain].blockSeconds) / 86400).toFixed(1)} days, ${SPANS[chain]} spans`);
  console.log(`  mode     : ${execute ? 'EXECUTE' : 'plan only'}`);

  // ---- spans: reuse any already sealed with these exact bounds -----------------------------------
  const wanted = Array.from({ length: SPANS[chain] }, (_, i) => [spanFrom + i * maxWindow, spanFrom + (i + 1) * maxWindow - 1]);
  const existing = new Map<string, number>();
  const nSpans = Number(await mirror.spanCount());
  for (let i = 0; i < nSpans; i++) {
    const sp = await mirror.spanOf(i);
    existing.set(`${sp.chainKey}:${sp.fromBlock}:${sp.toBlock}`, i);
  }
  const spanIds: number[] = [];
  for (const [a, b] of wanted) {
    const have = existing.get(`${chain}:${a}:${b}`);
    if (have !== undefined) {
      spanIds.push(have);
      console.log(`  = span ${have}: ${a}..${b}`);
    } else if (execute) {
      const rc = await sendWithRetry('seal', async () => (await mirror.sealSpan(chain, a, b)).wait());
      const ev = rc.logs.map((l: any) => { try { return mirror.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === 'SpanSealed');
      const id = ev ? Number(ev.args.spanId) : Number(await mirror.spanCount()) - 1;
      spanIds.push(id);
      console.log(`  + span ${id}: ${a}..${b}  ${Number(rc.gasUsed).toLocaleString()} gas  ${EXPLORER}/tx/${rc.hash}`);
    } else {
      console.log(`  ~ would seal ${a}..${b}`);
    }
  }

  // ---- the exhaustive scans ----------------------------------------------------------------------
  const venues = chain === 3 ? VENUES.filter((v) => v.key !== 'aave-repays') : SEPOLIA_VENUES;
  const scans = new Map<string, Log[]>();
  for (const v of venues) {
    const logs = (await getLogsAdaptive(LOG_RPCS[chain], { address: v.address, topics: [v.topic0] }, spanFrom, top, {
      exhaustive: true,
      onProgress: (m) => process.stdout.write(`\r  ${m.padEnd(90)}`),
    })) as Log[];
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
    scans.set(v.key, logs);
    const subjects = new Set(logs.map((l) => l.topics[v.subjectTopic]));
    console.log(`  ${v.label.padEnd(36)} ${String(logs.length).padStart(6)} logs, ${subjects.size} subjects — two endpoints agreed`);
  }

  const bySubject = (v: Venue) => {
    const m = new Map<string, Log[]>();
    for (const l of scans.get(v.key)!) {
      const s = '0x' + l.topics[v.subjectTopic].slice(26);
      m.set(s, [...(m.get(s) ?? []), l]);
    }
    return m;
  };

  const plan: Planned[] = [];
  const used = new Set<string>();
  const take = (v: Venue, role: Role, count: number, pick: (logs: Log[]) => boolean) => {
    const cands = [...bySubject(v).entries()].filter(([s, logs]) => !used.has(s) && pick(logs));
    // Spread across the range rather than bunching at one end.
    cands.sort((a, b) => a[1][0].blockNumber - b[1][0].blockNumber);
    const step = Math.max(1, Math.floor(cands.length / Math.max(1, count)));
    for (let i = 0, k = 0; i < cands.length && k < count; i += step, k++) {
      const [subject, logs] = cands[i];
      used.add(subject);
      const entry: Planned = { role, kind: role === 'omission' || role === 'complete' ? 1 : 0, venue: v, subject, logs };
      if (role === 'omission') {
        const omitIdx = Math.floor(logs.length / 2);
        entry.omitted = logs[omitIdx];
        entry.listed = logs.filter((_, j) => j !== omitIdx);
      }
      if (role === 'complete') entry.listed = logs;
      plan.push(entry);
    }
  };

  if (chain === 3) {
    const aave = VENUES.find((v) => v.key === 'aave-liquidations')!;
    const morpho = VENUES.find((v) => v.key === 'morpho-liquidates')!;
    const compound = VENUES.find((v) => v.key === 'compound-absorbs')!;
    take(aave, 'lie', 3, (l) => l.length === 1);
    take(morpho, 'lie', 2, (l) => l.length === 1);
    take(compound, 'lie', 1, (l) => l.length === 1);
    take(aave, 'bounty', 2, (l) => l.length === 1);
    take(morpho, 'bounty', 1, () => true);
    take(compound, 'bounty', 1, () => true);
    take(aave, 'omission', 1, (l) => l.length >= 3 && l.length <= 8);
    take(morpho, 'omission', 1, (l) => l.length >= 2 && l.length <= 8);
    take(aave, 'complete', 1, (l) => l.length >= 2 && l.length <= 6);
    take(compound, 'complete', 1, (l) => l.length >= 2 && l.length <= 6);

    // Clean: real Aave borrowers in the range whom neither endpoint saw liquidated in it.
    const borrows = (await getLogsAdaptive(LOG_RPCS[chain], { address: AAVE_V3_POOL, topics: [TOPIC_BORROW] }, top - 50_000, top, { exhaustive: true })) as Log[];
    const liquidated = new Set(scans.get(aave.key)!.map((l) => l.topics[3].toLowerCase()));
    const cleanSubjects = [...new Set(borrows.map((l) => l.topics[2].toLowerCase()))].filter((t) => !liquidated.has(t)).slice(0, 6);
    for (const t of cleanSubjects) plan.push({ role: 'clean', kind: 0, venue: aave, subject: '0x' + t.slice(26), logs: [] });
    console.log(`  clean    : ${cleanSubjects.length} real Aave borrowers (Borrow in the last 50,000 blocks) with no LiquidationCall in the whole window`);

    if (borrower) plan.push({ role: 'borrower', kind: 0, venue: aave, subject: borrower.toLowerCase(), logs: scans.get(aave.key)!.filter((l) => l.topics[3].toLowerCase() === pad32(borrower)) });
  } else {
    const aaveSep = SEPOLIA_VENUES[0];
    take(aaveSep, 'lie', 2, (l) => l.length >= 1);
    take(aaveSep, 'complete', 1, (l) => l.length >= 2 && l.length <= 8);
  }

  // Refuse to file a "true" claim that the scan says is false, or a lie with nothing to refute it.
  for (const p of plan) {
    const truthful = p.role === 'clean' || p.role === 'borrower' || p.role === 'complete';
    if (p.kind === 0 && truthful && p.logs.length !== 0) throw new Error(`${p.role} ${p.subject} has ${p.logs.length} matching logs: not clean`);
    if (p.kind === 0 && !truthful && p.logs.length === 0) throw new Error(`${p.role} ${p.subject} has no counterexample`);
    if (p.listed && p.listed.length > 32) throw new Error(`${p.subject}: ${p.listed.length} members exceeds MAX_MEMBERS`);
  }

  console.log(`\n  plan: ${plan.length} claims`);
  for (const p of plan) {
    const extra = p.role === 'omission' ? `lists ${p.listed!.length} of ${p.logs.length}, omits ${p.omitted!.transactionHash.slice(0, 12)}…` : p.kind === 1 ? `lists all ${p.listed!.length}` : p.logs.length ? `refuted by ${p.logs[0].transactionHash.slice(0, 12)}… @${p.logs[0].blockNumber}` : 'no matching log';
    console.log(`    ${p.role.padEnd(9)} ${p.kind ? 'CompleteSet' : 'EmptySet   '} ${p.venue.label.padEnd(36)} ${p.subject}  ${BOND[p.role]} tCTC  ${extra}`);
  }
  const total = plan.reduce((a, p) => a + Number(BOND[p.role]), 0);
  console.log(`  bonds: ${total} tCTC`);
  if (!execute) return;
  if (spanIds.length !== SPANS[chain]) throw new Error('spans missing');

  // ---- file --------------------------------------------------------------------------------------
  const record: any = existsSync(out) && process.argv.includes('--append') ? JSON.parse(readFileSync(out, 'utf8')) : { claims: [] };
  record.registry = registryAddr;
  record.chainKey = chain;
  record.spanIds = spanIds;
  record.spanFrom = spanFrom;
  record.spanTo = top;
  record.scannedWith = LOG_RPCS[chain].map((u) => new URL(u).host);

  for (const p of plan) {
    const subject = pad32(p.subject);
    const bond = parseEther(BOND[p.role]);
    let rc: any;
    let members: any[] | undefined;
    if (p.kind === 0) {
      rc = await sendWithRetry('assertAbsence', async () =>
        (await registry.assertAbsence(spanIds, p.venue.address, p.venue.topic0, subject, p.venue.subjectTopic, WINDOW[p.role], { value: bond })).wait(),
      );
    } else {
      const proofs: { height: number; logIndex: number; encodedTransaction: string; siblings: { hash: string; isLeft: boolean }[] }[] = [];
      members = [];
      for (const l of p.listed!) {
        const logIndex = await receiptLogIndex(chain, l);
        if (logIndex < 0) throw new Error(`member ${l.transactionHash} failed on-chain`);
        const path = await verifiedPathFor(mirror, chain, l.blockNumber, l.transactionHash);
        proofs.push({ height: l.blockNumber, logIndex, encodedTransaction: path.txBytes, siblings: path.siblings });
        members.push({ height: l.blockNumber, txIndex: path.index, logIndex, txHash: l.transactionHash });
      }
      // Registry order is (height, txIndex, logIndex).
      const order = proofs.map((_, i) => i).sort((a, b) => members![a].height - members![b].height || members![a].txIndex - members![b].txIndex || members![a].logIndex - members![b].logIndex);
      const sortedProofs = order.map((i) => proofs[i]);
      members = order.map((i) => members![i]);
      rc = await sendWithRetry('assertComplete', async () =>
        (await registry.assertComplete(spanIds, p.venue.address, p.venue.topic0, subject, p.venue.subjectTopic, WINDOW[p.role], sortedProofs, { value: bond })).wait(),
      );
    }
    const ev = rc.logs.map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === 'AbsenceAsserted');
    const claimId = Number(ev.args.claimId);
    const entry: any = {
      claimId,
      role: p.role,
      kind: p.kind === 0 ? 'EmptySet' : 'CompleteSet',
      venue: p.venue.address,
      venueLabel: p.venue.label,
      topic0: p.venue.topic0,
      subjectTopic: p.venue.subjectTopic,
      subject: p.subject,
      bond: bond.toString(),
      windowSeconds: WINDOW[p.role],
      openUntil: Number(ev.args.openUntil),
      assertTx: rc.hash,
      gasUsed: Number(rc.gasUsed),
      matchingLogsInRange: p.logs.length,
    };
    if (p.kind === 0 && p.logs.length) entry.counterexample = { txHash: p.logs[0].transactionHash, block: p.logs[0].blockNumber };
    if (members) entry.members = members;
    if (p.omitted) entry.omitted = { txHash: p.omitted.transactionHash, block: p.omitted.blockNumber };
    record.claims.push(entry);
    writeFileSync(out, JSON.stringify(record, null, 1) + '\n'); // after every claim: a crash loses nothing
    console.log(`  #${String(claimId).padStart(3)} ${p.role.padEnd(9)} ${Number(rc.gasUsed).toLocaleString().padStart(10)} gas  ${EXPLORER}/tx/${rc.hash}`);
  }
  console.log(`\n  recorded ${record.claims.length} claims in ${out.pathname}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
