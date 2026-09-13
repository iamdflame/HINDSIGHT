import { Seal } from '../brand/Seal';
import { Wordmark } from '../brand/Wordmark';
import { CountOnce } from '../shared/CountOnce';
import type { ArchiveStats } from './useArchiveStats';

type MastheadProps = {
  /** The legend lives on the home masthead only. */
  withLegend: boolean;
  stats: ArchiveStats;
};

/**
 * The register of record. Not a quiet library header: the live count of Ethereum heights whose
 * root lives on Creditcoin, how far behind Ethereum's head the attestors are, and the fact that
 * matters most -- that none of what follows needs the proving service.
 */
export function Masthead({ withLegend, stats }: MastheadProps) {
  return (
    <header className={`masthead${withLegend ? '' : ' masthead--no-legend'}`}>
      <a className="lockup" href="/">
        <Seal size={28} inverse title="" />
        <Wordmark withLegend={withLegend} size={40} />
      </a>
      {stats.status === 'loading' ? (
        // The final shape, held invisibly: revealing it is an appearance, not a shift.
        <span className="dateline t-ui is-pending" aria-hidden="true">
          mainnet <span className="num">000,000</span> · sepolia <span className="num">000,000</span> · lag <span className="num">00</span> · prover not in the loop
        </span>
      ) : stats.status === 'offline' ? (
        <a className="dateline t-ui is-offline" href="/record/">CC3 · offline</a>
      ) : (
        <a className="dateline t-ui" href="/record/" title="Heights held on Creditcoin, per source chain. Click for the record.">
          mainnet <span className="num"><CountOnce value={stats.mainnet.held} /></span>
          {' '}· sepolia <span className="num"><CountOnce value={stats.sepolia.held} /></span>
          {stats.attestedLag !== null && (
            <>
              {' '}· lag <span className="num">{stats.attestedLag}</span>
            </>
          )}
          {' '}· <span className="quiet">prover not in the loop</span>
        </a>
      )}
    </header>
  );
}
