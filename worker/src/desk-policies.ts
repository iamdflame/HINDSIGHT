/**
 * Create the desk's production policies, idempotently.
 *
 * Usage:
 *   node src/desk-policies.ts [--fund 10]
 *
 * Five policies, all over ninety days of Ethereum mainnet (648,000 blocks at 12s). `BlankFile` is the
 * default and appears first: silence is silence; a refutation or a listed event inside the window
 * blocks, and so does an open claim. It answers questions and never lends -- there is no bond under
 * silence to size a loan against. The two `BondedClean` policies each need a standing no-event claim
 * that covers the whole window, ends within a week of the head, and whose *unrecoverable* half covers
 * the principal -- the expensive kind of clean, and never the default.
 *
 * Policy creation is permissionless -- a policy only chooses which public facts are read -- so running
 * this again adds nothing if an identical policy already exists.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { CC_RPC, CHAIN_KEY_ETH_MAINNET, VENUES, privateKey } from './config.ts';

const DESK_ABI = [
  'function createPolicy((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal) p) returns (uint256)',
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal))',
  'function fund() payable',
];

const NINETY_DAYS = 648_000;
/** A BondedClean claim may end up to a week below the archive head and still count. */
const ONE_WEEK = 50_400;
/** One loan per address per policy, no repayment path: a small principal keeps a demo lender a demo. */
const MAX_PRINCIPAL = parseEther('1');
/**
 * Utuh's sizing rule lives in the desk: a loan may not exceed ten times what a liar could not recover.
 * A policy whose `minBond` floor is always above `principal / 10` never lets that rule speak, so the
 * fifth policy sets the floor low and the cap high enough that the bond -- not the policy -- is what
 * decides how much an address can borrow. Both are filed: the same desk, two prices of clean.
 */
const SIZED_MIN_BOND = parseEther('0.25');
const SIZED_MAX_PRINCIPAL = parseEther('5');

async function main() {
  const fundArg = process.argv.indexOf('--fund');
  const fund = fundArg >= 0 ? process.argv[fundArg + 1] : '10';
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const cc = new JsonRpcProvider(CC_RPC);
  const desk = new Contract(d.contracts.UnderwritingDesk, DESK_ABI, new Wallet(privateKey(), cc));

  const v = (key: string) => VENUES.find((x) => x.key === key)!;
  const wanted = [
    { kind: 0, venue: v('aave-liquidations'), minBond: 0n, maxStaleness: 0, label: 'BlankFile · Aave V3 LiquidationCall' },
    { kind: 1, venue: v('aave-liquidations'), minBond: parseEther('1'), maxStaleness: ONE_WEEK, label: 'BondedClean · Aave V3 LiquidationCall' },
    { kind: 0, venue: v('morpho-liquidates'), minBond: 0n, maxStaleness: 0, label: 'BlankFile · Morpho Blue Liquidate' },
    { kind: 0, venue: v('compound-absorbs'), minBond: 0n, maxStaleness: 0, label: 'BlankFile · Compound V3 AbsorbDebt' },
    {
      kind: 1,
      venue: v('aave-liquidations'),
      minBond: SIZED_MIN_BOND,
      maxStaleness: ONE_WEEK,
      maxPrincipal: SIZED_MAX_PRINCIPAL,
      label: 'BondedClean · Aave V3 · sized by enforceable loss',
    },
  ] as { kind: number; venue: (typeof VENUES)[number]; minBond: bigint; maxStaleness: number; maxPrincipal?: bigint; label: string }[];

  const n = Number(await desk.policyCount());
  const existing = await Promise.all(Array.from({ length: n }, (_, i) => desk.policyOf(i)));
  let created = n;
  for (const w of wanted) {
    const dup = existing.findIndex(
      (p: any) =>
        Number(p.kind) === w.kind && Number(p.window) === NINETY_DAYS && Number(p.maxStaleness) === w.maxStaleness && p.venue.toLowerCase() === w.venue.address.toLowerCase() &&
        p.topic0 === w.venue.topic0 && BigInt(p.minBond) === w.minBond && BigInt(p.maxPrincipal) === (w.maxPrincipal ?? MAX_PRINCIPAL),
    );
    if (dup >= 0) {
      console.log(`  = policy ${dup} ${w.label} exists`);
      continue;
    }
    await (
      await desk.createPolicy({
        kind: w.kind,
        chainKey: CHAIN_KEY_ETH_MAINNET,
        window: NINETY_DAYS,
        maxStaleness: w.maxStaleness,
        venue: w.venue.address,
        topic0: w.venue.topic0,
        subjectTopic: w.venue.subjectTopic,
        minBond: w.minBond,
        maxPrincipal: w.maxPrincipal ?? MAX_PRINCIPAL,
      })
    ).wait();
    // Numbered locally: a load-balanced RPC can answer policyCount() from a node a block behind.
    console.log(`  + policy ${created++} ${w.label}, 90 days`);
  }

  const bal = await cc.getBalance(await desk.getAddress());
  if (bal < parseEther(fund)) {
    await (await desk.fund({ value: parseEther(fund) - bal })).wait();
    console.log(`  funded to ${fund} tCTC`);
  } else console.log(`  holds ${(Number(bal) / 1e18).toFixed(2)} tCTC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
