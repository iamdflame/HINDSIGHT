import type { TabId } from '../shell/Tabs';

export type SealedSpan = { id: number; from: number; to: number };

/** §11.2 — the last 24 sealed spans. Asserting happens on the watch; no wallet opens from here. */
export function SpanList({ spans, onTab }: { spans: SealedSpan[]; onTab: (t: TabId) => void }) {
  return (
    <ul className="spans">
      {spans.map((sp) => (
        <li key={sp.id}>
          <span className="t-hash">{sp.from} – {sp.to}</span>
          <span className="sealed t-ui">sealed</span>
          <a className="linkish span-assert" href="?tab=watch" onClick={(e) => { e.preventDefault(); onTab('watch'); }}>
            {/* Plex carries the arrow; Fraunces' unicode-range (§5) does not. */}
            <span className="t-hash">assert on the watch →</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
