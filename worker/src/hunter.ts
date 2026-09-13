/**
 * The hunter: a searcher that refutes false claims on the absence registry without a human.
 *
 * Usage:
 *   node src/hunter.ts [--once] [--interval 60] [--min-age-hours 0] [--only 3,7] [--registry <address>] [--dry-run]
 *   node src/hunter.ts --audit     scan every settled claim again, read-only, and record what is found
 *   HUNTER_KEY=0x… to run as a separate actor (recommended; see below)
 *
 * WHY THIS IS THE LOAD-BEARING PART OF THE MARKET
 * -----------------------------------------------
 * `Standing` means "nobody refuted this while unrecoverable bond was at risk". That is only worth
 * anything if somebody was actually looking. The hunter is the somebody, and its silence -- scanned,
 * corroborated, nothing found -- is exactly the economic fact the registry records.
 *
 * TWO KINDS OF CLAIM
 * ------------------
 *   EmptySet     scan the claim's range for any successful matching log; one is enough to refute.
 *   CompleteSet  enumerate every matching log in the range, subtract the members the claimant listed
 *                (recovered from the registry's own `MembersListed` event, so nothing is trusted from
 *                anyone), and refute with any log left over.
 *
 * A log's position is identified the way the registry identifies it: (height, txIndex, logIndex),
 * where logIndex is the log's position *inside its transaction's receipt* -- not the block-level log
 * index `eth_getLogs` returns. Confusing the two would make every omission refutation revert with
 * `NoContradictionFound`, so the receipt is fetched and the position computed.
 *
 * A negative is never believed on one endpoint's word. `getLogsAdaptive` requires two endpoints to
 * cover the whole range before a scan counts as silence; a scan that cannot be corroborated is
 * reported as "could not scan", which is not the same thing and is never logged as silence.
 *
 * Refutation rebuilds the block from a public node rather than asking the prover, because the block
 * is already mirrored and refutation must keep working when the proving service does not.
 *
 * --min-age-hours makes this a deliberately slow searcher: it leaves claims younger than N hours alone.
 * That is how the board keeps live bounties for a human to hunt from the browser while still proving
 * that an automated searcher closes every lie eventually. It is stated on the board, not hidden.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, EXPLORER, CHAINS, LOG_RPCS, VENUES, REGISTRY_DEPLOY_BLOCK, privateKey, getLogsAdaptive } from './config.ts';
import { receiptLogIndex, verifiedPathFor, topicsFor, type Member } from './evidence.ts';

const REGISTRY_V3_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function commitmentFor(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32, address) pure returns (bytes32)',
  'function commitmentForComplete(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32, address) pure returns (bytes32)',
  'function commitRefutation(bytes32)',
  'function revealRefutation(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32)',
  'function revealOmission(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32)',
  'function finalize(uint256)',
  'function enforceableLoss(uint256) view returns (uint256)',
  'event MembersListed(uint256 indexed claimId, (uint64 height, uint64 txIndex, uint32 logIndex)[] members)',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 paidToRefuter, uint256 burned)',
  'event AbsenceAsserted(uint256 indexed claimId, address indexed claimant, uint8 kind, uint256[] spanIds, address venue, bytes32 topic0, bytes32 subject, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


type Claim = {
  id: number;
  assertedAt: number;
  chainKey: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  spanFrom: number;
  spanTo: number;
  openUntil: number;
  kind: 0 | 1;
  members: number;
};

function registryAddress(): string {
  const i = process.argv.indexOf('--registry');
  if (i >= 0) return process.argv[i + 1];
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const a = d.contracts.AbsenceRegistryV3;
  if (!a) throw new Error('AbsenceRegistryV3 not in deployments.json');
  return a;
}

/** claimId -> assertion timestamp, filled incrementally so a long-running hunter never rescans. */
const assertedAt = new Map<number, number>();
let scannedTo = REGISTRY_DEPLOY_BLOCK - 1;

