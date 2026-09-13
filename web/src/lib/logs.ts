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

/**
 * Measured 2026-09-13: flashbots answered zero logs for ranges that hold them, publicnode's Sepolia node
 * serves old blocks with no logs or receipts, so neither is here. Every endpoint is also canaried.
 */
export const LOG_RPCS: Record<number, string[]> = {
  3: ['https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io', 'https://ethereum-public.nodies.app'],
  1: ['https://gateway.tenderly.co/public/sepolia', 'https://eth-sepolia.api.onfinality.io/public', 'https://ethereum-sepolia-public.nodies.app'],
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type ScanResult = { logs: any[]; corroboratedBy: string[] };

export async function scanLogs(
  chainKey: number,
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
  onProgress?: (m: string) => void,
  corroboration = 2,
  /** Every log is needed, not one: a completeness hunt. Needs `corroboration` full covers that agree. */
  exhaustive = false,
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
  const counts: number[] = [];
  for (const url of urls) {
    try {
      // Canary: a pruned node answers an old query with an empty list, not an error. It must show it
      // serves logs at the bottom of the range before its silence can count.
      const probe = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
      const canary = await Promise.race([
        probe.getLogs({ topics: [TRANSFER_TOPIC], fromBlock, toBlock: fromBlock + 4 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000)),
      ]);
      if (canary.length === 0) throw new Error(`${new URL(url).host} serves no logs at ${fromBlock}; not counted`);
      onProgress?.(`scanning on ${new URL(url).host}…`);
      const logs = await cover(url);
      covered.push(new URL(url).host);
      counts.push(new Set(logs.map((l) => `${l.transactionHash}:${l.index}`)).size);
      for (const l of logs) seen.set(`${l.transactionHash}:${l.index}`, l);
      if ((!exhaustive && seen.size > 0) || covered.length >= corroboration) break;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (exhaustive && covered.length < corroboration) {
    throw new Error(
      `A completeness hunt needs ${corroboration} public endpoints to list every matching log in this range; ` +
        `only ${covered.length} could. Anything less could miss the omitted one. (${failures.join('; ')})`,
    );
  }
  if (exhaustive && counts.some((c) => c !== seen.size)) {
    throw new Error(`Public endpoints disagree about this range (${counts.join(' vs ')} logs), so neither list is treated as complete.`);
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
