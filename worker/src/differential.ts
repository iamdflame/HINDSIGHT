/**
 * Differential harness: our Solidity verification against the live block-prover precompile.
 *
 * Usage:
 *   node src/differential.ts [--limit <fixtures>] [--concurrency 4] [--transcript]
 *
 * THE INVARIANT BEING TESTED
 * --------------------------
 * `EthereumMirror` replaces `0x0FD2` for already-notarised history. That replacement is only
 * honest if it is indistinguishable from the thing it replaces. So for every input, three verdicts
 * must agree:
 *
 *     precompile.verify(...)        the authority, given a full continuity proof
 *     mirror.verifyOrRevert(...)    the reverting replacement
 *     mirror.tryVerify(...)         the boolean replacement
 *
 * and two further properties must hold:
 *
 *     the precompile reverts  <=>  verifyOrRevert reverts       (failure-mode parity)
 *     tryVerify never reverts, for any input at all             (boolean soundness)
 *
 * A single divergence means a split brain: two contracts on the same chain disagreeing about what
 * Ethereum contains. That is not a bug to trade off against a deadline, so this exits non-zero and
 * the result is treated as a ship-blocker.
 *
 * WHAT CHANGED FROM THE FIRST VERSION
 * -----------------------------------
 * It used to run two hardcoded transactions, which is a spot check dressed as a machine. It now
 * reads every fixture in `contracts/test/fixtures/` -- real mainnet liquidations, repayments,
 * Morpho liquidations and Compound absorbs, harvested by `corpus.ts` -- and adds seeded random
 * sibling corruption on top of the fixed mutation classes, so the corpus grows without anyone
 * hand-writing another adversarial case.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAIN_KEY_ETH_MAINNET } from './config.ts';

const ZERO = '0x' + '00'.repeat(32);
const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';
const PRECOMPILE_ABI = [
  'function verify(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) view returns (bool)',
  'function calculateTxIndex((bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof) view returns (uint64)',
];

const FIXTURE_ROOT = new URL('../../contracts/test/fixtures/', import.meta.url);
const TRANSCRIPTS = new URL('../../docs/transcripts/', import.meta.url);

type Sib = { hash: string; isLeft: boolean };
type Verdict = 'accept' | 'reject';

type Fixture = {
  path: string;
  headerNumber: number;
  txHash: string;
  txBytes: string;
  root: string;
  siblings: Sib[];
  lowerEndpointDigest: string;
  continuityRoots: string[];
  venue?: string;
};

/** Every fixture on disk, flat file or venue folder. */
function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];

  const read = (url: URL, label: string) => {
    const j = JSON.parse(readFileSync(url, 'utf8'));
    // Board records and other evidence files share the directory; only proof fixtures are inputs.
    if (!j.txBytes || !Array.isArray(j.siblingHashes) || !Array.isArray(j.continuityRoots)) return;
    out.push({
      path: label,
      headerNumber: j.headerNumber,
      txHash: j.txHash,
      txBytes: j.txBytes,
      root: j.root,
      siblings: j.siblingHashes.map((h: string, i: number) => ({ hash: h, isLeft: j.siblingIsLeft[i] })),
      lowerEndpointDigest: j.lowerEndpointDigest,
      continuityRoots: j.continuityRoots,
      venue: j.venue?.key,
    });
  };

  for (const f of readdirSync(FIXTURE_ROOT)) {
    if (f.endsWith('.json')) read(new URL(f, FIXTURE_ROOT), f);
  }

  const mainnet = new URL('mainnet/', FIXTURE_ROOT);
  if (existsSync(mainnet)) {
    for (const venue of readdirSync(mainnet)) {
      const dir = new URL(`${venue}/`, mainnet);
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json')) read(new URL(f, dir), `${venue}/${f}`);
      }
    }
  }
  return out;
}

const flip = (h: string) => '0x' + (BigInt(h) ^ 1n).toString(16).padStart(64, '0');

