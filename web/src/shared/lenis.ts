import Lenis from 'lenis';
import gsap from 'gsap';
import { prefersReducedMotion } from './motion';

let instance: Lenis | null = null;
let running = false;
let idleFrames = 0;

/**
 * The frame loop runs only while a scroll is actually moving. Driving Lenis from gsap's ticker
 * unconditionally meant a 60fps loop on an idle archive (Lighthouse attributed ~1.8s of script time to
 * it on a still page) — the kind of idle loop §7.8 bans. It wakes on input and sleeps ~0.5s after the
 * scroll settles; native scrolling (keys, touch, focus) never needs it at all.
 */
const tick = (time: number) => {
  if (!instance) return;
  instance.raf(time * 1000);
  if (instance.isScrolling) { idleFrames = 0; return; }
  if (++idleFrames > 30) { gsap.ticker.remove(tick); running = false; }
};

function wake() {
  if (!instance || running) return;
  running = true;
  idleFrames = 0;
  (instance as unknown as { time: number }).time = 0; // first delta after a sleep is 0, not the whole nap
  gsap.ticker.add(tick);
}

/** §7: smooth scroll (duration 1.0, lerp 0.08). Never constructed under reduced motion. */
export function startLenis(): void {
  if (instance || prefersReducedMotion()) return;
  instance = new Lenis({ duration: 1.0, lerp: 0.08 });
  gsap.ticker.lagSmoothing(0);
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
    window.addEventListener(type, wake, { passive: true });
  }
}

export function scrollToTop(): void {
  if (instance) { wake(); instance.scrollTo(0, { duration: 0.6 }); }
  else window.scrollTo({ top: 0, behavior: 'auto' });
}
