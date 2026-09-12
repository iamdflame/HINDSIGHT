/**
 * The hunter: a searcher that refutes false absence claims without a human.
 *
 * Usage:
 *   node src/hunter.ts [--once] [--interval 60] [--registry <address>] [--dry-run]
 *
 * WHY THIS IS THE LOAD-BEARING PART OF THE ABSENCE MARKET
 * ------------------------------------------------------
 * `Standing` means "nobody refuted this while a bond was at risk". That sentence is only worth
 * anything if somebody was actually looking. One human refuting one claim for a demo does not
 * establish that; a process that hunts every open claim on a loop does.
 *
 * And the silence matters as much as the catches. When the hunter scans a claim and finds no
 * contradicting log, it does nothing at all -- and that nothing, repeated over a challenge window,
 * is precisely the economic fact the registry records. The hunter is the clock.
 *
 * HOW A REFUTATION IS PRODUCED
 * ----------------------------
 *   1. read every Open claim from the registry
 *   2. scan the venue's logs across the claim's own snapshotted span, for its topic0 and subject
 *   3. if a log exists, rebuild that block's Merkle tree from a public Ethereum node and take the
 *      path for the offending transaction -- no prover, because the block is already mirrored
 *   4. commit, wait for the commitment to age, reveal, take the bond
 *
 * Step 3 uses the archive rather than the proving service on purpose: refutation has to stay cheap
 * and always-available, or the incentive argument that makes `Standing` meaningful collapses the
 * first time the prover has an outage.
 *
 * FRONT-RUNNING
 * -------------
 * The commitment binds `msg.sender`, so an observer who copies it from the mempool cannot reveal
 * against it. This is why the registry has no one-shot `refute()` and why the hunter must always
 * pay for two transactions.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { readFileSync } from 'node:fs';
import {
  CC_RPC,
  ETH_RPC,
  MIRROR,
  MIRROR_ABI,
  EXPLORER,
  CHAIN_KEY_ETH_MAINNET,
  VENUES,
  privateKey,
  getLogsChunked,
} from './config.ts';

const REGISTRY_V2_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status))',
  'function commitmentFor(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt, address refuter) pure returns (bytes32)',
  'function commitRefutation(bytes32 commitment)',
  'function revealRefutation(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt)',
  'function finalize(uint256 claimId)',
  'function assurance(uint256 claimId) view returns (uint8 status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
];

const STATUS = ['None', 'Open', 'Refuted', 'Standing'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).proofProvider ? sdkMod : (sdkMod as any).default;
const { proofProvider, encoding } = sdk;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = proofProvider.merkle;

type Claim = {
  id: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  spanFrom: number;
  spanTo: number;
  bondStaked: bigint;
  openUntil: number;
  status: number;
};

function registryAddress(): string {
  const i = process.argv.indexOf('--registry');
  if (i >= 0) return process.argv[i + 1];
  if (process.env.REGISTRY_V2) return process.env.REGISTRY_V2;
  const deployments = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const a = deployments.contracts.AbsenceRegistryV2 ?? deployments.contracts.AbsenceRegistry;
  if (!a) throw new Error('no registry address: pass --registry or set REGISTRY_V2');
  return a;
}

async function openClaims(registry: Contract): Promise<Claim[]> {
  const n = Number(await registry.claimCount());
  const out: Claim[] = [];
  for (let i = 0; i < n; i++) {
    const c = await registry.claimOf(i);
    if (Number(c.status) !== 1) continue; // only Open claims can be refuted
    out.push({
      id: i,
      venue: c.venue,
      topic0: c.topic0,
      subject: c.subject,
      subjectTopic: Number(c.subjectTopic),
      spanFrom: Number(c.spanFrom),
      spanTo: Number(c.spanTo),
      bondStaked: c.bondStaked,
      openUntil: Number(c.openUntil),
      status: Number(c.status),
    });
  }
  return out;
}

/** Find a transaction inside the claim's span that contradicts it. */
async function findCounterexample(eth: JsonRpcProvider, c: Claim) {
  const topics: (string | null)[] = [c.topic0];
  if (c.subjectTopic > 0) {
    for (let i = 1; i < c.subjectTopic; i++) topics.push(null);
    topics.push(c.subject);
  }

  const logs = await getLogsChunked(eth as any, { address: c.venue, topics }, c.spanFrom, c.spanTo);
  return logs.length > 0 ? logs[0] : null;
}

/** Rebuild the block locally and take the path for one transaction. No prover involved. */
async function pathFor(eth: JsonRpcProvider, blockNumber: number, txHash: string) {
  const withReceipts = await new SimpleBlockProvider(eth).getBlockWithReceipts(blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this RPC (archive access may be required)');
  const { transactions, receipts } = withReceipts;

  const leaves = transactions.map((t: any, i: number) => encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi);
  const idx = receipts.findIndex((r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase());
  if (idx < 0) throw new Error('transaction not present in the rebuilt block');

  const proof = new KeccakMerkleTree(leaves).getProof(idx);
  return {
    txBytes: leaves[idx],
    siblings: proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })),
    index: idx,
  };
}

