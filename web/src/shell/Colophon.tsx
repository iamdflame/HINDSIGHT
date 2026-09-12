import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import deployments from '../../../deployments.json';
import { Seal } from '../brand/Seal';
import { Wordmark } from '../brand/Wordmark';
import { LampToggle } from './LampToggle';
import { prefersReducedMotion } from '../shared/motion';

const EXPLORER = 'https://creditcoin-testnet.blockscout.com';

/** Band 2 address: full on desk, `0x4Bc1…e2AB` on phone; click copies, `copied` for 1.2s. */
function Address({ label, addr }: { label: string; addr: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="contract-row">
      <span className="t-ui">{label}</span>
      <button
        type="button"
        className="addr-copy"
        title={addr}
        aria-label={`${label} address ${addr}, copy`}
        onClick={() => {
          void navigator.clipboard?.writeText(addr);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        <span aria-live="polite">
          {copied ? 'copied' : (
            <>
              <span className="full">{addr}</span>
              <span className="short">{`${addr.slice(0, 6)}…${addr.slice(-4)}`}</span>
            </>
          )}
        </span>
      </button>
      <span className="net t-hash">cc3</span>
      <a className="out t-hash" href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" aria-label={`${label} on Blockscout`}>↗</a>
    </div>
  );
}

/** §13 — a colophon, not a strip: the three facts, the contracts, the independence, the meta. */
export function Colophon() {
  const root = useRef<HTMLElement>(null);
  const hairline = useRef<HTMLDivElement>(null);

  // §7.5: the hairline draws once when the footer enters view, then stays still.
  useEffect(() => {
    const el = root.current, line = hairline.current;
    if (!el || !line) return;
    if (prefersReducedMotion()) { gsap.set(line, { scaleX: 1 }); return; }
    gsap.set(line, { scaleX: 0, transformOrigin: '0% 50%' });
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      gsap.to(line, { scaleX: 1, duration: 0.6, ease: 'power2.out' });
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <footer ref={root} className="colophon">
      <div ref={hairline} className="colophon-hairline" aria-hidden="true" />
      <div className="colophon-body">
        <div className="band key" role="list" aria-label="The three assurances">
          <div role="listitem" className="key-row key-row--proven">
            <Seal size={18} tone="ink" title="" />
            <span className="t-ui">PROVEN</span>
            <span className="key-caption">cryptographic presence. merkle path against a notarised root.</span>
          </div>
          <div role="listitem" className="key-row key-row--standing">
            <Seal size={18} tone="ochre" title="" />
            <span className="t-ui">STANDING</span>
            <span className="key-caption">economic absence. a bond nobody took.</span>
          </div>
          <div role="listitem" className="key-row key-row--refuted">
            <Seal size={18} tone="wax" cancelled title="" />
            <span className="t-ui">REFUTED</span>
            <span className="key-caption">a counterexample was revealed. the bond moved.</span>
          </div>
        </div>

        <div className="band contracts">
          <Address label="Archive" addr={deployments.contracts.EthereumMirror} />
          <Address label="Registry" addr={deployments.contracts.AbsenceRegistry} />
          <div className="contract-row">
            <span className="t-ui">Source</span>
            <span className="t-hash source-line">Ethereum mainnet · chainKey 3</span>
          </div>
        </div>

        <div className="band independence">
          <p>Attestcoin notarises a block once.</p>
          <p>After that this site can answer without the prover, the precompile, or us.</p>
          <p>Kill the prover: the caption under Check the record is the proof.</p>
        </div>

        <div className="band band-meta">
          <a className="lockup-small" href="/" aria-label="Hindsight">
            <Seal size={16} inverse title="" />
            <Wordmark size={14} />
          </a>
          <a className="linkish t-ui" href="https://github.com/iamdflame/HINDSIGHT" target="_blank" rel="noreferrer">GitHub</a>
          <a className="linkish t-ui claims-link" href="/judge/">CLAIMS.md</a>
          <LampToggle />
          <span className="chain t-hash">Creditcoin testnet 102031</span>
        </div>
      </div>
    </footer>
  );
}
