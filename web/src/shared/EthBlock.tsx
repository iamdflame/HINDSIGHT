const ETHERSCAN = 'https://etherscan.io';
export function EthBlock({ n }: { n: number | bigint }) {
  return (
    <a className="t-hash" href={`${ETHERSCAN}/block/${n.toString()}`} target="_blank" rel="noreferrer">
      {n.toString()}
    </a>
  );
}
