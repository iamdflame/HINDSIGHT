import { useEffect, useState } from 'react';
import { MandatePage } from './MandatePage';
import { readBook, policyName, days, type Book, type Policy } from './desk';

/**
 * One page per instrument: the terms as filed, and what currently makes them answerable.
 *
 * An instrument here is a policy on the desk. Anyone may file one and filing grants nothing -- a
 * policy chooses which public facts get consulted, and cannot mark an address eligible. So this page
 * is a terms sheet, not a catalogue of products the operator approves of, and it says which of the
 * terms are arithmetic and which are somebody's bond.
 */

type State = { k: 'loading' } | { k: 'error'; msg: string } | { k: 'ok'; book: Book };

const tctc = (w: bigint) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 3 });
const EXPLORER = 'https://creditcoin-testnet.blockscout.com';

function Instrument({ p, book, open }: { p: Policy; book: Book; open: boolean }) {
  const nm = policyName(p);
  const offer = book.offers.get(p.id) ?? null;
  const covered = offer ? offer.to - offer.from + 1 : 0;
  const lag = offer ? book.head - offer.to : null;
  const answerable = offer !== null && lag !== null && lag <= p.maxStaleness;
  // Utuh's rule, resolved for these terms: the bond a borrower needs is whichever is larger.
  const needForMax = p.maxPrincipal / 10n > p.minBond ? p.maxPrincipal / 10n : p.minBond;

  return (
    <details className="instrument" open={open} id={`p${p.id}`}>
      <summary>
        <span className="t-ui">{p.kind === 0 ? 'Silence accepted' : 'Bond required'}</span>
        <span className="t-body">{nm.venue} · {nm.event}</span>
        <span className={`t-ui instrument-state ${answerable ? 'is-live' : 'is-shut'}`}>{answerable ? 'answering' : 'refusing'}</span>
      </summary>

      <p className="t-body">
        {p.kind === 0 ? (
          <>
            The honest default. Nothing said about an address is treated as nothing said — not as a clean record. A
            refuted statement or a listed event inside the window blocks, and so does a live challenge. It answers
            questions and never lends: there is no bond beneath silence to size a loan against.
          </>
        ) : (
          <>
            The expensive kind of clean. Somebody must have staked a bond saying no such event touched this address
            across the whole window, survived the challenge period without being refuted, and left more beyond recovery
            than the loan is worth. It is the one that looks like a green tick, so it is never the default.
          </>
        )}
      </p>

      <dl className="terms t-caption">
        <div><dt>Looks back</dt><dd>{p.window.toLocaleString()} Ethereum blocks ≈ {days(p.window)} days</dd></div>
        <div><dt>Window may end below the head by</dt><dd>{p.maxStaleness === 0 ? 'nothing — it must reach the head' : `${p.maxStaleness.toLocaleString()} blocks ≈ ${days(p.maxStaleness)} days`}</dd></div>
        <div><dt>Most it will lend</dt><dd>{tctc(p.maxPrincipal)} tCTC</dd></div>
        <div><dt>Least a lie must have cost</dt><dd>{p.minBond === 0n ? 'not applicable' : `${tctc(p.minBond)} tCTC beyond recovery`}</dd></div>
        <div>
          <dt>Bond needed to borrow the maximum</dt>
          <dd>
            {p.kind === 0 ? 'no amount of bond makes this instrument lend' : (
              <>
                {tctc(needForMax)} tCTC beyond recovery — a loan may not exceed ten times what a liar could not get back,
                and half of any bond goes to whoever breaks it
              </>
            )}
          </dd>
        </div>
        <div><dt>Watching</dt><dd>{p.chainKey === 1 ? 'Ethereum Sepolia' : 'Ethereum mainnet'} · <a className="linkish" href={`${EXPLORER}/address/${p.venue}`} target="_blank" rel="noreferrer">{p.venue}</a></dd></div>
        <div>
          <dt>History it can prove right now</dt>
          <dd>
            {offer ? (
              <>
                {covered.toLocaleString()} heights to {offer.to.toLocaleString()}, gap-free
                {lag === 0 ? ', at the top of the archive' : `, ending ${lag!.toLocaleString()} blocks below the top`}
              </>
            ) : (
              <>none long enough — every question under these terms is refused until the archive catches up</>
            )}
          </dd>
        </div>
      </dl>

      <p className="t-caption">
        {answerable ? (
          <>
            <a className="linkish" href={`/mandate/?q=0x7562be2022d31a75f9887b7b932256c704f0c8e7`}>Ask this instrument about an address →</a>
          </>
        ) : (
          <>
            These terms currently refuse everyone, for the same reason they would refuse a liar: the archive cannot
            demonstrate it holds the history they look back over. Refusing on incapacity is the only safe direction.
          </>
        )}
      </p>
    </details>
  );
}

export function Files() {
  const [s, setS] = useState<State>({ k: 'loading' });
  const wanted = Number(new URLSearchParams(window.location.search).get('p') ?? -1);

  useEffect(() => {
    void readBook()
      .then((book) => setS({ k: 'ok', book }))
      .catch((e: any) => setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) }));
  }, []);

  return (
    <MandatePage active="files" subtitle="the terms, as filed">
      <section className="pane">
        <h1 className="t-title pane-title">Instruments on file.</h1>
        <p className="t-body pane-lead">
          Anyone may file terms, and filing grants nothing: terms only choose which public facts get consulted, and
          cannot mark an address eligible. There is no administrator who can add an exception, and no key that can
          pause any of this. What follows is every instrument the desk holds, read from the desk.
        </p>

        {s.k === 'loading' && <p className="t-caption">reading the terms…</p>}
        {s.k === 'error' && <p className="t-body">{s.msg}</p>}
        {s.k === 'ok' && (
          <>
            <p className="t-caption">
              The desk holds {tctc(s.book.float)} tCTC and has lent {tctc(s.book.backing.outstanding)} of a{' '}
              {tctc(s.book.backing.cap)} tCTC ceiling — set by the {s.book.backing.attestors} attestors who stand behind
              Ethereum's history here, each bonded {tctc(s.book.backing.minBond)} CTC. Not our number to raise.
            </p>
            <div className="instruments">
              {s.book.policies.map((p) => (
                <Instrument key={p.id} p={p} book={s.book} open={p.id === wanted || (wanted < 0 && p.id === 0)} />
              ))}
            </div>
          </>
        )}
      </section>
    </MandatePage>
  );
}
