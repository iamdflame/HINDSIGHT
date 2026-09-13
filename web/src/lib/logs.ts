/**
 * `eth_getLogs` over a wide range from the browser: adaptively split, and corroborated.
 *
 * Mirrors `worker/src/config.ts#getLogsAdaptive`, for the same measured reasons. Endpoints refuse
 * very different widths -- Tenderly served 648,000 mainnet blocks in one filtered request, mevblocker
 * and flashbots cap at 10,000, publicnode at 1,000 -- so each is asked for the whole range and halved
 * on refusal. And one endpoint was measured returning an empty result for a query that had a match,
 * with no error, so a *negative* is only believed once two endpoints have each covered the entire
 * range. A positive needs no second opinion: the transaction it names is verified against the
 * notarised root before anything moves.
 */
import { JsonRpcProvider } from 'ethers';

export const LOG_RPCS: Record<number, string[]> = {
  3: [
    'https://gateway.tenderly.co/public/mainnet',
    'https://rpc.mevblocker.io',
    'https://rpc.flashbots.net',
    'https://ethereum-rpc.publicnode.com',
  ],
  1: ['https://gateway.tenderly.co/public/sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'],
};

export type ScanResult = { logs: any[]; corroboratedBy: string[] };

export async function scanLogs(
  chainKey: number,
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
  onProgress?: (m: string) => void,
  corroboration = 2,
): Promise<ScanResult> {
  const urls = LOG_RPCS[chainKey] ?? LOG_RPCS[3];
  const minChunk = 500;

  async function cover(url: string): Promise<any[]> {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
    const out: any[] = [];
    const stack: [number, number][] = [[fromBlock, toBlock]];
    let done = 0;
    const total = toBlock - fromBlock + 1;
    while (stack.length) {
      const [a, b] = stack.pop()!;
      try {
        const got = await Promise.race([
          p.getLogs({ ...filter, fromBlock: a, toBlock: b }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 25_000)),
        ]);
        out.push(...got);
        done += b - a + 1;
        if (total > 20_000) onProgress?.(`${new URL(url).host}: ${Math.round((done / total) * 100)}% of ${total.toLocaleString()} blocks`);
      } catch (e) {
        if (b - a + 1 <= minChunk) throw new Error(`${new URL(url).host} refused ${a}..${b}`);
        const mid = Math.floor((a + b) / 2);
        stack.push([mid + 1, b], [a, mid]);
      }
    }
    return out;
  }

  const seen = new Map<string, any>();
  const covered: string[] = [];
  const failures: string[] = [];
  for (const url of urls) {
    try {
      onProgress?.(`scanning on ${new URL(url).host}…`);
      const logs = await cover(url);
      covered.push(new URL(url).host);
      for (const l of logs) seen.set(`${l.transactionHash}:${l.index}`, l);
      if (seen.size > 0 || covered.length >= corroboration) break;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (seen.size === 0 && covered.length < corroboration) {
    throw new Error(
      `Only ${covered.length} public endpoint(s) could cover this range and none found a match. ` +
        `That is not silence, so it is not reported as silence. (${failures.join('; ')})`,
    );
  }
  return {
    logs: [...seen.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index),
    corroboratedBy: covered,
  };
}

/** A log's position inside its transaction's receipt -- the index the registry uses. -1 if the tx failed. */
export async function receiptLogIndex(chainKey: number, log: any): Promise<number> {
  const p = new JsonRpcProvider((LOG_RPCS[chainKey] ?? LOG_RPCS[3])[0], undefined, { staticNetwork: true });
  const rc = await p.getTransactionReceipt(log.transactionHash);
  if (!rc) throw new Error(`no receipt for ${log.transactionHash}`);
  if (rc.status !== 1) return -1;
  const i = rc.logs.findIndex((l) => l.index === log.index);
  if (i < 0) throw new Error('log not found in its own receipt');
  return i;
}
