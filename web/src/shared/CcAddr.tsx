import { Trunc } from './Trunc';
const EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export function CcAddr({ addr }: { addr: string }) {
  return (
    <a className="t-hash" href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer">
      <Trunc v={addr} />
    </a>
  );
}
