import type { ReactNode } from 'react';
import { Masthead } from './Masthead';
import { Nav, type RouteId } from './Nav';
import { Colophon } from './Colophon';
import { useArchiveStats } from './useArchiveStats';
import { SkipLink } from './SkipLink';

/**
 * Every route is its own entry so the first paint carries only what that page needs; this is the
 * shell they all share. The masthead is the register of record, the nav is the instrument's
 * sections, the colophon carries the assurance key and the rest of the routes.
 */
export function Page({ active, children, main = 'main' }: { active: RouteId; children: ReactNode; main?: string }) {
  const stats = useArchiveStats(active);
  return (
    <div className="shell">
      <SkipLink target={main} />
      <Masthead stats={stats} withLegend={active === 'home'} />
      <Nav active={active} />
      <main id={main} tabIndex={-1}>{children}</main>
      <Colophon />
    </div>
  );
}
