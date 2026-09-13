import { useEffect, useMemo, useState } from 'react';
import { Page } from '../shell/Page';
import { Stamp } from '../question/Stamp';
import { describeClaim, tctc } from '../watch/ClaimRow';
import { MiniStamp, assuranceWord } from '../shared/Assurance';
import { Trunc } from '../shared/Trunc';

type Policy = {
  id: number;
  kind: number; // 0 BlankFile · 1 BondedClean
  chainKey: number;
  window: number;
  venue: string;
  topic0: string;
  subjectTopic: number;
  minBond: bigint;
  maxPrincipal: bigint;
};

type ClaimAbout = {
  id: number;
  status: number;
  kind: number;
  chainKey: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  spanFrom: number;
  spanTo: number;
  bond: bigint;
};

type Verdict = { policy: Policy; ok: boolean; reason: string };

type State =
  | { k: 'idle' }
  | { k: 'loading'; note: string }
  | { k: 'error'; msg: string }
  | { k: 'ok'; subject: string; verdicts: Verdict[]; claims: ClaimAbout[]; archive: { lowest: number; highest: number; held: number } };

/** A real Ethereum address with a real Aave V3 liquidation, so the page opens on something that matters. */
const DEFAULT_SUBJECT = '0x180c0bd66467218add0190eacbad0aa62f39397b';

const STATUS_KIND: Record<number, 'none' | 'pending' | 'destroyed' | 'economic'> = { 0: 'none', 1: 'pending', 2: 'destroyed', 3: 'economic' };

const REASON_TEXT: Record<string, string> = {
  None: 'Pays. Nothing on the board disqualifies this address under this policy.',
  NoSuchPolicy: 'No such policy.',
  ArchiveTooShallow: 'Refuses: the archive does not yet hold the history this policy insists on. An answer drawn from history the archive does not hold is not an answer.',
  ClaimUnderHunt: 'Refuses: an open claim about this address is being hunted right now. The desk does not lend into a fight.',
  ProvenLiar: 'Refuses: someone produced the transaction and it verified against a notarised root. The only status here backed by cryptography.',
  NoBondedCleanliness: 'Refuses: this policy needs a standing claim of cleanliness whose unrecoverable bond covers the principal, and there is none.',
  DeskOutOfFunds: 'Refuses: the desk does not hold enough to lend this much.',
};

function initialSubject(): string {
  const q = new URLSearchParams(window.location.search).get('q');
  return q && /^0x[0-9a-fA-F]{40}$/.test(q) ? q : DEFAULT_SUBJECT;
}

/**
 * The desk, as a product page. Paste any Ethereum address; the desk's own `assess()` answers, as a
 * `view`, with the reason and the claims behind it. It is the same predicate `borrow()` gates on --
 * not a reimplementation -- so the answer on this page is the answer the money follows.
 *
 * Nothing here is a score. The desk either pays or refuses, and says why.
 */
