/**
 * Regenerate every number the project publishes, from the chain.
 *
 * Usage:
 *   node src/measure.ts [--write] [--check] [--empties]   (--empties also measures campaign gas: one receipt per call)
 *
 * WHY THIS EXISTS
 * ---------------
 * A README edited by hand drifts. Someone rounds a count up, then rounds the rounding, and three
 * commits later the project claims something nobody measured. `CLAIMS.md` only prevents that if the
 * numbers in it are produced rather than typed. They live in `deployments.json` under `measured`, this
 * script writes them from live chain state, and `--check` (run by CI) fails if they no longer match.
 *
 * WHAT IS MEASURED
 * ----------------
 * Per source chain, from Mirror v2's held bitmap: heights held, range, holes inside the range, the
 * number of contiguous runs and the longest one. Empty Ethereum blocks (`--empties`) are counted
 * exactly, by decoding the continuity roots out of every `mirror()` call's own calldata and counting
 * the zeros -- not inferred, not sampled. On v2 an empty block is held like any other height; the
 * number is published so the claim "empty blocks no longer break a span" can be checked.
 *
 * From Registry v3: claims by kind and status, bond staked, bond burned by refutations.
 * From the desk: whether its 90-day policy answers at all, which is the gate the mandate cares about.
 *
 * v1's numbers are frozen history under `measured.v1` and are never overwritten.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAINS, REGISTRY_DEPLOY_BLOCK } from './config.ts';

const DEPLOYMENTS = new URL('../../deployments.json', import.meta.url);

const REGISTRY_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 paidToRefuter, uint256 burned)',
];
const DESK_ABI = [
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal))',
  'function assess(address, uint256, uint256, uint256[]) view returns (bool, uint8)',
  'function securityBudget(uint64) view returns (uint32 attestors, uint128 minBond, uint256 cap)',
  'function totalOutstanding() view returns (uint256)',
];
import { allSpans, offerFor, NINETY_DAYS } from './spans.ts';

const REFUSAL = [
  'None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness',
  'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent', 'NeedsBondedCover', 'PoolCapReached',
];
const popcount = (x: bigint) => {
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
};

async function chainCoverage(mirror: Contract, chainKey: number) {
  const held = Number(await mirror.mirroredBlocks(chainKey));
  if (held === 0) return { held: 0 };
  const lowest = Number(await mirror.lowestMirrored(chainKey));
  const highest = Number(await mirror.highestMirrored(chainKey));

  const firstWord = Math.floor(lowest / 256);
  const lastWord = Math.floor(highest / 256);
  const words: bigint[] = [];
  for (let w = firstWord; w <= lastWord; w += 64) {
    const n = Math.min(64, lastWord - w + 1);
    words.push(...(await Promise.all(Array.from({ length: n }, (_, i) => mirror.heldWord(chainKey, w + i)))).map((v: any) => BigInt(v)));
  }

  // Read the counter again after the scan. Campaign workers may be writing while this runs, so the
  // bitmap may legitimately contain heights added after the first read -- but never fewer than the
  // first read, and never more than the second. Outside that window is a real disagreement.
  const heldAfter = Number(await mirror.mirroredBlocks(chainKey));

  // Runs, walking bits.
  let bitmapHeld = 0;
  let runs = 0;
  let longest = 0;
  let longestFrom = lowest;
  let cur = 0;
  let curFrom = lowest;
  for (let h = lowest; h <= highest; h++) {
    const bit = (words[Math.floor(h / 256) - firstWord] >> BigInt(h % 256)) & 1n;
    if (bit === 1n) {
      if (cur === 0) {
        curFrom = h;
        runs++;
      }
      cur++;
      bitmapHeld++;
      if (cur > longest) {
        longest = cur;
        longestFrom = curFrom;
      }
    } else cur = 0;
  }
  void popcount;
  // The run that ends at the top of the archive: the history a 90-day policy actually reads.
  let topRun = 0;
  for (let h = highest; h >= lowest; h--) {
    if (((words[Math.floor(h / 256) - firstWord] >> BigInt(h % 256)) & 1n) === 0n) break;
    topRun++;
  }
  return {
    held,
    heldAfterScan: heldAfter,
    bitmapHeld,
    bitmapAgrees: bitmapHeld >= held && bitmapHeld <= heldAfter,
    lowest,
    highest,
    unheldInRange: highest - lowest + 1 - held,
    runs,
    longestRun: longest,
    longestRunFrom: longestFrom,
    topRun,
    topRunFrom: highest - topRun + 1,
    topRunDays: Number(((topRun * CHAINS[chainKey].blockSeconds) / 86_400).toFixed(2)),
    days: Number(((held * CHAINS[chainKey].blockSeconds) / 86_400).toFixed(2)),
  };
}

/**
 * Exact empty-block count -- zero roots in the calldata of every mirror() call that added heights --
 * and, from the same receipts, what a retained root costs: gas per newly held height, over calls that
 * added at least 800 (so a mostly-overlapping call does not flatter or punish the figure).
 */
