import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { Seal } from '../brand/Seal';
import { prefersReducedMotion } from '../shared/motion';

gsap.registerPlugin(useGSAP);

export type StampState = 'idle' | 'proven' | 'standing' | 'refuted';

type StampProps = {
  state: StampState;
  reduceMotion?: boolean;
  /** What the verdict is about. A press never replays for the same key (§7.1). */
  pressKey?: string;
  /** false when the verdict was not just produced by a chain event (e.g. selecting a row). */
  animate?: boolean;
};

const WORD: Record<Exclude<StampState, 'idle'>, string> = { proven: 'PROVEN', standing: 'STANDING', refuted: 'REFUTED' };
const TONE = { idle: 'rule', proven: 'ink', standing: 'ochre', refuted: 'wax' } as const;

/**
 * The money shot (§7.1). A physical seal presses once when a result settles; the square and the
 * word line are reserved in layout beforehand, so the press moves nothing else on the page.
 */
export function Stamp({ state, reduceMotion, pressKey, animate = true }: StampProps) {
  const root = useRef<HTMLDivElement>(null);
  const lastPressed = useRef<string | null>(null);

  useGSAP(() => {
    const el = root.current;
    if (!el || state === 'idle') return;
    const imp = el.querySelector('.stamp-impression');
    const word = el.querySelector('.stamp-word');
    const bleed = el.querySelector('.stamp-bleed');
    const grain = el.querySelector('.stamp-grain');
    const bar = el.querySelector('.stamp-bar');
    const key = `${state}:${pressKey ?? ''}`;
    const reduce = reduceMotion ?? prefersReducedMotion();

    const final = () => {
      gsap.set(imp, { opacity: 1, scale: 0.98, rotate: -2 });
      gsap.set(word, { opacity: 1 });
      gsap.set(bleed, { clipPath: 'inset(0% 0 0% 0)' });
      gsap.set(grain, { opacity: 0.02 });
      if (bar) gsap.set(bar, { scaleX: 1, rotate: -2 });
    };

    if (reduce || !animate || lastPressed.current === key) {
      final();
      lastPressed.current = key;
      return;
    }
    lastPressed.current = key;

    // The start pose is set now, so nothing flashes; the timeline itself waits for two painted frames.
    // Lenis needs gsap.ticker.lagSmoothing(0), so any synchronous work in the commit that mounts the
    // verdict (the result section, the merkle table) would otherwise be skipped over, and a slow
    // machine would first paint the stamp halfway through its press.
    const tl = gsap.timeline({ paused: true });
    gsap.set(imp, { opacity: 0, scale: 1.15, rotate: -8, transformOrigin: '50% 50%' });
    gsap.set(word, { opacity: 0 });
    gsap.set(bleed, { clipPath: 'inset(0% 0 100% 0)' });
    gsap.set(grain, { opacity: 0 });
    if (bar) gsap.set(bar, { scaleX: 0, rotate: -2, transformOrigin: '0% 50%' });

    tl.to(imp, { opacity: 1, scale: 1, rotate: -2, duration: 0.18, ease: 'power3.out' }, 0)
      .to(word, { opacity: 1, duration: 0.18, ease: 'power3.out' }, 0)
      .to(imp, { scale: 0.98, duration: 0.02, ease: 'power1.in' }, 0.18)
      .to(bleed, { clipPath: 'inset(0% 0 0% 0)', duration: 0.2, ease: 'none' }, 0.2)
      .to(grain, { opacity: 0.02, duration: 0.2, ease: 'none' }, 0.2); // then frozen: no loop
    if (bar) tl.to(bar, { scaleX: 1, duration: 0.3, ease: 'power2.inOut' }, 0.5);

    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => tl.play(0)); });
    return () => cancelAnimationFrame(raf);
  }, { dependencies: [state, pressKey, animate, reduceMotion], scope: root });

  const idle = state === 'idle';
  const word = idle ? '' : WORD[state];
  const grainId = `grain-${state}`;

  return (
    <div ref={root} className={`stamp stamp--${state}`}>
      <div className="stamp-square">
        <div className="stamp-impression">
          <Seal
            tone={TONE[state]}
            impression={idle ? 'idle' : 'press'}
            title={idle ? 'Hindsight seal, waiting for a question' : `${word} seal`}
          />
        </div>
        {!idle && (
          <svg className="stamp-grain" aria-hidden="true" focusable="false">
            {/* Noise fills the whole filter region unless composited into the source shape; without the
                composite this painted a visible square behind a round seal. */}
            <filter id={grainId} x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" result="n" />
              <feComposite in="n" in2="SourceGraphic" operator="in" />
            </filter>
            <circle cx="50%" cy="50%" r="47%" filter={`url(#${grainId})`} />
          </svg>
        )}
      </div>
      <div className="stamp-wordline" aria-live="polite">
        {/* The word is always reserved; idle keeps its box so the verdict never pushes the gloss. */}
        <span className="stamp-word">{idle ? 'PROVEN' : word}</span>
        <span className="stamp-bleed" aria-hidden="true">{idle ? 'PROVEN' : word}</span>
        {state === 'refuted' && <span className="stamp-bar" aria-hidden="true" />}
      </div>
    </div>
  );
}
