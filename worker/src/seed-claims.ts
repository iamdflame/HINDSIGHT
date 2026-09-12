/**
 * Seed the registry with live, interactive claims so the watch has something real to act on:
 * one false claim a visitor can genuinely refute and collect, and one true claim that will stand.
 *
 * Nothing here is staged data — the venue, the borrower and the counterexample are all real
 * Ethereum mainnet facts; the only thing we create is the wager about them.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, zeroPadValue } from 'ethers';
import {
  CC_RPC, ETH_RPC, MIRROR, REGISTRY, MIRROR_ABI, REGISTRY_ABI,
  CHAIN_KEY_ETH_MAINNET, AAVE_V3_POOL, TOPIC_REPAY, TOPIC_LIQUIDATION_CALL, privateKey, EXPLORER,
} from './config.ts';

async function main() {
  const cc = new JsonRpcProvider(CC_RPC);
  const w = new Wallet(privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, w);
  const registry = new Contract(REGISTRY, REGISTRY_ABI, w);
  const eth = new JsonRpcProvider(ETH_RPC);

  // Seal the 99-block run that a single continuity proof notarised.
  const from = 25961802n;
  const span = await mirror.contiguousFrom(CHAIN_KEY_ETH_MAINNET, from, 5000);
  const to = from + BigInt(span) - 1n;
  console.log(`sealing ${from}..${to} (${span} blocks)`);
  const sealed = await (await mirror.sealSpan(CHAIN_KEY_ETH_MAINNET, from, to)).wait();
  const spanId = (await mirror.spanCount()) - 1n;
  console.log('  spanId', spanId.toString(), '·', `${EXPLORER}/tx/${sealed?.hash}`);

  // Find a real borrower who actually repaid inside that span — the claim about them will be false.
  const logs = await eth.getLogs({
    address: AAVE_V3_POOL, topics: [TOPIC_REPAY],
    fromBlock: Number(from), toBlock: Number(to),
  });
  if (logs.length === 0) throw new Error('no Repay events in the sealed span; pick another range');
  const borrower = '0x' + logs[0].topics[2].slice(-40);
  console.log(`\nfound a real repayment by ${borrower} in block ${logs[0].blockNumber}`);

  const window = 7 * 24 * 60 * 60; // a week, so the claim stays open for judging

  // 1 — a FALSE claim. A visitor can hunt the counterexample and take the bond.
  const falseTx = await registry.assertAbsence(
    spanId, AAVE_V3_POOL, TOPIC_REPAY, zeroPadValue(borrower, 32), 2, window,
    { value: parseEther('2') },
  );
  const fr = await falseTx.wait();
  console.log(`\nFALSE claim staked (2 tCTC): "${borrower} never repaid on Aave V3 in this span"`);
  console.log('  claimId', (await registry.claimCount()) - 1n, '·', `${EXPLORER}/tx/${fr?.hash}`);

  // 2 — a TRUE claim. An address with no Aave liquidation in this span; it should survive.
  const cleanAddr = '0x000000000000000000000000000000000000dEaD';
  const trueTx = await registry.assertAbsence(
    spanId, AAVE_V3_POOL, TOPIC_LIQUIDATION_CALL, zeroPadValue(cleanAddr, 32), 3, window,
    { value: parseEther('1') },
  );
  const tr = await trueTx.wait();
  console.log(`\nTRUE claim staked (1 tCTC): "${cleanAddr} was never liquidated in this span"`);
  console.log('  claimId', (await registry.claimCount()) - 1n, '·', `${EXPLORER}/tx/${tr?.hash}`);

  console.log('\nclaims now:', (await registry.claimCount()).toString());
}

main().catch((e) => { console.error('FAILED:', e.shortMessage ?? e.message); process.exit(1); });
