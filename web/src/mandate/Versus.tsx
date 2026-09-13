import { useEffect, useState } from 'react';
import { MandatePage } from './MandatePage';
import { Trunc } from '../shared/Trunc';
import { readBook, assessAll, filesOn, policyName, days, WHY, type Book, type Verdict, type FileRow } from './desk';

/**
 * Two addresses, one desk, side by side.
 *
 * The point of this page is the third column of the argument, which is not on screen: neither of these
 * addresses belongs to anyone here, neither was chosen for the outcome, and both answers come from the
 * same function call with a different first argument. If the two columns ever agreed for the wrong
 * reason, this is where it would show.
 */

/** Liquidated by Aave on mainnet, and somebody lost a bond saying otherwise. */
const A = '0x7562be2022d31a75f9887b7b932256c704f0c8e7';
/** A real Aave borrower with a standing, bonded claim of cleanliness over the whole window. */
const B = '0xa631a3ad3e715bd15191fb135cdd0b9e1263dc35';
/** A treasury address with no file at all: the column where silence is neither innocence nor guilt. */
const C = '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8';

type Side = { subject: string; verdicts: Verdict[]; files: FileRow[] } | null;
type State = { k: 'loading' } | { k: 'error'; msg: string } | { k: 'ok'; book: Book; left: Side; right: Side };

const tctc = (w: bigint) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 3 });
const param = (k: string, d: string) => {
  const v = new URLSearchParams(window.location.search).get(k);
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : d;
};

function Column({ side, book }: { side: Side; book: Book }) {
  if (!side) return <div className="versus-col"><p className="t-caption">—</p></div>;
  const headline = side.verdicts.find((v) => v.reason === 'ProvenLiar') ?? side.verdicts.find((v) => v.reason === 'EventOnRecord') ?? side.verdicts.find((v) => v.ok) ?? side.verdicts[0];
  const staked = side.files.reduce((a, f) => a + f.bond, 0n);
  return (
    <div className={`versus-col${headline?.ok ? ' is-pay' : ' is-refuse'}`}>
      <p className="t-hash versus-addr">
        <a className="linkish" href={`/mandate/?q=${side.subject}`}><Trunc v={side.subject} /></a>
      </p>
      <p className="t-ui versus-word">{headline?.ok ? 'pays' : 'refuses'}</p>
      <p className="t-caption"><code>{headline?.reason}</code></p>
      <p className="t-body">{WHY[headline?.reason ?? ''] ?? ''}</p>
      <dl className="versus-facts t-caption">
        <div>
          <dt>On file</dt>
          <dd>{side.files.length === 0 ? 'nothing' : `${side.files.length} · ${tctc(staked)} tCTC staked`}</dd>
        </div>
        <div>
          <dt>Open challenges</dt>
          <dd>{side.files.filter((f) => f.status === 1).length}</dd>
        </div>
        <div>
          <dt>Refuted against it</dt>
          <dd>{side.files.filter((f) => f.status === 2).length}</dd>
        </div>
        <div>
          <dt>Standing for it</dt>
          <dd>{side.files.filter((f) => f.status === 3).length}</dd>
        </div>
      </dl>
      <ul className="verdicts versus-verdicts">
        {side.verdicts.map((v) => {
          const nm = policyName(v.policy);
          return (
            <li key={v.policy.id} className={v.ok ? 'is-pay' : v.reason === 'ProvenLiar' ? 'is-liar' : 'is-refuse'}>
              <span className="t-ui verdict-word">{v.ok ? 'pays' : 'refuses'}</span>
              <div>
                <p className="t-ui">{v.policy.kind === 0 ? 'Silence accepted' : 'Bond required'} · {nm.event} · {days(v.policy.window)} d</p>
                <p className="t-caption"><code>{v.reason}</code></p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="t-caption">
        The desk has {tctc(book.float)} tCTC and would pay it to whichever of these addresses holds the key — never to
        whoever asked the question.
      </p>
    </div>
  );
}

export function Versus() {
  const [a, setA] = useState(() => param('a', A));
  const [b, setB] = useState(() => param('b', B));
  const [amount, setAmount] = useState('1');
  const [s, setS] = useState<State>({ k: 'loading' });
  const ok = /^0x[0-9a-fA-F]{40}$/.test(a.trim()) && /^0x[0-9a-fA-F]{40}$/.test(b.trim());

  async function run(left: string, right: string, principalText: string) {
    setS({ k: 'loading' });
    const url = new URL(window.location.href);
    url.searchParams.set('a', left);
    url.searchParams.set('b', right);
    window.history.replaceState(null, '', url);
    try {
      const { parseEther } = await import('ethers');
      const principal = parseEther(principalText || '0');
      const book = await readBook();
      const [lv, lf, rv, rf] = await Promise.all([
        assessAll(book, left, principal),
        filesOn(left, book.policies),
        assessAll(book, right, principal),
        filesOn(right, book.policies),
      ]);
      setS({ k: 'ok', book, left: { subject: left, verdicts: lv, files: lf }, right: { subject: right, verdicts: rv, files: rf } });
    } catch (e: any) {
      setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
    }
  }

  useEffect(() => {
    void run(param('a', A), param('b', B), '1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MandatePage active="versus" subtitle="the same desk, two addresses">
      <section className="pane">
        <h1 className="t-title pane-title">Two addresses, one desk.</h1>
        <p className="t-body pane-lead">
          Both columns are live calls to the contract holding the money, differing only in the address asked about.
          Nobody here holds either key, and neither address was chosen because of its answer — the left one was
          liquidated on Aave and somebody lost a bond denying it; the right one has a standing bond behind it that
          nobody has managed to break.
        </p>

        <form
          className="assess-form versus-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) void run(a.trim(), b.trim(), amount);
          }}
        >
          <label className="t-ui" htmlFor="v-a">Left</label>
          <input id="v-a" className="ledger-input t-hash" value={a} spellCheck={false} autoComplete="off" onChange={(e) => setA(e.target.value)} />
          <label className="t-ui" htmlFor="v-b">Right</label>
          <input id="v-b" className="ledger-input t-hash" value={b} spellCheck={false} autoComplete="off" onChange={(e) => setB(e.target.value)} />
          <label className="t-ui" htmlFor="v-amt">Amount, tCTC</label>
          <input id="v-amt" className="ledger-input t-hash short" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
          <button type="submit" className="act" disabled={!ok || s.k === 'loading'}>{s.k === 'loading' ? 'Asking…' : 'Compare'}</button>
          <p className="t-caption">
            Try a third: <button type="button" className="linkish" onClick={() => { setB(C); void run(a.trim(), C, amount); }}>a treasury address nobody has ever filed against</button> —
            silence, which this desk refuses to read as innocence.
          </p>
        </form>

        {s.k === 'loading' && <p className="t-caption">asking the desk about both…</p>}
        {s.k === 'error' && <p className="t-body">{s.msg}</p>}
        {s.k === 'ok' && (
          <div className="versus">
            <Column side={s.left} book={s.book} />
            <Column side={s.right} book={s.book} />
          </div>
        )}
      </section>
    </MandatePage>
  );
}
