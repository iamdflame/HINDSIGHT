/** The routes a visitor can reach from the masthead. Everything else is in the colophon. */
export const ROUTES = [
  { path: '/', label: 'Ask', id: 'home' },
  { path: '/verify/', label: 'Verify', id: 'verify' },
  { path: '/record/', label: 'Record', id: 'record' },
  { path: '/watch/', label: 'Watch', id: 'watch' },
  { path: '/assess/', label: 'Assess', id: 'assess' },
  { path: '/order/', label: 'Order', id: 'order' },
  { path: '/judge/', label: 'Judge', id: 'judge' },
] as const;

export const MORE = [
  { path: '/independence/', label: 'Independence', id: 'independence' },
  { path: '/integrate/', label: 'Integrate', id: 'integrate' },
  { path: '/enshrine/', label: 'Enshrine', id: 'enshrine' },
  { path: '/claims/', label: 'Claims', id: 'claims' },
] as const;

export type RouteId = (typeof ROUTES)[number]['id'] | (typeof MORE)[number]['id'];

export function Nav({ active }: { active: RouteId }) {
  return (
    <nav className="routes" aria-label="Sections">
      {ROUTES.map((r) => (
        <a key={r.id} href={r.path} className={r.id === active ? 'is-active' : ''} aria-current={r.id === active ? 'page' : undefined}>
          {r.label}
        </a>
      ))}
    </nav>
  );
}
