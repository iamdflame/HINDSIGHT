import { useEffect, useRef, useState } from 'react';
import type { ProofBundle } from '../lib/proof';
import type { TabId } from '../shell/Tabs';
import { LedgerField } from './LedgerField';
import { Stamp } from './Stamp';
import { Gloss } from './Gloss';
import { SourceCaption, type Source } from './SourceCaption';
import { Examples } from './Examples';
import { MerkleLedger } from './MerkleLedger';
import { Assurance } from '../shared/Assurance';
import { Steps, type StepState } from '../shared/Steps';
import { CopyLink } from '../shared/CopyLink';
import { EthBlock } from '../shared/EthBlock';
import { EthTx } from '../shared/EthTx';
import { scrollToTop } from '../shared/lenis';

type Phase = 'idle' | 'working' | 'proven' | 'not-notarised' | 'failed';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORKING_LABEL = (src: Source, step: number) =>
  step === 0 ? (src === 'prover' ? 'Obtaining proof…' : 'Rebuilding the path…') : step === 1 ? 'Checking the register…' : 'Folding the path…';

type Proven = { hash: string; proof: ProofBundle; index: bigint; source: Source };

/** First sentence of an error, for the one-line reason; the rest goes under `technical`. */
function shortReason(message: string): string {
  const first = message.split(/(?<=\.)\s/)[0]?.trim() || message;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

export function Question({ onTab }: { onTab: (t: TabId) => void }) {
  const [raw, setRaw] = useState('');
  const [emptySubmit, setEmptySubmit] = useState(false);
  const [source, setSource] = useState<Source>('prover');
  const [phase, setPhase] = useState<Phase>('idle');
  const [asked, setAsked] = useState(false);
  const [step, setStep] = useState(0);
  const [runSource, setRunSource] = useState<Source>('prover');
  const [steps, setSteps] = useState<{ label: string; state: StepState }[]>([]);
  const [proven, setProven] = useState<Proven | null>(null);
  const [pending, setPending] = useState<{ hash: string; block?: number } | null>(null);
  const [failure, setFailure] = useState<{ reason: string; technical: string } | null>(null);
  const running = useRef(false);

  const trimmed = raw.trim();
  const invalid = trimmed !== '' && !HASH.test(trimmed);
  const caption = invalid ? 'that is not a transaction hash' : emptySubmit ? 'paste a hash first' : '';

  // Deep links (§8): ?tx=0x…&src=prover|local auto-run on the question.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tx = q.get('tx');
    const src = q.get('src') === 'local' ? 'local' : 'prover';
    setSource(src);
    if (tx) { setRaw(tx); void run(tx, src); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function mark(i: number, state: StepState) {
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, state } : x)));
  }

  async function run(input: string, src: Source) {
    if (running.current) return;
    const value = input.trim();
    if (value === '') { setEmptySubmit(true); return; }
    if (!HASH.test(value)) return;

    running.current = true;
    setAsked(true);
    setFailure(null);
    setPending({ hash: value.toLowerCase() });
    setPhase('working');
    setRunSource(src);
    setStep(0);
    setSteps([
      { label: src === 'prover' ? 'Obtain a Merkle proof from the Attestcoin prover' : 'Rebuild the Merkle proof from a public Ethereum node', state: 'active' },
      { label: 'Check whether the block is notarised on Creditcoin', state: 'todo' },
      { label: 'Verify the transaction against the notarised root', state: 'todo' },
    ]);

    try {
      // The chain layer loads only when someone actually asks (first paint never waits for ethers).
      const [{ acquireProof, normaliseTxHash }, { mirrorContract, CHAIN_KEY_ETH_MAINNET }] = await Promise.all([
        import('../lib/proof'),
        import('../lib/chain'),
      ]);
      const hash = normaliseTxHash(value);

      const p = await acquireProof(src, hash);
      mark(0, 'done'); mark(1, 'active'); setStep(1);
      setPending({ hash, block: p.blockNumber });

      const mirror = mirrorContract();
      const isMirrored: boolean = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, p.blockNumber);
      if (!isMirrored) {
        mark(1, 'failed');
        setProven(null);
        setPhase('not-notarised');
        return;
      }
      mark(1, 'done'); mark(2, 'active'); setStep(2);

      const [valid, idx] = await mirror.tryVerify(CHAIN_KEY_ETH_MAINNET, p.blockNumber, p.txBytes, p.siblings);
      if (!valid) {
        mark(2, 'failed');
        setProven(null);
        setFailure({ reason: 'The notarised root rejected this transaction.', technical: `tryVerify returned false for block ${p.blockNumber}` });
        setPhase('failed');
        return;
      }
      mark(2, 'done');
      setProven({ hash, proof: p, index: idx, source: src });
      setPhase('proven');
    } catch (e: any) {
      setSteps((s) => s.map((x) => (x.state === 'active' ? { ...x, state: 'failed' } : x)));
      const message = e?.shortMessage ?? e?.message ?? String(e);
      setProven(null);
      setFailure({ reason: shortReason(message), technical: [message, e?.stack].filter(Boolean).join('\n\n') });
      setPhase('failed');
    } finally {
      running.current = false;
    }
  }

  function submit() {
    void run(raw, source);
  }

  function switchSource(s: Source) {
    setSource(s);
    const target = proven?.hash ?? pending?.hash ?? trimmed;
    if (target && HASH.test(target)) void run(target, s);
  }

  function tryExample(hash: string) {
    setRaw(hash);
    setEmptySubmit(false);
    scrollToTop();
    void run(hash, source);
  }

  const working = phase === 'working';
  // A re-run of the same hash keeps its stamp on the paper; a press never replays for it (§7.1).
  const sameHashRerun = working && proven && pending && proven.hash === pending.hash;
  const stampState = phase === 'proven' || sameHashRerun ? 'proven' : 'idle';
  const shownProof = proven;

  return (
    <section id="panel-question" role="tabpanel" aria-labelledby="tab-question" className="question">
      <div className="hero">
        <h1 className="t-display hero-title">Did this happen?</h1>
        <div className="hero-split">
          <div className="ask">
            <LedgerField
              value={raw}
              onChange={(v) => { setRaw(v); setEmptySubmit(false); }}
              invalid={invalid || emptySubmit}
              caption={caption}
              onSubmit={submit}
            />
            <div className="ask-row">
              <span className="act-wrap">
                <button
                  type="button"
                  className={`act${working ? ' is-working' : ''}`}
                  disabled={invalid}
                  aria-disabled={working || undefined}
                  aria-busy={working || undefined}
                  onClick={() => { if (!working) submit(); }}
                >
                  {working ? WORKING_LABEL(runSource, step) : 'Check the record'}
                </button>
                <span className={`act-hairline${working ? ' is-live' : ''}`} aria-hidden="true" />
              </span>
            </div>
          </div>

          <div className="verdict">
            <Stamp state={stampState} pressKey={proven?.hash ?? pending?.hash} />
            <div className="after-stamp" aria-live="polite">
              {stampState === 'proven' && (
                <p className="t-body">Ethereum contracts cannot read Ethereum’s own history. Creditcoin can.</p>
              )}
              {phase === 'not-notarised' && (
                <div className="plain-state">
                  <p className="t-body">This block is not in the register.</p>
                  <p className="t-caption">
                    <a className="linkish" href="?tab=record" onClick={(e) => { e.preventDefault(); onTab('record'); }}>see coverage</a>
                    {pending?.block != null && <> · this site cannot answer until someone notarises block {pending.block}</>}
                  </p>
                </div>
              )}
              {phase === 'failed' && failure && (
                <div className="plain-state">
                  <p className="t-body">The record could not be checked. {failure.reason}</p>
                  <p className="t-caption">
                    <button type="button" className="linkish" onClick={() => void run(pending?.hash ?? raw, source)}>retry</button>
                  </p>
                  <details>
                    <summary className="t-ui">technical</summary>
                    <pre>{failure.technical}</pre>
                  </details>
                </div>
              )}
            </div>
          </div>

          {/* Its own grid area: on phones the stamp must sit directly under the button, so the press
              happens on-screen (§10.1); the caption and steps follow it. */}
          <div className="ask-after">
            {asked && <SourceCaption source={source} onChange={switchSource} disabled={working} />}
            {asked && steps.length > 0 && <Steps items={steps} />}
          </div>
        </div>
      </div>

      {shownProof && (
        <div className="result" aria-label="The answer">
          <Gloss
            block={shownProof.proof.blockNumber}
            index={shownProof.index.toString()}
            steps={shownProof.proof.siblings.length}
            source={shownProof.source}
          />
          <Assurance kind="cryptographic" />
          <dl className="facts">
            <dt className="t-ui">block</dt>
            <dd><EthBlock n={shownProof.proof.blockNumber} /></dd>
            <dt className="t-ui">index</dt>
            <dd><EthTx hash={shownProof.hash} label={shownProof.index.toString()} /></dd>
            <dt className="t-ui">siblings</dt>
            <dd>{shownProof.proof.siblings.length}</dd>
            <dt className="t-ui">source</dt>
            <dd>{shownProof.source === 'local' ? 'rebuilt in this browser' : 'using Attestcoin prover'}</dd>
            <dt className="t-ui">chainKey</dt>
            <dd>{shownProof.proof.chainKey}</dd>
          </dl>
          <p>
            <CopyLink
              text={`${window.location.origin}${window.location.pathname}?tx=${shownProof.hash}&src=${shownProof.source}`}
              label="Copy a link to this answer"
              copiedLabel="Link copied"
              className="linkish t-hash"
            />
          </p>
          <MerkleLedger
            siblings={shownProof.proof.siblings}
            root={shownProof.proof.root}
            txIndex={Number(shownProof.index)}
            animateKey={`${shownProof.hash}:${shownProof.source}`}
          />
        </div>
      )}

      <Examples onTry={tryExample} />
    </section>
  );
}
