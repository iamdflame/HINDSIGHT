import { Page } from '../shell/Page';
import { IndependenceModule, useIndependence } from '../independence/IndependenceModule';
import { continuityAt } from '../lib/record';

/**
 * The eight-second landing. One sentence a non-engineer can read, the experiment already running
 * underneath it, and three things to do next. Nothing to paste, nothing to connect.
 *
 * On tone: the roots this project keeps are proved by Attestcoin's attestors, and the earlier draft of
 * this page read as though that were a flaw somebody had failed to notice. It is not. The attestation
 * layer binds a run of roots for every query and discards them because it is a *verifier*, and holding
 * history is not a verifier's job. Hindsight's whole claim is that the discarding is the only part
 * worth changing, and that is what the page should say -- to the people who built the layer it rests on
 * as much as to anyone else.
 */
export function Home() {
  const indep = useIndependence(true);
  return (
    <Page active="home">
      <div className="home-first">
        <section className="hero-home">
          <h1 className="t-display">
            Attestcoin already<br />
            proves the roots.<br />
            <em>This is where they live.</em>
          </h1>
          <p className="lede">
            Answering one query binds a run of Ethereum block roots — {continuityAt(1_296_000)?.toLocaleString() ?? 'hundreds'} of them for a
            block half a year old, measured — and then lets them go, because verifying is not the same job as remembering.
            Hindsight keeps them. Once a height is held, proving anything else in that block is a <code>view</code> call
            against stored state: no prover, no <code>0x0FD2</code>, no wallet, nothing in the loop that anyone can switch off.
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
            <h3 className="t-ui">Per question</h3>
            <p>One call to <code>0x0FD2</code>, carrying a continuity proof whose length grows with the age of the fact — measured {continuityAt(1_296_000)?.toLocaleString() ?? 'hundreds of'} roots at 180 days. The proof is checked, and then it is gone. The next question about the same block pays for it again.</p>
          </div>
          <div>
            <h3 className="t-ui">Per height</h3>
            <p>The same call, once, and every root it bound is written down. That height is never proved again — by anyone, for anything. The second question is a Merkle path against stored state, and the tenth thousandth is too.</p>
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