async function assertionTimes(registry: Contract): Promise<Map<number, number>> {
  const cc = registry.runner!.provider!;
  const head = await cc.getBlockNumber();
  for (let from = scannedTo + 1; from <= head; from += 5_000) {
    const to = Math.min(from + 4_999, head);
    for (const ev of await registry.queryFilter(registry.filters.AbsenceAsserted(), from, to)) {
      const blk = await (ev as any).getBlock();
      assertedAt.set(Number((ev as any).args.claimId), blk.timestamp);
    }
    scannedTo = to;
  }
  return assertedAt;
}

async function openClaims(registry: Contract): Promise<Claim[]> {
  const n = Number(await registry.claimCount());
  const times = await assertionTimes(registry);
  const out: Claim[] = [];
  for (let i = 0; i < n; i++) {
    const c = await registry.claimOf(i);
    if (Number(c.status) !== 1) continue;
    out.push({
      id: i,
      assertedAt: times.get(i) ?? 0,
      chainKey: Number(c.chainKey),
      venue: c.venue,
      topic0: c.topic0,
      subject: c.subject,
      subjectTopic: Number(c.subjectTopic),
      spanFrom: Number(c.spanFrom),
      spanTo: Number(c.spanTo),
      openUntil: Number(c.openUntil),
      kind: Number(c.kind) as 0 | 1,
      members: Number(c.members),
    });
  }
  return out;
}

/** The member list exactly as asserted, from the registry's own event. */
async function membersOf(registry: Contract, claimId: number): Promise<Member[]> {
  const logs = await registry.queryFilter(registry.filters.MembersListed(claimId), REGISTRY_DEPLOY_BLOCK, 'latest');
  if (logs.length !== 1) throw new Error(`expected one MembersListed for claim ${claimId}, found ${logs.length}`);
  const parsed = registry.interface.parseLog(logs[0] as any)!;
  return (parsed.args.members as any[]).map((m) => ({ height: Number(m.height), txIndex: Number(m.txIndex), logIndex: Number(m.logIndex) }));
}

type Counterexample = { log: any; logIndex: number; members?: Member[] };

async function findCounterexample(registry: Contract, c: Claim): Promise<Counterexample | null> {
  // A CompleteSet hunt needs every matching log -- an endpoint that returned only the listed ones
  // would otherwise read as "nothing omitted" -- so it is exhaustive and corroborated.
  const logs = await getLogsAdaptive(LOG_RPCS[c.chainKey], { address: c.venue, topics: topicsFor(c.topic0, c.subjectTopic, c.subject) }, c.spanFrom, c.spanTo, {
    exhaustive: c.kind === 1,
  });

  if (c.kind === 0) {
    for (const log of logs) {
      const li = await receiptLogIndex(c.chainKey, log);
      if (li >= 0) return { log, logIndex: li };
    }
    return null;
  }

  const members = await membersOf(registry, c.id);
  const listed = new Set(members.map((m) => `${m.height}:${m.txIndex}:${m.logIndex}`));
  for (const log of logs) {
    const li = await receiptLogIndex(c.chainKey, log);
    if (li < 0) continue;
    const key = `${log.blockNumber}:${log.transactionIndex}:${li}`;
    if (!listed.has(key)) return { log, logIndex: li, members };
  }
  return null;
}

