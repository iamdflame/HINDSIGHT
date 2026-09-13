/**
 * Write cover offers on every open claim that has none, so the Cover page has something to settle.
 *
 *   MARKET_KEY=0x… node src/cover-offers.ts [--payout 1] [--premium 0.05] [--dry-run]
 *
 * These are demonstration offers and the page says so: the house writes them on bounties the
 * repository documents as false, so whoever buys one is paid when the hunt settles the claim. That is
 * not a bet the house expects to win; it is the settlement path run in public with real money, once
 * per open claim, and it costs the house the payout each time somebody takes it. Idempotent: an open
 * claim that already has an unbought or live offer gets no second one.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { CC_RPC, EXPLORER, privateKey } from './config.ts';

const COVER_ABI = [
  'function offer(uint256 claimId, uint256 premium) payable returns (uint256)',
  'function offerCount() view returns (uint256)',
  'function offerOf(uint256) view returns ((uint256 claimId, address underwriter, address buyer, uint256 payout, uint256 premium, uint8 state))',
];
const REGISTRY_ABI = [
  'function claimCount() view returns (uint256)',
  'function assurance(uint256) view returns (uint8 status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
];

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(process.env.MARKET_KEY ?? privateKey(), cc);
  const cover = new Contract(d.contracts.Cover, COVER_ABI, wallet);
  const registry = new Contract(d.contracts.AbsenceRegistryV3, REGISTRY_ABI, cc);
  const payout = parseEther(get('--payout') ?? '1');
  const premium = parseEther(get('--premium') ?? '0.05');
  const dryRun = process.argv.includes('--dry-run');

  const nOffers = Number(await cover.offerCount());
  const covered = new Set<number>();
  for (let i = 0; i < nOffers; i++) {
    const o = await cover.offerOf(i);
    if (Number(o.state) === 1 || Number(o.state) === 2) covered.add(Number(o.claimId));
  }
  const nClaims = Number(await registry.claimCount());
  const now = Math.floor(Date.now() / 1000);
  let written = 0;
  console.log(`cover ${d.contracts.Cover} · underwriter ${wallet.address} (${formatEther(await cc.getBalance(wallet.address))} tCTC)`);
  for (let id = 0; id < nClaims; id++) {
    const a = await registry.assurance(id);
    if (Number(a.status) !== 1 || Number(a.openUntil) <= now) continue;
    if (covered.has(id)) {
      console.log(`  = claim #${id} already has cover on offer`);
      continue;
    }
    if (dryRun) {
      console.log(`  ~ would offer ${formatEther(payout)} tCTC on claim #${id} at ${formatEther(premium)}`);
      continue;
    }
    const tx = await cover.offer(id, premium, { value: payout });
    const rc = await tx.wait();
    written++;
    console.log(`  + offered ${formatEther(payout)} tCTC on claim #${id} at ${formatEther(premium)} premium  ${Number(rc.gasUsed).toLocaleString()} gas  ${EXPLORER}/tx/${tx.hash}`);
  }
  console.log(`  ${written} offer(s) written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
