import { useEffect, useState } from 'react';
import { MandatePage } from './MandatePage';
import { Stamp } from '../question/Stamp';
import { Trunc } from '../shared/Trunc';
import { MiniStamp, assuranceWord } from '../shared/Assurance';
import { readBook, assessAll, filesOn, policyName, days, WHY, type Book, type Verdict, type FileRow } from './desk';

/**
 * A real Aave V3 borrower, liquidated on Ethereum at block 25,797,699. Somebody staked a bond saying
 * otherwise and lost it. Nobody involved here controls that address, that liquidation or that hunt.
 */
const DEFAULT_SUBJECT = '0x7562be2022d31a75f9887b7b932256c704f0c8e7';

type State =
  | { k: 'loading'; note: string }
  | { k: 'error'; msg: string }
  | { k: 'ok'; subject: string; principal: bigint; book: Book; verdicts: Verdict[]; files: FileRow[] };

const STATUS_KIND: Record<number, 'none' | 'pending' | 'destroyed' | 'economic'> = { 0: 'none', 1: 'pending', 2: 'destroyed', 3: 'economic' };
const tctc = (w: bigint) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 3 });

function initialSubject(): string {
  const q = new URLSearchParams(window.location.search).get('q');
  return q && /^0x[0-9a-fA-F]{40}$/.test(q) ? q : DEFAULT_SUBJECT;
}

/**
 * The four rows a first paint settles into: what history is on hand, what has been said about this
 * address, whether anyone is currently challenging it, and the verdict. The verdict is last because
 * it is a consequence of the three above it, and a reader who disagrees with it should be able to see
 * which of the three they disagree with.
 */
