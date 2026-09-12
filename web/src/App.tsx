import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { prefersReducedMotion } from './shared/motion';
import { Masthead } from './shell/Masthead';
import { Tabs, TABS, type TabId } from './shell/Tabs';
import { SkipLink } from './shell/SkipLink';
import { Colophon } from './shell/Colophon';
import { useArchiveStats } from './shell/useArchiveStats';
import { Question } from './question/Question';
import { Record } from './record/Record';
import { Watch } from './watch/Watch';

function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get('tab');
  return TABS.find((x) => x.id === t)?.id ?? 'question';
}

/** App is the shell only (§14): masthead, tabs, the pane, the colophon. */
export default function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const stats = useArchiveStats(tab);
  const chrome = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const entering = useRef(false);
  const focusAfter = useRef(false);

  /** §7.4 — the leaving chapter fades in 80ms; the next rises 8px into place over 220ms. */
  function changeTab(next: TabId, thenFocusQuestion = false) {
    focusAfter.current = thenFocusQuestion;
    if (next === tab) { if (thenFocusQuestion) document.getElementById('question')?.focus(); return; }
    if (prefersReducedMotion() || !pane.current) { setTab(next); return; }
    gsap.to(pane.current, {
      opacity: 0, duration: 0.08, ease: 'none',
      onComplete: () => { entering.current = true; setTab(next); },
    });
  }

  useLayoutEffect(() => {
    if (entering.current && pane.current) {
      entering.current = false;
      gsap.fromTo(pane.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform' });
    }
    if (focusAfter.current) {
      focusAfter.current = false;
      requestAnimationFrame(() => document.getElementById('question')?.focus());
    }
  }, [tab]);

  // Keep the address bar in step so any chapter can be linked or reloaded (unchanged behaviour).
  useEffect(() => {
    const u = new URL(window.location.href);
    if (tab === 'question') u.searchParams.delete('tab');
    else u.searchParams.set('tab', tab);
    window.history.replaceState(null, '', u);
  }, [tab]);

  // The question's first screen is exactly the viewport below the masthead and tabs (§6).
  useLayoutEffect(() => {
    const el = chrome.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--chrome-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  return (
    <>
      <SkipLink onSkip={() => changeTab('question', true)} />
      <div className="shell">
        <div ref={chrome}>
          <Masthead
            withLegend={tab === 'question'}
            stats={stats}
            onDateline={() => changeTab('record')}
            onHome={(e) => { e.preventDefault(); changeTab('question'); }}
          />
          <Tabs tab={tab} onChange={(t) => changeTab(t)} />
        </div>
        {/* On the other chapters the skip link's target must still exist and take focus (§9.3, axe
            skip-link). Following it switches to the question and focuses the field. */}
        <main id={tab === 'question' ? 'main' : 'question'} ref={pane} tabIndex={tab === 'question' ? undefined : -1}>
          {tab === 'question' && <Question onTab={changeTab} />}
          {tab === 'record' && <Record onTab={changeTab} />}
          {tab === 'watch' && <Watch />}
        </main>
        <Colophon />
      </div>
    </>
  );
}