async function hunt(registry: Contract, mirror: Contract, eth: JsonRpcProvider, dryRun: boolean) {
  const claims = await openClaims(registry);
  const now = Math.floor(Date.now() / 1000);
  console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${claims.length} open claim(s)`);

  for (const c of claims) {
    const label = `claim ${String(c.id).padStart(3)}`;
    const left = c.openUntil - now;

    // Distinguish "scanned and found nothing" from "could not scan". Only the first is evidence.
    let log: any = null;
    try {
      log = await findCounterexample(eth, c);
    } catch (e) {
      console.log(`  ${label}  ! COULD NOT SCAN — ${(e as Error).message.slice(0, 120)}`);
      console.log(`  ${label}    (this is not silence: the claim was never actually checked)`);
      continue;
    }

    if (!log) {
      // The silence is the product. Nothing is written, and the window keeps running.
      console.log(`  ${label}  ${c.spanFrom}..${c.spanTo}  no counterexample  (${Math.max(left, 0)}s left)`);
      continue;
    }

    console.log(`  ${label}  counterexample: ${log.transactionHash.slice(0, 12)}… at block ${log.blockNumber}`);

    if (!(await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, log.blockNumber))) {
      console.log(`  ${label}  ! block ${log.blockNumber} is not mirrored — cannot refute without notarising it first`);
      continue;
    }

    if (dryRun) {
      console.log(`  ${label}  (dry run: would commit and reveal)`);
      continue;
    }

    try {
      const { txBytes, siblings, index } = await pathFor(eth, log.blockNumber, log.transactionHash);
      const salt = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
      const me = await (registry.runner as Wallet).getAddress();

      const commitment = await registry.commitmentFor(c.id, log.blockNumber, txBytes, siblings, salt, me);
      await (await registry.commitRefutation(commitment)).wait();
      console.log(`  ${label}  committed (tx index ${index}), waiting for the commitment to age`);

      // The commitment must be at least COMMIT_DELAY_BLOCKS old before it can be revealed.
      const start = await registry.runner!.provider!.getBlockNumber();
      while ((await registry.runner!.provider!.getBlockNumber()) < start + 2) await sleep(3000);

      const rc = await (await registry.revealRefutation(c.id, log.blockNumber, txBytes, siblings, salt)).wait();
      console.log(
        `  ${label}  REFUTED with ${log.transactionHash.slice(0, 12)}… block ${log.blockNumber} index ${index}  ` +
          `${Number(rc.gasUsed).toLocaleString()} gas  ${EXPLORER}/tx/${rc.hash}`,
      );
    } catch (e) {
      console.log(`  ${label}  ! refutation failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  // Anyone may finalise an expired claim; doing it here keeps the board readable.
  const n = Number(await registry.claimCount());
  for (let i = 0; i < n; i++) {
    const a = await registry.assurance(i);
    if (Number(a.status) === 1 && now > Number(a.openUntil)) {
      if (dryRun) {
        console.log(`  claim ${i} window closed (would finalise)`);
        continue;
      }
      try {
        await (await registry.finalize(i)).wait();
        console.log(`  claim ${i} finalised → Standing (nobody refuted it)`);
      } catch (e) {
        console.log(`  claim ${i} finalise failed: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }
}

async function main() {
  const argv = process.argv;
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const once = argv.includes('--once');
  const dryRun = argv.includes('--dry-run');
  const interval = Number(get('--interval') ?? 60) * 1000;

  const cc = new JsonRpcProvider(CC_RPC);
  // A hunter that is also the claimant proves nothing about whether anyone else would bother, so
  // HUNTER_KEY lets the searcher be a genuinely separate actor. `seed-market.ts` stakes as the
  // deployer; the hunter should not.
  const wallet = new Wallet(process.env.HUNTER_KEY ?? privateKey(), cc);
  const eth = new JsonRpcProvider(ETH_RPC);
  const addr = registryAddress();
  const registry = new Contract(addr, REGISTRY_V2_ABI, wallet);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  console.log('hunter');
  console.log('  registry :', addr);
  console.log('  as       :', wallet.address);
  console.log('  venues   :', VENUES.map((v) => v.protocol).join(', '));
  if (dryRun) console.log('  DRY RUN — no transactions will be sent');

  for (;;) {
    try {
      await hunt(registry, mirror, eth, dryRun);
    } catch (e) {
      console.log('  ! pass failed:', (e as Error).message.slice(0, 160));
    }
    if (once) break;
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
