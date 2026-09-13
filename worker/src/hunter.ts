/**
 * The hunter: a searcher that refutes false claims on the absence registry without a human.
 *
 * Usage:
 *   node src/hunter.ts [--once] [--interval 60] [--registry <address>] [--dry-run]
 *   HUNTER_KEY=0x… to run as a separate actor (recommended; see below)
 *
 * WHY THIS IS THE LOAD-BEARING PART OF THE MARKET
 * -----------------------------------------------
 * `Standing` means "nobody refuted this while unrecoverable bond was at risk". That is only worth
 * anything if somebody was actually looking. The hunter is the somebody, and its silence -- scanned,
 * corroborated, nothing found -- is exactly the economic fact the registry records.
 *
 * TWO KINDS OF CLAIM
 * ------------------
 *   EmptySet     scan the claim's range for any successful matching log; one is enough to refute.
 *   CompleteSet  enumerate every matching log in the range, subtract the members the claimant listed
 *                (recovered from the registry's own `MembersListed` event, so nothing is trusted from
 *                anyone), and refute with any log left over.
 *
 * A log's position is identified the way the registry identifies it: (height, txIndex, logIndex),
 * where logIndex is the log's position *inside its transaction's receipt* -- not the block-level log
 * index `eth_getLogs` returns. Confusing the two would make every omission refutation revert with
 * `NoContradictionFound`, so the receipt is fetched and the position computed.
 *
 * A negative is never believed on one endpoint's word. `getLogsAdaptive` requires two endpoints to
 * cover the whole range before a scan counts as silence; a scan that cannot be corroborated is
 * reported as "could not scan", which is not the same thing and is never logged as silence.
 *
 * Refutation rebuilds the block from a public node rather than asking the prover, because the block
 * is already mirrored and refutation must keep working when the proving service does not.
 */
import { JsonRpcProvider, Wallet, Contract, AbiCoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, EXPLORER, CHAINS, LOG_RPCS, VENUES, privateKey, getLogsAdaptive } from './config.ts';

const REGISTRY_V3_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function commitmentFor(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32, address) pure returns (bytes32)',
  'function commitmentForComplete(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32, address) pure returns (bytes32)',
  'function commitRefutation(bytes32)',
  'function revealRefutation(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32)',
  'function revealOmission(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32)',
  'function finalize(uint256)',
  'function enforceableLoss(uint256) view returns (uint256)',
  'event MembersListed(uint256 indexed claimId, (uint64 height, uint64 txIndex, uint32 logIndex)[] members)',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 paidToRefuter, uint256 burned)',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).proofProvider ? sdkMod : (sdkMod as any).default;
const { proofProvider, encoding } = sdk;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = proofProvider.merkle;

type Member = { height: number; txIndex: number; logIndex: number };

type Claim = {
  id: number;
  chainKey: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  spanFrom: number;
  spanTo: number;
  openUntil: number;
  kind: 0 | 1;
  members: number;
};

function registryAddress(): string {
  const i = process.argv.indexOf('--registry');
  if (i >= 0) return process.argv[i + 1];
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const a = d.contracts.AbsenceRegistryV3;
  if (!a) throw new Error('AbsenceRegistryV3 not in deployments.json');
  return a;
}

const providers = new Map<number, JsonRpcProvider>();
function ethFor(chainKey: number): JsonRpcProvider {
  if (!providers.has(chainKey)) {
    providers.set(chainKey, new JsonRpcProvider(LOG_RPCS[chainKey][0], undefined, { staticNetwork: true }));
  }
  return providers.get(chainKey)!;
}

