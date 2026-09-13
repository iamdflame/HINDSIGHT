/**
 * One thread of the root builder: fetch a block with its receipts, hash it into a transaction root.
 *
 * Measured per block on this machine: 668 ms to fetch and wrap, 1,482 ms to hash ~250 transactions. The
 * hashing is the wall and it is synchronous, so the parent keeps two jobs in flight here: the second
 * block's receipts are on the wire while the first is being hashed, and the core never waits for a
 * packet. Each worker holds its own endpoints and its own SDK instance.
 */
import { parentPort } from 'node:worker_threads';
import { BlockPool } from './blocks.ts';

if (!parentPort) throw new Error('block-worker must be run as a worker thread');

const pools = new Map<number, BlockPool>([[3, new BlockPool(3)]]);

parentPort.on('message', async (msg: { id: number; chainKey: number; height: number; withLeaves: boolean }) => {
  try {
    if (!pools.has(msg.chainKey)) pools.set(msg.chainKey, new BlockPool(msg.chainKey));
    // Started immediately, before anything is awaited on this job: that is what overlaps the fetch
    // with whichever sibling job is currently holding the core.
    const fetched = pools.get(msg.chainKey)!.fetchOf(msg.height);
    const got = BlockPool.hashOf(msg.height, await fetched, msg.withLeaves);
    parentPort!.postMessage({ id: msg.id, ok: true, root: got.root, leaves: got.leaves, height: got.height });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: String((e as Error).message).slice(0, 200), height: msg.height });
  }
});
