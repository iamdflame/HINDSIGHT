export type WalletView =
  | { k: 'idle' }
  | { k: 'connecting' }
  | { k: 'ok'; address: string }
  | { k: 'wrong' }
  | { k: 'failed' };

/** §12.1 — wallet chrome is one line of Plex. No modal, no endless spinner. */
export function WalletLine({ view, onConnect, onSwitch }: { view: WalletView; onConnect: () => void; onSwitch: () => void }) {
  return (
    <p className="wallet-line" aria-live="polite">
      {view.k === 'idle' && <button type="button" className="linkish" onClick={onConnect}>connect a Creditcoin wallet to hunt</button>}
      {view.k === 'connecting' && <span>connect a Creditcoin wallet to hunt</span>}
      {view.k === 'ok' && <span className="ok">connected {view.address.slice(0, 5)}… · Creditcoin</span>}
      {view.k === 'wrong' && <>wrong network → <button type="button" className="linkish" onClick={onSwitch}>switch to Creditcoin</button></>}
      {view.k === 'failed' && <>could not connect · <button type="button" className="linkish" onClick={onConnect}>connect a Creditcoin wallet to hunt</button></>}
    </p>
  );
}
