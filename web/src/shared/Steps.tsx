export type StepState = 'todo' | 'active' | 'done' | 'failed';

/** Compact Plex steps. Ticks in ink, failures in wax (§10.3). */
export function Steps({ items }: { items: { label: string; state: StepState }[] }) {
  return (
    <ol className="steps" aria-live="polite">
      {items.map((s, i) => (
        <li key={i} className={s.state === 'todo' ? '' : s.state}>
          <span aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'failed' ? '×' : s.state === 'active' ? '›' : '·'}</span>
          <span>
            {s.label}
            {s.state === 'failed' && <span className="visually-hidden"> (failed)</span>}
            {s.state === 'done' && <span className="visually-hidden"> (done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
