export type Source = 'prover' | 'local';

/**
 * §10.1 — the independence claim as a caption, not chrome. The pair appears after the first check;
 * choosing the other half re-runs the same hash without re-pasting.
 */
export function SourceCaption({ source, onChange, disabled = false }: {
  source: Source; onChange: (s: Source) => void; disabled?: boolean;
}) {
  const opt = (s: Source, label: string) => (
    <button
      type="button"
      className={source === s ? 'is-active' : 'linkish'}
      aria-pressed={source === s}
      disabled={disabled && source !== s}
      onClick={() => { if (source !== s) onChange(s); }}
      style={source === s ? { background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'default' } : undefined}
    >
      {label}
    </button>
  );
  return (
    <p className="source-caption t-caption">
      {opt('prover', 'using Attestcoin prover')}
      <span className="sep" aria-hidden="true">·</span>
      {opt('local', 'rebuilt in this browser')}
    </p>
  );
}
