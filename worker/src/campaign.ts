/**
 * The archive campaign: turn the mirror from a lab note into a continental archive.
 *
 * Usage:
 *   node src/campaign.ts --chain 3 --days 90            backfill 90 days of mainnet
 *   node src/campaign.ts --chain 1 --days 30            backfill 30 days of Sepolia
 *   node src/campaign.ts --chain 3 --follow             keep the head fresh, forever
 *   node src/campaign.ts --chain 3 --target 100000      (older form: a height count)
 *   ... [--stride 900] [--from <height>] [--key ENV_VAR] [--dry-run]
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
 * request costs two `eth_getBlockByNumber` calls and yields a whole stride. Measured at 45, 90 and
 * 100 days deep: still 901 roots per request, at 6-8s rather than 1s.
 *
 * Two hard limits shape the stride, both established by measurement rather than documentation:
 *   1. The prover refuses a batch spanning more than 1000 blocks (`BatchSpanTooLarge`).
 *   2. Its archiver reads in checkpoint-aligned chunks of 100. A window that straddles an extra
 *      boundary is refused with a 500 even while under the 1000 cap.
 *
 * Aligning every stride to a checkpoint boundary and keeping it to 900 blocks satisfies both.
 *
 * Empty blocks
 * ------------
 * An Ethereum block with no transactions has a transaction root of zero. Mirror v1 could not tell
 * that from "not held"; v2 keeps a bitmap, so the campaign no longer leaves the archive cut into
 * runs. This file does not need to know about any of that -- it hands the prover's array to
 * `mirror()` and the contract does the right thing -- but it is why 90 days is now a real window.
 *
 * Two chains, two wallets
 * -----------------------
 * Mainnet and Sepolia campaigns run concurrently. Each needs its own signer (`--key ENV_VAR`) so
 * that neither waits on the other's nonces. Both are serial against the prover: at most two
 * requests in flight against a shared testnet service.
 *
 * The campaign is idempotent and resumable. On-chain state is the only ground truth; there is no
 * local state file to fall out of sync. Re-running skips what is already held.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  CC_RPC,
  MIRROR,
  MIRROR_ABI,
  EXPLORER,
  CHAINS,
  privateKey,
  fetchBatchProof,
  ProverError,
} from './config.ts';

/** Measured: attestation checkpoints on CC3 sit one per 100 blocks. */
const CHECKPOINT = 100;

/** Blocks per stride. 900 keeps the archiver's aligned read at 900 of its 1000-block ceiling. */
const DEFAULT_STRIDE = 900;

/** Stay this far below the attested head so a stride never reaches for an unattested block. */
const HEAD_MARGIN = 200;

/** Refuse to submit a call estimated above this. The CC3 block limit is 75,000,000. */
const MAX_GAS = 40_000_000;

/** How often the follower looks for newly attested history. */
const FOLLOW_POLL_MS = 60_000;

/**
 * Pause while the network is congested.
 *
 * CC3 testnet is shared. Measured during the first run of this campaign: four workers each sending
 * ~21M-gas calls into 75M-gas blocks pushed EIP-1559's base fee from 0.5 gwei to 6.7 gwei in under
 * two hours, and blocks sat 33-86% full -- mostly us. That makes every other team's transactions
 * thirteen times dearer during a hackathon. So each worker waits while the base fee is above this
 * ceiling, which lets the fee decay (12.5% per under-target block) before it adds more load.
 * Throughput then settles at what the chain absorbs without escalating.
 */
const DEFAULT_MAX_BASE_FEE_GWEI = 1.5;

