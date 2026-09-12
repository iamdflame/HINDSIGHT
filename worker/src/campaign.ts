/**
 * The archive campaign: turn the mirror from a lab note into a continental archive.
 *
 * Usage:
 *   node src/campaign.ts [--target 100000] [--stride 900] [--from <height>] [--dry-run]
 *
 * Why this is not simply a loop over `mirror.ts`
 * ----------------------------------------------
 * A single-transaction continuity proof carries only the roots between that transaction's block
 * and the next endpoint above it. Measured against the live CC3 prover:
 *
 *     fresh block        1 root
 *     24h - 30d old     11 roots
 *     180d old         711 roots
 *
 * So the 99 roots this project first retained were a boundary alignment, not a rate. Harvesting
 * recent history one proof at a time would cost ~9,000 prover calls for 100,000 blocks.
 *
 * The batch endpoint anchors one continuity proof at both ends of a window and returns every root
 * between them. Two transactions are enough -- ten are no wider and measurably slower -- so each
 * request costs two `eth_getBlockByNumber` calls and yields a whole stride.
 *
 * Two hard limits shape the stride, both established by measurement rather than documentation:
 *   1. The prover refuses a batch spanning more than 1000 blocks (`BatchSpanTooLarge`).
 *   2. Its archiver reads in checkpoint-aligned chunks of 100. A window that straddles an extra
 *      boundary is refused with a 500 even while under the 1000 cap -- a 990-block window asked
 *      the archiver for 1100 blocks and failed.
 *
 * Aligning every stride to a checkpoint boundary and keeping it to 900 blocks satisfies both with
 * margin. That is ~112 requests and ~112 transactions for 100,000 heights.
 *
 * The campaign is idempotent and resumable. On-chain `mirroredBlocks` is the only ground truth;
 * there is no local state file to fall out of sync. Re-running skips what is already held, because
 * `_retain` silently ignores a height whose stored root already matches and reverts only on a
 * genuine conflict.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  CC_RPC,
  ETH_RPC,
  MIRROR,
  MIRROR_ABI,
  EXPLORER,
  CHAIN_KEY_ETH_MAINNET,
  privateKey,
  fetchBatchProof,
  ProverError,
} from './config.ts';

/** Measured: attestation checkpoints on CC3 sit one per 100 blocks, not one per 1000. */
const CHECKPOINT = 100;

/** Blocks per stride. 900 keeps the archiver's aligned read at 900 of its 1000-block ceiling. */
const DEFAULT_STRIDE = 900;

/** Stay this far below the attested head so a stride never reaches for an unattested block. */
const HEAD_MARGIN = 200;

/** Refuse to submit a call estimated above this. The CC3 block limit is 75,000,000. */
const MAX_GAS = 40_000_000;

/**
 * Public Ethereum endpoints, tried in order. Only `eth_getBlockByNumber` is needed and only for
 * transaction hashes -- the roots come from Attestcoin, so a lying RPC cannot poison the archive:
 * the precompile would reject the proof.
 */
const ETH_RPCS = [
  ETH_RPC,
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
];

const CAMPAIGN_LOG = new URL('../../docs/CAMPAIGN.md', import.meta.url);

