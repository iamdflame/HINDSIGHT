/**
 * Independence check.
 *
 * Rebuilds an Attestcoin transaction proof using nothing but a public Ethereum RPC and the
 * Creditcoin chain-info precompile, then compares it against what Gluwa's hosted prover returned
 * for the same transaction.
 *
 * If the roots agree, the hosted prover is a convenience rather than a dependency: anyone can
 * regenerate the evidence for any mainnet transaction, and mirrored history stays verifiable even
 * when the proving service is offline.
 */
import { JsonRpcProvider } from 'ethers';
import sdk from '@gluwa/usc-sdk';
import { readFileSync } from 'node:fs';

const { proofProvider, chainInfo, encoding } = sdk as any;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { computeMerkleRootOfBlock, KeccakMerkleTree } = proofProvider.merkle;

const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
const CC_RPC = process.env.CC_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
const FIXTURE = process.env.FIXTURE ?? '../../contracts/test/fixtures/liquidation.json';

async function main() {
  const expected = JSON.parse(readFileSync(new URL(FIXTURE, import.meta.url), 'utf8'));
  const blockNumber: number = expected.headerNumber;

  console.log('Independence check — rebuilding a proof with no prover service');
  console.log('  Ethereum RPC   :', ETH_RPC);
  console.log('  Creditcoin RPC :', CC_RPC);
  console.log('  block          :', blockNumber);
  console.log('  tx             :', expected.txHash);
  console.log('  prover root    :', expected.root);
  console.log('');

  const ethProvider = new JsonRpcProvider(ETH_RPC);
  const blockProvider = new SimpleBlockProvider(ethProvider);

  console.log('fetching block + receipts from a public Ethereum node…');
  const t0 = Date.now();
  const withReceipts = await blockProvider.getBlockWithReceipts(blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this RPC (archive access may be required)');
  const { transactions, receipts } = withReceipts;
  console.log(`  got ${transactions.length} transactions, ${receipts.length} receipts in ${Date.now() - t0}ms`);

  const localRoot = computeMerkleRootOfBlock(transactions, receipts, encoding.EncodingVersion.V1);
  console.log('');
  console.log('  locally computed root :', localRoot);
  console.log('  prover-reported root  :', expected.root);
  const rootsMatch = localRoot.toLowerCase() === expected.root.toLowerCase();
  console.log('  MATCH                 :', rootsMatch ? 'YES' : 'NO');
  if (!rootsMatch) throw new Error('local root does not reproduce prover root');

  // Rebuild the Merkle path for the same transaction and check it against the prover's path.
  const leaves = transactions.map((tx: any, i: number) =>
    encoding.abiEncode(tx, receipts[i], encoding.EncodingVersion.V1).abi,
  );
  const tree = new KeccakMerkleTree(leaves);
  const localProof = tree.getProof(expected.txIndex);

  const sameLength = localProof.siblings.length === expected.siblingHashes.length;
  const samePath = sameLength && localProof.siblings.every(
    (s: any, i: number) =>
      s.hash.toLowerCase() === expected.siblingHashes[i].toLowerCase() &&
      s.isLeft === expected.siblingIsLeft[i],
  );
  console.log('');
  console.log('  locally rebuilt Merkle path matches prover path :', samePath ? 'YES' : 'NO');
  console.log('  path length                                     :', localProof.siblings.length);

  // The chain-info precompile is read directly; no proving service is contacted at any point.
  const ccProvider = new JsonRpcProvider(CC_RPC);
  const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
  const attested = await info.getLatestAttestedHeightAndHash(expected.chainKey);
  console.log('');
  console.log('  latest attested height on Creditcoin :', attested.height?.toString?.() ?? attested.height);

  if (!samePath) throw new Error('local Merkle path does not reproduce prover path');
  console.log('');
  console.log('RESULT: proof fully reconstructed locally. The hosted prover is not a dependency.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
