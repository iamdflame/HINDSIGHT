/**
 * Seed the absence market: seal spans over the archive, then stake claims worth hunting.
 *
 * Usage:
 *   node src/seed-market.ts [--spans 12] [--lies 6] [--clean 24] [--window 7200] [--dry-run]
 *
 * WHAT A MARKET NEEDS THAT A DEMO DOES NOT
 * ----------------------------------------
 * One bounty on one lie is a screenshot. For `Standing` to mean anything, the board has to contain
 * claims that are actually false alongside claims that are actually true, with no marking to tell
 * them apart, so that what separates them is somebody doing the work of looking.
 *
 * So this stakes two populations:
 *
 *   lies   - claims that address X had no liquidation/repayment in a range where, on Ethereum
 *            mainnet, it demonstrably did. Each is refutable by anyone, and the hunter will refute
 *            them. Subjects come from the corpus, so every lie is anchored to a real transaction.
 *
 *   clean  - claims about addresses with no such event in the range. These should stand, and the
 *            fact that they stand is the only thing `Standing` ever asserts.
 *
 * Nothing on-chain distinguishes the two. That is deliberate: a board where the lies were labelled
 * would be theatre.
 *
 * SPANS
 * -----
 * A claim binds a list of adjacent sealed spans. Sealing walks one SLOAD per block and is capped at
 * `MAX_SEAL_WINDOW`, so a week of Ethereum is a list, not a single span -- which is exactly the
 * limitation `AbsenceRegistryV2` was deployed to remove.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther } from 'ethers';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  CC_RPC,
  MIRROR,
  MIRROR_ABI,
  EXPLORER,
  CHAIN_KEY_ETH_MAINNET,
  VENUES,
  privateKey,
} from './config.ts';

const REGISTRY_V2_ABI = [
  'function assertAbsence(uint256[] spanIds, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 window) payable returns (uint256)',
  'function claimCount() view returns (uint256)',
  'function MIN_BOND() view returns (uint256)',
];

const FIXTURES = new URL('../../contracts/test/fixtures/mainnet/', import.meta.url);
const LIES = new URL('../../contracts/test/fixtures/lies.json', import.meta.url);

type Planted = {
  claimId: number;
  venue: string;
  topic0: string;
  subject: string;
  spanFrom: number;
  spanTo: number;
  /** The mainnet transaction that makes this claim false. */
  counterexample: string;
  counterexampleBlock: number;
  bond: string;
};

function registryAddress(): string {
  const i = process.argv.indexOf('--registry');
  if (i >= 0) return process.argv[i + 1];
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const a = d.contracts.AbsenceRegistryV2;
  if (!a) throw new Error('AbsenceRegistryV2 not in deployments.json — run deploy-v2.ts first');
  return a;
}

