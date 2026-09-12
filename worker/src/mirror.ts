/**
 * Submits a real Ethereum mainnet transaction proof to the mirror on Creditcoin, and retains
 * every block commitment the proof carried.
 *
 * Usage: node src/mirror.ts <ethereum-mainnet-tx-hash>
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAIN_KEY_ETH_MAINNET, privateKey, fetchProof } from './config.ts';

const txHash = process.argv[2] ?? '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61';

async function main() {
  const provider = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), provider);
  const mirror = new Contract(MIRROR, MIRROR_ABI, wallet);

  console.log('Mirroring Ethereum mainnet history onto Creditcoin');
  console.log('  mirror   :', MIRROR);
  console.log('  source tx:', txHash, '(Ethereum mainnet — a contract we do not control)');

  // Fetched fresh: a continuity proof anchors to whichever attestation or checkpoint was current
  // when it was built, and attestations are pruned into sparser checkpoints as they age.
  const p = await fetchProof(CHAIN_KEY_ETH_MAINNET, txHash);
  const roots: string[] = p.continuityProof.roots;
  const siblings = p.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));

  console.log('  block    :', p.headerNumber);
  console.log('  carries  :', roots.length, 'block commitments →', p.headerNumber, '..', p.headerNumber + roots.length - 1);

  const before = await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET);

  const tx = await mirror.mirror(
    CHAIN_KEY_ETH_MAINNET,
    p.headerNumber,
    p.txBytes,
    p.merkleProof.root,
    siblings,
    p.continuityProof.lowerEndpointDigest,
    roots,
  );
  console.log('\n  submitted:', tx.hash);
  const rc = await tx.wait();
  console.log('  status   :', rc?.status === 1 ? 'SUCCESS' : 'FAILED');
  console.log('  gas used :', rc?.gasUsed?.toString());

  const after = await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET);
  const added = Number(after) - Number(before);
  console.log('\n  blocks mirrored by this call :', added);
  console.log('  total mirrored               :', after.toString());
  console.log('  gas per block retained       :', rc ? Math.round(Number(rc.gasUsed) / Math.max(added, 1)) : 'n/a');
  console.log('\n  explorer: https://creditcoin-testnet.blockscout.com/tx/' + tx.hash);
}

main().catch((e) => {
  console.error('FAILED:', e.shortMessage ?? e.message);
  process.exit(1);
});
