import { useEffect, useState } from 'react';
import { ArchiveStrip } from './ArchiveStrip';
import { SpanList, type SealedSpan } from './SpanList';
import { Page } from '../shell/Page';

type ChainView = {
  chainKey: number;
  name: string;
  held: number;
  lowest: number;
  highest: number;
  words: bigint[];
  firstWord: number;
  unheldInRange: number;
  emptyBlocks: number | null;
  spans: SealedSpan[];
};

type State =
  | { k: 'loading'; note: string }
  | { k: 'empty' }
  | { k: 'error'; msg: string }
  | { k: 'ok'; chains: ChainView[] };

const WORD_BATCH = 96;

/**
 * Coverage read straight from the mirror's held bitmap. One `heldWord` read covers 256 heights, so
 * ninety days of Ethereum is ~2,500 reads -- batched by ethers into a handful of JSON-RPC requests
 * -- rather than 648,000. Nothing here is cached or precomputed off-chain: what is drawn is what the
 * contract says, as of this page load.
 */
export function Record() {
  const [s, setS] = useState<State>({ k: 'loading', note: 'reading the held bitmap…' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const chain = await import('../lib/chain');
        const m = chain.mirrorContract();
        const measured: any = (await import('../../../deployments.json')).default?.measured ?? {};
        const views: ChainView[] = [];

        for (const [chainKey, name] of [
          [chain.CHAIN_KEY_ETH_MAINNET, 'Ethereum mainnet'],
          [chain.CHAIN_KEY_SEPOLIA, 'Sepolia'],
        ] as const) {
          const held = Number(await m.mirroredBlocks(chainKey));
          if (held === 0) continue;
          const lowest = Number(await m.lowestMirrored(chainKey));
          const highest = Number(await m.highestMirrored(chainKey));

          const firstWord = Math.floor(lowest / 256);
          const lastWord = Math.floor(highest / 256);
          const words: bigint[] = new Array(lastWord - firstWord + 1).fill(0n);
          for (let w = firstWord; w <= lastWord; w += WORD_BATCH) {
            const n = Math.min(WORD_BATCH, lastWord - w + 1);
            const got = await Promise.all(Array.from({ length: n }, (_, i) => m.heldWord(chainKey, w + i) as Promise<bigint>));
            got.forEach((v, i) => (words[w - firstWord + i] = BigInt(v)));
            if (cancelled) return;
            setS({ k: 'loading', note: `reading the held bitmap — ${name}, ${Math.round(((w + n - firstWord) / words.length) * 100)}%` });
          }

          const spanCount = Number(await m.spanCount());
          const spans: SealedSpan[] = [];
          for (let i = spanCount - 1; i >= 0 && spans.length < 16; i--) {
            const sp = await m.spanOf(i);
            if (Number(sp.chainKey) !== chainKey) continue;
            spans.push({ id: i, from: Number(sp.fromBlock), to: Number(sp.toBlock) });
          }
          spans.reverse();

          const perChain = measured.chains?.[String(chainKey)];
          views.push({
            chainKey,
            name,
            held,
            lowest,
            highest,
            words,
            firstWord,
            unheldInRange: highest - lowest + 1 - held,
            emptyBlocks: typeof perChain?.emptyBlocks === 'number' ? perChain.emptyBlocks : null,
            spans,
          });
        }
        if (cancelled) return;
        setS(views.length ? { k: 'ok', chains: views } : { k: 'empty' });
      } catch (e: any) {
        if (!cancelled) setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page active="record">
      <section className="record">
        <h1>What is held.</h1>
        <p className="lede">
          Every Ethereum height whose transaction root lives on Creditcoin, read from the mirror’s bitmap as
          this page loaded. A hole is exactly where a contradicting transaction could sit unseen, so a tick
          containing even one unheld height is drawn in wax, however many blocks the tick stands for.
        </p>

        {s.k === 'loading' && <p className="t-caption">{s.note}</p>}
        {s.k === 'empty' && <p className="t-caption">Nothing is held yet.</p>}
        {s.k === 'error' && <p className="t-caption">The public Creditcoin RPC refused the read: {s.msg}</p>}

        {s.k === 'ok' &&
          s.chains.map((c) => {
            const isHeld = (h: number) => ((c.words[Math.floor(h / 256) - c.firstWord] >> BigInt(h % 256)) & 1n) === 1n;
            return (
              <div key={c.chainKey} className="record-chain">
                <h2>
                  {c.name} <span className="t-hash">chainKey {c.chainKey}</span>
                </h2>
                <p className="t-ui record-summary">
                  <span className="num">{c.held.toLocaleString()}</span> heights held · ≈{' '}
                  {((c.held * 12) / 86_400).toFixed(1)} days ·{' '}
                  {c.unheldInRange === 0 ? 'no holes' : `${c.unheldInRange.toLocaleString()} unheld inside the range`}
                  {c.emptyBlocks !== null && <> · {c.emptyBlocks.toLocaleString()} empty blocks, held</>}
                </p>
                <ArchiveStrip lowest={c.lowest} highest={c.highest} isHeld={isHeld} label={c.name} />
                <p className="legend t-caption">
                  <span><i className="tick tick--run is-inked" aria-hidden="true" /> every height in the tick held</span>
                  <span><i className="tick tick--gap" aria-hidden="true" /> at least one height not held</span>
                </p>
                {c.spans.length > 0 && (
                  <>
                    <h3 className="t-ui">Sealed spans</h3>
                    <SpanList spans={c.spans} />
                  </>
                )}
              </div>
            );
          })}

        <p className="t-caption record-foot">
          An empty Ethereum block has a transaction root of zero. The first mirror could not tell that from
          “not stored”, which cut its archive into 25 runs. This mirror keeps a separate bitmap, so an empty
          block is held like any other height and a span seals straight across it.
        </p>
      </section>
    </Page>
  );
}
