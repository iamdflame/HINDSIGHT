import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import type { Sibling } from '../lib/proof';
import { prefersReducedMotion } from '../shared/motion';

gsap.registerPlugin(useGSAP);

/**
 * §7.3 — the Merkle path as a ledger, in proof order (leaf at the top, root at the bottom), exactly as
 * the proof walks it. Rows ink in at 40ms × depth; the root row then takes its rule.
 */
export function MerkleLedger({ siblings, root, txIndex, animateKey }: {
  siblings: Sibling[]; root: string; txIndex: number; animateKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const el = ref.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLTableRowElement>('tbody tr');
    const rule = el.querySelector('.root-rule');
    if (prefersReducedMotion()) {
      gsap.set(rows, { color: 'var(--ink)' });
      gsap.set(rule, { scaleX: 1 });
      return;
    }
    gsap.set(rows, { color: 'var(--ink-faint)' });
    gsap.set(rule, { scaleX: 0, transformOrigin: '0% 50%' });
    // Same reason as the stamp: start after the mounting commit has painted, not during it.
    const tl = gsap.timeline({ paused: true });
    rows.forEach((row, depth) => tl.to(row, { color: 'var(--ink)', duration: 0.12, ease: 'none' }, 0.04 * depth));
    tl.to(rule, { scaleX: 1, duration: 0.24, ease: 'power2.out' }, 0.04 * rows.length);
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => tl.play(0)); });
    return () => cancelAnimationFrame(raf);
  }, { dependencies: [animateKey], scope: ref });

  return (
    <div ref={ref} className="merkle">
      <div style={{ overflowX: 'auto' }}>
        <table className="ledger-table">
          <caption className="t-ui">Merkle path</caption>
          <thead>
            <tr>
              <th className="t-ui" scope="col">depth</th>
              <th className="t-ui" scope="col">sibling</th>
              <th className="t-ui" scope="col">bit</th>
              <th className="t-ui" scope="col">hash</th>
            </tr>
          </thead>
          <tbody>
            {siblings.map((s, i) => (
              <tr key={i}>
                <td>L{i}</td>
                <td>{s.isLeft ? 'left' : 'right'}</td>
                <td>{s.isLeft ? '1' : '0'}</td>
                <td className="hash">{s.hash}</td>
              </tr>
            ))}
            <tr className="is-root">
              <td>root</td>
              <td />
              <td />
              <td className="hash">{root}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="root-rule" aria-hidden="true" />
      <p className="merkle-note t-caption">
        Reading the direction bits from L0 upward gives transaction index {txIndex} — the position inside the
        block. No Ethereum receipt carries that; it is recovered from the shape of the path alone.
      </p>
    </div>
  );
}
