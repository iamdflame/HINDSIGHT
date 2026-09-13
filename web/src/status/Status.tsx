import { useEffect, useState } from 'react';
import { Page } from '../shell/Page';

type Gate = { id: string; title: string; pass: boolean; detail: string; ms: number };
type Run = { pass: boolean; ranAt: string; creditcoinBlock: number; durationMs: number; trigger: string; gates: Gate[]; source: string };

/**
 * The honesty machine, in public. GitHub does not run this project's CI (the account is billing-locked),
 * so the promises CI was meant to hold are re-checked by /api/gates against live Creditcoin state: by
 * free schedulers, and by this page every time someone opens it. Nothing here is computed in the
 * browser from a copy of the data -- the page shows what the function found, when, and at which block.
 */
export function Status() {
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/gates')
      .then(async (r) => {
        const j = await r.json();
        if (!alive) return;
        if (!Array.isArray(j.gates)) throw new Error(j.error ?? `the gates endpoint answered ${r.status}`);
        setRun(j);
      })
      .catch((e) => alive && setErr(e?.message ?? String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const age = run ? Math.max(0, Math.round((Date.now() - Date.parse(run.ranAt)) / 60_000)) : 0;
  const failed = run?.gates.filter((g) => !g.pass) ?? [];

  return (
    <Page active="status">
      <section className="pane status">
        <h1 className="t-title pane-title">The promises, re-checked.</h1>
        <p className="t-body pane-lead">
          Every gate below runs against live Creditcoin state: once a day by Vercel Cron, and whenever someone opens this page. No key, no transaction. A result is at most five minutes old. If any gate
          fails, the endpoint answers <code>503</code> and the schedulers raise the alarm.
        </p>

        {!run && !err && <p className="t-caption">Running the gates against Creditcoin…</p>}
        {err && <p className="t-body">The gates could not be read: {err}</p>}

        {run && (
          <>
            <p className={`t-ui status-summary${run.pass ? '' : ' is-broken'}`}>
              {run.pass ? `all ${run.gates.length} gates hold` : `${failed.length} of ${run.gates.length} gates broken`} · Creditcoin block{' '}
              {run.creditcoinBlock.toLocaleString('en-US')} · {age === 0 ? 'just now' : `${age} min ago`} · {(run.durationMs / 1000).toFixed(1)}s ·{' '}
              run by a {run.trigger}
            </p>
            <ul className="indep-rows status-rows">
              {run.gates.map((g) => (
                <li key={g.id} className={g.pass ? 'is-expected' : 'is-surprise'}>
                  <span className="mark" aria-hidden="true">{g.pass ? '✓' : '!'}</span>
                  <div>
                    <span className="t-ui">{g.title}</span>
                    <span className="t-caption outcome">
                      {g.pass ? 'holds' : 'broken'} · {g.detail}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="t-caption">
              Every expectation comes from the repository — the bytecode the contracts compile to, the measured record, the board as
              filed — through <code>worker/src/gates-manifest.ts</code>, never from the function itself.{' '}
              <a className="linkish" href="/api/gates">The raw result</a> ·{' '}
              <a className="linkish" href={run.source} target="_blank" rel="noreferrer">the code that ran</a>. Contract tests (
              <code>forge test</code>) are not here: they need a compiler, and run locally.
            </p>
          </>
        )}
      </section>
    </Page>
  );
}
