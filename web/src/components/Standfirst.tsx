import { useEffect, useState } from 'react';
import { mirrorContract, registryContract, CHAIN_KEY_ETH_MAINNET } from '../lib/chain';

type S = { blocks: number; hi: number; spans: number; claims: number } | null;

/**
 * Live state of the archive, shown before a visitor does anything.
 *
 * A landing page that opens on an empty form reads as a toy. Reading real counts off the chain on
 * first paint is the cheapest possible proof that this is a running system with real Ethereum
 * history in it — and it costs the visitor nothing.
 */
export function Standfirst() {
  const [s, setS] = useState<S>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const m = mirrorContract();
        const r = registryContract();
        const [blocks, hi, spans, claims] = await Promise.all([
          m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
          m.highestMirrored(CHAIN_KEY_ETH_MAINNET),
          m.spanCount(),
          r.claimCount(),
        ]);
        setS({ blocks: Number(blocks), hi: Number(hi), spans: Number(spans), claims: Number(claims) });
      } catch { setFailed(true); }
    })();
  }, []);

  return (
    <div className="standband">
      <p className="lead">
        Ethereum contracts cannot read Ethereum&rsquo;s own history. Creditcoin can — so this is
        where Ethereum&rsquo;s past becomes answerable: <em>positively</em> by proof,{' '}
        <em>negatively</em> by a bond anyone can take.
      </p>
      <dl className="tally">
        <div><dt>Ethereum blocks notarised</dt><dd>{s ? s.blocks.toLocaleString() : failed ? '—' : '·'}</dd></div>
        <div><dt>Latest block held</dt><dd>{s ? s.hi.toLocaleString() : failed ? '—' : '·'}</dd></div>
        <div><dt>Spans sealed</dt><dd>{s ? s.spans : failed ? '—' : '·'}</dd></div>
        <div><dt>Claims of absence</dt><dd>{s ? s.claims : failed ? '—' : '·'}</dd></div>
      </dl>
      {failed && <p className="note" style={{ marginTop: '.6rem' }}>Could not reach the Creditcoin testnet RPC to read live counts.</p>}
    </div>
  );
}
