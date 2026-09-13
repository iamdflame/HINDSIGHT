import { WORDMARK as W } from './wordmarkData';
import { SealMarks } from './Seal';

type WordmarkProps = {
  withLegend?: boolean;
  /** Rendered font size in px. Drives the tracking rule in §3.2. */
  size?: number;
  className?: string;
};

/** §3.2 tracking: −0.02em at display (≥48px), 0 at ≤18px, interpolated between. */
function trackingEm(px: number): number {
  if (px >= 48) return -0.02;
  if (px <= 18) return 0;
  return (-0.02 * (px - 18)) / 30;
}

/**
 * `Hindsight` in Fraunces (opsz 144, wght 550), set from outlines so the brand never waits on a
 * font. Both tittles are gone from the glyphs; the seal is the dot of each i (~0.18em).
 */
export function Wordmark({ withLegend = false, size = 40, className }: WordmarkProps) {
  const track = trackingEm(size) * W.upm;
  const n = W.glyphs.length;
  const width = W.advance + track * (n - 1);
  const height = W.top - W.bottom;
  const d = W.tittleDiameter;

  return (
    <span className={`wordmark${className ? ' ' + className : ''}`} style={{ fontSize: `${size}px` }}>
      <span className="wordmark-line">
        <svg
          className="wordmark-word"
          viewBox={`0 ${-W.top} ${width} ${height}`}
          style={{ width: `${width / W.upm}em`, height: `${height / W.upm}em`, verticalAlign: `${W.bottom / W.upm}em` }}
          role="img"
          aria-label="Hindsight"
          focusable="false"
        >
          {W.glyphs.map((g, i) => (
            <path key={i} className="wm-glyph" d={g.d} transform={`translate(${g.x + track * i} 0)`} />
          ))}
          {W.tittles.map((t) => {
            const gx = W.glyphs[t.glyph].x + track * t.glyph;
            return (
              <svg
                key={t.glyph}
                className="wm-tittle seal"
                x={gx + t.cx - d / 2}
                y={-t.cy - d / 2}
                width={d}
                height={d}
                viewBox="0 0 64 64"
                aria-hidden="true"
              >
                <SealMarks inverse />
              </svg>
            );
          })}
        </svg>
      </span>
      {withLegend && <span className="wordmark-legend">the cache Attestcoin forgot to keep</span>}
    </span>
  );
}
