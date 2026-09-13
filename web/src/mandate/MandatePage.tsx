import type { ReactNode } from 'react';
import { Seal } from '../brand/Seal';
import { Colophon } from '../shell/Colophon';
import { SkipLink } from '../shell/SkipLink';

/**
 * Mandate is the product face of the same runtime. It has its own masthead and its own vocabulary:
 * an underwriter's, not a protocol's. Nothing here says *precompile*, *mirror*, *span* or *topic0* --
 * not because those are secrets (every page links to where they are documented) but because the
 * person deciding whether to rely on a refusal should not have to learn a storage layout first.
 *
 * It shares the colophon, the paper, the wax and the type with hindsight.run, because it is the same
 * system and pretending otherwise would be the dishonest half of a rebrand.
 */
export const MANDATE_ROUTES = [
  { path: '/mandate/', label: 'Assess', id: 'assess' },
  { path: '/files/', label: 'Files', id: 'files' },
  { path: '/cover/', label: 'Cover', id: 'cover' },
  { path: '/versus/', label: 'Versus', id: 'versus' },
  { path: '/hunt/', label: 'Hunt', id: 'hunt' },
  { path: '/claims/', label: 'Docs', id: 'docs' },
] as const;

export type MandateRouteId = (typeof MANDATE_ROUTES)[number]['id'];

export function MandatePage({ active, children, subtitle }: { active: MandateRouteId; children: ReactNode; subtitle: string }) {
  return (
    <div className="shell">
      <SkipLink target="main" />
      <header className="masthead mandate-masthead">
        <a className="lockup" href="/mandate/">
          <Seal size={28} inverse title="" />
          <span className="mandate-wordmark">
            <span className="t-title">Mandate</span>
            <span className="t-ui mandate-sub">{subtitle}</span>
          </span>
        </a>
        <a className="dateline t-ui" href="/">
          on <span className="quiet">Hindsight</span>
        </a>
      </header>
      <nav className="routes" aria-label="Sections">
        {MANDATE_ROUTES.map((r) => (
          <a key={r.id} href={r.path} className={r.id === active ? 'is-active' : ''} aria-current={r.id === active ? 'page' : undefined}>
            {r.label}
          </a>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>{children}</main>
      <Colophon />
    </div>
  );
}