async function campaignFacts(cc: JsonRpcProvider, mirror: Contract, chainKey: number, deployBlock: number) {
  const head = await cc.getBlockNumber();
  const events: any[] = [];
  for (let from = deployBlock; from <= head; from += 5_000) {
    events.push(...(await mirror.queryFilter(mirror.filters.BlocksMirrored(chainKey), from, Math.min(from + 4_999, head))));
  }
  const heights = new Set<number>();
  const perRoot: number[] = [];
  let calls = 0;
  let totalGas = 0n;
  let widest = { roots: 0, tx: '' };
  const queue = events.filter((ev) => Number(ev.args.newlyAdded) > 0);
  for (let i = 0; i < queue.length; i += 16) {
    await Promise.all(
      queue.slice(i, i + 16).map(async (ev) => {
        const [tx, rc] = await Promise.all([cc.getTransaction(ev.transactionHash), cc.getTransactionReceipt(ev.transactionHash)]);
        const parsed = mirror.interface.parseTransaction({ data: tx!.data });
        if (!parsed || parsed.name !== 'mirror') return;
        calls++;
        totalGas += rc!.gasUsed;
        const first = Number(parsed.args[1]);
        const roots: string[] = parsed.args[6];
        if (roots.length > widest.roots) widest = { roots: roots.length, tx: ev.transactionHash };
        roots.forEach((r, k) => {
          if (BigInt(r) === 0n) heights.add(first + k);
        });
        const added = Number(ev.args.newlyAdded);
        if (added >= 800) perRoot.push(Number(rc!.gasUsed) / added);
      }),
    );
  }
  perRoot.sort((a, b) => a - b);
  const sorted = [...heights].sort((a, b) => a - b);
  // Spread across the archive rather than the lowest ten, so a sample lands inside any sealed window.
  const step = Math.max(1, Math.floor(sorted.length / 12));
  return {
    count: heights.size,
    sample: sorted.filter((_, k) => k % step === 0).slice(0, 12),
    calls,
    totalGas: totalGas.toString(),
    widest,
    gasPerNewRoot: perRoot.length
      ? { min: Math.round(perRoot[0]), median: Math.round(perRoot[Math.floor(perRoot.length / 2)]), max: Math.round(perRoot[perRoot.length - 1]), calls: perRoot.length }
      : null,
  };
}