export function Assess() {
  const [input, setInput] = useState(initialSubject);
  const [principal, setPrincipal] = useState('1');
  const [s, setS] = useState<State>({ k: 'idle' });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(input.trim());

  async function run(subject: string) {
    setS({ k: 'loading', note: 'reading the desk’s policies…' });
    const url = new URL(window.location.href);
    url.searchParams.set('q', subject);
    window.history.replaceState(null, '', url);
    try {
      const { deskContract, registryContract, mirrorContract, REFUSAL, parseEther, CHAIN_KEY_ETH_MAINNET } = await import('../lib/chain').then(async (m) => ({
        ...m,
        parseEther: (await import('ethers')).parseEther,
      }));
      const desk = deskContract();
      const n = Number(await desk.policyCount());
      const policies: Policy[] = (await Promise.all(Array.from({ length: n }, (_, i) => desk.policyOf(i)))).map((p: any, i: number) => ({
        id: i,
        kind: Number(p.kind),
        chainKey: Number(p.chainKey),
        window: Number(p.window),
        venue: p.venue,
        topic0: p.topic0,
        subjectTopic: Number(p.subjectTopic),
        minBond: BigInt(p.minBond),
        maxPrincipal: BigInt(p.maxPrincipal),
      }));

      let amount: bigint;
      try {
        amount = parseEther(principal || '0');
      } catch {
        throw new Error('Principal must be a number of tCTC.');
      }

      setS({ k: 'loading', note: `asking the desk about ${subject.slice(0, 10)}… under ${n} ${n === 1 ? 'policy' : 'policies'}` });
      const verdicts: Verdict[] = await Promise.all(
        policies.map(async (p) => {
          const [ok, reason] = await desk.assess(subject, p.id, amount);
          return { policy: p, ok: Boolean(ok), reason: REFUSAL[Number(reason)] ?? String(reason) };
        }),
      );

      setS({ k: 'loading', note: 'reading every claim about this address…' });
      const reg = registryContract();
      const count = Number(await reg.claimCount());
      const wanted = '0x' + subject.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const all = await Promise.all(Array.from({ length: count }, (_, i) => reg.claimOf(i)));
      const claims: ClaimAbout[] = all
        .map((c: any, i: number) => ({
          id: i,
          status: Number(c.status),
          kind: Number(c.kind),
          chainKey: Number(c.chainKey),
          venue: c.venue,
          topic0: c.topic0,
          subject: c.subject,
          subjectTopic: Number(c.subjectTopic),
          spanFrom: Number(c.spanFrom),
          spanTo: Number(c.spanTo),
          bond: BigInt(c.bondStaked),
        }))
        .filter((c) => c.subject.toLowerCase() === wanted);

      const m = mirrorContract();
      const [lowest, highest, held] = await Promise.all([
        m.lowestMirrored(CHAIN_KEY_ETH_MAINNET),
        m.highestMirrored(CHAIN_KEY_ETH_MAINNET),
        m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
      ]);
      setS({ k: 'ok', subject, verdicts, claims, archive: { lowest: Number(lowest), highest: Number(highest), held: Number(held) } });
    } catch (e: any) {
      setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
    }
  }

  useEffect(() => {
    void run(initialSubject());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [venues, setVenues] = useState<any[]>([]);
  useEffect(() => {
    void import('../lib/chain').then((m) => setVenues(m.VENUES as any));
  }, []);

  const headline = useMemo(() => {
    if (s.k !== 'ok' || s.verdicts.length === 0) return null;
    // The strictest verdict wins the stamp: a proven liar is shown as refuted even if another policy would pay.
    if (s.verdicts.some((v) => v.reason === 'ProvenLiar')) return 'refuted' as const;
    if (s.verdicts.every((v) => v.ok)) return 'proven' as const;
    return 'standing' as const;
  }, [s]);

  return (
    <Page active="assess">
      <section className="pane assess">
        <h1 className="t-title pane-title">Would the desk lend?</h1>
        <p className="t-body pane-lead">
          Paste an Ethereum address. The desk answers from the notarised archive and the claim board — no indexer,
          no wallet, no score. It pays, or it refuses and says why. The default policy treats silence as silence:
          an address nobody has said anything about is not assumed clean, and is not assumed guilty.
        </p>

        <form
          className="assess-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void run(input.trim());
          }}
        >
          <label className="t-ui" htmlFor="assess-subject">Ethereum address</label>
          <input
            id="assess-subject"
            className="ledger-input t-hash"
            value={input}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
            aria-invalid={!valid}
          />
          <label className="t-ui" htmlFor="assess-principal">Principal, tCTC</label>
          <input id="assess-principal" className="ledger-input t-hash short" value={principal} inputMode="decimal" onChange={(e) => setPrincipal(e.target.value)} />
          <button type="submit" className="act" disabled={!valid || s.k === 'loading'}>
            {s.k === 'loading' ? 'Asking…' : 'Assess'}
          </button>
          {!valid && <p className="t-caption field-error">That is not an address — 0x followed by 40 hex characters.</p>}
          <p className="t-caption">
            Opens on <a className="linkish" href={`?q=${DEFAULT_SUBJECT}`}>a borrower Aave V3 liquidated on mainnet</a>.
          </p>
        </form>

        {s.k === 'loading' && <p className="t-caption">{s.note}</p>}
        {s.k === 'error' && <p className="t-body">{s.msg}</p>}

        {s.k === 'ok' && (
          <div className={`assess-result${headline ? ' has-stamp' : ''}`}>
            {headline && (
              <div className="assess-stamp">
                <Stamp state={headline} pressKey={`assess:${s.subject}:${principal}`} />
              </div>
            )}
            <div>
              {s.verdicts.length === 0 && <p className="t-body">The desk has no policies yet.</p>}
              <ul className="verdicts">
                {s.verdicts.map((v) => {
                  const d = describeClaim({ venue: v.policy.venue, topic0: v.policy.topic0, subject: '0x', subjectTopic: 0 }, venues);
                  return (
                    <li key={v.policy.id} className={v.ok ? 'is-pay' : v.reason === 'ProvenLiar' ? 'is-liar' : 'is-refuse'}>
                      <span className="t-ui verdict-word">{v.ok ? 'pays' : 'refuses'}</span>
                      <div>
                        <p className="t-ui">
                          policy {v.policy.id} · {v.policy.kind === 0 ? 'BlankFile' : 'BondedClean'} · {d.event} ·{' '}
                          {v.policy.chainKey === 1 ? 'Sepolia' : 'mainnet'} · last {v.policy.window.toLocaleString()} blocks ≈{' '}
                          {((v.policy.window * 12) / 86_400).toFixed(0)} days
                        </p>
                        <p className="t-caption">
                          <code>{v.reason}</code> — {REASON_TEXT[v.reason] ?? ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <h2 className="t-ui">What the board says about <Trunc v={s.subject} /></h2>
              {s.claims.length === 0 ? (
                <p className="t-caption">
                  Nothing. No claim on the registry names this address. Under <code>BlankFile</code> that is silence, not innocence;
                  under <code>BondedClean</code> it is a refusal.
                </p>
              ) : (
                <ul className="about">
                  {s.claims.map((c) => {
                    const d = describeClaim(c, venues);
                    const kind = STATUS_KIND[c.status] ?? 'none';
                    return (
                      <li key={c.id}>
                        <a className="linkish" href={`/watch/?claim=${c.id}`}>#{c.id}</a>{' '}
                        {c.kind === 1 ? 'these are all the' : 'no'} {d.event} · {c.spanFrom.toLocaleString()}–{c.spanTo.toLocaleString()} · {tctc(c.bond)} tCTC{' '}
                        <span className={`claim-status assurance--${kind}`}>
                          <MiniStamp kind={kind} /> <span className="assurance-word">{assuranceWord(kind)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="t-caption">
                Archive: {s.archive.held.toLocaleString()} mainnet heights, {s.archive.lowest.toLocaleString()} – {s.archive.highest.toLocaleString()}.
                A policy that needs more history than that is refused <code>ArchiveTooShallow</code> rather than answered.
                Borrowing needs a Creditcoin wallet and underwrites <em>your own</em> address — there is no field for someone else’s.
              </p>
            </div>
          </div>
        )}
      </section>
    </Page>
  );
}
