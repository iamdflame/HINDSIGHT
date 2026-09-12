/**
 * The claim this project rests on.
 *
 * Verify a real Ethereum mainnet transaction against mirrored history on Creditcoin:
 *   - without a continuity proof
 *   - without the block-prover precompile
 *   - without contacting Gluwa's proving service at all
 *
 * The Merkle path is rebuilt locally from a public Ethereum node. The only thing consulted on
 * Creditcoin is a stored block root that anyone could have put there.
 *
 * Usage: node src/verify-offline.ts <ethereum-mainnet-tx-hash>
 */
import { JsonRpcProvider, Contract } from 'ethers';
import sdk from '@gluwa/usc-sdk';
import { CC_RPC, ETH_RPC, MIRROR, MIRROR_ABI, CHAIN_KEY_ETH_MAINNET } from './config.ts';

const { proofProvider, encoding } = sdk as any;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = proofProvider.merkle;

const txHash = process.argv[2] ?? '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61';

async function main() {
  console.log('Verifying Ethereum mainnet history with the proving service switched off');
  console.log('  prover contacted : NO');
  console.log('  precompile called: NO');
  console.log('  tx               :', txHash);

  const eth = new JsonRpcProvider(ETH_RPC);
  const blockProvider = new SimpleBlockProvider(eth);

  const tx = await eth.getTransaction(txHash);
  if (!tx || tx.blockNumber == null) throw new Error('transaction not found on Ethereum');
  const blockNumber = tx.blockNumber;
  console.log('  block            :', blockNumber);

  const cc = new JsonRpcProvider(CC_RPC);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  const mirrored = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, blockNumber);
  console.log('  block mirrored   :', mirrored);
  if (!mirrored) throw new Error(`block ${blockNumber} is not mirrored yet — run: node src/mirror.ts ${txHash}`);

  // Rebuild the leaf and its Merkle path from public Ethereum data alone.
  const withReceipts = await blockProvider.getBlockWithReceipts(blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this RPC');
  const { transactions, receipts } = withReceipts;

  const leaves = transactions.map((t: any, i: number) =>
    encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi,
  );
  const idx = receipts.findIndex(
    (r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase(),
  );
  if (idx < 0) throw new Error('transaction not present in fetched block');

  const tree = new KeccakMerkleTree(leaves);
  const proof = tree.getProof(idx);
  const siblings = proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));

  console.log('  locally rebuilt path length:', siblings.length);

  // Both entry points, because they must agree on the verdict and differ only in how they
  // report failure. verifyOrRevert mirrors the precompile (reverts); tryVerify returns a boolean.
  const txIndex: bigint = await mirror.verifyOrRevert(CHAIN_KEY_ETH_MAINNET, blockNumber, leaves[idx], siblings);
  const [valid, alsoIndex] = await mirror.tryVerify(CHAIN_KEY_ETH_MAINNET, blockNumber, leaves[idx], siblings);
  if (!valid || alsoIndex !== txIndex) throw new Error('verifyOrRevert and tryVerify disagreed');

  const gas = await mirror.verifyOrRevert.estimateGas(
    CHAIN_KEY_ETH_MAINNET, blockNumber, leaves[idx], siblings,
  ).catch(() => null);

  console.log('');
  console.log('  VERIFIED         :', valid, '(verifyOrRevert and tryVerify agree)');
  console.log('  txIndex in block :', txIndex.toString());
  console.log('  local index      :', idx, idx === Number(txIndex) ? '(agrees)' : '(MISMATCH)');
  if (gas) console.log('  gas if called on-chain:', gas.toString());
  console.log('');
  console.log(valid
    ? 'RESULT: a real mainnet transaction verified on Creditcoin with no oracle in the loop.'
    : 'RESULT: verification FAILED.');
  if (!valid) process.exit(1);
}

main().catch((e) => { console.error('FAILED:', e.shortMessage ?? e.message); process.exit(1); });