export function Mandate() {
  const [input, setInput] = useState(initialSubject);
  const [amount, setAmount] = useState('1');
  const [s, setS] = useState<State>({ k: 'loading', note: 'reading the desk' });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(input.trim());

  async function run(subject: string, principalText: string) {
    setS({ k: 'loading', note: 'reading the terms on file' });
    const url = new URL(window.location.href);
    url.searchParams.set('q', subject);
    window.history.replaceState(null, '', url);
    try {
      const { parseEther } = await import('ethers');
      let principal: bigint;
      try {
        principal = parseEther(principalText || '0');
      } catch {
        throw new Error('The amount has to be a number of tCTC.');
      }
      const book = await readBook();
      setS({ k: 'loading', note: 'asking the desk' });
      const [verdicts, files] = await Promise.all([assessAll(book, subject, principal), filesOn(subject, book.policies)]);
      setS({ k: 'ok', subject, principal, book, verdicts, files });
    } catch (e: any) {
      setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
    }
  }

  useEffect(() => {
    void run(initialSubject(), '1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refuted = s.k === 'ok' && s.verdicts.some((v) => v.reason === 'ProvenLiar');
  const open = s.k === 'ok' ? s.files.filter((f) => f.status === 1).length : 0;
  const worst = s.k === 'ok' ? (s.verdicts.find((v) => v.reason === 'ProvenLiar') ?? s.verdicts.find((v) => v.reason === 'EventOnRecord') ?? s.verdicts.find((v) => !v.ok) ?? s.verdicts[0]) : null;

  return (
    <MandatePage active="assess" subtitle="underwriting on history nobody here owns">
      <section className="pane assess">
        <h1 className="t-title pane-title">Ask about an address.</h1>
        <p className="t-body pane-lead">
          Every answer below is a live call to the lending contract that holds the money — the same function, with the
          same arguments, that decides whether the transfer happens. It is not a score and there is no number. The desk
          either pays or refuses, and the refusal names the fact that caused it, at a height you can check.
        </p>

        <form
          className="assess-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void run(input.trim(), amount);
          }}
        >
          <label className="t-ui" htmlFor="m-subject">Ethereum address</label>
          <input id="m-subject" className="ledger-input t-hash" value={input} spellCheck={false} autoComplete="off" onChange={(e) => setInput(e.target.value)} aria-invalid={!valid} />
          <label className="t-ui" htmlFor="m-amount">Amount, tCTC</label>
          <input id="m-amount" className="ledger-input t-hash short" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
          <button type="submit" className="act" disabled={!valid || s.k === 'loading'}>{s.k === 'loading' ? 'Asking…' : 'Assess'}</button>
          {!valid && <p className="t-caption field-error">That is not an address — 0x followed by 40 hex characters.</p>}
          <p className="t-caption">
            Opens on <a className="linkish" href={`?q=${DEFAULT_SUBJECT}`}>a borrower Aave liquidated on mainnet</a>.{' '}
            <a className="linkish" href={`/versus/?a=${DEFAULT_SUBJECT}`}>Compare two addresses →</a>
          </p>
        </form>

        {s.k === 'loading' && <p className="t-caption">{s.note}…</p>}
        {s.k === 'error' && <p className="t-body">{s.msg}</p>}

        {s.k === 'ok' && (
          <div className={`assess-result${refuted ? ' has-stamp' : ''}`}>
            {refuted && (
              <div className="assess-stamp">
                <Stamp state="refuted" pressKey={`mandate:${s.subject}:${amount}`} />
              </div>
            )}
            <div>
              <ol className="mandate-rows">
                <li>
                  <span className="t-ui row-label">History on hand</span>
                  <p className="t-body">
                    {s.book.held.toLocaleString()} Ethereum heights, {s.book.lowest.toLocaleString()} to {s.book.head.toLocaleString()}.{' '}
                    {[...s.book.offers.values()].some((o) => o) ? (
                      <>
                        A window of{' '}
                        {(() => {
                          const o = [...s.book.offers.values()].find((x) => x)!;
                          return `${(o.to - o.from + 1).toLocaleString()} heights ending at ${o.to.toLocaleString()}`;
                        })()}{' '}
                        is proven gap-free, which is what makes “nothing happened here” a checkable statement rather than a hope.
                      </>
                    ) : (
                      <>No stretch of history long enough for these terms is currently proven gap-free, so every instrument below refuses.</>
                    )}
                  </p>
                </li>
                <li>
                  <span className="t-ui row-label">What is on file</span>
                  <p className="t-body">
                    {s.files.length === 0 ? (
                      <>Nothing. Nobody has ever staked money on a statement about <Trunc v={s.subject} />. That is silence, and the desk does not read it as innocence.</>
                    ) : (
                      <>
                        {s.files.length} {s.files.length === 1 ? 'statement' : 'statements'}, {tctc(s.files.reduce((a, f) => a + f.bond, 0n))} tCTC staked between them.
                      </>
                    )}
                  </p>
                  {s.files.length > 0 && (
                    <ul className="about">
                      {s.files.map((f) => (
                        <li key={f.id}>
                          <a className="linkish" href={`/watch/?claim=${f.id}`}>#{f.id}</a> {f.kind === 1 ? 'this is the complete list of' : 'no'} such event ·{' '}
                          {f.spanFrom.toLocaleString()}–{f.spanTo.toLocaleString()} · {tctc(f.bond)} tCTC{' '}
                          <span className={`claim-status assurance--${STATUS_KIND[f.status] ?? 'none'}`}>
                            <MiniStamp kind={STATUS_KIND[f.status] ?? 'none'} /> <span className="assurance-word">{assuranceWord(STATUS_KIND[f.status] ?? 'none')}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
                <li>
                  <span className="t-ui row-label">Under challenge</span>
                  <p className="t-body">
                    {open === 0
                      ? 'Nothing about this address is being contested right now.'
                      : `${open} statement${open === 1 ? ' is' : 's are'} open to challenge. The desk will not lend into a fight it can see is still running.`}
                  </p>
                </li>
                <li>
                  <span className="t-ui row-label">Verdict</span>
                  <p className="t-body">
                    {worst ? (
                      <>
                        <strong>{worst.ok ? 'Pays' : 'Refuses'}</strong> — {WHY[worst.reason] ?? worst.reason}
                      </>
                    ) : (
                      'The desk has no instruments on file.'
                    )}
                  </p>
                </li>
              </ol>

              <h2 className="t-ui">Every instrument, on the same address</h2>
              <ul className="verdicts">
                {s.verdicts.map((v) => {
                  const nm = policyName(v.policy);
                  return (
                    <li key={v.policy.id} className={v.ok ? 'is-pay' : v.reason === 'ProvenLiar' ? 'is-liar' : 'is-refuse'}>
                      <span className="t-ui verdict-word">{v.ok ? 'pays' : 'refuses'}</span>
                      <div>
                        <p className="t-ui">
                          <a className="linkish" href={`/files/?p=${v.policy.id}`}>
                            {v.policy.kind === 0 ? 'Silence accepted' : 'Bond required'} · {nm.venue} · {nm.event}
                          </a>{' '}
                          · looks back {days(v.policy.window)} days · up to {tctc(v.policy.maxPrincipal)} tCTC
                        </p>
                        <p className="t-caption">
                          <code>{v.reason}</code> — {WHY[v.reason] ?? ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <p className="t-caption mandate-foot">
                The desk holds {tctc(s.book.float)} tCTC and has lent {tctc(s.book.backing.outstanding)}. It may not lend past{' '}
                {tctc(s.book.backing.cap)} tCTC in total, because that is what the {s.book.backing.attestors} attestors who stand behind
                Ethereum's history on this chain have bonded — every fact here rests on them, so the money at risk is held to
                what they have at stake. Nothing is minted, nothing is transferable, and there is no number.
              </p>
            </div>
          </div>
        )}
      </section>
    </MandatePage>
  );
}
