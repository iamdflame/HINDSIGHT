import type { ProofBundle, Progress } from './proof';

/**
 * Rebuild a proof from public Ethereum data, in a Web Worker when the browser has one.
 *
 * Re-encoding and hashing a whole block is seconds of CPU; on the page's own thread it froze input for
 * most of that time (Lighthouse measured 9.7s of blocking on the home page). This module deliberately
 * imports no SDK: the page loads only the few lines that start the worker, and the worker loads and runs
 * `rebuildInThisThread` from `lib/proof.ts` -- the identical code the fallback runs here.
 */
export function proofFromEthereum(txHash: string, onProgress?: Progress, chainKey = 3): Promise<ProofBundle> {
  const inline = () => import('./proof').then((m) => m.rebuildInThisThread(txHash, onProgress, chainKey));
  if (typeof Worker === 'undefined') return inline();
  return new Promise<ProofBundle>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      inline().then(resolve, reject);
      return;
    }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { progress?: string; result?: ProofBundle; error?: string };
      if (m.progress) onProgress?.(m.progress);
      else if (m.result) {
        worker.terminate();
        resolve(m.result);
      } else if (m.error !== undefined) {
        worker.terminate();
        reject(new Error(m.error));
      }
    };
    // A worker that cannot even load (an old browser, a strict CSP) falls back to this thread, not to failure.
    worker.onerror = (ev) => {
      ev.preventDefault();
      worker.terminate();
      inline().then(resolve, reject);
    };
    worker.postMessage({ txHash, chainKey });
  });
}
