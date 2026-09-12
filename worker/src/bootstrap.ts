/**
 * One-command bootstrap of a fresh deployment: notarise real Ethereum history, seal a gap-free
 * span, and stake the live claims the interface needs.
 *
 * Reproducibility matters here — anyone should be able to stand this up from scratch and get the
 * same archive, rather than relying on state we happened to create by hand.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, zeroPadValue } from 'ethers';
import {
  CC_RPC, ETH_RPC, MIRROR, REGISTRY, MIRROR_ABI, REGISTRY_ABI, CHAIN_KEY_ETH_MAINNET,
  AAVE_V3_POOL, TOPIC_REPAY, TOPIC_LIQUIDATION_CALL, privateKey, EXPLORER, fetchProof,
} from './config.ts';

// Real Aave V3 mainnet transactions. We deploy nothing on Ethereum and control none of this.
const SEEDS = [
  '0xcb9cd732d95ea9632c02add1afa7d66b5fd94f0ae48a4fdee6f88b2142149c00', // repay   — ~99 roots
  '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61', // liquidation — ~27 roots
];

async function main() {
  const cc = new JsonRpcProvider(CC_RPC);
  const w = new Wallet(privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, w);
  const registry = new Contract(REGISTRY, REGISTRY_ABI, w);
  const eth = new JsonRpcProvider(ETH_RPC);

  console.log('Bootstrapping', MIRROR);

  // 1 — notarise
  for (const tx of SEEDS) {
    const p = await fetchProof(CHAIN_KEY_ETH_MAINNET, tx);
    const sib = p.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
    const r = await (await mirror.mirror(
      CHAIN_KEY_ETH_MAINNET, p.headerNumber, p.txBytes, p.merkleProof.root, sib,
      p.continuityProof.lowerEndpointDigest, p.continuityProof.roots,
    )).wait();
    console.log(`  notarised ${p.continuityProof.roots.length} blocks from ${p.headerNumber}  (${r?.gasUsed} gas)`);
  }
  const total = await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET);
  console.log('  total blocks held:', total.toString());

  // 2 — seal the long run
  const from = 25961802n;
  const span = await mirror.contiguousFrom(CHAIN_KEY_ETH_MAINNET, from, 5000);
  const to = from + BigInt(span) - 1n;
  await (await mirror.sealSpan(CHAIN_KEY_ETH_MAINNET, from, to)).wait();
  const spanId = (await mirror.spanCount()) - 1n;
  console.log(`  sealed span #${spanId} ${from}..${to} (${span} blocks)`);

  // 3 — stake claims against real borrowers
  const logs = await eth.getLogs({ address: AAVE_V3_POOL, topics: [TOPIC_REPAY], fromBlock: Number(from), toBlock: Number(to) });
  if (logs.length === 0) throw new Error('no Repay events in the sealed span');
  const borrower = '0x' + logs[0].topics[2].slice(-40);
  const week = 7 * 24 * 3600;

  const f = await (await registry.assertAbsence(
    spanId, AAVE_V3_POOL, TOPIC_REPAY, zeroPadValue(borrower, 32), 2, week, { value: parseEther('2') },
  )).wait();
  console.log(`  FALSE claim staked (2 tCTC) about ${borrower} — refutable`);
  console.log('   ', `${EXPLORER}/tx/${f?.hash}`);

  const t = await (await registry.assertAbsence(
    spanId, AAVE_V3_POOL, TOPIC_LIQUIDATION_CALL,
    zeroPadValue('0x000000000000000000000000000000000000dEaD', 32), 3, week, { value: parseEther('1') },
  )).wait();
  console.log('  TRUE claim staked (1 tCTC) about 0x…dEaD — should stand');
  console.log('   ', `${EXPLORER}/tx/${t?.hash}`);

  console.log('\nclaims:', (await registry.claimCount()).toString(), '· spans:', (await mirror.spanCount()).toString());
}

main().catch((e) => { console.error('FAILED:', e.shortMessage ?? e.message); process.exit(1); });