async function openClaims(registry: Contract): Promise<Claim[]> {
  const n = Number(await registry.claimCount());
  const out: Claim[] = [];
  for (let i = 0; i < n; i++) {
    const c = await registry.claimOf(i);
    if (Number(c.status) !== 1) continue;
    out.push({
      id: i,
      chainKey: Number(c.chainKey),
      venue: c.venue,
      topic0: c.topic0,
      subject: c.subject,
      subjectTopic: Number(c.subjectTopic),
      spanFrom: Number(c.spanFrom),
      spanTo: Number(c.spanTo),
      openUntil: Number(c.openUntil),
      kind: Number(c.kind) as 0 | 1,
      members: Number(c.members),
    });
  }
  return out;
}

/** The member list exactly as asserted, from the registry's own event. */
async function membersOf(registry: Contract, claimId: number): Promise<Member[]> {
  const cc = registry.runner!.provider!;
  const deployBlock = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8')).deployBlock ?? 0;
  const logs = await registry.queryFilter(registry.filters.MembersListed(claimId), deployBlock, 'latest');
  if (logs.length !== 1) throw new Error(`expected one MembersListed for claim ${claimId}, found ${logs.length}`);
  const parsed = registry.interface.parseLog(logs[0] as any)!;
  void cc;
  return (parsed.args.members as any[]).map((m) => ({ height: Number(m.height), txIndex: Number(m.txIndex), logIndex: Number(m.logIndex) }));
}

function topicsFor(c: Claim): (string | null)[] {
  const t: (string | null)[] = [c.topic0];
  if (c.subjectTopic > 0) {
    for (let i = 1; i < c.subjectTopic; i++) t.push(null);
    t.push(c.subject);
  }
  return t;
}

/** Receipt-local position of a log -- the index the registry and the decoder use. */
async function receiptLogIndex(eth: JsonRpcProvider, log: any): Promise<number> {
  const rc = await eth.getTransactionReceipt(log.transactionHash);
  if (!rc) throw new Error(`no receipt for ${log.transactionHash}`);
  if (rc.status !== 1) return -1; // a failed transaction is not evidence; the registry would refuse it
  const i = rc.logs.findIndex((l) => l.index === (log.index ?? log.logIndex));
  if (i < 0) throw new Error(`log not found in its own receipt: ${log.transactionHash}`);
  return i;
}

/** Rebuild the block locally and take the path for one transaction. No prover involved. */
async function pathFor(chainKey: number, blockNumber: number, txHash: string) {
  const eth = ethFor(chainKey);
  const withReceipts = await new SimpleBlockProvider(eth).getBlockWithReceipts(blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this RPC');
  const { transactions, receipts } = withReceipts;
  const leaves = transactions.map((t: any, i: number) => encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi);
  const idx = receipts.findIndex((r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase());
  if (idx < 0) throw new Error('transaction not present in the rebuilt block');
  const proof = new KeccakMerkleTree(leaves).getProof(idx);
  return { txBytes: leaves[idx], siblings: proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })), index: idx };
}

type Counterexample = { log: any; logIndex: number; members?: Member[] };

async function findCounterexample(registry: Contract, c: Claim): Promise<Counterexample | null> {
  const logs = await getLogsAdaptive(LOG_RPCS[c.chainKey], { address: c.venue, topics: topicsFor(c) }, c.spanFrom, c.spanTo);
  const eth = ethFor(c.chainKey);

  if (c.kind === 0) {
    for (const log of logs) {
      const li = await receiptLogIndex(eth, log);
      if (li >= 0) return { log, logIndex: li };
    }
    return null;
  }

  const members = await membersOf(registry, c.id);
  const listed = new Set(members.map((m) => `${m.height}:${m.txIndex}:${m.logIndex}`));
  for (const log of logs) {
    const li = await receiptLogIndex(eth, log);
    if (li < 0) continue;
    const key = `${log.blockNumber}:${log.transactionIndex}:${li}`;
    if (!listed.has(key)) return { log, logIndex: li, members };
  }
  return null;
}

