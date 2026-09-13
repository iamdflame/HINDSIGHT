import facts from './record.generated.json';

/**
 * Measured facts the site prints without a chain client. `record.generated.json` is extracted from
 * `deployments.json` by `worker/src/claims-doc.ts` (CI checks it), so every value here was written by
 * a worker script from live state -- none is typed -- and the page shell does not ship the whole record.
 */
export const CONTINUITY_BY_AGE: { label: string; age: number; block: number; roots?: number }[] = facts.continuityByAge;

export const continuityAt = (age: number): number | undefined => CONTINUITY_BY_AGE.find((r) => r.age === age)?.roots;

/** The most roots one `mirror()` call has retained on mainnet. */
export const WIDEST_CALL_ROOTS: number | undefined = facts.widestCallRoots ?? undefined;