type Args = {
  chain: number;
  days?: number;
  target?: number;
  stride: number;
  from?: number;
  keyEnv?: string;
  follow: boolean;
  dryRun: boolean;
  maxBaseFeeGwei: number;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = Number(get('--chain') ?? 3);
  if (!CHAINS[chain]) throw new Error(`unknown --chain ${chain}; known: ${Object.keys(CHAINS).join(', ')}`);
  return {
    chain,
    days: get('--days') ? Number(get('--days')) : undefined,
    target: get('--target') ? Number(get('--target')) : undefined,
    stride: Number(get('--stride') ?? DEFAULT_STRIDE),
    from: get('--from') ? Number(get('--from')) : undefined,
    keyEnv: get('--key'),
    follow: argv.includes('--follow'),
    dryRun: argv.includes('--dry-run'),
    maxBaseFeeGwei: Number(get('--max-base-fee') ?? DEFAULT_MAX_BASE_FEE_GWEI),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bucketOf = (h: number) => Math.floor(h / CHECKPOINT) * CHECKPOINT;

class EthPool {
  private i = 0;
  private providers: JsonRpcProvider[];
  constructor(urls: string[]) {
    this.providers = urls.map((u) => new JsonRpcProvider(u));
  }

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

  async firstTxFrom(height: number, limit: number): Promise<[number, string] | null> {
    for (let h = height; h <= limit; h++) {
      const b = await this.block(h);
      if (b && b.transactions.length > 0) return [h, b.transactions[0]];
    }
    return null;
  }

  async lastTxBefore(height: number, limit: number): Promise<[number, string] | null> {
    for (let h = height; h >= limit; h--) {
      const b = await this.block(h);
      if (b && b.transactions.length > 0) return [h, b.transactions[0]];
    }
    return null;
  }
}

function campaignLog(chain: number) {
  const slug = CHAINS[chain].slug;
  const file = new URL(`../../docs/CAMPAIGN-${slug}.md`, import.meta.url);
  return (line: string) => {
    try {
      mkdirSync(new URL('../../docs/', import.meta.url), { recursive: true });
      if (!existsSync(file)) {
        writeFileSync(
          file,
          [
            `# Campaign log — ${CHAINS[chain].name} (chainKey ${chain})`,
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
      appendFileSync(file, line + '\n');
    } catch (e) {
      console.error('  (campaign log unwritable:', (e as Error).message, ')');
    }
  };
}

/** Read the attested head straight from the chain-info precompile. */
async function attestedHeight(cc: JsonRpcProvider, chain: number): Promise<number> {
  const sdk: any = await import('@gluwa/usc-sdk/dist/index.js');
  const m = sdk.proofProvider ? sdk : sdk.default;
  const info = new m.chainInfo.PrecompileChainInfoProvider(cc);
  const head = await info.getLatestAttestedHeightAndHash(chain);
  return Number(head.height ?? head[0]);
}

async function main() {
  const args = parseArgs(process.argv);
  const chainCfg = CHAINS[args.chain];
  const cc = new JsonRpcProvider(CC_RPC);
  const key = args.keyEnv ? process.env[args.keyEnv] : undefined;
  if (args.keyEnv && !key) throw new Error(`--key ${args.keyEnv} is set but that variable is empty`);
  const wallet = new Wallet(key ?? privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, wallet);
  const eth = new EthPool(chainCfg.ethRpcs);
  const log = campaignLog(args.chain);

  const attestedHead = await attestedHeight(cc, args.chain);
  let held = Number(await mirror.mirroredBlocks(args.chain));
  const perDay = Math.round(86_400 / chainCfg.blockSeconds);
  const floor = args.days ? bucketOf(attestedHead - args.days * perDay) : 0;
  const target = args.target ?? Number.MAX_SAFE_INTEGER;

  console.log('campaign');
  console.log('  chain         :', chainCfg.name, `(chainKey ${args.chain})`);
  console.log('  mirror        :', MIRROR);
  console.log('  signer        :', wallet.address);
  console.log('  attested head :', attestedHead.toLocaleString());
  console.log('  held now      :', held.toLocaleString(), 'heights');
  if (args.days) console.log('  floor         :', floor.toLocaleString(), `(${args.days} days ≈ ${(args.days * perDay).toLocaleString()} blocks)`);
  if (args.target) console.log('  target        :', args.target.toLocaleString(), 'heights');
  console.log('  stride        :', args.stride, 'blocks, checkpoint-aligned');
  if (args.follow) console.log('  mode          : follow the attested head');
  console.log('  base fee cap  :', args.maxBaseFeeGwei, 'gwei (pauses above it)');
  if (args.dryRun) console.log('  DRY RUN — no transactions will be sent');
  console.log();

  if (args.follow) return follow({ mirror, eth, cc, chain: args.chain, stride: args.stride, dryRun: args.dryRun, maxBaseFeeGwei: args.maxBaseFeeGwei, log });

  // Walk downward from just under the attested head. Descending keeps every stride inside
  // already-attested history, and leaves the follower the fresh edge.
  let cursor = args.from ?? bucketOf(attestedHead - HEAD_MARGIN);
  let stride = args.stride;
  let calls = 0;
  let failures = 0;
  const startedHeld = held;
  const t0 = Date.now();

  while (held < target) {
    // Each window's roots run one checkpoint past its top, so stepping down by a full stride
    // leaves a single block of overlap rather than a gap.
    const windowLo = bucketOf(cursor) - stride;
    const windowHi = windowLo + stride - 1;
    if (windowLo <= 0 || windowLo < floor) {
      console.log(args.days ? `reached the ${args.days}-day floor.` : 'reached the bottom of the chain.');
      break;
    }

    try {
      const added = await mirrorWindow({ mirror, eth, chain: args.chain, windowLo, windowHi, dryRun: args.dryRun, maxBaseFeeGwei: args.maxBaseFeeGwei, log });
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
        if (stride > 200) {
          stride -= 100;
          console.log(`    narrowing stride to ${stride}`);
          continue;
        }
      }
      if (failures >= 8) {
        console.log('  eight consecutive failures — stopping so the state stays inspectable.');
        break;
      }
      await sleep(3000 * failures);
      continue; // retry the same window rather than skipping it
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
  const onChain = Number(await mirror.mirroredBlocks(args.chain));
  console.log('  on-chain says :', onChain.toLocaleString(), onChain === held ? '(agrees)' : '(DISAGREES — trust the chain)');
}

/**
 * Keep the archive current. Every minute, if the attested head has moved a full stride past what is
 * held, mirror the next window upward. The archive that is still lengthening during judging is a
 * protocol; the one that stopped at the screenshot is a demo.
 */
async function follow(o: {
  mirror: Contract;
  eth: EthPool;
  cc: JsonRpcProvider;
  chain: number;
  stride: number;
  dryRun: boolean;
  maxBaseFeeGwei: number;
  log: (l: string) => void;
}) {
  for (;;) {
    try {
      const head = await attestedHeight(o.cc, o.chain);
      const highest = Number(await o.mirror.highestMirrored(o.chain));
      const safeTop = bucketOf(head - HEAD_MARGIN);
      // Next window starts at the checkpoint just above what is held, so overlap stays one block.
      const windowLo = highest === 0 ? safeTop - o.stride : bucketOf(highest);
      const windowHi = windowLo + o.stride - 1;

      if (windowHi + 1 > safeTop) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] held to ${highest.toLocaleString()}, attested ${head.toLocaleString()} — waiting`);
      } else {
        await mirrorWindow({ ...o, windowLo, windowHi });
        continue; // there may be more than one window to catch up on
      }
    } catch (e) {
      console.log('  ! follow:', (e as Error).message.slice(0, 160));
    }
    await sleep(FOLLOW_POLL_MS);
  }
}

let lastCalmNote = 0;
async function waitForCalm(cc: JsonRpcProvider, maxGwei: number) {
  const ceiling = BigInt(Math.round(maxGwei * 1e9));
  for (let waited = 0; ; waited++) {
    const blk = await cc.getBlock('latest');
    const fee = blk?.baseFeePerGas ?? 0n;
    if (fee <= ceiling) return;
    if (Date.now() - lastCalmNote > 60_000) {
      console.log(`  … base fee ${(Number(fee) / 1e9).toFixed(2)} gwei > ${maxGwei} — pausing so the chain can recover`);
      lastCalmNote = Date.now();
    }
    await sleep(8_000 + Math.floor(Math.random() * 4_000)); // jitter so paused workers do not all resume in one block
  }
}

async function mirrorWindow(o: {
  mirror: Contract;
  eth: EthPool;
  chain: number;
  windowLo: number;
  windowHi: number;
  dryRun: boolean;
  maxBaseFeeGwei: number;
  log: (row: string) => void;
}): Promise<number | null> {
  const { mirror, eth, chain, windowLo, windowHi } = o;

  // Cheap pre-check: if both ends and the middle are already held, the stride is very likely
  // done. `_retain` would no-op anyway, but skipping saves a prover call and a transaction.
  const probes = await Promise.all(
    [windowLo, Math.floor((windowLo + windowHi) / 2), windowHi].map((h) => mirror.isMirrored(chain, h)),
  );
  if (probes.every(Boolean)) {
    console.log(`  = ${windowLo}..${windowHi} already held, skipping`);
    return null;
  }

  const lo = await eth.firstTxFrom(windowLo, windowLo + CHECKPOINT - 1);
  const hi = await eth.lastTxBefore(windowHi, windowHi - CHECKPOINT + 1);
  if (!lo || !hi) throw new Error('no anchor transactions in window');

  const proof = await fetchBatchProof(chain, [lo[1], hi[1]]);
  const roots: string[] = proof.continuityProof.roots;
  const fromHeader: number = proof.fromHeader;

  // `mirror()` requires continuityRoots[0] to be the Merkle root of the block it is told about.
  const atFrom = proof.merkleProofs?.[String(fromHeader)];
  if (!atFrom) throw new Error(`batch carried no Merkle proof at its own fromHeader ${fromHeader}`);
  const entry: any = Object.values(atFrom)[0];
  if (entry.merkleProof.root.toLowerCase() !== roots[0].toLowerCase()) {
    throw new Error('prover disagreed with itself: roots[0] is not the root at fromHeader');
  }

  const siblings = entry.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
  const call = [chain, fromHeader, entry.txBytes, entry.merkleProof.root, siblings, proof.continuityProof.lowerEndpointDigest, roots] as const;

  // Good citizenship on a shared testnet: never add a 21M-gas call to a congested chain.
  await waitForCalm(mirror.runner!.provider as JsonRpcProvider, o.maxBaseFeeGwei);

  const gas = await mirror.mirror.estimateGas(...call);
  if (Number(gas) > MAX_GAS) {
    throw new Error(`estimated ${Number(gas).toLocaleString()} gas, above the ${MAX_GAS.toLocaleString()} ceiling`);
  }

  const covers = `${fromHeader}..${fromHeader + roots.length - 1}`;
  if (o.dryRun) {
    console.log(`  ~ ${covers}  ${roots.length} roots, ${Number(gas).toLocaleString()} gas (dry run)`);
    return null;
  }

  const tx = await mirror.mirror(...call, { gasLimit: (gas * 12n) / 10n });
  const rc = await tx.wait();
  // Read what *this* call added from its own event. `mirroredBlocks` after-minus-before is wrong the
  // moment more than one worker is writing: it counts everyone's additions in the interval.
  const ev = rc.logs
    .map((l: any) => { try { return mirror.interface.parseLog(l); } catch { return null; } })
    .find((x: any) => x?.name === 'BlocksMirrored');
  if (!ev) throw new Error(`mirror() succeeded but emitted no BlocksMirrored: ${tx.hash}`);
  const added = Number(ev.args.newlyAdded);
  const after = Number(await mirror.mirroredBlocks(chain));

  console.log(
    `  + ${covers}  ${String(roots.length).padStart(4)} roots  ${String(added).padStart(4)} new  ` +
      `${Number(rc.gasUsed).toLocaleString().padStart(12)} gas  held ${after.toLocaleString()}`,
  );
  o.log(
    `| ${new Date().toISOString().replace('T', ' ').slice(0, 19)} | ${fromHeader} | ${fromHeader + roots.length - 1} | ` +
      `${roots.length} | ${added} | ${Number(rc.gasUsed)} | ${after} | [\`${tx.hash.slice(0, 10)}…\`](${EXPLORER}/tx/${tx.hash}) |`,
  );
  return added;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
