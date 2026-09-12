import { useState } from 'react';

const KEY = 'hindsight-lamp';

export function lampIsOn(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** §13 band 4 — paper by default, always. Lamp is a choice, remembered locally, never in the URL. */
export function LampToggle() {
  const [on, setOn] = useState(() => document.documentElement.dataset.theme === 'lamp');
  return (
    <button
      type="button"
      className="linkish t-ui"
      aria-pressed={on}
      onClick={() => {
        const next = !on;
        setOn(next);
        if (next) document.documentElement.dataset.theme = 'lamp';
        else delete document.documentElement.dataset.theme;
        try { if (next) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* private mode */ }
      }}
    >
      Lamp
    </button>
  );
}
