import { useId } from 'react';

type LedgerFieldProps = {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  caption?: string;
  onSubmit: () => void;
  disabled?: boolean;
};

/** A baseline rule, not a boxy well (§10.1). Plex, caret ink; the rule turns wax when wrong. */
export function LedgerField({ value, onChange, invalid = false, caption, onSubmit, disabled = false }: LedgerFieldProps) {
  const captionId = useId();
  return (
    <div className={`ledger${invalid ? ' is-invalid' : ''}`}>
      <label className="ledger-label t-ui" htmlFor="question">Transaction</label>
      <input
        id="question"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        placeholder="paste an Ethereum mainnet hash"
        aria-invalid={invalid || undefined}
        aria-describedby={captionId}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
      />
      <p id={captionId} className="ledger-caption t-caption" aria-live="polite">{caption}</p>
    </div>
  );
}
