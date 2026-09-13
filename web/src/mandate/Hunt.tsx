import { useEffect, useState } from 'react';
import { MandatePage } from './MandatePage';
import { Trunc } from '../shared/Trunc';
import board from '../../../contracts/test/fixtures/board-v3-mainnet.json';
import { house } from '../../../deployments.json';
import facts from '../lib/record.generated.json';

/** Addresses this project operates. A refutation by one of these is the house, and is labelled so. */
const HOUSE = new Set(Object.values(house).filter((v) => typeof v === 'string' && v.startsWith('0x')).map((v) => (v as string).toLowerCase()));

/**
 * The hunt as a job, not a page of documentation.
 *
 * A bounty is a false statement somebody staked money on: "this address was never liquidated here",
 * about an address that was. Refute it -- produce the transaction, checked against the archive -- and
 * half the bond is yours. The other half burns, which is why a liar cannot refute themselves and walk
 * away whole, and why the leaderboard counts burned tCTC and nothing else: it is the one number that
 * cannot be farmed by filing and refuting your own claims.
 *
 * Every figure here is read from the registry. The gas range is measured from this board's own past
 * refutations; the fee is Creditcoin's current base fee; the expected value is the difference.
 * `worker/src/seed-v3.ts --replenish 4` keeps at least four open, and `/api/gates` says whether it has.
 */

type Claim = {
  id: number;
  status: number;
  kind: number;
  chainKey: number;
  bond: bigint;
  payout: bigint;
  openUntil: number;
  spanFrom: number;
  spanTo: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  claimant: string;
  refuter: string;
};

type State = { k: 'loading' } | { k: 'error'; msg: string } | { k: 'ok'; claims: Claim[]; baseFee: bigint; now: number };

/** Measured on this board: the cheapest and dearest refutations so far, in gas. From the record, not typed. */
const GAS: { min: number; max: number } = (facts as any).refutationGas ?? { min: 0, max: 0 };
const EXPLORER = 'https://creditcoin-testnet.blockscout.com';
const tctc = (w: bigint, d = 3) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: d });

/** What the repository says about a claim, if it says anything. Public since the day it was filed. */
const documented = new Map<number, { role: string; counterexample?: { txHash: string; block: number } }>(
  (board as any).claims.map((c: any) => [c.claimId, { role: c.role, counterexample: c.counterexample ?? c.omitted }]),
);

function venueName(venue: string, topic0: string, venues: any[]): string {
  for (const v of venues) {
    if (v.address.toLowerCase() !== venue.toLowerCase()) continue;
    const e = v.events.find((x: any) => x.topic0 === topic0);
    if (e) return `${v.label} · ${e.label}`;
  }
  return `${venue.slice(0, 6)}… · ${topic0.slice(0, 10)}…`;
}

function until(ts: number, now: number): string {
  const s = ts - now;
  if (s <= 0) return 'window closed — finalise or refute';
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min left`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h left`;
}

