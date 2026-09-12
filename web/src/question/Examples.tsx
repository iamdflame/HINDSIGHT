// Real Ethereum mainnet transactions, the same ones the README cites. Nothing here is a fixture.
export const EXAMPLES = [
  { label: 'try a real Aave liquidation', hash: '0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61' },
  { label: 'try a real repayment', hash: '0xcb9cd732d95ea9632c02add1afa7d66b5fd94f0ae48a4fdee6f88b2142149c00' },
];

/** §10.7 — two quiet text links under the fold. Real hrefs, so they also work as deep links. */
export function Examples({ onTry }: { onTry: (hash: string) => void }) {
  return (
    <aside className="examples" aria-label="Examples">
      <p className="examples-links">
        {EXAMPLES.map((x) => (
          <a
            key={x.hash}
            href={`?tx=${x.hash}&src=prover`}
            onClick={(e) => { e.preventDefault(); onTry(x.hash); }}
          >
            {x.label}
          </a>
        ))}
      </p>
      <p className="t-caption">real mainnet transactions, not fixtures we deployed</p>
    </aside>
  );
}
