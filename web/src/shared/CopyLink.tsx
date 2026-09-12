import { useEffect, useRef, useState } from 'react';

/** Copies `text`; the label becomes `copiedLabel` for `ms`, then reverts. No toast. */
export function CopyLink({ text, label, copiedLabel, ms = 2000, className = 'linkish' }: {
  text: string; label: string; copiedLabel: string; ms?: number; className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), ms);
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
