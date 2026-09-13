import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { prefersReducedMotion } from '../shared/motion';

/**
 * What follows a run. A `gap` is a height the archive does not hold -- exactly where a contradicting
 * transaction could sit unseen. An `empty` break is different in kind: an Ethereum block with no
 * transactions, whose root genuinely is zero and therefore reads as absent to the contract. Nothing
 * can hide in it, but nothing can be sealed across it either, and drawing it as a gap would be a lie
 * in the other direction.
 */
export type BreakKind = 'gap' | 'empty';
export type CoverageRun = { from: number; to: number; ticks: number; gapAfter: number; breakKind?: BreakKind };

const PITCH = 3; // a 2px tick and a 1px gap (§11.1)

/**
 * §11.1 — one row per contiguous run. Notarised heights are ink ticks; the hole that follows a run, up
 * to where the next run begins, is paper with a 1px wax tick. Gaps never animate: they are the subject.
 * Rows longer than the strip render only the visible slice (§7.2).
 */
function Row({ run }: { run: CoverageRun }) {
  const strip = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(0);
  const filled = useRef(false);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setCapacity(Math.max(1, Math.floor((el.clientWidth + 1) / PITCH)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The break after a run is the thing the strip exists to show, so it is never squeezed out by
  // the ink before it. An empty block is exactly one tick; a real gap gets up to a tenth of the
  // row so its size registers without the ink vanishing.
  const breakWanted = run.gapAfter === 0 ? 0 : run.breakKind === 'empty' ? 1 : Math.min(run.gapAfter, Math.max(1, Math.floor(capacity / 10)));
  const inkShown = Math.min(run.ticks, Math.max(1, capacity - breakWanted));
  const gapShown = Math.max(0, Math.min(breakWanted, capacity - inkShown));

  useEffect(() => {
    const el = strip.current;
    if (!el || capacity === 0) return;
    const ink = () => el.querySelectorAll<HTMLElement>('.tick--run');
    if (filled.current) { ink().forEach((t) => t.classList.add('is-inked')); return; }
    if (prefersReducedMotion()) {
      filled.current = true;
      ink().forEach((t) => t.classList.add('is-inked'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || filled.current) return;
      filled.current = true;
      io.disconnect();
      const target = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
      gsap.to(ink(), {
        backgroundColor: target,
        duration: 0.08,
        ease: 'none',
        stagger: 0.004,
        onComplete() {
          ink().forEach((t) => { t.classList.add('is-inked'); t.style.removeProperty('background-color'); });
        },
      });
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [capacity]);

  return (
    <div className="cov-row">
      <p className="cov-label t-hash">
        {run.from} – {run.to}
        <span className="count">{run.ticks} blocks</span>
      </p>
      <div
        ref={strip}
        className="cov-strip"
        role="img"
        aria-label={
          `blocks ${run.from} to ${run.to} notarised` +
          (run.gapAfter > 0
            ? run.breakKind === 'empty'
              ? `, then block ${run.to + 1}, an empty Ethereum block`
              : `, then ${run.gapAfter} blocks not notarised`
            : '')
        }
      >
        {Array.from({ length: inkShown }, (_, i) => (
          <i key={`r${i}`} className="tick tick--run" title={String(run.from + i)} />
        ))}
        {Array.from({ length: gapShown }, (_, i) => (
          <i
            key={`g${i}`}
            className={run.breakKind === 'empty' ? 'tick tick--empty' : 'tick tick--gap'}
            title={run.breakKind === 'empty' ? `${run.to + 1 + i} — empty block, no transactions` : String(run.to + 1 + i)}
          />
        ))}
      </div>
    </div>
  );
}

export function CoverageStrip({ runs }: { runs: CoverageRun[] }) {
  return (
    <div className="coverage">
      {runs.map((r) => <Row key={r.from} run={r} />)}
    </div>
  );
}
