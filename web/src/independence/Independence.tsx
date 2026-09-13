import { Page } from '../shell/Page';
import { IndependenceModule, useIndependence } from '../independence/IndependenceModule';
import { MIRROR_ADDRESS, EXPLORER } from '../lib/chain';

/**
 * The full experiment, with the reasoning a sceptic needs. Three claims are made about a notarised
 * block, and all three are run rather than asserted: the hosted prover is not needed, the
 * block-prover precompile is not needed, and this website is not needed.
 */
export function Independence() {
  const state = useIndependence(true);
  return (
    <Page active="independence">
      <div className="doc indep">
        <h1>Without the prover, without the precompile, without us.</h1>
        <p className="lede">
          Once a block is notarised, answering a question about it is a Merkle path and a stored root.
          Everything below runs in this browser, against Creditcoin, right now.
        </p>

        <IndependenceModule state={state} />

        <h2>Why the control is there</h2>
        <p>
          A state override that the node quietly ignored would make the precompile row meaningless — the call
          would have succeeded whether or not <code>0x0FD2</code> was deleted. So the same override mechanism is
          turned on the archive itself. Blanking the mirror must break verification, and it does. The override
          is real, and therefore so is the deletion.
        </p>

        <h2>Why a second transaction</h2>
        <p>
          Re-verifying the transaction a block was notarised <em>with</em> would only show a cached receipt.
          Verifying a different transaction, at a different index in the same block, is what demonstrates that a
          whole block was stored — every transaction in it is now answerable, not one.
        </p>

        <h2>What is still needed</h2>
        <p>
          Notarising a block in the first place requires the Attestcoin attestor set and the block-prover
          precompile, and that is never waived. These are two different claims, and only the second one —
          verification <em>after</em> notarisation — is free of them.
        </p>
        <p className="t-caption">
          Reproduce without this page:{' '}
          <a href={`${EXPLORER}/address/${MIRROR_ADDRESS}#readContract`} rel="noreferrer" target="_blank">
            call <code>verifyOrRevert</code> on Blockscout
          </a>
          , run <code>npx github:iamdflame/HINDSIGHT verify &lt;tx&gt;</code>, or{' '}
          <code>forge test --match-contract SecondTransaction</code>, which deletes the precompile in the EVM rather
          than in one call.
        </p>
      </div>
    </Page>
  );
}
