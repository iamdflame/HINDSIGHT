import type { Source } from './SourceCaption';

/** §10.4 / §16 — honest about which path produced the proof bytes. */
export function Gloss({ block, index, steps, source }: { block: number; index: string; steps: number; source: Source }) {
  return (
    <div className="gloss t-body">
      <p>This transaction sits in Ethereum block {block} at index {index}.</p>
      <p>
        {source === 'local'
          ? `Settled by a ${steps}-step Merkle path against a root Creditcoin already notarised — rebuilt in this browser, with no prover and no precompile at verification time.`
          : 'Proof obtained from the Attestcoin prover, then verified against a root already on Creditcoin, with no second call to the precompile.'}
      </p>
    </div>
  );
}