async function hunt(registry: Contract, mirror: Contract, dryRun: boolean, minAgeHours: number, only: Set<number> | null) {
  const claims = (await openClaims(registry)).filter((c) => !only || only.has(c.id));
  const now = Math.floor(Date.now() / 1000);
  console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${claims.length} open claim(s)`);

  for (const c of claims) {
    const label = `claim ${String(c.id).padStart(3)} ${c.kind === 0 ? 'EmptySet   ' : 'CompleteSet'} ${CHAINS[c.chainKey]?.slug ?? c.chainKey}`;
    if (now > c.openUntil) continue; // finalised below
    const ageH = (now - c.assertedAt) / 3600;
    if (ageH < minAgeHours) {
      console.log(`  ${label}  left for human hunters (asserted ${ageH.toFixed(1)}h ago, house hunter waits ${minAgeHours}h)`);
      continue;
    }

    let found: Counterexample | null;
    try {
      found = await findCounterexample(registry, c);
    } catch (e) {
      console.log(`  ${label}  ! COULD NOT SCAN — ${(e as Error).message.slice(0, 140)}`);
      console.log(`  ${label}    (this is not silence: the claim was not checked)`);
      continue;
    }

    if (!found) {
      console.log(`  ${label}  ${c.spanFrom}..${c.spanTo}  no counterexample, corroborated  (${c.openUntil - now}s left)`);
      continue;
    }

    const { log, logIndex } = found;
    console.log(`  ${label}  counterexample ${log.transactionHash.slice(0, 12)}… block ${log.blockNumber} tx ${log.transactionIndex} log ${logIndex}`);

    if (!(await mirror.isMirrored(c.chainKey, log.blockNumber))) {
      console.log(`  ${label}  ! block ${log.blockNumber} is not mirrored — notarise it first`);
      continue;
    }
    if (dryRun) {
      console.log(`  ${label}  (dry run: would commit and reveal)`);
      continue;
    }

    try {
      const { txBytes, siblings } = await verifiedPathFor(mirror, c.chainKey, log.blockNumber, log.transactionHash);
      const salt = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
      const me = await (registry.runner as Wallet).getAddress();

      const commitment =
        c.kind === 0
          ? await registry.commitmentFor(c.id, log.blockNumber, txBytes, siblings, salt, me)
          : await registry.commitmentForComplete(c.id, log.blockNumber, txBytes, siblings, logIndex, found.members!, salt, me);
      await (await registry.commitRefutation(commitment)).wait();

      const cc = registry.runner!.provider!;
      const start = await cc.getBlockNumber();
      while ((await cc.getBlockNumber()) < start + 2) await sleep(3000);

      const tx =
        c.kind === 0
          ? await registry.revealRefutation(c.id, log.blockNumber, txBytes, siblings, salt)
          : await registry.revealOmission(c.id, log.blockNumber, txBytes, siblings, logIndex, found.members!, salt);
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === 'AbsenceRefuted');
      const paid = ev ? Number(ev.args.paidToRefuter) / 1e18 : NaN;
      const burned = ev ? Number(ev.args.burned) / 1e18 : NaN;
      console.log(
        `  ${label}  REFUTED  ${Number(rc.gasUsed).toLocaleString()} gas  paid ${paid} tCTC  burned ${burned} tCTC  ${EXPLORER}/tx/${rc.hash}`,
      );
    } catch (e) {
      console.log(`  ${label}  ! refutation failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  // Anyone may finalise an expired claim; doing it here keeps the board readable.
  const n = Number(await registry.claimCount());
  for (let i = 0; i < n; i++) {
    if (only && !only.has(i)) continue;
    const c = await registry.claimOf(i);
    if (Number(c.status) === 1 && now > Number(c.openUntil)) {
      if (dryRun) continue;
      try {
        await (await registry.finalize(i)).wait();
        console.log(`  claim ${i} finalised → Standing (nobody refuted it)`);
      } catch (e) {
        console.log(`  claim ${i} finalise failed: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }
}

/**
 * Audit: re-scan every claim that has settled and record whether a counterexample exists today.
 * A Refuted claim should still have one; a Standing claim should not. Read-only -- nothing is sent --
 * and it is the evidence that "Standing" on this board was not merely "nobody was looking".
 */
async function audit(registry: Contract, only: Set<number> | null) {
  const n = Number(await registry.claimCount());
  const rows: any[] = [];
  for (let i = 0; i < n; i++) {
    if (only && !only.has(i)) continue;
    const c = await registry.claimOf(i);
    const status = ['None', 'Open', 'Refuted', 'Standing'][Number(c.status)];
    const claim: Claim = {
      id: i, assertedAt: 0, chainKey: Number(c.chainKey), venue: c.venue, topic0: c.topic0, subject: c.subject,
      subjectTopic: Number(c.subjectTopic), spanFrom: Number(c.spanFrom), spanTo: Number(c.spanTo),
      openUntil: Number(c.openUntil), kind: Number(c.kind) as 0 | 1, members: Number(c.members),
    };
    try {
      const found = await findCounterexample(registry, claim);
      const consistent = status === 'Open' || (status === 'Refuted') === Boolean(found);
      rows.push({ claimId: i, status, kind: claim.kind === 0 ? 'EmptySet' : 'CompleteSet', counterexample: found ? found.log.transactionHash : null, consistent, scannedAt: new Date().toISOString() });
      console.log(`  claim ${String(i).padStart(3)} ${status.padEnd(8)} ${found ? `counterexample ${found.log.transactionHash.slice(0, 12)}…` : 'no counterexample, corroborated'}${consistent ? '' : '  ← INCONSISTENT'}`);
    } catch (e) {
      rows.push({ claimId: i, status, error: String((e as Error).message).slice(0, 160), consistent: null, scannedAt: new Date().toISOString() });
      console.log(`  claim ${String(i).padStart(3)} ${status.padEnd(8)} COULD NOT SCAN — ${(e as Error).message.slice(0, 100)}`);
    }
  }
  const out = new URL('../../docs/transcripts/audit-v3.json', import.meta.url);
  // With --only, re-scanned rows replace their earlier results; every other row keeps its own.
  if (only && existsSync(out)) {
    const prior = JSON.parse(readFileSync(out, 'utf8'));
    if (prior.registry.toLowerCase() === (await registry.getAddress()).toLowerCase()) {
      const fresh = new Map(rows.map((r) => [r.claimId, r]));
      rows.splice(0, rows.length, ...prior.rows.map((r: any) => fresh.get(r.claimId) ?? r), ...rows.filter((r) => !prior.rows.some((q: any) => q.claimId === r.claimId)));
      rows.sort((a, b) => a.claimId - b.claimId);
    }
  }
  writeFileSync(out, JSON.stringify({ registry: await registry.getAddress(), at: new Date().toISOString(), rows }, null, 1) + '\n');
  const bad = rows.filter((r) => r.consistent === false).length;
  console.log(`\n  audited ${rows.length} claims · inconsistent ${bad} · unscannable ${rows.filter((r) => r.consistent === null).length}`);
  console.log(`  ${out.pathname}`);
  if (bad) process.exit(1);
}

async function main() {
  const argv = process.argv;
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const once = argv.includes('--once');
  const dryRun = argv.includes('--dry-run');
  const interval = Number(get('--interval') ?? 60) * 1000;
  const minAgeHours = Number(get('--min-age-hours') ?? 0);
  const only = get('--only') ? new Set(get('--only')!.split(',').map(Number)) : null;

  const cc = new JsonRpcProvider(CC_RPC);
  // A hunter that is also the claimant proves nothing about whether anyone else would bother.
  const wallet = new Wallet(process.env.HUNTER_KEY ?? privateKey(), cc);
  const registry = new Contract(registryAddress(), REGISTRY_V3_ABI, wallet);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  console.log('hunter');
  console.log('  registry :', await registry.getAddress());
  console.log('  as       :', wallet.address);
  console.log('  venues   :', [...new Set(VENUES.map((v) => v.protocol))].join(', '));
  if (minAgeHours > 0) console.log(`  waits    : ${minAgeHours}h before touching a claim, so humans get the first shot`);
  if (only) console.log(`  only     : claims ${[...only].join(', ')}`);
  if (dryRun) console.log('  DRY RUN — no transactions will be sent');
  if (argv.includes('--audit')) return audit(registry, only);

  for (;;) {
    try {
      await hunt(registry, mirror, dryRun, minAgeHours, only);
    } catch (e) {
      console.log('  ! pass failed:', (e as Error).message.slice(0, 160));
    }
    if (once) break;
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
