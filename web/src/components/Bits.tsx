import type { ReactNode } from 'react';
import { EXPLORER, ETHERSCAN } from '../lib/chain';

export function Working({ children }: { children: ReactNode }) {
  return <span className="working">{children}</span>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Failure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="state bad">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Trunc({ v, n = 10 }: { v: string; n?: number }) {
  if (!v) return <>—</>;
  return <span className="mono" title={v}>{v.length <= n * 2 + 2 ? v : `${v.slice(0, n)}…${v.slice(-6)}`}</span>;
}

export function EthTx({ hash }: { hash: string }) {
  return <a href={`${ETHERSCAN}/tx/${hash}`} target="_blank" rel="noreferrer"><Trunc v={hash} /></a>;
}
export function EthAddr({ addr }: { addr: string }) {
  return <a href={`${ETHERSCAN}/address/${addr}`} target="_blank" rel="noreferrer"><Trunc v={addr} n={8} /></a>;
}
export function EthBlock({ n }: { n: number | bigint }) {
  return <a href={`${ETHERSCAN}/block/${n}`} target="_blank" rel="noreferrer" className="mono">{n.toString()}</a>;
}
export function CcTx({ hash, label }: { hash: string; label?: string }) {
  return <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">{label ?? <Trunc v={hash} />}</a>;
}
export function CcAddr({ addr }: { addr: string }) {
  return <a href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer"><Trunc v={addr} n={8} /></a>;
}

/**
 * The integrity control of the whole product. Every answer states the *kind* of assurance behind
 * it, because "proved by mathematics" and "nobody disputed it for a while" are not the same fact
 * and must never render identically.
 */
export type AssuranceKind = 'cryptographic' | 'economic' | 'pending' | 'destroyed' | 'none';

const ASSURANCE_TEXT: Record<AssuranceKind, string> = {
  cryptographic: 'Cryptographic',
  economic: 'Economic — unrefuted',
  pending: 'Open — bond at risk',
  destroyed: 'Destroyed by counterexample',
  none: 'No assurance',
};

export function Assurance({ kind }: { kind: AssuranceKind }) {
  return <span className={`assurance ${kind}`}>{ASSURANCE_TEXT[kind]}</span>;
}

export function Steps({ items }: { items: { label: string; state: 'todo' | 'active' | 'done' | 'failed' }[] }) {
  return (
    <ul className="steps">
      {items.map((s, i) => (
        <li key={i} className={s.state === 'todo' ? '' : s.state}>
          <span className="tick">{s.state === 'done' ? '✓' : s.state === 'failed' ? '✕' : s.state === 'active' ? '›' : '·'}</span>
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}
