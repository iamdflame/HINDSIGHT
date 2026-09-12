import { useRef } from 'react';

export type TabId = 'question' | 'record' | 'watch';
export const TABS: { id: TabId; label: string }[] = [
  { id: 'question', label: 'A question' },
  { id: 'record', label: 'The record' },
  { id: 'watch', label: 'The watch' },
];

/** §9.2 — chapters, not pills. tablist/tab with Left/Right (and Home/End) (§15). */
export function Tabs({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: React.KeyboardEvent, i: number) {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(TABS[next].id);
    refs.current[next]?.focus();
  }
  return (
    <nav className="tabs" role="tablist" aria-label="Chapters">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[i] = el; }}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
