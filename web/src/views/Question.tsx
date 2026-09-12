import { useEffect, useState } from 'react';
import { acquireProof, normaliseTxHash, type ProofBundle } from '../lib/proof';
import { mirrorContract, ethereum, currentEthRpc, CHAIN_KEY_ETH_MAINNET, MIRROR_ADDRESS, BLOCK_PROVER, VENUES } from '../lib/chain';
import { MerklePath } from '../components/MerklePath';
import { Assurance, Working, Empty, Failure, Steps, EthTx, EthBlock, CcAddr, Trunc } from '../components/Bits';

type Phase = 'idle' | 'working' | 'proven' | 'not-notarised' | 'invalid' | 'error';

const EXAMPLES = [
  { label: 'Aave V3 liquidation', hash: '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61' },
  { label: 'Aave V3 repayment', hash: '0xcb9cd732d95ea9632c02add1afa7d66b5fd94f0ae48a4fdee6f88b2142149c00' },
];

type Found = { venue: string; event: string; subject?: string };

export function Question() {
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState<'prover' | 'local'>('prover');
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [proof, setProof] = useState<ProofBundle | null>(null);
  const [txIndexOnChain, setTxIndexOnChain] = useState<bigint | null>(null);
  const [found, setFound] = useState<Found[]>([]);
  const [copied, setCopied] = useState(false);
  const [steps, setSteps] = useState<{ label: string; state: 'todo' | 'active' | 'done' | 'failed' }[]>([]);

  // Deep link: ?tx=0x…&src=local makes a verified answer shareable, which is the point of an
  // evidence page — a reader should be able to re-run the check rather than take a screenshot.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tx = q.get('tx');
    const src = q.get('src');
    if (src === 'local' || src === 'prover') setSource(src);
    if (tx) { setRaw(tx); setTimeout(() => void run(tx, (src as any) ?? 'prover'), 0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function mark(i: number, state: 'active' | 'done' | 'failed') {
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, state } : x)));
  }

  async function run(rawOverride?: string, srcOverride?: 'prover' | 'local') {
    const input = rawOverride ?? raw;
    const src = srcOverride ?? source;
    setErr(''); setProof(null); setFound([]); setTxIndexOnChain(null);
    let hash: string;
    try { hash = normaliseTxHash(input); } catch (e: any) { setErr(e.message); setPhase('invalid'); return; }

    setPhase('working');
    setSteps([
      { label: src === 'prover' ? 'Obtain a Merkle proof from the Attestcoin prover' : 'Rebuild the Merkle proof from a public Ethereum node', state: 'active' },
      { label: 'Check whether the block is notarised on Creditcoin', state: 'todo' },
      { label: 'Verify the transaction against the notarised root', state: 'todo' },
    ]);

    try {
      const p = await acquireProof(src, hash, setNote);
      setProof(p); mark(0, 'done'); mark(1, 'active');
      setNote('');

      const mirror = mirrorContract();
      const isMirrored: boolean = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, p.blockNumber);
      if (!isMirrored) { mark(1, 'failed'); setPhase('not-notarised'); return; }
      mark(1, 'done'); mark(2, 'active');

      const [valid, idx] = await mirror.tryVerify(CHAIN_KEY_ETH_MAINNET, p.blockNumber, p.txBytes, p.siblings);
      if (!valid) { mark(2, 'failed'); setPhase('invalid'); setErr('The notarised root rejected this transaction.'); return; }
      mark(2, 'done');
      setTxIndexOnChain(idx);
      setPhase('proven');

      // Display only: name any recognised credit event in the receipt. The verification above is
      // independent of this and does not rely on it.
      try {
        const rc = await ethereum().getTransactionReceipt(hash);
        const hits: Found[] = [];
        for (const lg of rc?.logs ?? []) {
          for (const v of VENUES) {
            if (lg.address.toLowerCase() !== v.address.toLowerCase()) continue;
            for (const ev of v.events) {
              if (lg.topics[0]?.toLowerCase() !== ev.topic0.toLowerCase()) continue;
              hits.push({
                venue: v.label, event: ev.label,
                subject: lg.topics[ev.subjectTopic] ? '0x' + lg.topics[ev.subjectTopic].slice(-40) : undefined,
              });
            }
          }
        }
        setFound(hits);
      } catch { /* naming is a nicety; silence is correct if the node declines */ }
    } catch (e: any) {
      setSteps((s) => s.map((x) => (x.state === 'active' ? { ...x, state: 'failed' } : x)));
      setErr(e.message ?? String(e)); setPhase('error');
    }
  }

  return (
    <section className="pane">
      <h2 className="pane-title">Did this happen on Ethereum?</h2>
      <p className="pane-intro">
        Paste any Ethereum mainnet transaction. If its block has been notarised on Creditcoin, the
        answer is settled by <strong>a Merkle path against a root the block-prover precompile
        already certified</strong> — no indexer, no subgraph, no oracle, and no trust in this site.
        Reading requires no wallet and costs nothing.
      </p>

      <div className="split">
        <div>
          <label className="field">
            <span>Ethereum mainnet transaction hash</span>
            <input
              type="text" value={raw} spellCheck={false}
              placeholder="0x…"
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            />
          </label>

          <p className="examples">
            Try: {EXAMPLES.map((x, i) => (
              <span key={x.hash}>
                {i > 0 && ' · '}
                <button onClick={() => setRaw(x.hash)}>{x.label}</button>
              </span>
            ))}
          </p>

          <label className="field">
            <span>Where should the proof come from?</span>
            <div className="toggle">
              <button aria-pressed={source === 'prover'} onClick={() => setSource('prover')}>Attestcoin prover</button>
              <button aria-pressed={source === 'local'} onClick={() => setSource('local')}>Rebuild from a public node</button>
            </div>
          </label>
          <p className="note" style={{ marginTop: '.5rem' }}>
            {source === 'prover'
              ? 'One request to Gluwa’s hosted prover. Fast.'
              : 'Downloads the whole block with every receipt, re-encodes each transaction and rebuilds the Merkle tree in your browser. Slow on purpose — it does the prover’s job to show the prover is replaceable.'}
          </p>

          <div style={{ marginTop: '1.4rem' }}>
            <button className="act" onClick={() => void run()} disabled={phase === 'working'}>
              {phase === 'working' ? 'Checking…' : 'Check the record'}
            </button>
          </div>

          {steps.length > 0 && <Steps items={steps} />}
          {note && <div style={{ marginTop: '.8rem' }}><Working>{note}</Working></div>}

          {phase === 'proven' && (
            <div className="limits">
              <h3>What this does, and does not, establish</h3>
              <p><b>Established.</b> This exact transaction occupies this exact position in this
                Ethereum block, and the block&rsquo;s commitment on Creditcoin was certified by the
                block-prover precompile from a continuity proof anchored to an attestation.</p>
              <p><b>Not established.</b> That the transaction did what you think it did — that is a
                question about the contract it called, not about inclusion. And nothing at all about
                blocks outside the notarised range.</p>
              <p><b>Still trusted.</b> Notarising a block in the first place requires Attestcoin&rsquo;s
                attestor set and the precompile. Verification afterwards does not. Those are two
                different claims and only the second one is free of a trust assumption.</p>
            </div>
          )}
        </div>

        <div>
          {phase === 'idle' && (
            <div className="explainer">
              <h3>How an answer is reached</h3>
              <ol>
                <li>
                  <b>A proof is obtained.</b> Either from Gluwa&rsquo;s hosted prover, or rebuilt in
                  your browser from a public Ethereum node. Both produce the same bytes.
                </li>
                <li>
                  <b>The block must already be notarised.</b> Its transaction Merkle root has to be
                  held on Creditcoin, put there by a continuity proof the block-prover precompile
                  verified.
                </li>
                <li>
                  <b>The path is walked on-chain.</b> Nine hashes against that root. No prover, no
                  precompile, no indexer at this step — and no wallet, because it is a view call.
                </li>
              </ol>
              <p>
                If the block is not notarised, you get told so plainly rather than shown a guess.
              </p>
            </div>
          )}

          {phase === 'error' && <Failure title="Could not complete the check"><p>{err}</p></Failure>}
          {phase === 'invalid' && <Failure title="Not verifiable"><p>{err}</p></Failure>}

          {phase === 'not-notarised' && proof && (
            <Empty title="That block is not notarised yet">
              <p>
                Ethereum block <strong>{proof.blockNumber}</strong> has no commitment on Creditcoin, so
                there is nothing here to check the transaction against.
              </p>
              <p>
                This is an honest gap, not a failure: the archive only covers what someone has paid to
                notarise. Any address can extend it from the Record tab.
              </p>
            </Empty>
          )}

          {phase === 'proven' && proof && (
            <div className="verdict">
              <p className="stamp proven">Proven</p>
              <p className="gloss">
                This transaction is in Ethereum block <b>{proof.blockNumber}</b> at index{' '}
                <b>{txIndexOnChain?.toString()}</b>. Established by a {proof.siblings.length}-step Merkle
                path against a root notarised on Creditcoin — <b>without contacting the prover,
                the precompile, or any indexer</b> at verification time.
              </p>
              <div style={{ margin: '.9rem 0 1.3rem' }}><Assurance kind="cryptographic" /></div>

              {found.length > 0 && (
                <dl className="facts" style={{ marginBottom: '1.4rem' }}>
                  {found.map((f, i) => (
                    <div key={i} style={{ display: 'contents' }}>
                      <dt>{f.venue}</dt>
                      <dd>{f.event}{f.subject ? ` — ${f.subject}` : ''}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1rem', margin: '0 0 .7rem' }}>Chain of custody</h3>
              <dl className="facts">
                <dt>Ethereum tx</dt><dd><EthTx hash={proof.txHash} /></dd>
                <dt>Ethereum block</dt><dd><EthBlock n={proof.blockNumber} /></dd>
                {proof.blockTxCount && <><dt>Txs in block</dt><dd>{proof.blockTxCount}</dd></>}
                <dt>Proof source</dt><dd>{proof.source === 'prover' ? 'Attestcoin hosted prover' : `rebuilt locally via ${currentEthRpc()}`}</dd>
                <dt>Build time</dt><dd>{Math.round(proof.elapsedMs)} ms</dd>
                <dt>Block root</dt><dd><Trunc v={proof.root} n={22} /></dd>
                <dt>Notarised in</dt><dd><CcAddr addr={MIRROR_ADDRESS} /></dd>
                <dt>Root certified by</dt><dd><CcAddr addr={BLOCK_PROVER} /> (block prover precompile)</dd>
              </dl>

              <p className="note" style={{ marginTop: '1.2rem' }}>
                <button className="linkish" onClick={() => {
                  const u = `${window.location.origin}${window.location.pathname}?tx=${proof.txHash}&src=${proof.source}`;
                  void navigator.clipboard?.writeText(u); setCopied(true); setTimeout(() => setCopied(false), 2000);
                }}>{copied ? 'Link copied' : 'Copy a link to this answer'}</button>
                {' '}— whoever opens it re-runs the check in their own browser rather than trusting this page.
              </p>

              <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1rem', margin: '1.6rem 0 .6rem' }}>The path</h3>
              <MerklePath siblings={proof.siblings} root={proof.root} txIndex={proof.txIndex} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
