import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { prefersReducedMotion } from '../shared/motion';

const PITCH = 3; // a 2px tick and a 1px gap

/**
 * The archive at scale. Six hundred thousand heights do not fit in a row of ticks one block wide,
 * so the range is divided into as many equal buckets as the row can draw, and each tick answers one
 * question about its bucket: is every height in it held?
 *
 * The rule that makes this honest is that a bucket with even one missing height is drawn in wax.
 * Downsampling never averages a hole away -- a single gap in 648,000 blocks is still a visible tick.
 * Ink ticks fill once when the strip scrolls into view; wax never animates, because the gap is the
 * subject.
 */
export function ArchiveStrip({
  lowest,
  highest,
  isHeld,
  label,
}: {
  lowest: number;
  highest: number;
  /** Whether a height is held. Called per height; the caller backs it with the bitmap words. */
  isHeld: (h: number) => boolean;
  label: string;
}) {
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

  const span = highest - lowest + 1;
  const buckets = Math.max(1, Math.min(capacity, span));
  const per = Math.ceil(span / buckets);

  const ticks: { full: boolean; from: number; to: number; missing: number }[] = [];
  if (capacity > 0) {
    for (let b = 0; b < buckets; b++) {
      const from = lowest + b * per;
      if (from > highest) break;
      const to = Math.min(highest, from + per - 1);
      let missing = 0;
      for (let h = from; h <= to; h++) if (!isHeld(h)) missing++;
      ticks.push({ full: missing === 0, from, to, missing });
    }
  }
  const gaps = ticks.filter((t) => !t.full);

  useEffect(() => {
    const el = strip.current;
    if (!el || ticks.length === 0) return;
    const ink = () => el.querySelectorAll<HTMLElement>('.tick--run');
    if (filled.current || prefersReducedMotion()) {
      filled.current = true;
      ink().forEach((t) => t.classList.add('is-inked'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || filled.current) return;
        filled.current = true;
        io.disconnect();
        const target = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
        gsap.to(ink(), {
          backgroundColor: target,
          duration: 0.08,
          ease: 'none',
          stagger: 0.003,
          onComplete() {
            ink().forEach((t) => {
              t.classList.add('is-inked');
              t.style.removeProperty('background-color');
            });
          },
        });
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks.length]);

  return (
    <div className="cov-row cov-row--archive">
      <p className="cov-label t-hash">
        {lowest.toLocaleString()} – {highest.toLocaleString()}
        <span className="count">{per.toLocaleString()} blocks per tick</span>
      </p>
      <div
        ref={strip}
        className="cov-strip"
        role="img"
        aria-label={
          `${label}: heights ${lowest} to ${highest}, ` +
          (gaps.length === 0 ? 'every height held' : `${gaps.length} ticks contain unheld heights`)
        }
      >
        {ticks.map((t, i) =>
          t.full ? (
            <i key={i} className="tick tick--run" title={`${t.from.toLocaleString()} – ${t.to.toLocaleString()}: all held`} />
          ) : (
            <i
              key={i}
              className="tick tick--gap"
              title={`${t.from.toLocaleString()} – ${t.to.toLocaleString()}: ${t.missing.toLocaleString()} not held`}
            />
          ),
        )}
      </div>
    </div>
  );
}