export function Hunt() {
  const [s, setS] = useState<State>({ k: 'loading' });
  const [venues, setVenues] = useState<any[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const { registryContract, creditcoin, VENUES } = await import('../lib/chain');
        setVenues(VENUES as any);
        const r = registryContract();
        const cc = creditcoin();
        const [n, shareBps, fee, block] = await Promise.all([r.claimCount(), r.REFUTER_SHARE_BPS(), cc.getFeeData(), cc.getBlock('latest')]);
        const ids = Array.from({ length: Number(n) }, (_, i) => i);
        const rows = await Promise.all(ids.map((i) => r.claimOf(i)));
        const claims: Claim[] = rows.map((c: any, k: number) => {
          const staked = BigInt(c.bondStaked);
          return {
            id: ids[k],
            status: Number(c.status),
            kind: Number(c.kind),
            chainKey: Number(c.chainKey),
            bond: staked,
            payout: (staked * BigInt(shareBps)) / 10_000n,
            openUntil: Number(c.openUntil),
            spanFrom: Number(c.spanFrom),
            spanTo: Number(c.spanTo),
            venue: c.venue,
            topic0: c.topic0,
            subject: c.subject,
            subjectTopic: Number(c.subjectTopic),
            claimant: c.claimant,
            refuter: c.refuter,
          };
        });
        setS({ k: 'ok', claims, baseFee: BigInt(fee.gasPrice ?? 1_500_000_000n), now: block?.timestamp ?? Math.floor(Date.now() / 1000) });
      } catch (e: any) {
        setS({ k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) });
      }
    })();
  }, []);

  const open = s.k === 'ok' ? s.claims.filter((c) => c.status === 1).sort((a, b) => Number(b.payout - a.payout)) : [];
  const refuted = s.k === 'ok' ? s.claims.filter((c) => c.status === 2) : [];
  const documentedOpen = open.filter((c) => ['lie', 'bounty', 'omission'].includes(documented.get(c.id)?.role ?? ''));

  // Burned tCTC per refuter: the leaderboard, and the only score.
  const board_ = new Map<string, { burned: bigint; paid: bigint; count: number }>();
  for (const c of refuted) {
    const row = board_.get(c.refuter) ?? { burned: 0n, paid: 0n, count: 0 };
    row.burned += c.bond - c.payout;
    row.paid += c.payout;
    row.count++;
    board_.set(c.refuter, row);
  }
  const leaders = [...board_.entries()].sort((a, b) => Number(b[1].burned - a[1].burned));
  const worstCost = s.k === 'ok' ? BigInt(GAS.max) * s.baseFee : 0n;
  const bestCost = s.k === 'ok' ? BigInt(GAS.min) * s.baseFee : 0n;

  return (
    <MandatePage active="hunt" subtitle="paid to be right">
      <section className="pane">
        <h1 className="t-title pane-title">Open bounties.</h1>
        <p className="t-body pane-lead">
          Each row is a statement somebody staked money on. Find the transaction that contradicts it, check it against
          the archive, reveal it, and half the bond is yours — the other half burns, so a liar cannot refute themselves
          and walk away whole. No wallet is needed to hunt; one is needed to collect.
        </p>

        {s.k === 'loading' && <p className="t-caption">reading the board…</p>}
        {s.k === 'error' && <p className="t-body">{s.msg}</p>}

        {s.k === 'ok' && (
          <>
            <p className="t-caption">
              {open.length} open · {documentedOpen.length} of them documented in the repository as false, with the counterexample recorded —{' '}
              {documentedOpen.length >= 4 ? 'the board promises at least four, and keeps it' : 'below the four the board promises; the replenisher is due'}.
              Refuting costs {GAS.min.toLocaleString()}–{GAS.max.toLocaleString()} gas here, measured; at today's{' '}
              {(Number(s.baseFee) / 1e9).toFixed(2)} gwei that is {tctc(bestCost, 4)}–{tctc(worstCost, 4)} tCTC.
            </p>

            <table className="tax hunt-board">
              <thead>
                <tr>
                  <th>claim</th>
                  <th>says</th>
                  <th>about</th>
                  <th>pays</th>
                  <th>expected value</th>
                  <th>window</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {open.map((c) => {
                  const doc = documented.get(c.id);
                  const ev = c.payout - worstCost;
                  return (
                    <tr key={c.id} className={doc && ['lie', 'bounty', 'omission'].includes(doc.role) ? 'is-job' : ''}>
                      <td className="t-hash">#{c.id}</td>
                      <td>
                        {c.kind === 1 ? 'these are all the' : 'no'} {venueName(c.venue, c.topic0, venues)}
                        <br />
                        <span className="t-caption">{c.spanFrom.toLocaleString()}–{c.spanTo.toLocaleString()}</span>
                      </td>
                      <td className="t-hash"><Trunc v={'0x' + c.subject.slice(26)} /></td>
                      <td>{tctc(c.payout)} tCTC</td>
                      <td>
                        {ev > 0n ? '+' : ''}{tctc(ev)} tCTC
                        {doc && ['lie', 'bounty', 'omission'].includes(doc.role) && (
                          <>
                            <br />
                            <span className="t-caption">
                              documented false{doc.counterexample ? ` — see block ${doc.counterexample.block.toLocaleString()}` : ''}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="t-caption">{until(c.openUntil, s.now)}</td>
                      <td><a className="linkish" href={`/watch/?claim=${c.id}`}>hunt →</a></td>
                    </tr>
                  );
                })}
                {open.length === 0 && (
                  <tr><td colSpan={7} className="t-caption">Nothing is open. Every statement on the board has either been refuted or has stood.</td></tr>
                )}
              </tbody>
            </table>

            <h2 className="t-ui">Leaderboard</h2>
            <p className="t-caption">
              Scored by tCTC burned — the half of every broken bond that nobody receives. Filing and refuting your own
              claims moves this number exactly as much as it costs you, which is the point of scoring it this way.
            </p>
            <table className="tax">
              <thead>
                <tr><th>hunter</th><th></th><th>refutations</th><th>collected</th><th>burned</th></tr>
              </thead>
              <tbody>
                {leaders.map(([who, row]) => (
                  <tr key={who}>
                    <td className="t-hash"><a className="linkish" href={`${EXPLORER}/address/${who}`} target="_blank" rel="noreferrer"><Trunc v={who} /></a></td>
                    <td className="t-caption">{HOUSE.has(who.toLowerCase()) ? 'the house' : 'a stranger'}</td>
                    <td>{row.count}</td>
                    <td>{tctc(row.paid)} tCTC</td>
                    <td>{tctc(row.burned)} tCTC</td>
                  </tr>
                ))}
                {leaders.length === 0 && <tr><td colSpan={5} className="t-caption">No refutations yet.</td></tr>}
              </tbody>
            </table>
            <p className="t-caption">
              {leaders.length > 0 && leaders.every(([who]) => HOUSE.has(who.toLowerCase())) ? (
                <>
                  Every refutation so far was made by this project's own hunter, which waits six days before taking a
                  bounty so that a stranger can get there first. A stranger's name in this table is the result this page
                  exists to make possible, and it has not happened yet.
                </>
              ) : leaders.some(([who]) => !HOUSE.has(who.toLowerCase())) ? (
                <>At least one refutation was made by an address this project does not operate.</>
              ) : null}
            </p>
          </>
        )}
      </section>
    </MandatePage>
  );
}
