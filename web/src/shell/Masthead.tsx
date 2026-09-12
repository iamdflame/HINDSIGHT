import { Seal } from '../brand/Seal';
import { Wordmark } from '../brand/Wordmark';
import { CountOnce } from '../shared/CountOnce';
import type { ArchiveStats } from './useArchiveStats';

type MastheadProps = {
  /** The legend lives on the homepage masthead only (§3.2). */
  withLegend: boolean;
  stats: ArchiveStats;
  onDateline: () => void;
  onHome?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
};

/** §9.1 — lockup left, dateline right, baseline-aligned, then the 2px ink rule. */
export function Masthead({ withLegend, stats, onDateline, onHome }: MastheadProps) {
  return (
    <header className={`masthead${withLegend ? '' : ' masthead--no-legend'}`}>
      <a className="lockup" href="/" onClick={onHome}>
        {/* 28px is below where the outline seal's 1.25-unit rings survive; the spec's inverse
            colourway keeps the mark a seal at masthead size. */}
        <Seal size={28} inverse title="" />
        <Wordmark withLegend={withLegend} size={40} />
      </a>
      {stats.status === 'loading' ? (
        // The final shape, held invisibly: revealing it is an appearance, not a shift.
        <span className="dateline t-ui is-pending" aria-hidden="true">
          CC3 · Ethereum mainnet · <span className="num">000</span> blocks · sealed <span className="num">0</span> · claims <span className="num">0</span>
        </span>
      ) : stats.status === 'offline' ? (
        <button type="button" className="dateline t-ui is-offline" onClick={onDateline}>CC3 · offline</button>
      ) : (
        <button type="button" className="dateline t-ui" onClick={onDateline}>
          CC3 · Ethereum mainnet ·{' '}
          <span className="num"><CountOnce value={stats.blocks} /></span> blocks
          {(stats.spans > 0 || stats.claims > 0) && (
            <>
              {' '}· sealed <span className="num">{stats.spans}</span> · claims <span className="num">{stats.claims}</span>
            </>
          )}
        </button>
      )}
    </header>
  );
}