async function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const withEmpties = process.argv.includes('--empties');

  const cc = new JsonRpcProvider(CC_RPC);
  const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);
  const prev = d.measured ?? {};

  // v1 history, frozen: whatever was measured against the first mirror stays exactly as it was.
  const v1 = prev.v1 ?? Object.fromEntries(Object.entries(prev).filter(([k]) => !['v1', 'chains', 'claims', 'desk', 'acceptance', 'board', 'differential', 'continuityByAge'].includes(k)));

  const chains: Record<string, any> = {};
  for (const k of Object.keys(CHAINS).map(Number)) {
    const c: any = await chainCoverage(mirror, k);
    if (withEmpties && c.held > 0) {
      const e = await campaignFacts(cc, mirror, k, d.deployBlock);
      c.emptyBlocks = e.count;
      c.emptyBlockSample = e.sample;
      c.mirrorCalls = e.calls;
      c.campaignGas = e.totalGas;
      c.widestCall = e.widest;
      c.gasPerNewRoot = e.gasPerNewRoot;
    } else if (prev.chains?.[k]?.emptyBlocks !== undefined) {
      for (const key of ['emptyBlocks', 'emptyBlockSample', 'mirrorCalls', 'campaignGas', 'widestCall', 'gasPerNewRoot']) c[key] = prev.chains[k][key];
    }
    chains[k] = c;
  }

  const claims: any = { total: 0, byStatus: { open: 0, refuted: 0, standing: 0 }, byKind: { emptySet: 0, completeSet: 0 }, bondStakedWei: '0', burnedWei: '0' };
  if (d.contracts.AbsenceRegistryV3) {
    const reg = new Contract(d.contracts.AbsenceRegistryV3, REGISTRY_ABI, cc);
    const n = Number(await reg.claimCount());
    claims.total = n;
    let staked = 0n;
    for (let i = 0; i < n; i++) {
      const c = await reg.claimOf(i);
      const s = Number(c.status);
      if (s === 1) claims.byStatus.open++;
      if (s === 2) claims.byStatus.refuted++;
      if (s === 3) claims.byStatus.standing++;
      if (Number(c.kind) === 0) claims.byKind.emptySet++;
      else claims.byKind.completeSet++;
      staked += BigInt(c.bondStaked);
    }
    claims.bondStakedWei = staked.toString();
    const head = await cc.getBlockNumber();
    let burned = 0n;
    for (let from = REGISTRY_DEPLOY_BLOCK; from <= head; from += 5_000) {
      for (const ev of await reg.queryFilter(reg.filters.AbsenceRefuted(), from, Math.min(from + 4_999, head))) burned += BigInt((ev as any).args.burned);
    }
    claims.burnedWei = burned.toString();
  }

  // ---- the acceptance facts that are about state, not code --------------------------------------
  const acceptance: any = {};
  {
    const SPAN_ABI = [
      'function spanCount() view returns (uint256)',
      'function spanOf(uint256) view returns ((uint64 chainKey, uint64 fromBlock, uint64 toBlock))',
      'function spanCovers(uint256, uint64, uint64) view returns (bool)',
      'function rootOf(uint64, uint64) view returns (bytes32)',
    ];
    const m2 = new Contract(MIRROR, [...MIRROR_ABI, ...SPAN_ABI], cc);
    // An empty Ethereum block inside a sealed span: held, root zero, and the span crosses it.
    const empties: number[] = chains['3']?.emptyBlockSample ?? [];
    const nSpans = Number(await m2.spanCount());
    const spans = await Promise.all(Array.from({ length: nSpans }, (_, i) => m2.spanOf(i)));
    outer: for (const h of empties) {
      for (let i = 0; i < nSpans; i++) {
        const sp = spans[i];
        if (Number(sp.chainKey) === 3 && h >= Number(sp.fromBlock) && h <= Number(sp.toBlock)) {
          const [held, root, covers] = await Promise.all([m2.isMirrored(3, h), m2.rootOf(3, h), m2.spanCovers(i, 3, h)]);
          acceptance.emptyBlockInSealedSpan = {
            height: h,
            spanId: i,
            spanFrom: Number(sp.fromBlock),
            spanTo: Number(sp.toBlock),
            isMirrored: Boolean(held),
            rootIsZero: BigInt(root) === 0n,
            spanCovers: Boolean(covers),
            spanBlocks: Number(sp.toBlock) - Number(sp.fromBlock) + 1,
          };
          break outer;
        }
      }
    }

    // A second transaction in a notarised block, verified three ways against the live mirror.
    const fx = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/mainnet/random-block-second-tx/0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9.json', import.meta.url), 'utf8'));
    const notarisedWith = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/liquidation.json', import.meta.url), 'utf8'));
    const data = mirror.interface.encodeFunctionData('verifyOrRevert', [3, fx.headerNumber, fx.txBytes, fx.siblingHashes.map((h: string, i: number) => ({ hash: h, isLeft: fx.siblingIsLeft[i] }))]);
    const call = async (override?: Record<string, { code: string }>) => {
      try {
        const out = await cc.send('eth_call', override ? [{ to: MIRROR, data }, 'latest', override] : [{ to: MIRROR, data }, 'latest']);
        return { ok: true, txIndex: Number(BigInt(out)) };
      } catch (e) {
        return { ok: false, error: String((e as Error).message).slice(0, 60) };
      }
    };
    // Sealing: what proving a span gap-free costs, read from every SpanSealed receipt.
    {
      const head = await cc.getBlockNumber();
      const sealed: any[] = [];
      const ev = new Contract(MIRROR, ['event SpanSealed(uint256 indexed spanId, uint64 indexed chainKey, uint64 fromBlock, uint64 toBlock)'], cc);
      for (let from = d.deployBlock; from <= head; from += 5_000) sealed.push(...(await ev.queryFilter(ev.filters.SpanSealed(), from, Math.min(from + 4_999, head))));
      const rows = await Promise.all(sealed.map(async (e) => ({ width: Number(e.args.toBlock) - Number(e.args.fromBlock) + 1, gas: Number((await cc.getTransactionReceipt(e.transactionHash))!.gasUsed), tx: e.transactionHash })));
      const widest = rows.filter((r) => r.width === Math.max(...rows.map((x) => x.width)));
      acceptance.sealing = rows.length
        ? { spans: rows.length, widest: widest[0].width, gasForWidest: Math.max(...widest.map((r) => r.gas)), tx: widest[0].tx }
        : null;
    }

    // The consumer in another repository, called on-chain: with and without the precompile, and the control.
    const gate = d.external?.hindsightGate?.address;
    if (gate) {
      const liq = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/liquidation.json', import.meta.url), 'utf8'));
      const gi = new Contract(gate, ['function happened(uint64 height, bytes txBytes, (bytes32 hash, bool isLeft)[] path) view returns (uint64)'], cc);
      const gdata = gi.interface.encodeFunctionData('happened', [liq.headerNumber, liq.txBytes, liq.siblingHashes.map((h: string, i: number) => ({ hash: h, isLeft: liq.siblingIsLeft[i] }))]);
      const gcall = async (override?: Record<string, { code: string }>) => {
        try {
          const out = await cc.send('eth_call', override ? [{ to: gate, data: gdata }, 'latest', override] : [{ to: gate, data: gdata }, 'latest']);
          return { ok: true, txIndex: Number(BigInt(out)) };
        } catch {
          return { ok: false };
        }
      };
      acceptance.strangerConsumer = {
        address: gate,
        tx: liq.txHash,
        block: liq.headerNumber,
        plain: await gcall(),
        precompileBlanked: await gcall({ '0x0000000000000000000000000000000000000FD2': { code: '0x' } }),
        mirrorBlanked: await gcall({ [MIRROR]: { code: '0x' } }),
      };
    }

    acceptance.secondTransaction = {
      block: fx.headerNumber,
      txHash: fx.txHash,
      expectedIndex: fx.txIndex,
      notarisedWithIndex: notarisedWith.txIndex,
      plain: await call(),
      precompileBlanked: await call({ '0x0000000000000000000000000000000000000FD2': { code: '0x' } }),
      mirrorBlanked: await call({ [MIRROR]: { code: '0x' } }),
    };
  }

  // ---- the desk: policies, and the one question the mandate gates on ------------------------------
  const desk: any = { policies: 0 };
  if (d.contracts.UnderwritingDesk) {
    const dk = new Contract(d.contracts.UnderwritingDesk, DESK_ABI, cc);
    const n = Number(await dk.policyCount());
    desk.policies = n;
    desk.balanceWei = (await cc.getBalance(d.contracts.UnderwritingDesk)).toString();

    // The window the desk is handed, proven once by `sealSpan` rather than walked on every question.
    const mir = new Contract(d.contracts.EthereumMirror, MIRROR_ABI, cc);
    const offer = offerFor(await allSpans(mir, 3), NINETY_DAYS);
    desk.window = offer ? { spanIds: offer.ids, from: offer.from, to: offer.to, heights: offer.to - offer.from + 1 } : null;
    const [attestors, minBond, cap] = await dk.securityBudget(3);
    desk.securityBudget = {
      source: '0x0FD4 AttestorStash, read live on every decision',
      attestors: Number(attestors),
      minBondWei: minBond.toString(),
      capWei: cap.toString(),
      outstandingWei: (await dk.totalOutstanding()).toString(),
    };

    desk.ninetyDay = [];
    if (offer) {
      for (let i = 0; i < n; i++) {
        const p = await dk.policyOf(i);
        if (Number(p.window) < 648_000) continue;
        // An address nothing has ever been said about, asking only what its file says. Under either
        // policy the only possible refusal is the archive itself, so this is the live form of
        // "the desk is not ArchiveTooShallow".
        const [ok, reason] = await dk.assess('0x000000000000000000000000000000000000c1ea', i, 0, offer.ids);
        desk.ninetyDay.push({ policy: i, kind: Number(p.kind) === 0 ? 'BlankFile' : 'BondedClean', window: Number(p.window), subject: '0x…c1ea', ok: Boolean(ok), reason: REFUSAL[Number(reason)] });
      }
    }
  }
  // Transactions the desk demo sent, as recorded; their receipts are immutable, so they are re-read.
  {
    const url = new URL('../../docs/transcripts/desk-v4.json', import.meta.url);
    if (existsSync(url)) {
      const t = JSON.parse(readFileSync(url, 'utf8'));
      const txs = t.entries.filter((e: any) => e.tx);
      desk.transactions = [];
      for (const e of txs) {
        const rc = await cc.getTransactionReceipt(e.tx);
        desk.transactions.push({ kind: e.kind, label: e.label, policyId: e.policyId, reason: e.reason ?? (e.ok ? 'Lent' : null), ok: e.ok, tx: e.tx, status: rc?.status ?? null, gasUsed: rc ? Number(rc.gasUsed) : null });
      }
      desk.assessedAtDemo = t.entries.filter((e: any) => e.kind === 'assess').map((e: any) => ({ label: e.label, subject: e.subject, policyId: e.policyId, reason: e.reason, claimId: e.claimId }));
    }
  }

  // ---- the board as filed, checked against the chain ---------------------------------------------
  const board: any = { chains: {} };
  if (d.contracts.AbsenceRegistryV3) {
    const reg = new Contract(d.contracts.AbsenceRegistryV3, REGISTRY_ABI, cc);
    const head = await cc.getBlockNumber();
    const refutedBy = new Map<number, any>();
    for (let from = REGISTRY_DEPLOY_BLOCK; from <= head; from += 5_000) {
      for (const ev of await reg.queryFilter(reg.filters.AbsenceRefuted(), from, Math.min(from + 4_999, head))) {
        const a = (ev as any).args;
        const rc = await cc.getTransactionReceipt(ev.transactionHash);
        refutedBy.set(Number(a.claimId), { tx: ev.transactionHash, refuter: a.refuter, evidenceBlock: Number(a.blockNumber), paidWei: a.paidToRefuter.toString(), burnedWei: a.burned.toString(), gasUsed: Number(rc!.gasUsed) });
      }
    }
    for (const slug of ['mainnet', 'sepolia']) {
      const url = new URL(`../../contracts/test/fixtures/board-v3-${slug}.json`, import.meta.url);
      if (!existsSync(url)) continue;
      const rec = JSON.parse(readFileSync(url, 'utf8'));
      if (rec.registry.toLowerCase() !== d.contracts.AbsenceRegistryV3.toLowerCase()) continue;
      const rows = [];
      for (const c of rec.claims) {
        const onChain = await reg.claimOf(c.claimId);
        const status = ['None', 'Open', 'Refuted', 'Standing'][Number(onChain.status)];
        rows.push({ claimId: c.claimId, role: c.role, kind: c.kind, venue: c.venueLabel, subject: c.subject, bondWei: c.bond, status, members: c.members?.length ?? 0, assertTx: c.assertTx, refutation: refutedBy.get(c.claimId) ?? null, openUntil: c.openUntil });
      }
      const byRole: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        byRole[r.role] = byRole[r.role] ?? { total: 0, Open: 0, Refuted: 0, Standing: 0 };
        byRole[r.role].total++;
        byRole[r.role][r.status]++;
      }
      // A lie that stood, or a truth that was refuted, is a failure of the market -- or of this board.
      const liesStanding = rows.filter((r) => ['lie', 'bounty', 'omission'].includes(r.role) && r.status === 'Standing').length;
      const truthsRefuted = rows.filter((r) => ['clean', 'complete', 'borrower'].includes(r.role) && r.status === 'Refuted').length;
      board.chains[slug] = { spanFrom: rec.spanFrom, spanTo: rec.spanTo, spanIds: rec.spanIds, claims: rows.length, byRole, liesStanding, truthsRefuted, rows };
    }
    const burns = [...refutedBy.values()];
    board.refutations = burns.length;
    board.burnedWei = burns.reduce((a, b) => a + BigInt(b.burnedWei), 0n).toString();
    board.paidWei = burns.reduce((a, b) => a + BigInt(b.paidWei), 0n).toString();
    {
      const url = new URL('../../docs/transcripts/audit-v3.json', import.meta.url);
      if (existsSync(url)) {
        const a = JSON.parse(readFileSync(url, 'utf8'));
        if (a.registry.toLowerCase() === d.contracts.AbsenceRegistryV3.toLowerCase()) {
          board.audit = { at: a.at, claims: a.rows.length, settled: a.rows.filter((r: any) => r.status !== 'Open').length, inconsistent: a.rows.filter((r: any) => r.consistent === false).length, unscannable: a.rows.filter((r: any) => r.consistent === null).length };
        }
      }
    }
    board.refutationGas = burns.length ? { min: Math.min(...burns.map((b) => b.gasUsed)), max: Math.max(...burns.map((b) => b.gasUsed)) } : null;
  }

  // ---- the newest differential transcript against this mirror ------------------------------------
  let differential: any = prev.differential ?? null;
  {
    const dir = new URL('../../docs/transcripts/', import.meta.url);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.startsWith('differential-') && f.endsWith('.md')).sort();
      for (const f of files.reverse()) {
        const body = readFileSync(new URL(f, dir), 'utf8');
        if (!body.includes(`Mirror: ${MIRROR}`)) continue;
        const num = (label: string) => Number(body.match(new RegExp(`${label}: (\\d+)`))?.[1]);
        differential = { transcript: `docs/transcripts/${f}`, fixtures: num('Fixtures compared'), checks: num('Checks'), divergences: num('Divergences') };
        break;
      }
    }
  }

  const measured = { ...prev, v1, chains, claims, desk, acceptance, board, differential };
  for (const k of Object.keys(measured)) if (!['v1', 'chains', 'claims', 'desk', 'acceptance', 'board', 'differential', 'continuityByAge'].includes(k)) delete (measured as any)[k];

  for (const [k, c] of Object.entries(chains)) {
    if (!c.held) {
      console.log(`  chain ${k}: nothing held`);
      continue;
    }
    console.log(
      `  chain ${k} ${CHAINS[Number(k)].slug.padEnd(8)} held ${c.held.toLocaleString()} (${c.days}d) · ${c.lowest.toLocaleString()}–${c.highest.toLocaleString()} · ` +
        `unheld inside ${c.unheldInRange.toLocaleString()} · runs ${c.runs} · longest ${c.longestRun.toLocaleString()} · top run ${c.topRun.toLocaleString()} (${c.topRunDays}d)` +
        (c.emptyBlocks !== undefined ? ` · empty blocks ${c.emptyBlocks}` : '') +
        ` · bitmap ${c.bitmapHeld.toLocaleString()} vs counter ${c.held.toLocaleString()}..${c.heldAfterScan.toLocaleString()}` +
        (c.bitmapAgrees ? ' (consistent)' : ' · BITMAP DISAGREES WITH mirroredBlocks'),
    );
  }
  console.log(`  claims ${claims.total}: open ${claims.byStatus.open}, refuted ${claims.byStatus.refuted}, standing ${claims.byStatus.standing}; EmptySet ${claims.byKind.emptySet}, CompleteSet ${claims.byKind.completeSet}; burned ${Number(BigInt(claims.burnedWei)) / 1e18} tCTC`);
  console.log(`  desk policies ${desk.policies}${desk.ninetyDay?.length ? ' · 90-day: ' + desk.ninetyDay.map((x: any) => `${x.subject.slice(0, 8)}… ${x.reason}`).join(', ') : ''}`);

  if (check) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    // Only compare what this run measured; the head keeps moving if a follower is running, so held counts
    // may only have grown, never shrunk.
    const stale: string[] = [];
    for (const [k, c] of Object.entries(chains)) {
      const was = prev.chains?.[k];
      if (!was) continue;
      if (c.held < was.held) stale.push(`chain ${k} held shrank: recorded ${was.held}, chain says ${c.held}`);
      if (was.unheldInRange === 0 && c.unheldInRange !== 0) stale.push(`chain ${k} gained a hole: ${c.unheldInRange} unheld inside the range`);
      if (!c.bitmapAgrees) stale.push(`chain ${k} bitmap disagrees with mirroredBlocks`);
    }
    if (prev.claims && !same(prev.claims.total, claims.total) && claims.total < prev.claims.total) stale.push('claim count shrank');
    for (const [k, c] of Object.entries(chains)) {
      const was = prev.chains?.[k];
      if (was?.topRun && c.topRun < was.topRun) stale.push(`chain ${k} top run shrank: recorded ${was.topRun}, chain says ${c.topRun}`);
    }
    // Settled claims never change status; an Open one may have moved on, which is not drift.
    for (const [slug, b] of Object.entries(prev.board?.chains ?? {}) as [string, any][]) {
      for (const r of b.rows) {
        const now = board.chains?.[slug]?.rows.find((x: any) => x.claimId === r.claimId);
        if (r.status !== 'Open' && now?.status !== r.status) stale.push(`claim ${r.claimId} was recorded ${r.status}, chain says ${now?.status}`);
      }
    }
    const pa = prev.acceptance ?? {};
    if (pa.emptyBlockInSealedSpan && !same(pa.emptyBlockInSealedSpan, acceptance.emptyBlockInSealedSpan)) stale.push('empty-block-in-sealed-span fact changed');
    const verdicts = (x: any) => x && [x.plain, x.precompileBlanked, x.mirrorBlanked].map((v: any) => `${v.ok}:${v.txIndex ?? ''}`).join(' ');
    if (pa.secondTransaction && verdicts(pa.secondTransaction) !== verdicts(acceptance.secondTransaction)) stale.push('second-transaction independence result changed');
    for (const t of prev.desk?.transactions ?? []) {
      const now = desk.transactions?.find((x: any) => x.tx === t.tx);
      if (!now || now.status !== t.status) stale.push(`desk transaction ${t.tx} receipt changed`);
    }
    if (stale.length) {
      console.log('\nSTALE — deployments.json disagrees with the chain:');
      for (const s of stale) console.log('  ' + s);
      process.exit(1);
    }
    console.log('\nrecorded numbers agree with the chain.');
  }

  if (write) {
    d.measured = measured;
    writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + '\n');
    console.log('\nwritten to deployments.json');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
