import claims from '../../../CLAIMS.md?raw';
import { Masthead } from '../shell/Masthead';
import { Colophon } from '../shell/Colophon';
import { useArchiveStats } from '../shell/useArchiveStats';
import { ClaimsDocument } from './ClaimsDocument';

/** §8 /judge — CLAIMS.md as a designed page. Same type, no new chrome. */
export function Judge() {
  const stats = useArchiveStats();
  return (
    <div className="shell">
      <Masthead withLegend={false} stats={stats} onDateline={() => { window.location.href = '/?tab=record'; }} />
      <main id="main">
        <ClaimsDocument source={claims} />
      </main>
      <Colophon />
    </div>
  );
}
