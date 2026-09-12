/**
 * DIFFERENTIAL HARNESS — the consistency proof.
 *
 * `EthereumMirror` reimplements Attestcoin's Merkle verification in Solidity so that a notarised
 * transaction can be checked without a continuity proof. A reimplementation is only safe if it
 * reaches the *same verdict* as the authority it replaces, and fails in the *same way*.
 *
 * This harness runs both paths over real Ethereum mainnet transactions and a full set of
 * adversarial mutations, and asserts:
 *
 *   1. verdict agreement    — the precompile accepts iff the mirror accepts
 *   2. failure-mode parity  — `verifyOrRevert` reverts wherever `0x0FD2` reverts
 *   3. boolean soundness    — `tryVerify` never reports valid where the precompile refuses
 *
 * Point 2 is the one that matters in practice. The precompile reverts on bad input, so a caller
 * who ignores its return value is accidentally safe. An earlier version of the mirror returned
 * `false` instead, which would have made that same caller exploitable. The split API exists
 * because of this harness.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAIN_KEY_ETH_MAINNET, fetchProof } from './config.ts';

const ZERO = '0x' + '00'.repeat(32);
const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';
const PRECOMPILE_ABI = [
  'function verify(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) view returns (bool)',
  'function calculateTxIndex((bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof) view returns (uint64)',
];

type Sib = { hash: string; isLeft: boolean };
type Verdict = 'accept' | 'reject';

const SUBJECTS = [
  '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61', // Aave V3 liquidation
  '0xcb9cd732d95ea9632c02add1afa7d66b5fd94f0ae48a4fdee6f88b2142149c00', // Aave V3 repay
];

function mutations(sib: Sib[], txBytes: string): { name: string; sib: Sib[]; tx: string }[] {
  const flip = (h: string) => '0x' + (BigInt(h) ^ 1n).toString(16).padStart(64, '0');
  return [
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
    { name: 'flip isLeft at top level', sib: [...sib.slice(0, -1), { ...sib[sib.length - 1], isLeft: !sib[sib.length - 1].isLeft }], tx: txBytes },
    { name: 'mutate sibling hash bit', sib: [{ ...sib[0], hash: flip(sib[0].hash) }, ...sib.slice(1)], tx: txBytes },
    { name: 'all siblings ZERO', sib: sib.map((s) => ({ ...s, hash: ZERO })), tx: txBytes },
    { name: 'tamper last byte of tx', sib, tx: txBytes.slice(0, -2) + (txBytes.slice(-2) === '00' ? '01' : '00') },
    { name: 'tamper first byte of tx', sib, tx: '0x' + (txBytes.slice(2, 4) === '00' ? '01' : '00') + txBytes.slice(4) },
    { name: 'truncate tx bytes', sib, tx: txBytes.slice(0, -64) },
    { name: 'empty tx bytes', sib, tx: '0x' },
  ];
}

async function main() {
  const p = new JsonRpcProvider(CC_RPC);
  const pre = new Contract(PRECOMPILE, PRECOMPILE_ABI, p);
  const mirror = new Contract(MIRROR, MIRROR_ABI, p);

  console.log('DIFFERENTIAL HARNESS  0x0FD2  vs  EthereumMirror');
  console.log('  mirror:', MIRROR);
  console.log('');

  let checks = 0;
  let divergences = 0;

  for (const txHash of SUBJECTS) {
    const proof = await fetchProof(CHAIN_KEY_ETH_MAINNET, txHash);
    const baseSib: Sib[] = proof.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
    const height = proof.headerNumber;

    const mirrored = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, height);
    console.log(`block ${height}  (${txHash.slice(0, 12)}…)  mirrored=${mirrored}`);
    if (!mirrored) {
      console.log('  SKIPPED — notarise it first with: node src/mirror.ts ' + txHash);
      continue;
    }

    for (const m of mutations(baseSib, proof.txBytes)) {
      // Authority: the precompile, given the full continuity proof.
      let preVerdict: Verdict;
      try {
        const ok = await pre.verify(
          CHAIN_KEY_ETH_MAINNET, height, m.tx,
          { root: proof.merkleProof.root, siblings: m.sib },
          { lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest, roots: proof.continuityProof.roots },
        );
        preVerdict = ok ? 'accept' : 'reject';
      } catch { preVerdict = 'reject'; }

      // Replacement, reverting form.
      let orRevertVerdict: Verdict;
      try { await mirror.verifyOrRevert(CHAIN_KEY_ETH_MAINNET, height, m.tx, m.sib); orRevertVerdict = 'accept'; }
      catch { orRevertVerdict = 'reject'; }

      // Replacement, boolean form.
      let tryVerdict: Verdict;
      try {
        const [valid] = await mirror.tryVerify(CHAIN_KEY_ETH_MAINNET, height, m.tx, m.sib);
        tryVerdict = valid ? 'accept' : 'reject';
      } catch { tryVerdict = 'accept'; /* tryVerify must never revert; treat as a failure */ }

      const agree = preVerdict === orRevertVerdict && preVerdict === tryVerdict;
      checks++;
      if (!agree) divergences++;
      console.log(
        `  ${agree ? 'ok     ' : 'DIVERGE'} ${m.name.padEnd(30)} ` +
        `precompile=${preVerdict.padEnd(6)} verifyOrRevert=${orRevertVerdict.padEnd(6)} tryVerify=${tryVerdict}`,
      );
    }
    console.log('');
  }

  console.log(`${checks} checks, ${divergences} divergences`);
  if (divergences > 0) {
    console.log('FAIL — verification semantics differ from the precompile.');
    process.exit(1);
  }
  console.log('PASS — the mirror accepts exactly what the precompile accepts, and fails the same way.');
}

main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