type Args = { target: number; stride: number; from?: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    target: Number(get('--target') ?? 100_000),
    stride: Number(get('--stride') ?? DEFAULT_STRIDE),
    from: get('--from') ? Number(get('--from')) : undefined,
    dryRun: argv.includes('--dry-run'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Round down to a checkpoint boundary, so the archiver's aligned read starts where we do. */
const bucketOf = (h: number) => Math.floor(h / CHECKPOINT) * CHECKPOINT;

class EthPool {
  private i = 0;
  private providers = ETH_RPCS.map((u) => new JsonRpcProvider(u));

  /** Try every endpoint before giving up; public RPCs fail often enough that one is not enough. */
  async block(height: number): Promise<{ transactions: readonly string[] } | null> {
    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const p = this.providers[(this.i + attempt) % this.providers.length];
      try {
        const b = await p.getBlock(height);
        this.i = (this.i + attempt) % this.providers.length;
        return b as any;
      } catch {
        /* rotate */
      }
    }
    return null;
  }

  /** First transaction at or after `height`, without leaving the checkpoint bucket. */
  async firstTxFrom(height: number, limit: number): Promise<[number, string] | null> {
    for (let h = height; h <= limit; h++) {
      const b = await this.block(h);
      if (b && b.transactions.length > 0) return [h, b.transactions[0]];
    }
    return null;
  }

  /** Last transaction at or before `height`, searching downward. */
  async lastTxBefore(height: number, limit: number): Promise<[number, string] | null> {
    for (let h = height; h >= limit; h--) {
      const b = await this.block(h);
      if (b && b.transactions.length > 0) return [h, b.transactions[0]];
    }
    return null;
  }
}

function logLine(line: string) {
  try {
    mkdirSync(new URL('../../docs/', import.meta.url), { recursive: true });
    if (!existsSync(CAMPAIGN_LOG)) {
      writeFileSync(
        CAMPAIGN_LOG,
        [
          '# Campaign log',
          '',
          'Every `mirror()` call this archive was built from, appended as it happened. Generated by',
          '`worker/src/campaign.ts`; not written by hand.',
          '',
          '| when (UTC) | from | to | roots | newly added | gas | total held | tx |',
          '|---|---|---|---|---|---|---|---|',
          '',
        ].join('\n'),
      );
    }
    appendFileSync(CAMPAIGN_LOG, line + '\n');
  } catch (e) {
    console.error('  (campaign log unwritable:', (e as Error).message, ')');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, wallet);
  const eth = new EthPool();

  const attestedHead = await attestedHeight(cc);
  let held = Number(await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));

  console.log('campaign');
  console.log('  mirror        :', MIRROR);
  console.log('  attested head :', attestedHead.toLocaleString());
  console.log('  held now      :', held.toLocaleString(), 'heights');
  console.log('  target        :', args.target.toLocaleString(), 'heights');
  console.log('  stride        :', args.stride, 'blocks, checkpoint-aligned');
  if (args.dryRun) console.log('  DRY RUN — no transactions will be sent');
  console.log();

  if (held >= args.target) {
    console.log('already at target.');
    return;
  }

  // Walk downward from just under the attested head. Descending keeps every stride inside
  // already-attested history, and leaves the head-follower (a later, cheap pass) the fresh edge.
  let cursor = args.from ?? bucketOf(attestedHead - HEAD_MARGIN);
  let stride = args.stride;
  let calls = 0;
  let failures = 0;
  const startedHeld = held;
  const t0 = Date.now();

  while (held < args.target) {
    // Each window's roots run one checkpoint past its top, so stepping down by a full stride
    // leaves a single block of overlap rather than a gap.
    const bucketStart = bucketOf(cursor) - stride;
    const windowLo = bucketStart;
    const windowHi = bucketStart + stride - 1;
    if (windowLo <= 0) {
      console.log('reached the bottom of the chain.');
      break;
    }

    try {
      const added = await mirrorWindow({
        mirror,
        eth,
        windowLo,
        windowHi,
        dryRun: args.dryRun,
        onTx: (row) => logLine(row),
        heldBefore: held,
      });
      if (added !== null) {
        held += added;
        calls++;
      }
      failures = 0;
    } catch (e) {
      const err = e as Error;
      failures++;
      console.log(`  ! ${windowLo}..${windowHi}: ${err.message.slice(0, 160)}`);
      if (e instanceof ProverError && !e.retriable) {
        // A span this prover will never serve: shrink and move on rather than stall.
        if (stride > 200) {
          stride -= 100;
          console.log(`    narrowing stride to ${stride}`);
          continue;
        }
      }
      if (failures >= 5) {
        console.log('  five consecutive failures — stopping so the state stays inspectable.');
        break;
      }
      await sleep(2000 * failures);
    }

    cursor = windowLo;
    await sleep(150); // be a polite client of a shared testnet service
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log();
  console.log('  calls sent    :', calls);
  console.log('  heights added :', (held - startedHeld).toLocaleString());
  console.log('  held now      :', held.toLocaleString());
  console.log('  elapsed       :', mins, 'min');
  const onChain = Number(await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
  console.log('  on-chain says :', onChain.toLocaleString(), onChain === held ? '(agrees)' : '(DISAGREES — trust the chain)');
}

/** Read the attested head straight from the chain-info precompile. */
async function attestedHeight(cc: JsonRpcProvider): Promise<number> {
  const sdk: any = await import('@gluwa/usc-sdk/dist/index.js');
  const m = sdk.proofProvider ? sdk : sdk.default;
  const info = new m.chainInfo.PrecompileChainInfoProvider(cc);
  const head = await info.getLatestAttestedHeightAndHash(CHAIN_KEY_ETH_MAINNET);
  return Number(head.height ?? head[0]);
}

async function mirrorWindow(o: {
  mirror: Contract;
  eth: EthPool;
  windowLo: number;
  windowHi: number;
  dryRun: boolean;
  heldBefore: number;
  onTx: (row: string) => void;
}): Promise<number | null> {
  const { mirror, eth, windowLo, windowHi } = o;

  // Cheap pre-check: if both ends and the middle are already held, the stride is very likely
  // done. `_retain` would no-op anyway, but skipping saves a prover call and a transaction.
  const probes = await Promise.all(
    [windowLo, Math.floor((windowLo + windowHi) / 2), windowHi].map((h) =>
      mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, h),
    ),
  );
  if (probes.every(Boolean)) {
    console.log(`  = ${windowLo}..${windowHi} already held, skipping`);
    return null;
  }

  const lo = await eth.firstTxFrom(windowLo, windowLo + CHECKPOINT - 1);
  const hi = await eth.lastTxBefore(windowHi, windowHi - CHECKPOINT + 1);
  if (!lo || !hi) throw new Error('no anchor transactions in window');

  const proof = await fetchBatchProof(CHAIN_KEY_ETH_MAINNET, [lo[1], hi[1]]);
  const roots: string[] = proof.continuityProof.roots;
  const fromHeader: number = proof.fromHeader;

  // `mirror()` requires continuityRoots[0] to be the Merkle root of the block it is told about,
  // which is the protocol's own indexing invariant. Find the anchor proof for that exact header.
  const atFrom = proof.merkleProofs?.[String(fromHeader)];
  if (!atFrom) throw new Error(`batch carried no Merkle proof at its own fromHeader ${fromHeader}`);
  const entry: any = Object.values(atFrom)[0];
  if (entry.merkleProof.root.toLowerCase() !== roots[0].toLowerCase()) {
    throw new Error('prover disagreed with itself: roots[0] is not the root at fromHeader');
  }

  const siblings = entry.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
  const call = [
    CHAIN_KEY_ETH_MAINNET,
    fromHeader,
    entry.txBytes,
    entry.merkleProof.root,
    siblings,
    proof.continuityProof.lowerEndpointDigest,
    roots,
  ] as const;

  const gas = await mirror.mirror.estimateGas(...call);
  if (Number(gas) > MAX_GAS) {
    throw new Error(`estimated ${Number(gas).toLocaleString()} gas, above the ${MAX_GAS.toLocaleString()} ceiling`);
  }

  const covers = `${fromHeader}..${fromHeader + roots.length - 1}`;
  if (o.dryRun) {
    console.log(`  ~ ${covers}  ${roots.length} roots, ${Number(gas).toLocaleString()} gas (dry run)`);
    return null;
  }

  const before = Number(await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
  const tx = await mirror.mirror(...call, { gasLimit: (gas * 12n) / 10n });
  const rc = await tx.wait();
  const after = Number(await mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
  const added = after - before;

  console.log(
    `  + ${covers}  ${String(roots.length).padStart(4)} roots  ${String(added).padStart(4)} new  ` +
      `${Number(rc.gasUsed).toLocaleString().padStart(12)} gas  held ${after.toLocaleString()}`,
  );
  o.onTx(
    `| ${new Date().toISOString().replace('T', ' ').slice(0, 19)} | ${fromHeader} | ${fromHeader + roots.length - 1} | ` +
      `${roots.length} | ${added} | ${Number(rc.gasUsed)} | ${after} | [\`${tx.hash.slice(0, 10)}…\`](${EXPLORER}/tx/${tx.hash}) |`,
  );
  return added;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
