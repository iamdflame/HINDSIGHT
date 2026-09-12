import { useEffect, useRef, useState } from 'react';

export type ArchiveStats =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'ok'; blocks: number; spans: number; claims: number };

const MIN_REFRESH_MS = 30_000;

/**
 * The old Standfirst's RPC reads, moved behind the dateline (§9.1). The chain layer is imported on
 * demand so the first paint never waits for ethers. No timers: it re-reads only when the page
 * becomes visible again or the chapter changes, and never more than once per 30s (§7.6).
 */
export function useArchiveStats(refreshKey?: unknown): ArchiveStats {
  const [stats, setStats] = useState<ArchiveStats>({ status: 'loading' });
  const last = useRef(0);
  const inFlight = useRef(false);
  const everOk = useRef(false);

  async function read(force = false) {
    const now = Date.now();
    if (inFlight.current || (!force && now - last.current < MIN_REFRESH_MS)) return;
    inFlight.current = true;
    last.current = now;
    try {
      const { mirrorContract, registryContract, CHAIN_KEY_ETH_MAINNET } = await import('../lib/chain');
      const [blocks, spans, claims] = await Promise.all([
        mirrorContract().mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
        mirrorContract().spanCount(),
        registryContract().claimCount(),
      ]);
      everOk.current = true;
      setStats({ status: 'ok', blocks: Number(blocks), spans: Number(spans), claims: Number(claims) });
    } catch {
      // A failed refresh keeps the last honest reading; only a register never reached is offline.
      if (!everOk.current) setStats({ status: 'offline' });
    } finally {
      inFlight.current = false;
    }
  }

  useEffect(() => {
    void read(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (last.current !== 0) void read();
  }, [refreshKey]);

  return stats;
}
