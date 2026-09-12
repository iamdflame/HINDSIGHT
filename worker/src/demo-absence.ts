/**
 * The negative-fact game, end to end on Creditcoin testnet, over a real Ethereum mainnet
 * liquidation that neither party created.
 *
 *   1. seal a gap-free span of mirrored Ethereum history
 *   2. a claimant stakes a bond on "this borrower was never liquidated in this span"
 *   3. a refuter destroys the claim with the borrower's real liquidation and takes the bond
 *
 * Nobody enumerates anything. The claim is cheap to make and cheap to disprove, which is what
 * makes it safe to believe the claims nobody bothered to disprove.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther, zeroPadValue } from 'ethers';
import sdk from '@gluwa/usc-sdk';
import {
  CC_RPC, ETH_RPC, MIRROR, REGISTRY, MIRROR_ABI, REGISTRY_ABI,
  CHAIN_KEY_ETH_MAINNET, AAVE_V3_POOL, TOPIC_LIQUIDATION_CALL, privateKey,
} from './config.ts';

const { proofProvider, encoding } = sdk as any;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = proofProvider.merkle;

// A real Aave V3 liquidation on Ethereum mainnet.
const LIQUIDATION_TX = '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61';
const BORROWER = '0xa63f5B1AcE5Ef4BcE91d3f12f31B8F2eA110B980';

async function main() {
  const cc = new JsonRpcProvider(CC_RPC);
  const claimant = new Wallet(privateKey(), cc);
  const refuter = Wallet.createRandom().connect(cc);

  const mirror = new Contract(MIRROR, MIRROR_ABI, claimant);
  const registry = new Contract(REGISTRY, REGISTRY_ABI, claimant);

  console.log('Negative facts about Ethereum, settled on Creditcoin\n');
  console.log('  claimant:', claimant.address);
  console.log('  refuter :', refuter.address, '(fresh key, funded below)');

  // Give the refuter only enough for gas; the point is that the bond is what they walk away with.
  await (await claimant.sendTransaction({ to: refuter.address, value: parseEther('5') })).wait();

  // 1 ---------------------------------------------------------------- seal the span
  // A claim is only meaningful over a range with no gaps, because a gap is exactly where a
  // contradicting transaction could sit unseen. Discover the contiguous run that actually
  // contains the evidence rather than assuming the archive is dense.
  const eth0 = new JsonRpcProvider(ETH_RPC);
  const evidenceBlock = (await eth0.getTransaction(LIQUIDATION_TX))!.blockNumber!;
  const lo = BigInt(evidenceBlock);
  const span = await mirror.contiguousFrom(CHAIN_KEY_ETH_MAINNET, lo, 5000);
  const hi = lo + BigInt(span) - 1n;
  console.log('\n1. sealing a gap-free run of mirrored history', lo.toString(), '..', hi.toString(),
              `(${span} blocks)`);
  const sealTx = await mirror.sealSpan(CHAIN_KEY_ETH_MAINNET, lo, hi);
  await sealTx.wait();
  const spanId = (await mirror.spanCount()) - 1n;
  console.log('   spanId:', spanId.toString(), '— every block in range proven present, no gaps');

  // 2 ------------------------------------------------------- assert a false clean record
  const subject = zeroPadValue(BORROWER, 32);
  console.log('\n2. claimant stakes 1 tCTC on a false statement:');
  console.log('   "' + BORROWER + ' was never liquidated on Aave V3 in this span"');
  const assertTx = await registry.assertAbsence(
    spanId, AAVE_V3_POOL, TOPIC_LIQUIDATION_CALL, subject, 3, 3600, { value: parseEther('1') },
  );
  const ar = await assertTx.wait();
  const claimId = (await registry.claimCount()) - 1n;
  console.log('   claimId:', claimId.toString(), '| tx:', ar?.hash);

  // 3 ------------------------------------------- refute with the borrower's real liquidation
  console.log('\n3. refuter rebuilds the evidence locally and destroys the claim');
  const eth = new JsonRpcProvider(ETH_RPC);
  const blockNumber = evidenceBlock;
  const { transactions, receipts } = await new SimpleBlockProvider(eth).getBlockWithReceipts(blockNumber);
  const leaves = transactions.map((t: any, i: number) =>
    encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi,
  );
  const idx = receipts.findIndex((r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === LIQUIDATION_TX.toLowerCase());
  const proof = new KeccakMerkleTree(leaves).getProof(idx);
  const siblings = proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
  console.log('   evidence: Ethereum mainnet block', blockNumber, 'tx index', idx, '(no prover used)');

  // Commit first. The evidence stays hidden, and the commitment binds the refuter's address, so
  // an observer who copies it from the mempool cannot produce a matching reveal.
  const salt = '0x' + '11'.repeat(32);
  const reg = registry.connect(refuter) as any;
  const commitment = await registry.commitmentFor(claimId, blockNumber, leaves[idx], siblings, salt, refuter.address);
  const ct = await reg.commitRefutation(commitment);
  await ct.wait();
  console.log('   committed :', commitment.slice(0, 18) + '…  (evidence still secret)');

  // A commitment must age one block before it can be revealed.
  await new Promise((r) => setTimeout(r, 16_000));

  const before = await cc.getBalance(refuter.address);
  const refuteTx = await reg.revealRefutation(claimId, blockNumber, leaves[idx], siblings, salt);
  const rr = await refuteTx.wait();
  const after = await cc.getBalance(refuter.address);

  const a = await registry.assurance(claimId);
  const c = await registry.claimOf(claimId);
  console.log('   reveal tx :', rr?.hash);
  console.log('   gas used  :', rr?.gasUsed?.toString());
  console.log('   claim status:', ['None', 'Open', 'Refuted', 'Standing'][Number(a.status)]);
  console.log('   holds()    :', await registry.holds(claimId), '(unrefuted? no — it was refuted)');
  console.log('   assurance  : bond', formatEther(a.bond), 'tCTC over blocks', a.spanFrom.toString(), '..', a.spanTo.toString());
  console.log('   refuter net:', formatEther(after - before), 'tCTC (bond, less gas)');
  console.log('\n   https://creditcoin-testnet.blockscout.com/tx/' + rr?.hash);
}

main().catch((e) => { console.error('FAILED:', e.shortMessage ?? e.message); process.exit(1); });