async function hunt(registry: Contract, mirror: Contract, dryRun: boolean) {
  const claims = await openClaims(registry);
  const now = Math.floor(Date.now() / 1000);
  console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${claims.length} open claim(s)`);

  for (const c of claims) {
    const label = `claim ${String(c.id).padStart(3)} ${c.kind === 0 ? 'EmptySet   ' : 'CompleteSet'} ${CHAINS[c.chainKey]?.slug ?? c.chainKey}`;
    if (now > c.openUntil) continue; // finalised below

    let found: Counterexample | null;
    try {
      found = await findCounterexample(registry, c);
    } catch (e) {
      console.log(`  ${label}  ! COULD NOT SCAN — ${(e as Error).message.slice(0, 140)}`);
      console.log(`  ${label}    (this is not silence: the claim was not checked)`);
      continue;
    }

    if (!found) {
      console.log(`  ${label}  ${c.spanFrom}..${c.spanTo}  no counterexample, corroborated  (${c.openUntil - now}s left)`);
      continue;
    }

    const { log, logIndex } = found;
    console.log(`  ${label}  counterexample ${log.transactionHash.slice(0, 12)}… block ${log.blockNumber} tx ${log.transactionIndex} log ${logIndex}`);

    if (!(await mirror.isMirrored(c.chainKey, log.blockNumber))) {
      console.log(`  ${label}  ! block ${log.blockNumber} is not mirrored — notarise it first`);
      continue;
    }
    if (dryRun) {
      console.log(`  ${label}  (dry run: would commit and reveal)`);
      continue;
    }

    try {
      const { txBytes, siblings } = await pathFor(c.chainKey, log.blockNumber, log.transactionHash);
      const salt = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
      const me = await (registry.runner as Wallet).getAddress();

      const commitment =
        c.kind === 0
          ? await registry.commitmentFor(c.id, log.blockNumber, txBytes, siblings, salt, me)
          : await registry.commitmentForComplete(c.id, log.blockNumber, txBytes, siblings, logIndex, found.members!, salt, me);
      await (await registry.commitRefutation(commitment)).wait();

      const cc = registry.runner!.provider!;
      const start = await cc.getBlockNumber();
      while ((await cc.getBlockNumber()) < start + 2) await sleep(3000);

      const tx =
        c.kind === 0
          ? await registry.revealRefutation(c.id, log.blockNumber, txBytes, siblings, salt)
          : await registry.revealOmission(c.id, log.blockNumber, txBytes, siblings, logIndex, found.members!, salt);
      const rc = await tx.wait();
      const ev = rc.logs.map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === 'AbsenceRefuted');
      const paid = ev ? Number(ev.args.paidToRefuter) / 1e18 : NaN;
      const burned = ev ? Number(ev.args.burned) / 1e18 : NaN;
      console.log(
        `  ${label}  REFUTED  ${Number(rc.gasUsed).toLocaleString()} gas  paid ${paid} tCTC  burned ${burned} tCTC  ${EXPLORER}/tx/${rc.hash}`,
      );
    } catch (e) {
      console.log(`  ${label}  ! refutation failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  // Anyone may finalise an expired claim; doing it here keeps the board readable.
  const n = Number(await registry.claimCount());
  for (let i = 0; i < n; i++) {
    const c = await registry.claimOf(i);
    if (Number(c.status) === 1 && now > Number(c.openUntil)) {
      if (dryRun) continue;
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
  // A hunter that is also the claimant proves nothing about whether anyone else would bother.
  const wallet = new Wallet(process.env.HUNTER_KEY ?? privateKey(), cc);
  const registry = new Contract(registryAddress(), REGISTRY_V3_ABI, wallet);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  console.log('hunter');
  console.log('  registry :', await registry.getAddress());
  console.log('  as       :', wallet.address);
  console.log('  venues   :', [...new Set(VENUES.map((v) => v.protocol))].join(', '));
  if (dryRun) console.log('  DRY RUN — no transactions will be sent');
  void AbiCoder;

  for (;;) {
    try {
      await hunt(registry, mirror, dryRun);
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
