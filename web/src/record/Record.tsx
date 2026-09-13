import { useEffect, useState } from 'react';
import type { TabId } from '../shell/Tabs';
import { CoverageStrip, type CoverageRun } from './CoverageStrip';
import { SpanList, type SealedSpan } from './SpanList';

type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'empty' }
  | { k: 'ok'; runs: CoverageRun[]; spans: SealedSpan[] };

export function Record({ onTab }: { onTab: (t: TabId) => void }) {
  const [s, setS] = useState<State>({ k: 'loading' });

  useEffect(() => { void load(); }, []);

  async function load() {
    setS({ k: 'loading' });
    try {
      const { mirrorContract, CHAIN_KEY_ETH_MAINNET, DEPLOY_BLOCK } = await import('../lib/chain');
      const m = mirrorContract();
      const total = Number(await m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
      if (total === 0) { setS({ k: 'empty' }); return; }

      // Coverage comes from the archive's own `BlocksMirrored` events, merged into contiguous runs.
      const raw = await m.queryFilter(m.filters.BlocksMirrored(CHAIN_KEY_ETH_MAINNET), DEPLOY_BLOCK, 'latest');
      const intervals = raw
        .map((e: any) => ({ from: Number(e.args.fromBlock), to: Number(e.args.toBlock) }))
        .sort((a, b) => a.from - b.from);
      if (intervals.length === 0) throw new Error('NO_EVENTS');

      const merged: { from: number; to: number }[] = [];
      for (const iv of intervals) {
        const last = merged[merged.length - 1];
        if (last && iv.from <= last.to + 1) last.to = Math.max(last.to, iv.to);
        else merged.push({ ...iv });
      }
      // Events say what was retained. They cannot see that a retained root of zero -- an empty
      // Ethereum block -- reads as absent to `isMirrored` and cannot be sealed across. Those
      // heights are measured off-chain by `worker/src/measure.ts`, checked by CI, and split in here
      // so the strip shows the archive as it can actually be used rather than as one unbroken run.
      const { EMPTY_BLOCK_HEIGHTS } = await import('../lib/chain');
      const empties = [...EMPTY_BLOCK_HEIGHTS].sort((a, b) => a - b);
      const pieces: { from: number; to: number; breakKind?: 'gap' | 'empty' }[] = [];
      for (const r of merged) {
        let from = r.from;
        for (const e of empties) {
          if (e < from || e > r.to) continue;
          if (e > from) pieces.push({ from, to: e - 1, breakKind: 'empty' });
          from = e + 1;
        }
        if (from <= r.to) pieces.push({ from, to: r.to });
      }
      const runs: CoverageRun[] = pieces.map((r, i) => {
        const next = pieces[i + 1];
        const gapAfter = next ? next.from - r.to - 1 : 0;
        return {
          from: r.from,
          to: r.to,
          ticks: r.to - r.from + 1,
          gapAfter,
          breakKind: gapAfter > 0 ? (r.breakKind ?? 'gap') : undefined,
        };
      });

      const spanCount = Number(await m.spanCount());
      const spans: SealedSpan[] = [];
      for (let i = Math.max(0, spanCount - 24); i < spanCount; i++) {
        const sp = await m.spanOf(i);
        spans.push({ id: i, from: Number(sp.fromBlock), to: Number(sp.toBlock) });
      }
      setS({ k: 'ok', runs, spans });
    } catch (e: any) {
      const raw = e?.shortMessage ?? e?.message ?? String(e);
      const msg = /coalesce|range|limit|too many|timeout|NO_EVENTS/i.test(raw)
        ? 'The public Creditcoin RPC refused the log query for this range. Coverage is derived from the archive’s own events, so this is a node limit rather than missing history.'
        : raw;
      setS({ k: 'error', msg });
    }
  }

  return (
    <section id="panel-record" role="tabpanel" aria-labelledby="tab-record" className="pane">
      <h1 className="t-title pane-title">What is held.</h1>
      <p className="t-body pane-lead">
        Gaps are the subject, not a blemish: a claim of absence is only meaningful over a run with no holes,
        because a hole is exactly where a contradicting transaction could sit unseen.
      </p>

      {s.k === 'loading' && <p className="t-caption">Reading the archive from Creditcoin…</p>}

      {s.k === 'error' && (
        <div className="plain-state">
          <p className="t-body">{s.msg}</p>
          <p className="t-caption"><button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>
        </div>
      )}

      {s.k === 'empty' && (
        <div className="plain-state">
          <p className="t-body">No Ethereum blocks have been notarised into this deployment yet.</p>
        </div>
      )}

      {s.k === 'ok' && (
        <>
          <CoverageStrip runs={s.runs} />
          <p className="legend">
            <span><i className="tick is-inked" aria-hidden="true" /> notarised</span>
            <span><i className="tick tick--gap" aria-hidden="true" /> gap (a contradiction could hide here)</span>
            <span><i className="tick tick--empty" aria-hidden="true" /> empty block (nothing to hide; nothing to seal across)</span>
          </p>

          <h2 className="t-ui section-head">Sealed spans</h2>
          {s.spans.length === 0
            ? <p className="t-caption">No span has been proven gap-free yet.</p>
            : <SpanList spans={s.spans} onTab={onTab} />}
        </>
      )}
    </section>
  );
}
