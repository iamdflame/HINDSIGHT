/**
 * The desk, read for the public API. Shared by /api/assess, /api/certificate and /api/dump.
 *
 * Every function here is a `view` on the deployed contracts. None caches to a server, none re-implements
 * a rule: the verdict returned is the return value of the same `assess` that `borrow` gates on, and the
 * sealed window it is priced against is computed the way the browser and the worker compute it.
 */
import { JsonRpcProvider, Contract, isAddress, getAddress } from 'ethers';
import { manifest } from './_manifest.js';

export const REFUSAL = [
  'None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness',
  'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent', 'NeedsBondedCover', 'PoolCapReached', 'UnprovenSubject',
] as const;

/** Plain-language half of each refusal. Kept beside the enum, never instead of it. */
export const WHY: Record<string, string> = {
  None: 'Pays. Nothing on the board disqualifies this address under these terms.',
  NoSuchPolicy: 'No such instrument.',
  ArchiveTooShallow: 'Refuses. The archive cannot show it holds every height these terms look back over; an answer drawn from history nobody holds is not an answer.',
  ClaimUnderHunt: 'Refuses. Somebody has money on the line challenging a statement about this address right now.',
  ProvenLiar: 'Refuses. Somebody swore this address was clean, staked money on it, and lost: a real transaction inside the window was produced and checked against the archive.',
  NoBondedCleanliness: 'Refuses. These terms need a standing bond on this address covering the whole window, with more beyond recovery than the loan is worth. There is none.',
  DeskOutOfFunds: 'Refuses. The desk does not hold this much.',
  EventOnRecord: 'Refuses. A standing claim lists this exact event against this address inside the window, verified when it was filed.',
  AlreadyLent: 'Refuses. This address has already borrowed once under these terms; there is no repayment path.',
  NeedsBondedCover: 'Answers, and will not lend. Nothing disqualifies this address and nothing stands behind it either; silence is not collateral.',
  PoolCapReached: 'Refuses. The desk has lent as much as the attestors behind this source chain have bonded.',
  UnprovenSubject: 'Refuses. These terms only answer about Ethereum addresses somebody has proven control of, and nobody has signed for this one.',
};

const MIRROR_ABI = [
  'function highestMirrored(uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns ((uint64 chainKey, uint64 fromBlock, uint64 toBlock))',
];
const DESK_ABI = [
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal, bool requiresBinding))',
  'function assess(address, uint256, uint256, uint256[]) view returns (bool ok, uint8 reason)',
  'function securityBudget(uint64) view returns (uint32 attestors, uint128 minBond, uint256 cap)',
  'function totalOutstanding() view returns (uint256)',
];
const REGISTRY_ABI = [
  'function keyOf(uint64, address, bytes32, uint8, bytes32) pure returns (bytes32)',
  'function recordOf(bytes32) view returns (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total)',
  'function claimUnderKey(bytes32, uint256) view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function enforceableLoss(uint256) view returns (uint256)',
];
const STATUS = ['None', 'Open', 'Refuted', 'Standing'] as const;

export type Policy = { id: number; kind: 'BlankFile' | 'BondedClean'; chainKey: number; window: number; maxStaleness: number; venue: string; topic0: string; subjectTopic: number; minBond: string; maxPrincipal: string; requiresBinding: boolean };
export type Offer = { spanIds: number[]; from: number; to: number };

export function provider() {
  return new JsonRpcProvider(manifest.rpc, 102031, { staticNetwork: true });
}

export function contracts(cc = provider()) {
  return {
    cc,
    mirror: new Contract(manifest.contracts.EthereumMirror.address, MIRROR_ABI, cc),
    desk: new Contract(manifest.contracts.UnderwritingDesk.address, DESK_ABI, cc),
    registry: new Contract(manifest.contracts.AbsenceRegistryV3.address, REGISTRY_ABI, cc),
  };
}

export function checksummed(s: string | null): string | null {
  if (!s || !isAddress(s)) return null;
  return getAddress(s);
}

export async function policies(desk: Contract): Promise<Policy[]> {
  const n = Number(await desk.policyCount());
  const rows = await Promise.all(Array.from({ length: n }, (_, i) => desk.policyOf(i)));
  return rows.map((p: any, id: number) => ({
    id,
    kind: Number(p.kind) === 0 ? 'BlankFile' : 'BondedClean',
    chainKey: Number(p.chainKey),
    window: Number(p.window),
    maxStaleness: Number(p.maxStaleness),
    venue: p.venue,
    topic0: p.topic0,
    subjectTopic: Number(p.subjectTopic),
    minBond: p.minBond.toString(),
    maxPrincipal: p.maxPrincipal.toString(),
    requiresBinding: Boolean(p.requiresBinding),
  }));
}

