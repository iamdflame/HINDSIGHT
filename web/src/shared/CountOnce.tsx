import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * §7.6: on the first real value, count 0 → N in 600ms (ease-out, integers), then stay still.
 * Later changes snap. A live archive that flickers looks like a dashboard.
 */
export function CountOnce({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  const counted = useRef(false);

  useEffect(() => {
    if (counted.current || prefersReducedMotion()) {
      counted.current = true;
      setShown(value);
      return;
    }
    counted.current = true;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  // Padded to the final width with no-break spaces: in a monospaced face the number never changes
  // width while it counts, so nothing beside it moves (the dateline was the page's only layout shift).
  const final = value.toLocaleString('en-US');
  return <>{shown.toLocaleString('en-US').padStart(final.length, '\u00a0')}</>;
}
