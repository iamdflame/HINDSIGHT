import { useEffect, useState } from 'react';
import { MandatePage } from '../mandate/MandatePage';
import { readBook, assessAll, filesOn, WHY, type Verdict, type FileRow } from '../mandate/desk';

/**
 * One question, one page, for an originator. No partnership badge, no logo, no claim of contact:
 * a memo somebody at a lender could read in a minute, with the desk answering the question live
 * underneath it. The address is the same real Aave borrower the rest of the site opens on.
 */
const SUBJECT = '0x7562be2022d31a75f9887b7b932256c704f0c8e7';

type State = { k: 'loading' } | { k: 'error'; msg: string } | { k: 'ok'; verdicts: Verdict[]; files: FileRow[]; head: number };

export function Aella() {
  const [s, setS] = useState<State>({ k: 'loading' });
  useEffect(() => {
    void (async () => {
      try {
        const book = await readBook();
        const [verdicts, files] = await Promise.all([assessAll(book, SUBJECT, 0n), filesOn(SUBJECT, book.policies)]);
        setS({ k: 'ok', verdicts, files, head: book.head });
      } catch (e: any) {
        setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
      }
    })();
  }, []);
  const liar = s.k === 'ok' ? s.verdicts.find((v) => v.reason === 'ProvenLiar') : undefined;
  const refuted = s.k === 'ok' ? s.files.find((f) => f.status === 2) : undefined;

  return (
    <MandatePage active="assess" subtitle="one question, for an originator">
      <section className="pane">
        <h1 className="t-title pane-title">A question your ledger cannot ask.</h1>
        <p className="t-body pane-lead">
          A credit ledger records the loans it made. It cannot ask Ethereum whether this borrower was liquidated on
          Aave in the last ninety days — not without an indexer, and an indexer is somebody else's database with
          somebody else's uptime. Mandate is that question. Paste the address. The desk answers from block roots
          Creditcoin already holds, or refuses because the archive is too shallow to answer honestly.
        </p>

        <div className="beat beat--key">
          <h2>The question, asked live</h2>
          <p className="t-body">
            <em>Was <code>{SUBJECT.slice(0, 10)}…</code> liquidated on Aave V3 in the last 648,000 Ethereum blocks?</em>
          </p>
          {s.k === 'loading' && <p className="t-caption">asking the desk…</p>}
          {s.k === 'error' && <p className="t-body">{s.msg}</p>}
          {s.k === 'ok' && (
            <>
              <p className="t-body">
                <strong>{liar ? 'Yes — and the desk refuses.' : 'Nothing on file says so.'}</strong>{' '}
                {liar ? WHY.ProvenLiar : 'Under the default instrument that is silence, not innocence, and the desk answers without lending.'}
              </p>
              {refuted && (
                <p className="t-caption">
                  Claim #{refuted.id} said this address was clean across blocks {refuted.spanFrom.toLocaleString()}–{refuted.spanTo.toLocaleString()} and staked{' '}
                  {(Number(refuted.bond) / 1e18).toLocaleString()} tCTC on it. A hunter produced the liquidation transaction, checked it against a held root, and
                  took half; the other half burned. That transaction is the answer, and it is not ours.
                </p>
              )}
              <p className="t-caption">
                Read at archive head {s.head.toLocaleString()}. <a className="linkish" href={`/mandate/?q=${SUBJECT}`}>Every instrument →</a> ·{' '}
                <a className="linkish" href={`/api/certificate?subject=${SUBJECT}`} target="_blank" rel="noreferrer">certificate (PDF)</a> ·{' '}
                <a className="linkish" href={`/api/assess?subject=${SUBJECT}`} target="_blank" rel="noreferrer">JSON</a>
              </p>
            </>
          )}
        </div>

        <article className="beat">
          <h2>What you would be relying on</h2>
          <p className="t-body">
            A cryptographic fact where there is one — the liquidation transaction, verified against a root the
            attestors bound — and an economic one where there is not: "nothing happened" is a statement somebody
            staked money on, open to anyone to refute for half the stake. The desk tells you which kind it is
            answering with, every time, by name.
          </p>
        </article>
        <article className="beat">
          <h2>What you would not be relying on</h2>
          <p className="t-body">
            An indexer, a proving service, an oracle, an operator, or us. The verification is a <code>view</code> on a
            contract with no owner and no pause key; it runs with the proving precompile deleted for the call, and the
            page at <a className="linkish" href="/independence/">/independence</a> does that as it loads. If this project
            stopped tomorrow the archive would stop lengthening and everything already held would still answer.
          </p>
        </article>
        <article className="beat">
          <h2>What it costs to ask</h2>
          <p className="t-body">
            Nothing, from a browser, a curl or an agent. A borrower who wants to be underwritten as their Ethereum
            address signs one transaction from it naming their Creditcoin key; after that the desk reads their record
            when that key asks. No stranger has done this yet, and the site says so wherever it matters.
          </p>
        </article>
        <p className="t-caption">
          This memo names no company as a partner and claims no conversation. It is the question, and the answer, and
          where the answer came from.
        </p>
      </section>
    </MandatePage>
  );
}
