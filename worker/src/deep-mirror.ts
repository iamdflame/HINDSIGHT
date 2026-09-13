/**
 * Extend and repair the archive with the hosted prover switched off.
 *
 * Usage:
 *   node src/deep-mirror.ts --chain 3 --to 25172001 [--dry-run] [--width 12] [--key ENV_VAR]
 *   node src/deep-mirror.ts --chain 3 --from 25171100 --to 24672700      (deepening, downward)
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured 2026-09-13: the hosted prover's batch endpoint serves ~108.5 days and its floor rises with
 * the head, so the 15,299-height hole at 25,172,001–25,187,299 sits permanently below it and no depth
 * beyond ~108 days can ever be bought from it. The archive would be capped by somebody else's retention.
 *
 * It is not, because Creditcoin keeps the continuity itself: `0x0FD3.getContinuityBounds` returns a
 * checkpoint every 1,000 blocks at any depth tested (108d, 180d, 343d), and public Ethereum nodes still
 * serve `eth_getBlockReceipts` that far back. Between two checkpoints, everything the precompile needs
 * can be computed here: the transaction root of each block, and the digest chain that links them.
 *
 * So this worker mirrors a checkpoint interval at a time, from public data only:
 *
 *   roots        computed locally from block + receipts (the same code `local-proof.ts` checks against
 *                the prover, and `deep-spike` checks against roots already held)
 *   anchor       the first non-empty block of the interval, with its Merkle path built locally
 *   lower digest the checkpoint's stored digest, walked forward with `computeDigestOf` when the anchor
 *                is not the checkpoint's immediate successor (an empty first block)
 *
 * `0x0FD2` still decides. Nothing here is trusted: a wrong root, a wrong digest or a lying RPC produces
 * a chain that does not terminate at the checkpoint Creditcoin stores, and the call reverts. That is why
 * every interval is simulated with `eth_call` before a transaction is signed.
 *
 * Idempotent and resumable: the bitmap is the state. An interval already held is skipped without a fetch.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, EXPLORER, CHAINS, privateKey } from './config.ts';
import { BlockPool, ThreadedRoots, computeDigestOf, KeccakMerkleTree, ZERO_ROOT, type BlockRoot } from './blocks.ts';

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).chainInfo ? sdkMod : (sdkMod as any).default;

/** One 1,000-root call is ~23.6M gas; CC3's block limit is 75M. */
const MAX_GAS = 40_000_000;
const DEFAULT_MAX_BASE_FEE_GWEI = 1.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (f: string) => process.argv.includes(f);

/** Every height in [lo, hi] already held, read word by word from the mirror's bitmap. */
async function fullyHeld(mirror: Contract, chain: number, lo: number, hi: number): Promise<boolean> {
  for (let w = lo >> 8; w <= hi >> 8; w++) {
    const word = BigInt(await mirror.heldWord(chain, w));
    const first = Math.max(lo, w << 8) - (w << 8);
    const last = Math.min(hi, (w << 8) + 255) - (w << 8);
    const width = BigInt(last - first + 1);
    const mask = ((1n << width) - 1n) << BigInt(first);
    if ((word & mask) !== mask) return false;
  }
  return true;
}

let lastCalmNote = 0;
async function waitForCalm(cc: JsonRpcProvider, maxGwei: number) {
  const ceiling = BigInt(Math.round(maxGwei * 1e9));
  for (;;) {
    const blk = await cc.getBlock('latest');
    const fee = blk?.baseFeePerGas ?? 0n;
    if (fee <= ceiling) return;
    if (Date.now() - lastCalmNote > 60_000) {
      console.log(`  … base fee ${(Number(fee) / 1e9).toFixed(2)} gwei > ${maxGwei} — pausing so the chain can recover`);
      lastCalmNote = Date.now();
    }
    await sleep(8_000 + Math.floor(Math.random() * 4_000));
  }
}

