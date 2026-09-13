import deployments from '../../../deployments.json';

/**
 * Measured facts from `deployments.json`, with no chain client attached, so a page can print a number
 * without pulling ethers into its first paint. Every value here was written by a worker script from
 * live state; none is typed.
 */
export const CONTINUITY_BY_AGE: { label: string; age: number; block: number; roots?: number }[] =
  (deployments as any).measured?.continuityByAge?.rows ?? [];

export const continuityAt = (age: number): number | undefined => CONTINUITY_BY_AGE.find((r) => r.age === age)?.roots;

/** The most roots one `mirror()` call has retained on mainnet. */
export const WIDEST_CALL_ROOTS: number | undefined = (deployments as any).measured?.chains?.['3']?.widestCall?.roots;
