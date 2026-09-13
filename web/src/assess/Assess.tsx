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
  maxStaleness: number;
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
  | { k: 'ok'; subject: string; verdicts: Verdict[]; claims: ClaimAbout[]; files: number; archive: { lowest: number; highest: number; held: number; contiguous: { window: number; floor: number; run: number; whole: boolean } } };

/**
 * A real Aave V3 borrower, liquidated on mainnet at block 25,797,699 by `0x0b72a88d…`. Board claim #2
 * said otherwise and the hunter refuted it against a held root, so the page opens on a refusal that
 * matters. The liquidation stays inside the 90-day window until roughly block 26,445,700.
 */
const DEFAULT_SUBJECT = '0x7562be2022d31a75f9887b7b932256c704f0c8e7';

const STATUS_KIND: Record<number, 'none' | 'pending' | 'destroyed' | 'economic'> = { 0: 'none', 1: 'pending', 2: 'destroyed', 3: 'economic' };

const REASON_TEXT: Record<string, string> = {
  None: 'Pays. Nothing on the board disqualifies this address under this policy.',
  NoSuchPolicy: 'No such policy.',
  ArchiveTooShallow: 'Refuses: the archive does not yet hold the history this policy insists on. An answer drawn from history the archive does not hold is not an answer.',
  ClaimUnderHunt: 'Refuses: an open claim about this address is being hunted right now. The desk does not lend into a fight.',
  ProvenLiar: 'Refuses: someone claimed this address was clean, and a transaction inside the window proved otherwise against a notarised root. Backed by cryptography, not by a bond.',
  EventOnRecord: 'Refuses: a claim on the board lists this very event about this address inside the window, and every listed event was verified against a notarised root when it was filed.',
  NoBondedCleanliness: 'Refuses: this policy needs a standing no-event claim over the whole window, ending near the head, whose unrecoverable half covers the principal. There is none.',
  DeskOutOfFunds: 'Refuses: the desk does not hold enough to lend this much.',
  AlreadyLent: 'Refuses: this desk already lent to this address under this policy. One loan each — there is no repayment path.',
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
        maxStaleness: Number(p.maxStaleness),
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

      // The registry indexes claims by (chain, venue, event, topic slot, subject), so this reads the
      // files for this address under every event the site knows about -- a few calls, however
      // many claims the board holds -- rather than walking the board.
      setS({ k: 'loading', note: 'reading the registry’s files on this address…' });
      const reg = registryContract();
      const wanted = '0x' + subject.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const { VENUES } = await import('../lib/chain');
      const keys = new Map<string, true>();
      for (const chainKey of [CHAIN_KEY_ETH_MAINNET, 1]) {
        for (const v of VENUES) for (const e of v.events) keys.set(JSON.stringify([chainKey, v.address, e.topic0, e.subjectTopic]), true);
      }
      for (const p of policies) keys.set(JSON.stringify([p.chainKey, p.venue, p.topic0, p.subjectTopic]), true);
      const ids = new Set<number>();
      await Promise.all(
        [...keys.keys()].map(async (k) => {
          const [chainKey, venue, topic0, slot] = JSON.parse(k);
          const key = await reg.keyOf(chainKey, venue, topic0, slot, wanted);
          const rec = await reg.recordOf(key);
          const total = Number(rec.total);
          const under = await Promise.all(Array.from({ length: total }, (_, i) => reg.claimUnderKey(key, i)));
          for (const id of under) ids.add(Number(id));
        }),
      );
      const claims: ClaimAbout[] = (
        await Promise.all([...ids].sort((a, b) => a - b).map(async (id) => [id, await reg.claimOf(id)] as const))
      ).map(([id, c]: readonly [number, any]) => ({
        id,
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
      }));

      const m = mirrorContract();
      const [lowest, highest, held] = await Promise.all([
        m.lowestMirrored(CHAIN_KEY_ETH_MAINNET),
        m.highestMirrored(CHAIN_KEY_ETH_MAINNET),
        m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
      ]);
      // How far back, from the top, every height is held: the number the desk's depth check reads.
      const deepest = Math.max(...policies.filter((p) => p.chainKey === CHAIN_KEY_ETH_MAINNET).map((p) => p.window), 0);
      const probeFrom = Number(highest) - deepest;
      const run = deepest > 0 && probeFrom > 0 ? Number(await m.contiguousFrom(CHAIN_KEY_ETH_MAINNET, probeFrom, deepest + 1)) : 0;
      // `run` counts upward from the policy floor to the first missing height (or the window's top).
      const contiguous = { window: deepest, floor: probeFrom, run, whole: deepest > 0 && run === deepest + 1 };
      setS({
        k: 'ok',
        subject,
        verdicts,
        claims,
        files: keys.size,
        archive: { lowest: Number(lowest), highest: Number(highest), held: Number(held), contiguous },
      });
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

  // The stamp means what it means everywhere else on the site, and nothing more. REFUTED is pressed
  // only when a claim about this address really was refuted inside a policy's window. A desk that
  // pays is not a proof of anything about the address, so paying presses no stamp at all.
  const headline = useMemo(() => {
    if (s.k !== 'ok') return null;
    return s.verdicts.some((v) => v.reason === 'ProvenLiar') ? ('refuted' as const) : null;
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
                Archive: {s.archive.held.toLocaleString()} mainnet heights between {s.archive.lowest.toLocaleString()} and{' '}
                {s.archive.highest.toLocaleString()}.{' '}
                {s.archive.contiguous.whole ? (
                  <>Every one of the {(s.archive.contiguous.window + 1).toLocaleString()} heights from {s.archive.contiguous.floor.toLocaleString()} to the top is held, with no gap.</>
                ) : s.archive.contiguous.window > 0 ? (
                  <>Counting up from {s.archive.contiguous.floor.toLocaleString()}, the first missing height is {(s.archive.contiguous.floor + s.archive.contiguous.run).toLocaleString()}.</>
                ) : null}{' '}
                The desk reads that bitmap, not the endpoints — a policy whose window has a hole is refused <code>ArchiveTooShallow</code> rather
                than answered. Claims shown are those filed under the {s.files} (chain, venue, event, slot) files this site knows;
                the desk reads exactly the file its policy names.
                Borrowing needs a Creditcoin wallet and underwrites <em>your own</em> address — there is no field for someone else’s.
              </p>
            </div>
          </div>
        )}
      </section>
    </Page>
  );
}