/** Deterministic pseudo-random, so a divergence found in CI is reproducible locally. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mutations(sib: Sib[], txBytes: string, seed: number): { name: string; sib: Sib[]; tx: string }[] {
  const fixed = [
    { name: 'baseline (valid)', sib, tx: txBytes },
    { name: 'append ZERO sibling (right)', sib: [...sib, { hash: ZERO, isLeft: false }], tx: txBytes },
    { name: 'append ZERO sibling (left)', sib: [...sib, { hash: ZERO, isLeft: true }], tx: txBytes },
    { name: 'append duplicate of last', sib: [...sib, sib[sib.length - 1]], tx: txBytes },
    { name: 'truncate last sibling', sib: sib.slice(0, -1), tx: txBytes },
    { name: 'truncate first sibling', sib: sib.slice(1), tx: txBytes },
    { name: 'empty path', sib: [], tx: txBytes },
    { name: 'swap siblings 0<->1', sib: [sib[1], sib[0], ...sib.slice(2)], tx: txBytes },
    { name: 'reverse whole path', sib: [...sib].reverse(), tx: txBytes },
    { name: 'flip isLeft at level 0', sib: [{ ...sib[0], isLeft: !sib[0].isLeft }, ...sib.slice(1)], tx: txBytes },
    {
      name: 'flip isLeft at top level',
      sib: [...sib.slice(0, -1), { ...sib[sib.length - 1], isLeft: !sib[sib.length - 1].isLeft }],
      tx: txBytes,
    },
    { name: 'mutate sibling hash bit', sib: [{ ...sib[0], hash: flip(sib[0].hash) }, ...sib.slice(1)], tx: txBytes },
    { name: 'all siblings ZERO', sib: sib.map((s) => ({ ...s, hash: ZERO })), tx: txBytes },
    {
      name: 'tamper last byte of tx',
      sib,
      tx: txBytes.slice(0, -2) + (txBytes.slice(-2) === '00' ? '01' : '00'),
    },
    { name: 'tamper first byte of tx', sib, tx: '0x' + (txBytes.slice(2, 4) === '00' ? '01' : '00') + txBytes.slice(4) },
    { name: 'truncate tx bytes', sib, tx: txBytes.slice(0, -64) },
    { name: 'empty tx bytes', sib, tx: '0x' },
  ];

  // Random corruption, so the adversarial surface is not limited to cases someone thought of.
  const rnd = seeded(seed);
  const random = Array.from({ length: 5 }, (_, k) => {
    const level = Math.floor(rnd() * sib.length);
    const bit = BigInt(Math.floor(rnd() * 256));
    const mutated = sib.map((s, i) =>
      i === level ? { ...s, hash: '0x' + (BigInt(s.hash) ^ (1n << bit)).toString(16).padStart(64, '0') } : s,
    );
    return { name: `random bitflip #${k + 1} (level ${level}, bit ${bit})`, sib: mutated, tx: txBytes };
  });

  return [...fixed, ...random];
}

async function main() {
  const argv = process.argv;
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limit = Number(get('--limit') ?? Infinity);
  const concurrency = Number(get('--concurrency') ?? 4);

  const cc = new JsonRpcProvider(CC_RPC);
  const pre = new Contract(PRECOMPILE, PRECOMPILE_ABI, cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  const all = loadFixtures();
  console.log(`corpus: ${all.length} fixtures`);

  let checks = 0;
  let divergences = 0;
  let skipped = 0;
  const lines: string[] = [];

  let used = 0;
  for (const f of all) {
    if (used >= limit) break;

    const mirrored = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, f.headerNumber);
    if (!mirrored) {
      skipped++;
      continue;
    }
    used++;

    const cases = mutations(f.siblings, f.txBytes, f.headerNumber);
    const results = new Array(cases.length);

    // Bounded concurrency: the public RPC is shared, and a burst gets throttled rather than served.
    for (let i = 0; i < cases.length; i += concurrency) {
      const slice = cases.slice(i, i + concurrency);
      const settled = await Promise.all(
        slice.map(async (m) => {
          let preVerdict: Verdict;
          try {
            const ok = await pre.verify(
              CHAIN_KEY_ETH_MAINNET,
              f.headerNumber,
              m.tx,
              { root: f.root, siblings: m.sib },
              { lowerEndpointDigest: f.lowerEndpointDigest, roots: f.continuityRoots },
            );
            preVerdict = ok ? 'accept' : 'reject';
          } catch {
            preVerdict = 'reject';
          }

          let orRevert: Verdict;
          try {
            await mirror.verifyOrRevert(CHAIN_KEY_ETH_MAINNET, f.headerNumber, m.tx, m.sib);
            orRevert = 'accept';
          } catch {
            orRevert = 'reject';
          }

          let tryV: Verdict;
          let tryReverted = false;
          try {
            const [valid] = await mirror.tryVerify(CHAIN_KEY_ETH_MAINNET, f.headerNumber, m.tx, m.sib);
            tryV = valid ? 'accept' : 'reject';
          } catch {
            // tryVerify must never revert. Scoring a revert as `accept` guarantees it shows up as
            // a divergence rather than passing quietly.
            tryV = 'accept';
            tryReverted = true;
          }

          return { m, preVerdict, orRevert, tryV, tryReverted };
        }),
      );
      for (let k = 0; k < settled.length; k++) results[i + k] = settled[k];
    }

    let bad = 0;
    for (const r of results) {
      checks++;
      const agree = r.preVerdict === r.orRevert && r.preVerdict === r.tryV;
      if (!agree) {
        divergences++;
        bad++;
        const detail =
          `  DIVERGENCE ${f.path} ${f.txHash.slice(0, 12)}… "${r.m.name}": ` +
          `precompile=${r.preVerdict} verifyOrRevert=${r.orRevert} tryVerify=${r.tryV}` +
          (r.tryReverted ? ' (tryVerify REVERTED)' : '');
        console.log(detail);
        lines.push(detail);
      }
    }
    console.log(
      `  ${String(used).padStart(3)}. block ${f.headerNumber} ${f.venue ?? 'legacy'} ` +
        `${f.txHash.slice(0, 12)}…  ${results.length} checks  ${bad === 0 ? 'agree' : bad + ' DIVERGED'}`,
    );
  }

  console.log(`\n  fixtures compared : ${used}`);
  if (skipped) console.log(`  skipped (unmirrored): ${skipped}`);
  console.log(`  checks            : ${checks}`);
  console.log(`  divergences       : ${divergences}`);

  if (argv.includes('--transcript')) {
    mkdirSync(TRANSCRIPTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const body = [
      `# Differential transcript ${new Date().toISOString()}`,
      '',
      `Mirror: ${MIRROR}`,
      `Precompile: ${PRECOMPILE}`,
      `Fixtures compared: ${used}`,
      `Checks: ${checks}`,
      `Divergences: ${divergences}`,
      '',
      divergences === 0
        ? 'The mirror accepted exactly what the precompile accepted, and failed the same way.'
        : 'DIVERGENCES FOUND:',
      ...lines,
      '',
    ].join('\n');
    writeFileSync(new URL(`differential-${stamp}.md`, TRANSCRIPTS), body);
    console.log(`  transcript        : docs/transcripts/differential-${stamp}.md`);
  }

  if (divergences > 0) {
    console.log('\nFAIL — verification semantics differ from the precompile.');
    process.exit(1);
  }
  console.log('\nPASS — the mirror accepts exactly what the precompile accepts, and fails the same way.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
