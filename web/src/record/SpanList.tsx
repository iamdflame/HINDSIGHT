export type SealedSpan = { id: number; from: number; to: number };

/** The most recent sealed spans for one chain. Asserting happens on the watch; no wallet opens here. */
export function SpanList({ spans }: { spans: SealedSpan[] }) {
  return (
    <ul className="spans">
      {spans.map((sp) => (
        <li key={sp.id}>
          <span className="t-hash">
            {sp.from.toLocaleString()} – {sp.to.toLocaleString()}
          </span>
          <span className="sealed t-ui">sealed · {(sp.to - sp.from + 1).toLocaleString()} blocks</span>
          <a className="linkish span-assert" href="/watch/">
            {/* Plex carries the arrow; Fraunces' unicode-range does not. */}
            <span className="t-hash">assert on the watch →</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
