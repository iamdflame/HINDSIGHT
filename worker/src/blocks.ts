/**
 * Ethereum block+receipt fetching for root computation, at campaign speed.
 *
 * The SDK's `SimpleBlockProvider` says of itself that it has "no caching or optimizations": it sleeps
 * 500ms twice per block on purpose and fetches the block before the receipts. A backfill measured at
 * ~0.96 MB of receipts per block cannot afford a second of deliberate idling on top of that, so this
 * subclass keeps the SDK's wrapping (the part that has to agree with the encoder, byte for byte) and
 * changes only the scheduling: both calls at once, no sleeps, and a pool of endpoints so one slow node
 * does not set the pace.
 *
 * Everything here is read-only against public Ethereum nodes. Nothing is trusted from them either: a
 * root computed from a lying node simply fails to meet the digest chain the precompile checks.
 */
import { JsonRpcProvider } from 'ethers';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { LOG_RPCS } from './config.ts';

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).proofProvider ? sdkMod : (sdkMod as any).default;
const { proofProvider, encoding } = sdk;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
export const { computeMerkleRootOfBlock, KeccakMerkleTree, computeDigestOf } = proofProvider.merkle;
export const ENCODING_V1 = encoding.EncodingVersion.V1;
export const ZERO_ROOT = '0x' + '00'.repeat(32);

/**
 * Endpoints that answered `eth_getBlockReceipts` at 108, 180 and 343 days deep when measured on
 * 2026-09-13. Log endpoints are chosen for honest `eth_getLogs`; these are chosen for archive depth,
 * which is a different property, so the list is its own.
 */
export const DEEP_RPCS: Record<number, string[]> = {
  3: [
    'https://gateway.tenderly.co/public/mainnet',
    'https://rpc.mevblocker.io',
    'https://eth.drpc.org',
    'https://ethereum-public.nodies.app',
  ],
  1: ['https://gateway.tenderly.co/public/sepolia', 'https://eth-sepolia.api.onfinality.io/public'],
};

export type BlockRoot = {
  height: number;
  /** Zero for an empty block: its transaction root genuinely is zero, and the mirror holds it anyway. */
  root: string;
  /** ABI-encoded (transaction, receipt) leaves, kept only when the caller asks to anchor here. */
  leaves?: string[];
};

class FastBlockProvider extends SimpleBlockProvider {
  // A plain field, not a parameter property: Node strips types, it does not transform them.
  rpcProvider: JsonRpcProvider;

  constructor(rpcProvider: JsonRpcProvider) {
    super(rpcProvider);
    this.rpcProvider = rpcProvider;
  }

  /** The SDK's own wrapping, with the two deliberate 500ms sleeps removed and both calls in flight. */
  async getBlockWithReceipts(blockNumber: number) {
    const tag = `0x${blockNumber.toString(16)}`;
    const rpc = this.rpcProvider as any;
    const [blockRaw, receiptsRaw] = await Promise.all([
      rpc.send('eth_getBlockByNumber', [tag, true]),
      rpc.send('eth_getBlockReceipts', [tag]),
    ]);
    if (!blockRaw) throw new Error(`block ${blockNumber} not found`);
    if (!receiptsRaw) throw new Error(`receipts for ${blockNumber} not found`);
    const network = await rpc.getNetwork();
    const transactions = blockRaw.transactions.map((t: any) => {
      const formatted = rpc._wrapTransactionResponse(t, network);
      const authorizations = t.authorizationList?.map((a: any) => ({ yParity: Number(a.yParity) })) ?? null;
      return new encoding.TransactionWithRaw(formatted, new encoding.RawTransactionResponse(authorizations));
    });
    const receipts = receiptsRaw.map((r: any) => rpc._wrapTransactionReceipt(r, rpc._network));
    return { block: rpc._wrapBlock(blockRaw, true), transactions, receipts };
  }
}

/** A rotating pool of public endpoints; a failing one is skipped rather than retried into the ground. */
export class BlockPool {
  private readonly providers: FastBlockProvider[];
  private readonly hosts: string[];
  private cursor = 0;
  readonly failures = new Map<string, number>();

  constructor(chainKey: number, urls: string[] = DEEP_RPCS[chainKey] ?? LOG_RPCS[chainKey]) {
    this.hosts = urls.map((u) => new URL(u).host);
    this.providers = urls.map((u) => new FastBlockProvider(new JsonRpcProvider(u, undefined, { staticNetwork: true, batchMaxCount: 1 })));
  }

  /**
   * The network half. Measured at 0.94 MB and 668 ms per block; it is I/O, so several can be in flight
   * at once even on one core. Split out from the hashing so a caller can overlap the two.
   */
  async fetchOf(height: number): Promise<{ transactions: any[]; receipts: any[] }> {
    const errors: string[] = [];
    // Public archive endpoints time out under load rather than refusing, so a height is only declared
    // unavailable after every endpoint has been tried several times, with a widening pause between.
    for (let attempt = 0; attempt < this.providers.length * 3; attempt++) {
      const i = (this.cursor++ + attempt) % this.providers.length;
      if (attempt >= this.providers.length) await new Promise((r) => setTimeout(r, 250 * (attempt - this.providers.length + 1)));
      try {
        return await this.providers[i].getBlockWithReceipts(height);
      } catch (e) {
        const host = this.hosts[i];
        this.failures.set(host, (this.failures.get(host) ?? 0) + 1);
        errors.push(`${host}: ${String((e as Error).message).slice(0, 60)}`);
      }
    }
    throw new Error(`height ${height} unavailable from every endpoint — ${errors.slice(0, 3).join(' | ')}`);
  }