/** Corpus entries, which carry both the subject and the transaction that proves the event. */
function corpus() {
  const out: { venueKey: string; subject: string; block: number; txHash: string }[] = [];
  if (!existsSync(FIXTURES)) return out;
  for (const venue of readdirSync(FIXTURES)) {
    const dir = new URL(`${venue}/`, FIXTURES);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      if (!j.subject) continue;
      out.push({ venueKey: venue, subject: j.subject, block: j.headerNumber, txHash: j.txHash });
    }
  }
  return out;
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function main() {
  const argv = process.argv;
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const wantSpans = Number(get('--spans') ?? 12);
  const wantLies = Number(get('--lies') ?? 6);
  const wantClean = Number(get('--clean') ?? 24);
  const window = Number(get('--window') ?? 7200); // 2h: long enough for a judge to watch a hunt
  const dryRun = argv.includes('--dry-run');

  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, wallet);
  const registry = new Contract(registryAddress(), REGISTRY_V2_ABI, wallet);

  const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
  const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));
  const maxWindow = Number(await mirror.MAX_SEAL_WINDOW());

  console.log('seeding the absence market');
  console.log('  registry:', await registry.getAddress());
  console.log('  archive :', low.toLocaleString(), '..', high.toLocaleString());
  console.log('  spans   :', wantSpans, 'x', maxWindow, 'blocks');
  if (dryRun) console.log('  DRY RUN');

  // ---- find the longest usable run, then seal spans inside it ------------------------------
  //
  // An empty Ethereum block has no transactions, so its transaction Merkle root genuinely is
  // zero -- and zero is also this contract's "not present" sentinel. Such a height therefore
  // reads as a gap forever and cannot be sealed across. There are 24 of them in this archive,
  // which cuts it into 25 runs. A claim has to live inside one run, so pick the longest.
  //
  // Nothing unsound follows from skipping them: a block with no transactions cannot hide the
  // transaction that would refute a claim. It is an expressiveness limit, not a soundness one.
  const runs: { start: number; len: number }[] = [];
  {
    let cur = low;
    let acc = 0;
    let start = low;
    let guard = 0;
    while (cur <= high && guard++ < 500) {
      const run = Number(await mirror.contiguousFrom(CHAIN_KEY_ETH_MAINNET, cur, maxWindow));
      if (run === 0) {
        if (acc) runs.push({ start, len: acc });
        acc = 0;
        cur++;
        start = cur;
        continue;
      }
      acc += run;
      cur += run;
      if (run < maxWindow && cur <= high) {
        runs.push({ start, len: acc });
        acc = 0;
        cur++;
        start = cur;
      }
    }
    if (acc) runs.push({ start, len: acc });
  }
  runs.sort((a, b) => b.len - a.len);
  const best = runs[0];
  console.log(
    `  ${runs.length} runs between empty blocks; longest ${best.len.toLocaleString()} blocks ` +
      `(${((best.len * 12) / 3600).toFixed(1)}h) at ${best.start.toLocaleString()}`,
  );

  const spans: { id: number; from: number; to: number }[] = [];
  const spanIds: number[] = [];
  for (let i = 0; i < wantSpans; i++) {
    const from = best.start + i * maxWindow;
    const to = Math.min(from + maxWindow - 1, best.start + best.len - 1);
    if (from > to) break;

    if (dryRun) {
      console.log(`  ~ would seal ${from}..${to}`);
      continue;
    }
    const rc = await (await mirror.sealSpan(CHAIN_KEY_ETH_MAINNET, from, to)).wait();
    const id = Number(await mirror.spanCount()) - 1;
    spans.push({ id, from, to });
    spanIds.push(id);
    console.log(`  sealed span ${id}: ${from}..${to}  ${Number(rc.gasUsed).toLocaleString()} gas`);
    if (to === best.start + best.len - 1) break;
  }
  if (dryRun) return;
  if (spans.length === 0) throw new Error('no spans sealed');

  const spanFrom = spans[0].from;
  const spanTo = spans[spans.length - 1].to;
  console.log(
    `  claims will cover ${spanFrom}..${spanTo} ` +
      `(${(spanTo - spanFrom + 1).toLocaleString()} blocks = ${(((spanTo - spanFrom + 1) * 12) / 86400).toFixed(2)} days)`,
  );

  // ---- plant lies -------------------------------------------------------------------------
  const inRange = corpus().filter((c) => c.block >= spanFrom && c.block <= spanTo);
  const bySubject = new Map<string, (typeof inRange)[number]>();
  for (const c of inRange) if (!bySubject.has(c.subject)) bySubject.set(c.subject, c);
  const candidates = [...bySubject.values()];
  console.log(`\n  ${candidates.length} corpus subjects sit inside the claimed range`);

  const planted: Planted[] = [];
  let staked = 0;

  for (const c of candidates.slice(0, wantLies)) {
    const v = VENUES.find((x) => x.key === c.venueKey)!;
    // A larger bond on a lie than on a truth, so the board's top row is worth hunting.
    const bond = parseEther('0.5');
    const rc = await (
      await registry.assertAbsence(spanIds, v.address, v.topic0, pad32(c.subject), v.subjectTopic, window, {
        value: bond,
      })
    ).wait();
    const claimId = Number(await registry.claimCount()) - 1;
    planted.push({
      claimId,
      venue: v.address,
      topic0: v.topic0,
      subject: c.subject,
      spanFrom,
      spanTo,
      counterexample: c.txHash,
      counterexampleBlock: c.block,
      bond: bond.toString(),
    });
    staked++;
    console.log(
      `  LIE   claim ${String(claimId).padStart(3)}  ${v.label}  ${c.subject.slice(0, 10)}…  ` +
        `refutable by ${c.txHash.slice(0, 12)}… at ${c.block}  ${Number(rc.gasUsed).toLocaleString()} gas`,
    );
  }

  // ---- plant claims that should stand ------------------------------------------------------
  // Addresses derived from a fixed string: nothing has ever happened at them, which is exactly
  // what makes them the honest half of the board.
  for (let i = 0; i < wantClean; i++) {
    const subject = '0x' + Buffer.from(`hindsight-clean-${i}`.padEnd(20, '.')).toString('hex');
    const v = VENUES[i % VENUES.length];
    const rc = await (
      await registry.assertAbsence(spanIds, v.address, v.topic0, pad32(subject), v.subjectTopic, window, {
        value: parseEther('0.05'),
      })
    ).wait();
    const claimId = Number(await registry.claimCount()) - 1;
    staked++;
    console.log(
      `  CLEAN claim ${String(claimId).padStart(3)}  ${v.label}  ${subject.slice(0, 10)}…  ` +
        `${Number(rc.gasUsed).toLocaleString()} gas`,
    );
  }

  // The planted lies are recorded so the evidence is auditable: anyone can check that each claim
  // really is false, and that the hunter found it rather than being told.
  mkdirSync(new URL('.', LIES), { recursive: true });
  writeFileSync(LIES, JSON.stringify({ registry: await registry.getAddress(), planted }, null, 1) + '\n');

  console.log(`\n  ${staked} claims staked, ${planted.length} of them false`);
  console.log(`  ${EXPLORER}/address/${await registry.getAddress()}`);
  console.log('  recorded the planted lies in contracts/test/fixtures/lies.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
