/**
 * Regenerate every number the project publishes, from the chain.
 *
 * Usage:
 *   node src/measure.ts [--write] [--check]
 *
 * WHY THIS EXISTS
 * ---------------
 * A README that is edited by hand drifts. Someone rounds 100,777 up to "over 100k", then to "a
 * hundred thousand blocks", and three commits later the project is claiming something nobody
 * measured. `CLAIMS.md` is supposed to prevent that, but only if the numbers in it are produced
 * rather than typed.
 *
 * So the numbers live in `deployments.json` under `measured`, this script writes them by reading
 * live chain state, and `--check` fails if the recorded values no longer match. CI runs `--check`.
 *
 * THE ONE SUBTLETY WORTH READING
 * ------------------------------
 * `mirroredBlocks` counts every height whose root was retained. An **empty Ethereum block** has no
 * transactions, so its transaction Merkle root genuinely is zero -- and zero is also the contract's
 * "not present" sentinel. Such a height is counted as retained, but `isMirrored` reports false for
 * it and it cannot be sealed across.
 *
 * Both numbers are therefore recorded separately and neither is allowed to stand in for the other:
 *
 *     heightsRetained   what mirroredBlocks() says
 *     heightsAnswerable retained minus empty blocks -- the honest figure for "questions we can answer"
 *
 * The headline number is the second one.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAIN_KEY_ETH_MAINNET } from './config.ts';

const DEPLOYMENTS = new URL('../../deployments.json', import.meta.url);

const REGISTRY_V2_ABI = [
  'function claimCount() view returns (uint256)',
  'function assurance(uint256) view returns (uint8 status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
];

async function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');

  const cc = new JsonRpcProvider(CC_RPC);
  const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  const retained = Number(await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
  const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
  const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));
  const maxWindow = Number(await mirror.MAX_SEAL_WINDOW());

  // Walk the archive to separate real coverage from the empty-block sentinel collision, and to
  // find the longest range an absence claim could actually bind.
  const runs: { start: number; len: number }[] = [];
  const emptyHeights: number[] = [];
  let cur = low;
  let acc = 0;
  let start = low;
  let guard = 0;
  while (cur <= high && guard++ < 2000) {
    const run = Number(await mirror.contiguousFrom(CHAIN_KEY_ETH_MAINNET, cur, maxWindow));
    if (run === 0) {
      if (acc) runs.push({ start, len: acc });
      acc = 0;
      emptyHeights.push(cur);
      cur++;
      start = cur;
      continue;
    }
    acc += run;
    cur += run;
    if (run < maxWindow && cur <= high) {
      runs.push({ start, len: acc });
      acc = 0;
      emptyHeights.push(cur);
      cur++;
      start = cur;
    }
  }
  if (acc) runs.push({ start, len: acc });

  const answerable = runs.reduce((a, b) => a + b.len, 0);
  const emptyBlocks = retained - answerable;
  const longest = runs.reduce((a, b) => (b.len > a.len ? b : a), { start: 0, len: 0 });

  let claims = 0;
  let refuted = 0;
  let standing = 0;
  let open = 0;
  if (d.contracts.AbsenceRegistryV2) {
    const reg = new Contract(d.contracts.AbsenceRegistryV2, REGISTRY_V2_ABI, cc);
    claims = Number(await reg.claimCount());
    for (let i = 0; i < claims; i++) {
      const s = Number((await reg.assurance(i)).status);
      if (s === 1) open++;
      else if (s === 2) refuted++;
      else if (s === 3) standing++;
    }
  }

  const measured = {
    ...d.measured,
    heightsRetained: retained,
    heightsAnswerable: answerable,
    emptyBlocksInRange: emptyBlocks,
    // The heights themselves, so the interface can draw them as what they are rather than
    // rendering the archive as one unbroken run it is not.
    emptyBlockHeights: emptyHeights,
    archiveFrom: low,
    archiveTo: high,
    contiguousRuns: runs.length,
    longestRunBlocks: longest.len,
    longestRunFrom: longest.start,
    claimsTotal: claims,
    claimsOpen: open,
    claimsRefuted: refuted,
    claimsStanding: standing,
  };

  const report = [
    ['heights retained (mirroredBlocks)', retained.toLocaleString()],
    ['heights answerable (non-empty)', answerable.toLocaleString()],
    ['empty Ethereum blocks in range', String(emptyBlocks)],
    ['archive range', `${low.toLocaleString()} .. ${high.toLocaleString()}`],
    ['contiguous runs', String(runs.length)],
    ['longest run', `${longest.len.toLocaleString()} blocks (${((longest.len * 12) / 3600).toFixed(1)}h) at ${longest.start}`],
    ['claims total / open / refuted / standing', `${claims} / ${open} / ${refuted} / ${standing}`],
  ];
  for (const [k, v] of report) console.log(`  ${k.padEnd(42)} ${v}`);

  if (check) {
    // Arrays are compared by content; a reference comparison would flag them stale every run.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const stale = Object.entries(measured).filter(([k, v]) => d.measured?.[k] !== undefined && !same(d.measured[k], v));
    if (stale.length) {
      console.log('\nSTALE — deployments.json disagrees with the chain:');
      for (const [k, v] of stale) {
        const show = (x: unknown) => (Array.isArray(x) ? `[${x.length} items]` : String(x));
        console.log(`  ${k}: recorded ${show(d.measured[k])}, chain says ${show(v)}`);
      }
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
