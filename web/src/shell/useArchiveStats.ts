import { useEffect, useRef, useState } from 'react';

export type ChainCoverage = { held: number; lowest: number; highest: number };

export type ArchiveStats =
  | { status: 'loading' }
  | { status: 'offline' }
  | {
      status: 'ok';
      mainnet: ChainCoverage;
      sepolia: ChainCoverage;
      /** Blocks between Ethereum's head and the last height Attestcoin has attested. */
      attestedLag: number | null;
      spans: number;
      claims: number;
      /** Kept for the dateline's count-up: mainnet held. */
      blocks: number;
    };

const MIN_REFRESH_MS = 30_000;

/**
 * The register of record, read live. Mirror v2 counts a held empty block as held, so the number
 * shown is the number that answers questions -- no subtraction, no footnote.
 *
 * The chain layer is imported on demand so the first paint never waits for ethers. No timers: it
 * re-reads only when the page becomes visible again or the caller's key changes, never more than
 * once per 30s.
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
      const chain = await import('../lib/chain');
      const m = chain.mirrorContract();
      const r = chain.registryContract();
      const K = chain.CHAIN_KEY_ETH_MAINNET;
      const S = chain.CHAIN_KEY_SEPOLIA;

      const [mh, ml, mx, sh, sl, sx, spans, claims] = await Promise.all([
        m.mirroredBlocks(K),
        m.lowestMirrored(K),
        m.highestMirrored(K),
        m.mirroredBlocks(S),
        m.lowestMirrored(S),
        m.highestMirrored(S),
        m.spanCount(),
        r.claimCount(),
      ]);

      // The lag is informational and must never make the register look offline if one of its two
      // sources is slow, so it is read separately and tolerated.
      let attestedLag: number | null = null;
      try {
        const [attested, ethHead] = await Promise.all([chain.attestedHead(K), chain.ethereum().getBlockNumber()]);
        attestedLag = Math.max(0, ethHead - attested);
      } catch {
        attestedLag = null;
      }

      everOk.current = true;
      setStats({
        status: 'ok',
        mainnet: { held: Number(mh), lowest: Number(ml), highest: Number(mx) },
        sepolia: { held: Number(sh), lowest: Number(sl), highest: Number(sx) },
        attestedLag,
        spans: Number(spans),
        claims: Number(claims),
        blocks: Number(mh),
      });
    } catch {
      // A failed refresh keeps the last honest reading; only a register never reached is offline.
      if (!everOk.current) setStats({ status: 'offline' });
    } finally {
      inFlight.current = false;
    }
  }

  useEffect(() => {
    void read(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (refreshKey !== undefined) void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return stats;
}
