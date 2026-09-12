import { useEffect, useState } from 'react';
import { Question } from './views/Question';
import { Record } from './views/Record';
import { Watch } from './views/Watch';
import { MIRROR_ADDRESS, REGISTRY_ADDRESS, EXPLORER } from './lib/chain';
import { Standfirst } from './components/Standfirst';

const TABS = [
  { id: 'question', label: 'A question', node: <Question /> },
  { id: 'record', label: 'The record', node: <Record /> },
  { id: 'watch', label: 'The watch', node: <Watch /> },
] as const;

export default function App() {
  // The question opens first: it is the one thing a visitor can do with no wallet, no gas and no
  // setup, and it is the claim the rest of the product rests on.
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (TABS.find((x) => x.id === t)?.id ?? 'question');
  });

  // Keep the address bar in step so any view can be linked to or reloaded.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (tab === 'question') u.searchParams.delete('tab'); else u.searchParams.set('tab', tab);
    window.history.replaceState(null, '', u);
  }, [tab]);

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">Hindsight<span> · a register of Ethereum's past</span></h1>
        <p className="standfirst">Creditcoin testnet · source chain Ethereum mainnet</p>
      </header>

      <Standfirst />

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      {TABS.find((t) => t.id === tab)!.node}

      <footer className="colophon">
        <span>Creditcoin testnet · chain 102031</span>
        <span>Archive <a href={`${EXPLORER}/address/${MIRROR_ADDRESS}`} target="_blank" rel="noreferrer">{MIRROR_ADDRESS.slice(0, 10)}…</a></span>
        <span>Registry <a href={`${EXPLORER}/address/${REGISTRY_ADDRESS}`} target="_blank" rel="noreferrer">{REGISTRY_ADDRESS.slice(0, 10)}…</a></span>
        <span>Source chain: Ethereum mainnet (Attestcoin chainKey 3)</span>
      </footer>
    </div>
  );
}
