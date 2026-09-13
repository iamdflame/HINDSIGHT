/// <reference lib="webworker" />
/**
 * The in-browser Merkle rebuild, off the page's thread. Same function as `lib/proof.ts` runs inline;
 * this file only carries messages.
 */
import { rebuildInThisThread } from './proof';

self.onmessage = async (e: MessageEvent<{ txHash: string; chainKey: number }>) => {
  const { txHash, chainKey } = e.data;
  try {
    const result = await rebuildInThisThread(txHash, (progress) => self.postMessage({ progress }), chainKey);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: (err as Error).message ?? String(err) });
  }
};
