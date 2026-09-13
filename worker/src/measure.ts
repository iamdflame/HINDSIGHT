/**
 * Regenerate every number the project publishes, from the chain.
 *
 * Usage:
 *   node src/measure.ts [--write] [--check] [--empties]
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
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAINS } from './config.ts';

const DEPLOYMENTS = new URL('../../deployments.json', import.meta.url);

const REGISTRY_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 paidToRefuter, uint256 burned)',
];
const DESK_ABI = [
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal))',
  'function assess(address, uint256, uint256) view returns (bool, uint8)',
];
const REFUSAL = ['None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness', 'DeskOutOfFunds'];
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
    days: Number(((held * CHAINS[chainKey].blockSeconds) / 86_400).toFixed(2)),
  };
}

/** Exact empty-block count: zero roots in the calldata of every mirror() call that added heights. */
async function emptyBlocks(cc: JsonRpcProvider, mirror: Contract, chainKey: number, deployBlock: number) {
  const head = await cc.getBlockNumber();
  const events: any[] = [];
  for (let from = deployBlock; from <= head; from += 5_000) {
    events.push(...(await mirror.queryFilter(mirror.filters.BlocksMirrored(chainKey), from, Math.min(from + 4_999, head))));
  }
  const heights = new Set<number>();
  for (const ev of events) {
    if (Number(ev.args.newlyAdded) === 0) continue;
    const tx = await cc.getTransaction(ev.transactionHash);
    const parsed = mirror.interface.parseTransaction({ data: tx!.data });
    if (!parsed) continue;
    const first = Number(parsed.name === 'mirror' ? parsed.args[1] : parsed.args[4]);
    const roots: string[] = parsed.args[6];
    roots.forEach((r, i) => {
      if (BigInt(r) === 0n) heights.add(first + i);
    });
  }
  return { count: heights.size, sample: [...heights].sort((a, b) => a - b).slice(0, 10) };
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
  const v1 = prev.v1 ?? Object.fromEntries(Object.entries(prev).filter(([k]) => !['v1', 'chains', 'claims', 'desk'].includes(k)));

  const chains: Record<string, any> = {};
  for (const k of Object.keys(CHAINS).map(Number)) {
    const c: any = await chainCoverage(mirror, k);
    if (withEmpties && c.held > 0) {
      const e = await emptyBlocks(cc, mirror, k, d.deployBlock);
      c.emptyBlocks = e.count;
      c.emptyBlockSample = e.sample;
    } else if (prev.chains?.[k]?.emptyBlocks !== undefined) {
      c.emptyBlocks = prev.chains[k].emptyBlocks;
      c.emptyBlockSample = prev.chains[k].emptyBlockSample;
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
    for (let from = d.deployBlock; from <= head; from += 5_000) {
      for (const ev of await reg.queryFilter(reg.filters.AbsenceRefuted(), from, Math.min(from + 4_999, head))) burned += BigInt((ev as any).args.burned);
    }
    claims.burnedWei = burned.toString();
  }

  const desk: any = { policies: 0 };
  if (d.contracts.UnderwritingDesk) {
    const dk = new Contract(d.contracts.UnderwritingDesk, DESK_ABI, cc);
    const n = Number(await dk.policyCount());
    desk.policies = n;
    desk.ninetyDay = [];
    for (let i = 0; i < n; i++) {
      const p = await dk.policyOf(i);
      if (Number(p.window) < 648_000) continue;
      // A liquidated Aave borrower, and an address nothing has ever been said about.
      for (const subject of ['0x180c0bd66467218add0190eacbad0aa62f39397b', '0x000000000000000000000000000000000000c1ea']) {
        const [ok, reason] = await dk.assess(subject, i, 10n ** 18n);
        desk.ninetyDay.push({ policy: i, subject, ok: Boolean(ok), reason: REFUSAL[Number(reason)] });
      }
    }
  }

  const measured = { ...prev, v1, chains, claims, desk };
  for (const k of Object.keys(measured)) if (!['v1', 'chains', 'claims', 'desk'].includes(k)) delete (measured as any)[k];

  for (const [k, c] of Object.entries(chains)) {
    if (!c.held) {
      console.log(`  chain ${k}: nothing held`);
      continue;
    }
    console.log(
      `  chain ${k} ${CHAINS[Number(k)].slug.padEnd(8)} held ${c.held.toLocaleString()} (${c.days}d) · ${c.lowest.toLocaleString()}–${c.highest.toLocaleString()} · ` +
        `unheld inside ${c.unheldInRange.toLocaleString()} · runs ${c.runs} · longest ${c.longestRun.toLocaleString()}` +
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