  /**
   * The CPU half: 1,482 ms per block here, synchronous, and the actual wall of this whole exercise.
   * Nothing about it is parallel within a thread -- which is why the thread pool exists.
   */
  static hashOf(height: number, got: { transactions: any[]; receipts: any[] }, withLeaves: boolean): BlockRoot {
    const { transactions, receipts } = got;
    if (transactions.length === 0) return { height, root: ZERO_ROOT, leaves: withLeaves ? [] : undefined };
    const leaves = withLeaves
      ? transactions.map((t: any, k: number) => encoding.abiEncode(t, receipts[k], ENCODING_V1).abi)
      : undefined;
    return { height, root: computeMerkleRootOfBlock(transactions, receipts, ENCODING_V1), leaves };
  }

  /** The transaction root of one height, and optionally the leaves needed to anchor a proof there. */
  async rootOf(height: number, withLeaves = false): Promise<BlockRoot> {
    return BlockPool.hashOf(height, await this.fetchOf(height), withLeaves);
  }

  /** Roots for a contiguous range, `width` in flight, reported as they land. */
  async roots(from: number, to: number, width: number, onProgress?: (done: number, total: number) => void): Promise<BlockRoot[]> {
    const total = to - from + 1;
    const out = new Array<BlockRoot>(total);
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(width, total) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= total) return;
          out[i] = await this.rootOf(from + i, i === 0);
          if (++done % 25 === 0 || done === total) onProgress?.(done, total);
        }
      }),
    );
    return out;
  }
}

/**
 * The same work across threads.
 *
 * Two measurements shape this. Hashing a block is ~1,482 ms of CPU and fetching it ~668 ms of network,
 * so a thread that does them in turn spends a third of its life with its core idle: 0.47 blocks/s
 * instead of 0.67. And the hash is synchronous, so no amount of concurrency inside one thread helps.
 *
 * Hence: one worker per core-to-spare, and **two jobs in flight per worker**, so the next block's
 * receipts are arriving while the current block is being hashed. Beyond two there is nothing left to
 * hide -- the core is already saturated -- and the memory cost of buffered receipts is real (~1 MB each).
 */
export class ThreadedRoots {
  /** Jobs handed to one worker at a time, so a fetch always overlaps the hash before it. */
  static readonly DEPTH = 2;

  private readonly workers: Worker[] = [];
  private readonly load = new Map<Worker, number>();
  private readonly waiting: ((w: Worker) => void)[] = [];
  private readonly pending = new Map<number, { resolve: (b: BlockRoot) => void; reject: (e: Error) => void; worker: Worker }>();
  private id = 0;

  private chainKey: number;

  constructor(chainKey: number, threads = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1)) {
    this.chainKey = chainKey;
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL('./block-worker.ts', import.meta.url));
      w.on('message', (m: { id: number; ok: boolean; root?: string; leaves?: string[]; height: number; error?: string }) => {
        const job = this.pending.get(m.id);
        if (!job) return;
        this.pending.delete(m.id);
        this.release(job.worker);
        if (m.ok) job.resolve({ height: m.height, root: m.root!, leaves: m.leaves });
        else job.reject(new Error(m.error ?? 'worker failed'));
      });
      w.on('error', (e) => {
        for (const [id, job] of this.pending) {
          if (job.worker === w) {
            this.pending.delete(id);
            this.release(w);
            job.reject(e);
          }
        }
      });
      // Deliberately not unref'd: an unreferenced worker lets Node exit while the parent is still
      // awaiting its reply, which ended a run mid-interval with no output at all.
      this.workers.push(w);
      this.load.set(w, 0);
    }
  }

  get threads(): number {
    return this.workers.length;
  }

  private take(): Promise<Worker> {
    let best: Worker | undefined;
    for (const w of this.workers) {
      const n = this.load.get(w)!;
      if (n < ThreadedRoots.DEPTH && (best === undefined || n < this.load.get(best)!)) best = w;
    }
    if (best) {
      this.load.set(best, this.load.get(best)! + 1);
      return Promise.resolve(best);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(w: Worker) {
    const next = this.waiting.shift();
    // The slot is handed straight on rather than decremented and re-taken, so the depth never dips.
    if (next) next(w);
    else this.load.set(w, this.load.get(w)! - 1);
  }

  async rootOf(height: number, withLeaves = false): Promise<BlockRoot> {
    const worker = await this.take();
    const id = this.id++;
    return new Promise<BlockRoot>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker });
      worker.postMessage({ id, chainKey: this.chainKey, height, withLeaves });
    });
  }

  /** Roots for a contiguous range. Leaves are kept for the first height, which anchors the proof. */
  async roots(from: number, to: number, onProgress?: (done: number, total: number) => void): Promise<BlockRoot[]> {
    const total = to - from + 1;
    let done = 0;
    const jobs = Array.from({ length: total }, (_, i) =>
      this.rootOf(from + i, i === 0).then((b) => {
        if (++done % 25 === 0 || done === total) onProgress?.(done, total);
        return b;
      }),
    );
    return Promise.all(jobs);
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
