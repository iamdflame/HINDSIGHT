import { Trunc } from './Trunc';
const ETHERSCAN = 'https://etherscan.io';
export function EthTx({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="t-hash" href={`${ETHERSCAN}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? <Trunc v={hash} />}
    </a>
  );
}
