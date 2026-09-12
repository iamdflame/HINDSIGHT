import { useId } from 'react';

export type SealSize = 16 | 18 | 28 | 64 | 96 | 128 | 160;
export type SealTone = 'ink' | 'wax' | 'ochre' | 'rule';

type SealProps = {
  /** Omit to fill the parent box (the verdict stamp's reserved square). */
  size?: SealSize;
  /** `idle` is the empty ring: no ink on the tree. `press` is the inked mark. */
  impression?: 'idle' | 'press';
  tone?: SealTone;
  /** REFUTED: a 1.5px wax cancellation bar across the seal. */
  cancelled?: boolean;
  /** Accessible name. Pass an empty string when an adjacent word already names the state. */
  title?: string;
  className?: string;
  /** §3.1 `seal-inverse` colourway: filled disc, rings and tree knocked out in paper. */
  inverse?: boolean;
};

/**
 * The seal, drawn by hand from §3.1 (viewBox 0 0 64 64). A seven-node merkle tree inside a double
 * ring: four leaves, two internals, one root. Edges are drawn first so they sit under the discs.
 * Nothing else goes in the circle — no letter, no eye, no chain links.
 */
export function SealMarks({ impression = 'press', cancelled = false, inverse = false }: {
  impression?: 'idle' | 'press';
  cancelled?: boolean;
  /** §3.1 `seal-inverse`: a filled circle with the rings and tree knocked out in paper. */
  inverse?: boolean;
}) {
  return (
    <g className={inverse ? 'seal-inverse' : undefined}>
      {/* r=32 so both paper rings read inside the disc; at 30.625 the outer ring merged into the page. */}
      {inverse && <circle className="seal-disc" cx="32" cy="32" r="32" />}
      <circle className="seal-line" cx="32" cy="32" r="30" strokeWidth="1.25" />
      <circle className="seal-line" cx="32" cy="32" r="26" strokeWidth="0.75" />
      {impression === 'press' && (
        <>
          <path
            className="seal-line"
            strokeWidth="1"
            d="M14 44 L20 32 L32 18 M26 44 L20 32 M38 44 L44 32 L32 18 M50 44 L44 32"
          />
          <circle className="seal-ink" cx="14" cy="44" r="2.4" />
          <circle className="seal-ink" cx="26" cy="44" r="2.4" />
          <circle className="seal-ink" cx="38" cy="44" r="2.4" />
          <circle className="seal-ink" cx="50" cy="44" r="2.4" />
          <circle className="seal-ink" cx="20" cy="32" r="2.6" />
          <circle className="seal-ink" cx="44" cy="32" r="2.6" />
          <circle className="seal-ink" cx="32" cy="18" r="3" />
        </>
      )}
      {cancelled && <line className="seal-bar" x1="1" y1="33" x2="63" y2="31" />}
    </g>
  );
}

export function Seal({ size, impression = 'press', tone = 'wax', cancelled = false, title = 'Hindsight seal', className, inverse = false }: SealProps) {
  const id = useId();
  const decorative = title === '';
  return (
    <svg
      className={`seal tone-${tone}${className ? ' ' + className : ''}`}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-labelledby={decorative ? undefined : id}
      focusable="false"
    >
      {!decorative && <title id={id}>{title}</title>}
      <SealMarks impression={impression} cancelled={cancelled} inverse={inverse} />
    </svg>
  );
}