const LOG = new URL('../../docs/CAMPAIGN-deep.md', import.meta.url);
function logRow(row: string) {
  if (!existsSync(LOG)) {
    writeFileSync(
      LOG,
      '# Deep campaign — the archive repairing and extending itself\n\n' +
        'Every row below was mirrored **without the hosted prover**: roots computed from public Ethereum\n' +
        'receipts, the digest chain walked from a checkpoint Creditcoin stores, and `0x0FD2` asked to\n' +
        'reject it. Written by `worker/src/deep-mirror.ts`.\n\n' +
        '| when (UTC) | interval | roots | new | gas | held after | tx |\n|---|---|---|---|---|---|---|\n',
    );
  }
  appendFileSync(LOG, row + '\n');
}

async function main() {
  const chain = Number(get('--chain') ?? 3);
  const dryRun = flag('--dry-run');
  const maxBaseFeeGwei = Number(get('--max-base-fee') ?? DEFAULT_MAX_BASE_FEE_GWEI);
  const keyEnv = get('--key');
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !key) throw new Error(`--key ${keyEnv} is set but that variable is empty`);

  const cc = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(key ?? privateKey(), cc);
  const mirror = new Contract(MIRROR, MIRROR_ABI, wallet);
  const info = new sdk.chainInfo.PrecompileChainInfoProvider(cc);
  const pool = new ThreadedRoots(chain, Number(get('--threads') ?? 0) || undefined);
  const single = new BlockPool(chain);

  const lowest = Number(await mirror.lowestMirrored(chain));
  const from = Number(get('--from') ?? lowest - 1);
  const to = Number(get('--to') ?? from - 999);
  if (to > from) throw new Error('--to must be below --from: this worker walks downward');

  console.log('deep mirror — no prover in the loop');
  console.log('  chain        :', CHAINS[chain].name, `(chainKey ${chain})`);
  console.log('  signer       :', wallet.address);
  console.log('  held from    :', lowest.toLocaleString());
  console.log('  target range :', to.toLocaleString(), '..', from.toLocaleString(), `(${(from - to + 1).toLocaleString()} heights)`);
  console.log('  threads      :', pool.threads, '· base fee cap', maxBaseFeeGwei, 'gwei');
  if (dryRun) console.log('  DRY RUN — every interval is simulated, none is sent');
  console.log();

  // Workers keep the event loop alive, so every exit path has to close them.
  const shutdown = async () => {
    await pool.close();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(130)));

  let cursor = from;
  let intervals = 0;
  let added = 0;
  let gasSpent = 0n;
  const t0 = Date.now();

  while (cursor >= to) {
    const bounds: any = await info.getContinuityBounds(chain, cursor);
    const parent = Number(bounds.parentHeight);
    const child = Number(bounds.childHeight);
    if (!Number.isFinite(parent) || !Number.isFinite(child) || child <= parent) {
      console.log(`  ! no continuity bounds around ${cursor.toLocaleString()} — stopping`);
      break;
    }
    const lo = parent + 1;
    const hi = child;

    if (await fullyHeld(mirror, chain, lo, hi)) {
      console.log(`  = ${lo.toLocaleString()}..${hi.toLocaleString()} already held, skipping`);
      cursor = parent - 1;
      continue;
    }

    const fetchStart = Date.now();
    let blocks: BlockRoot[];
    try {
      blocks = await pool.roots(lo, hi, (done, total) => {
        if (done === total || done % 250 === 0) process.stdout.write(`\r  … ${lo.toLocaleString()}..${hi.toLocaleString()}  ${done}/${total} blocks`);
      });
      process.stdout.write('\r' + ' '.repeat(64) + '\r');
    } catch (e) {
      console.log(`  ! ${lo}..${hi}: ${(e as Error).message.slice(0, 140)}`);
      cursor = parent - 1;
      continue;
    }
    const fetchedIn = (Date.now() - fetchStart) / 1000;

    // The anchor must be a block with a transaction. Empty blocks at the start of an interval are
    // walked past by computing their digests locally, which is exactly what the precompile will redo.
    let anchorIndex = blocks.findIndex((b) => b.root !== ZERO_ROOT);
    if (anchorIndex < 0) {
      console.log(`  ! ${lo}..${hi}: every block empty — nothing to anchor on`);
      cursor = parent - 1;
      continue;
    }
    let digest: string = bounds.parentHash;
    for (let i = 0; i < anchorIndex; i++) digest = computeDigestOf(blocks[i].height, blocks[i].root, digest);

    let anchor = blocks[anchorIndex];
    if (!anchor.leaves || anchor.leaves.length === 0) anchor = await single.rootOf(anchor.height, true);
    const leaves = anchor.leaves!;
    const proof = new KeccakMerkleTree(leaves).getProof(0);
    const siblings = proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
    const roots = blocks.slice(anchorIndex).map((b) => b.root);

    const call = [chain, anchor.height, leaves[0], roots[0], siblings, digest, roots] as const;

    // Ask the precompile before spending anything. A locally built chain that does not terminate at
    // the checkpoint Creditcoin stores fails here, where it costs nothing.
    try {
      await mirror.mirror.staticCall(...call);
    } catch (e) {
      console.log(`  ! ${lo}..${hi}: the precompile refused the locally built proof — ${String((e as Error).message).slice(0, 160)}`);
      cursor = parent - 1;
      continue;
    }

    const gas = await mirror.mirror.estimateGas(...call);
    if (Number(gas) > MAX_GAS) {
      console.log(`  ! ${lo}..${hi}: ${Number(gas).toLocaleString()} gas is above the ${MAX_GAS.toLocaleString()} ceiling`);
      cursor = parent - 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `  ~ ${lo.toLocaleString()}..${hi.toLocaleString()}  ${roots.length} roots  ${Number(gas).toLocaleString()} gas  ` +
          `fetched in ${fetchedIn.toFixed(0)}s  (dry run, accepted by the precompile)`,
      );
      intervals++;
      cursor = parent - 1;
      continue;
    }

    await waitForCalm(cc, maxBaseFeeGwei);
    const fee = await cc.getFeeData();
    const tip = (fee.maxPriorityFeePerGas ?? 1_000_000n) + BigInt(1 + Math.floor(Math.random() * 100_000));
    const tx = await mirror.mirror(...call, { gasLimit: (gas * 12n) / 10n, maxPriorityFeePerGas: tip, maxFeePerGas: (fee.maxFeePerGas ?? 2_000_000_000n) + tip });
    const rc = await tx.wait();
    const ev = rc.logs
      .map((l: any) => {
        try {
          return mirror.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((x: any) => x?.name === 'BlocksMirrored');
    if (!ev) throw new Error(`mirror() succeeded but emitted no BlocksMirrored: ${tx.hash}`);
    const newly = Number(ev.args.newlyAdded);
    const heldAfter = Number(await mirror.mirroredBlocks(chain));
    added += newly;
    gasSpent += rc.gasUsed;
    intervals++;

    console.log(
      `  + ${lo.toLocaleString()}..${hi.toLocaleString()}  ${String(roots.length).padStart(4)} roots  ${String(newly).padStart(4)} new  ` +
        `${Number(rc.gasUsed).toLocaleString().padStart(12)} gas  ${fetchedIn.toFixed(0)}s fetch  held ${heldAfter.toLocaleString()}`,
    );
    logRow(
      `| ${new Date().toISOString().replace('T', ' ').slice(0, 19)} | ${lo}–${hi} | ${roots.length} | ${newly} | ${Number(rc.gasUsed)} | ${heldAfter} | [\`${tx.hash.slice(0, 10)}…\`](${EXPLORER}/tx/${tx.hash}) |`,
    );

    cursor = parent - 1;
    if (flag('--once')) break;
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n  intervals    : ${intervals}`);
  console.log(`  heights added: ${added.toLocaleString()}`);
  console.log(`  gas          : ${gasSpent.toLocaleString()} (${(Number(gasSpent) * 1.5e-9).toFixed(2)} tCTC at 1.5 gwei)`);
  console.log(`  elapsed      : ${mins} min`);
  if (single.failures.size) console.log('  endpoint failures:', [...single.failures].map(([h, n]) => `${h} ${n}`).join(', '));
  await pool.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
