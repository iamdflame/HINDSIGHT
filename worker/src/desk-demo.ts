/**
 * The desk, on-chain: one address paid, the same address refused.
 *
 * Usage:
 *   node src/desk-demo.ts [--fund 5]
 *
 * WHAT THIS HAS TO PROVE, AND WHAT IT MUST NOT FAKE
 * -------------------------------------------------
 * The claim is that a lender can refuse someone because of a fact on Ethereum that nobody in this
 * system authored. The honest demonstration of that has two halves, and only one of them can be a
 * transaction we send:
 *
 *   1. `borrow()` underwrites `msg.sender` and takes no subject argument, so the only address it can
 *      ever pay is the caller's. We can therefore show a real payout to an address we control.
 *
 *   2. The refusal has to be about a *real* liquidated borrower on Ethereum mainnet — an address
 *      whose key nobody here has. So the refusal is shown through `assess(subject, …)`, which is a
 *      `view` over the identical predicate `borrow` gates on. Both call `_assess`; there is no
 *      second implementation that could drift.
 *
 * Faking the second half by lending to an address we secretly marked would be the exact dishonesty
 * this project exists to avoid, so it is not done. The view call is the demonstration, and it is
 * reproducible by anyone against the deployed contract.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { CC_RPC, MIRROR, EXPLORER, CHAIN_KEY_ETH_MAINNET, VENUES, privateKey } from './config.ts';

const DESK_ABI = [
  'function createPolicy((uint8 kind, uint64 chainKey, uint64 window, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal) p) returns (uint256)',
  'function fund() payable',
  'function assess(address subject, uint256 policyId, uint256 principal) view returns (bool ok, uint8 reason)',
  'function borrow(uint256 policyId, uint256 principal)',
  'function policyCount() view returns (uint256)',
];

const REFUSAL = [
  'None',
  'NoSuchPolicy',
  'ArchiveTooShallow',
  'ClaimUnderHunt',
  'ProvenLiar',
  'NoBondedCleanliness',
  'DeskOutOfFunds',
];

function addr(name: string): string {
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const a = d.contracts[name];
  if (!a) throw new Error(`${name} not in deployments.json`);
  return a;
}

async function main() {
  const fundAmount = process.argv.includes('--fund')
    ? process.argv[process.argv.indexOf('--fund') + 1]
    : '5';

  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), cc);
  const desk = new Contract(addr('UnderwritingDesk'), DESK_ABI, wallet);

  const aave = VENUES[0]; // Aave V3 LiquidationCall
  const lies = JSON.parse(
    readFileSync(new URL('../../contracts/test/fixtures/lies.json', import.meta.url), 'utf8'),
  );

  console.log('the desk');
  console.log('  contract:', await desk.getAddress());

  // A policy that consults liquidations over the last 10,000 held blocks. BlankFile: silence is
  // acceptable, an Open or Refuted claim is not.
  const policy = {
    kind: 0,
    chainKey: CHAIN_KEY_ETH_MAINNET,
    window: 10_000,
    venue: aave.address,
    topic0: aave.topic0,
    subjectTopic: aave.subjectTopic,
    minBond: 0n,
    maxPrincipal: parseEther('2'),
  };

  let policyId = Number(await desk.policyCount());
  if (policyId === 0) {
    await (await desk.createPolicy(policy)).wait();
    policyId = 0;
    console.log('  policy  : 0 (BlankFile, Aave V3 LiquidationCall, 10,000-block window)');
  } else {
    policyId = 0;
    console.log('  policy  : 0 (already created)');
  }

  const balance = await cc.getBalance(await desk.getAddress());
  if (balance < parseEther('1')) {
    await (await desk.fund({ value: parseEther(fundAmount) })).wait();
    console.log(`  funded  : ${fundAmount} tCTC`);
  } else {
    console.log(`  holds   : ${formatEther(balance)} tCTC`);
  }

  // ---- half one: a real payout to an address the desk has nothing against ---------------------
  const borrower = Wallet.createRandom().connect(cc);
  await (await wallet.sendTransaction({ to: borrower.address, value: parseEther('0.5') })).wait();

  const before = await cc.getBalance(borrower.address);
  const asDeskBorrower = desk.connect(borrower) as any;
  const rc = await (await asDeskBorrower.borrow(policyId, parseEther('1'))).wait();
  const after = await cc.getBalance(borrower.address);

  console.log('\n  PAID');
  console.log('    borrower :', borrower.address, '(nothing is said about this address)');
  console.log('    received :', formatEther(after - before + rc.gasUsed * rc.gasPrice), 'tCTC');
  console.log('    tx       :', `${EXPLORER}/tx/${rc.hash}`);

  // ---- half two: the refusal, about an address nobody here controls ---------------------------
  // Subjects of the claims the hunter refuted: real Ethereum borrowers with a real liquidation.
  console.log('\n  REFUSED');
  let shown = 0;
  for (const planted of lies.planted) {
    const [ok, reason] = await desk.assess(planted.subject, policyId, parseEther('1'));
    if (ok) continue;
    console.log('    subject  :', planted.subject, '(a real Ethereum address, not ours)');
    console.log('    verdict  :', REFUSAL[Number(reason)]);
    console.log('    because  :', `${planted.counterexample} at block ${planted.counterexampleBlock}`);
    console.log('    reproduce:', `${EXPLORER}/address/${await desk.getAddress()}#readContract → assess`);
    if (++shown >= 2) break;
  }
  if (shown === 0) console.log('    (no refused subject yet — the hunter has not refuted a claim)');

  console.log('\n  Same desk, same policy. The difference is a transaction on Ethereum that');
  console.log('  nobody in this system wrote.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
