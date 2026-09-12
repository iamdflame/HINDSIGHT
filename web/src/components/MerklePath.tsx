import type { Sibling } from '../lib/proof';

/**
 * Renders the Merkle path as a path — each level showing which side the sibling sat on and which
 * bit of the transaction index that implies. A hex dump proves nothing to a reader; the shape of
 * the climb is the thing worth seeing, because it is literally how the index is recovered.
 */
export function MerklePath({ siblings, root, txIndex }: { siblings: Sibling[]; root: string; txIndex: number }) {
  return (
    <div>
      <ol className="path">
        {siblings.map((s, i) => (
          <li key={i}>
            <span className="lvl">L{i}</span>
            <span>
              <span className="dir">{s.isLeft ? 'sibling left  · bit 1' : 'sibling right · bit 0'}</span>
              {'  '}
              <span title={s.hash}>{s.hash.slice(0, 18)}…</span>
            </span>
          </li>
        ))}
        <li className="rootrow">
          <span className="lvl">root</span>
          <span title={root}>{root.slice(0, 26)}…</span>
        </li>
      </ol>
      <p className="note">
        Reading the direction bits from L0 upward gives transaction index <strong>{txIndex}</strong> —
        the position inside the block. No Ethereum receipt carries that; it is recovered from the
        shape of the path alone.
      </p>
    </div>
  );
}
