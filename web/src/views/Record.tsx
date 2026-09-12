import { useEffect, useState } from 'react';
import { mirrorContract, CHAIN_KEY_ETH_MAINNET, MIRROR_ADDRESS, DEPLOY_BLOCK } from '../lib/chain';
import { Empty, Failure, Working, CcAddr, EthBlock } from '../components/Bits';

type Run = { from: number; to: number };
type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'empty' }
  | { k: 'ok'; total: number; lo: number; hi: number; runs: Run[]; spans: { id: number; from: number; to: number }[] };

export function Record() {
  const [s, setS] = useState<State>({ k: 'loading' });

  useEffect(() => { void load(); }, []);

  async function load() {
    setS({ k: 'loading' });
    try {
      const m = mirrorContract();
      const total = Number(await m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET));
      if (total === 0) { setS({ k: 'empty' }); return; }

      const lo = Number(await m.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
      const hi = Number(await m.highestMirrored(CHAIN_KEY_ETH_MAINNET));

      // Derive coverage from the archive's own `BlocksMirrored` events and merge overlapping
      // ranges. An earlier version walked the chain with a stride, which silently reported a
      // 99-block run as 3 because the stride landed mid-run. Events are both exact and cheaper.
      const raw = await m.queryFilter(m.filters.BlocksMirrored(CHAIN_KEY_ETH_MAINNET), DEPLOY_BLOCK, 'latest');
      const intervals = raw
        .map((e: any) => ({ from: Number(e.args.fromBlock), to: Number(e.args.toBlock) }))
        .sort((a, b) => a.from - b.from);

      if (intervals.length === 0) throw new Error('NO_EVENTS');

      const runs: Run[] = [];
      for (const iv of intervals) {
        const last = runs[runs.length - 1];
        // Merge when ranges touch or overlap; a one-block gap is still a gap.
        if (last && iv.from <= last.to + 1) last.to = Math.max(last.to, iv.to);
        else runs.push({ ...iv });
      }

      const spanCount = Number(await m.spanCount());
      const spans: { id: number; from: number; to: number }[] = [];
      for (let i = Math.max(0, spanCount - 12); i < spanCount; i++) {
        const sp = await m.spanOf(i);
        spans.push({ id: i, from: Number(sp.fromBlock), to: Number(sp.toBlock) });
      }

      setS({ k: 'ok', total, lo, hi, runs, spans });
    } catch (e: any) {
      const raw = e?.shortMessage ?? e?.message ?? String(e);
      const msg = /coalesce|range|limit|too many|timeout/i.test(raw)
        ? 'The public Creditcoin RPC refused the log query for this range. Coverage is derived from ' +
          'the archive\'s own events, so this is a node limit rather than missing history.'
        : raw;
      setS({ k: 'error', msg });
    }
  }

  return (
    <section className="pane">
      <h2 className="pane-title">The record</h2>
      <p className="pane-intro">
        Ethereum block commitments held on Creditcoin. Each one arrived inside a continuity proof
        that the block-prover precompile verified — <strong>a single query certifies roughly a
        hundred consecutive blocks</strong>, and every other integration throws ninety-nine of them
        away. Keeping them is what makes verification cheap and the prover optional afterwards.
      </p>

      {s.k === 'loading' && <Working>Reading the archive from Creditcoin…</Working>}

      {s.k === 'error' && (
        <Failure title="Could not read the archive">
          <p>{s.msg}</p>
          <p>The Creditcoin testnet RPC may be unreachable from here.</p>
          <button className="act ghost" onClick={load}>Try again</button>
        </Failure>
      )}

      {s.k === 'empty' && (
        <Empty title="The archive is empty">
          <p>No Ethereum blocks have been notarised into this deployment yet.</p>
        </Empty>
      )}

      {s.k === 'ok' && (
        <>
          <dl className="facts" style={{ marginBottom: '1.8rem' }}>
            <dt>Blocks held</dt><dd>{s.total.toLocaleString()}</dd>
            <dt>Earliest</dt><dd><EthBlock n={s.lo} /></dd>
            <dt>Latest</dt><dd><EthBlock n={s.hi} /></dd>
            <dt>Contiguous runs</dt><dd>{s.runs.length}</dd>
            <dt>Archive</dt><dd><CcAddr addr={MIRROR_ADDRESS} /></dd>
          </dl>

          <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', margin: '0 0 .3rem' }}>Coverage</h3>
          <p className="note" style={{ margin: '0 0 .4rem', borderLeft: 0, paddingLeft: 0 }}>
            Gaps are the subject, not a blemish: a claim of absence is only meaningful over a run
            with no holes, because a hole is exactly where a contradicting transaction could sit unseen.
          </p>
          {s.runs.map((r) => (
            <div key={r.from} style={{ marginBottom: '1.1rem' }}>
              <div style={{ fontSize: '.78rem', color: 'var(--ink-soft)', fontFamily: 'var(--mono)' }}>
                {r.from.toLocaleString()} … {r.to.toLocaleString()} · {(r.to - r.from + 1)} blocks
              </div>
              <div className="coverage">
                {Array.from({ length: Math.min(r.to - r.from + 1, 120) }).map((_, i) => <i key={i} className="on" />)}
              </div>
            </div>
          ))}
          <div className="legend">
            <span><b style={{ background: 'var(--proven)' }} /> notarised</span>
            <span><b style={{ background: 'var(--rule)' }} /> not notarised</span>
          </div>

          <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', margin: '2.2rem 0 .5rem' }}>Sealed spans</h3>
          <p className="note" style={{ margin: '0 0 .8rem', borderLeft: 0, paddingLeft: 0 }}>
            A span is a run proven gap-free once, so later claims can reference it without paying
            that cost again. Claims of absence can only be made over a sealed span.
          </p>
          {s.spans.length === 0 ? (
            <Empty title="No spans sealed yet"><p>Notarised history exists, but nobody has proven a run contiguous yet.</p></Empty>
          ) : (
            <div className="scroll-x">
              <table className="ledger">
                <thead><tr><th>Span</th><th>From</th><th>To</th><th>Blocks</th></tr></thead>
                <tbody>
                  {s.spans.map((sp) => (
                    <tr key={sp.id}>
                      <td className="mono">#{sp.id}</td>
                      <td><EthBlock n={sp.from} /></td>
                      <td><EthBlock n={sp.to} /></td>
                      <td className="mono">{(sp.to - sp.from + 1).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
