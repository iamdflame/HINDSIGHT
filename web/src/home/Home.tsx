import { Page } from '../shell/Page';
import { IndependenceModule, useIndependence } from '../independence/IndependenceModule';
import { continuityAt } from '../lib/record';

/**
 * The eight-second landing. One sentence a non-engineer can read, the experiment already running
 * underneath it, and three things to do next. Nothing to paste, nothing to connect.
 */
export function Home() {
  const indep = useIndependence(true);
  return (
    <Page active="home">
      <div className="home-first">
        <section className="hero-home">
          <h1 className="t-display">
            Ask Ethereum.<br />
            Creditcoin answers.<br />
            <em>The second ask is free.</em>
          </h1>
          <p className="lede">
            Every Attestcoin query already proves a run of Ethereum block roots — {continuityAt(1_296_000)?.toLocaleString() ?? 'hundreds'} of
            them for a block half a year old, measured — then throws them away. Hindsight is the first contract that keeps them. After that, proving a second transaction in the same block is a{' '}
            <code>view</code> call — no prover, no <code>0x0FD2</code>, no wallet.
          </p>
          <div className="ctas">
            <button
              type="button"
              className="cta"
              onClick={indep.run}
              disabled={indep.phase !== 'idle' && indep.phase !== 'done' && indep.phase !== 'failed'}
            >
              {indep.phase === 'done' || indep.phase === 'failed' ? 'Prove it again' : indep.phase === 'idle' ? 'Prove it' : 'Proving…'}
            </button>
            <a className="cta cta--quiet" href="/watch/">Hunt a false claim</a>
            <a className="cta cta--quiet" href="/assess/">Assess an address</a>
          </div>
        </section>

        <section className="home-proof" aria-label="Independence, live">
          <p className="beat-n t-hash">running now, on a block picked as this page loaded</p>
          <IndependenceModule state={indep} compact />
          <p className="t-caption home-proof-foot">
            The prover can go down. The precompile can be deleted for the call. The answer does not change. Full sequence
            on <a className="linkish" href="/independence/">/independence</a>; the ninety-second version is{' '}
            <a className="linkish" href="/judge/">/judge</a>.
          </p>
        </section>
      </div>

      <section className="home-why">
        <h2>Why this is a cost-structure change, not a feature</h2>
        <div className="why-grid">
          <div>
            <h3 className="t-ui">Everyone else</h3>
            <p>Calls <code>0x0FD2</code> per question, with a continuity proof whose length grows with the age of the fact — measured {continuityAt(1_296_000)?.toLocaleString() ?? 'hundreds of'} roots at 180 days. Discards the proof. Pays again next time.</p>
          </div>
          <div>
            <h3 className="t-ui">Hindsight</h3>
            <p>Calls <code>0x0FD2</code> once per <em>height</em>, keeps every root the precompile bound, and never calls it for that height again. The second question is a Merkle path against stored state.</p>
          </div>
        </div>
        <p className="t-caption">
          Negatives — “this address was never liquidated” — cannot be proven by inclusion at all. They are
          bonded claims here, half the bond burned when wrong, and the desk’s default treats silence as
          silence, not innocence. See <a className="linkish" href="/watch/">the watch</a> and{' '}
          <a className="linkish" href="/claims/">what is not claimed</a>.
        </p>
      </section>
    </Page>
  );
}
