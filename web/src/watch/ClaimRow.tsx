import { Trunc } from '../shared/Trunc';
import { MiniStamp, assuranceWord } from '../shared/Assurance';
import { STATUS_KIND, type Claim } from './types';

/** wei → "2.00" without pulling ethers into the page's first chunk. */
export function tctc(wei: bigint): string {
  const cents = (wei + 5_000_000_000_000_000n) / 10_000_000_000_000_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function describeClaim(c: Claim, venues: readonly { label: string; address: string; events: readonly { label: string; topic0: string }[] }[]) {
  const v = venues.find((x) => x.address.toLowerCase() === c.venue.toLowerCase());
  const ev = v?.events.find((e) => e.topic0.toLowerCase() === c.topic0.toLowerCase());
  return {
    event: ev?.label ?? `${c.topic0.slice(0, 10)}…`,
    subject: c.subjectTopic === 0 ? null : `0x${c.subject.slice(-40)}`,
  };
}

/** §12.1 — a register entry, not a card: index · event · range · bond · mini-stamp. */
export function ClaimRow({ claim, position, event, subject, selected, onSelect }: {
  claim: Claim; position: number; event: string; subject: string | null; selected: boolean; onSelect: () => void;
}) {
  const kind = STATUS_KIND[claim.status as 0 | 1 | 2 | 3] ?? 'none';
  const bond = tctc(claim.bond);
  return (
    <button type="button" className="claim-row" aria-pressed={selected} onClick={onSelect}>
      <span className="claim-index t-hash">{String(position).padStart(2, '0')}</span>
      <span className="claim-event">
        no {event}{subject && <> of <Trunc v={subject} /></>}
      </span>
      <span className="claim-range t-hash">{claim.spanFrom}–{claim.spanTo}</span>
      <span className="claim-bond t-hash">{bond} tCTC</span>
      <span className={`claim-status assurance--${kind}`}>
        <MiniStamp kind={kind} />
        <span className="assurance-word">{assuranceWord(kind)}</span>
      </span>
    </button>
  );
}