/** The sealed spans to offer for a window on a chain: the shortest adjacent run reaching highest. */
export async function offerFor(mirror: Contract, chainKey: number, window: number): Promise<Offer | null> {
  const n = Number(await mirror.spanCount());
  const all = await Promise.all(Array.from({ length: n }, async (_, i) => ({ id: i, s: await mirror.spanOf(i) })));
  const spans = all.filter((x) => Number(x.s.chainKey) === chainKey).map((x) => ({ id: x.id, from: Number(x.s.fromBlock), to: Number(x.s.toBlock) }));
  let top = spans[0];
  for (const x of spans) if (!top || x.to > top.to || (x.to === top.to && x.from < top.from)) top = x;
  if (!top) return null;
  const ids = [top.id];
  let from = top.from;
  while (top.to - from < window && ids.length < 8) {
    const below = spans.find((x) => x.to + 1 === from && x.id !== top.id);
    if (!below) break;
    from = below.from;
    ids.unshift(below.id);
  }
  return top.to - from < window ? null : { spanIds: ids, from, to: top.to };
}

export type Verdict = { policy: Policy; ok: boolean; reason: (typeof REFUSAL)[number] | string; why: string; window: Offer | null };

export async function assessAll(desk: Contract, mirror: Contract, subject: string, principalWei: bigint): Promise<Verdict[]> {
  const ps = await policies(desk);
  const offers = new Map<string, Offer | null>();
  for (const p of ps) {
    const k = `${p.chainKey}:${p.window}`;
    if (!offers.has(k)) offers.set(k, await offerFor(mirror, p.chainKey, p.window));
  }
  return Promise.all(
    ps.map(async (policy) => {
      const window = offers.get(`${policy.chainKey}:${policy.window}`) ?? null;
      const [ok, reason] = await desk.assess(subject, policy.id, principalWei, window?.spanIds ?? []);
      const name = REFUSAL[Number(reason)] ?? String(reason);
      return { policy, ok: Boolean(ok), reason: name, why: WHY[name] ?? '', window };
    }),
  );
}

export type Claim = { id: number; status: (typeof STATUS)[number]; kind: 'EmptySet' | 'CompleteSet'; chainKey: number; venue: string; topic0: string; subjectTopic: number; spanFrom: number; spanTo: number; bondStaked: string; enforceableLoss: string; openUntil: number; claimant: string; refuter: string };

/** Everything on file about an address, through the registry's per-key index. */
export async function filesOn(registry: Contract, subject: string, ps: Policy[]): Promise<Claim[]> {
  const wanted = '0x' + subject.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const keys = new Map<string, [number, string, string, number]>();
  for (const p of ps) keys.set(`${p.chainKey}|${p.venue}|${p.topic0}|${p.subjectTopic}`, [p.chainKey, p.venue, p.topic0, p.subjectTopic]);
  const ids = new Set<number>();
  await Promise.all(
    [...keys.values()].map(async ([chainKey, venue, topic0, slot]) => {
      const key = await registry.keyOf(chainKey, venue, topic0, slot, wanted);
      const rec = await registry.recordOf(key);
      const under = await Promise.all(Array.from({ length: Number(rec.total) }, (_, i) => registry.claimUnderKey(key, i)));
      for (const id of under) ids.add(Number(id));
    }),
  );
  return Promise.all(
    [...ids].sort((a, b) => a - b).map(async (id) => {
      const [c, loss] = await Promise.all([registry.claimOf(id), registry.enforceableLoss(id)]);
      return {
        id,
        status: STATUS[Number(c.status)] ?? 'None',
        kind: Number(c.kind) === 0 ? 'EmptySet' : 'CompleteSet',
        chainKey: Number(c.chainKey),
        venue: c.venue,
        topic0: c.topic0,
        subjectTopic: Number(c.subjectTopic),
        spanFrom: Number(c.spanFrom),
        spanTo: Number(c.spanTo),
        bondStaked: c.bondStaked.toString(),
        enforceableLoss: loss.toString(),
        openUntil: Number(c.openUntil),
        claimant: c.claimant,
        refuter: c.refuter,
      };
    }),
  );
}

export async function archive(mirror: Contract, chainKey: number) {
  const [held, lowest, highest] = await Promise.all([mirror.mirroredBlocks(chainKey), mirror.lowestMirrored(chainKey), mirror.highestMirrored(chainKey)]);
  return { chainKey, held: Number(held), lowest: Number(lowest), highest: Number(highest), missingInRange: Number(highest) - Number(lowest) + 1 - Number(held) };
}

export const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
