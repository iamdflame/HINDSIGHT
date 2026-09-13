/**
 * What the desk is, read from the desk.
 *
 * Every number on a Mandate page comes through here: the policies as filed, the sealed window each
 * one can be priced against, the ceiling the attestors put on the whole book, and the verdict for an
 * address. Nothing is cached to a server and nothing is recomputed in a second implementation -- the
 * verdict a visitor sees is the return value of the same `assess` that `borrow` gates on.
 */
import { deskContract, mirrorContract, registryContract, sealedSpans, spanOffer, REFUSAL, VENUES, CHAIN_KEY_ETH_MAINNET, type Span } from '../lib/chain';

export type Policy = {
  id: number;
  kind: 0 | 1;
  chainKey: number;
  window: number;
  maxStaleness: number;
  venue: string;
  topic0: string;
  subjectTopic: number;
  minBond: bigint;
  maxPrincipal: bigint;
  /** Only addresses somebody has proven control of on the source chain. */
  requiresBinding: boolean;
};

export type Offer = { ids: number[]; from: number; to: number };

export type Book = {
  policies: Policy[];
  /** Sealed windows by chain key, and the offer each policy is priced against. */
  offers: Map<number, Offer | null>;
  head: number;
  lowest: number;
  held: number;
  /** What the attestors behind Ethereum have staked, and how much of it this desk has drawn on. */
  backing: { attestors: number; minBond: bigint; cap: bigint; outstanding: bigint };
  float: bigint;
  spans: Map<number, Span[]>;
};

export type Verdict = { policy: Policy; ok: boolean; reason: string; offer: Offer | null };

/** The plain-English half of a refusal. The enum name is kept beside it; neither replaces the other. */
export const WHY: Record<string, string> = {
  None: 'Pays. Nothing on the board disqualifies this address under these terms.',
  NoSuchPolicy: 'No such instrument.',
  ArchiveTooShallow:
    'Refuses. The archive cannot show it holds every height these terms look back over, so there is nowhere a contradicting transaction could be hiding that anyone has ruled out. An answer drawn from history nobody holds is not an answer.',
  ClaimUnderHunt: 'Refuses. Somebody has money on the line challenging a statement about this address right now. The desk does not lend into a fight.',
  ProvenLiar:
    'Refuses. Somebody swore this address was clean, staked money on it, and lost: a real transaction inside the window was produced and checked against the archive. This one is arithmetic, not opinion.',
  NoBondedCleanliness:
    'Refuses. These terms need somebody to have staked a bond on this address covering the whole window, survived the challenge period, and put more beyond recovery than the loan is worth. Nobody has.',
  DeskOutOfFunds: 'Refuses. The desk does not hold this much.',
  EventOnRecord:
    'Refuses. A standing claim lists this exact event against this address inside the window, and every listed event was checked against the archive when it was filed.',
  AlreadyLent: 'Refuses. This address has already borrowed once under these terms, and there is no repayment path. A lender without one that lends twice is a faucet.',
  NeedsBondedCover:
    'Answers, and will not lend. Nothing disqualifies this address — and nothing stands behind it either. Silence is not collateral, so these terms answer the question and stop there.',
  PoolCapReached:
    'Refuses. The desk has already lent as much as the attestors behind this source chain have bonded. Every fact underwritten here rests on them, so the money at risk is held to what they have at stake.',
  UnprovenSubject:
    'Refuses. These terms only answer about Ethereum addresses somebody has proven they control, by signing an Ethereum transaction that names their Creditcoin address. Nobody has signed for this one. A fresh wallet with a true-of-everyone claim about itself is exactly what this refusal exists for.',
};

/** Short label for a policy, from the venue table rather than from the policy id. */
export function policyName(p: Policy): { venue: string; event: string } {
  for (const v of VENUES) {
    if (v.address.toLowerCase() !== p.venue.toLowerCase()) continue;
    const e = v.events.find((x) => x.topic0 === p.topic0);
    if (e) return { venue: v.label, event: e.label };
  }
  return { venue: `${p.venue.slice(0, 6)}…${p.venue.slice(-4)}`, event: `${p.topic0.slice(0, 10)}…` };
}

export const days = (blocks: number) => Math.round((blocks * 12) / 86_400);

export async function readBook(): Promise<Book> {
  const desk = deskContract();
  const mirror = mirrorContract();
  const n = Number(await desk.policyCount());
  const policies: Policy[] = (await Promise.all(Array.from({ length: n }, (_, i) => desk.policyOf(i)))).map((p: any, id: number) => ({
    id,
    kind: Number(p.kind) as 0 | 1,
    chainKey: Number(p.chainKey),
    window: Number(p.window),
    maxStaleness: Number(p.maxStaleness),
    venue: p.venue,
    topic0: p.topic0,
    subjectTopic: Number(p.subjectTopic),
    minBond: BigInt(p.minBond),
    maxPrincipal: BigInt(p.maxPrincipal),
    requiresBinding: Boolean(p.requiresBinding),
  }));

  const spans = new Map<number, Span[]>();
  for (const chainKey of new Set(policies.map((p) => p.chainKey))) spans.set(chainKey, await sealedSpans(mirror, chainKey));
  const offers = new Map<number, Offer | null>();
  for (const p of policies) offers.set(p.id, spanOffer(spans.get(p.chainKey) ?? [], p.window));

  const [head, lowest, held, budget, outstanding, float] = await Promise.all([
    mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET),
    mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET),
    mirror.mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
    desk.securityBudget(CHAIN_KEY_ETH_MAINNET),
    desk.totalOutstanding(),
    (desk.runner as any).provider.getBalance(await desk.getAddress()),
  ]);

  return {
    policies,
    offers,
    spans,
    head: Number(head),
    lowest: Number(lowest),
    held: Number(held),
    float: BigInt(float),
    backing: { attestors: Number(budget[0]), minBond: BigInt(budget[1]), cap: BigInt(budget[2]), outstanding: BigInt(outstanding) },
  };
}

/** Every policy's answer about one address, at one principal. */
export async function assessAll(book: Book, subject: string, principal: bigint): Promise<Verdict[]> {
  const desk = deskContract();
  return Promise.all(
    book.policies.map(async (policy) => {
      const offer = book.offers.get(policy.id) ?? null;
      const [ok, reason] = await desk.assess(subject, policy.id, principal, offer?.ids ?? []);
      return { policy, ok: Boolean(ok), reason: REFUSAL[Number(reason)] ?? String(reason), offer };
    }),
  );
}

export type FileRow = { id: number; status: number; kind: number; spanFrom: number; spanTo: number; bond: bigint; venue: string; topic0: string; subjectTopic: number; chainKey: number };

/**
 * Everything the board has ever said about one address, read through the registry's own per-key index
 * -- a handful of calls however many claims exist, because nobody can bury a file under volume.
 */
export async function filesOn(subject: string, policies: Policy[]): Promise<FileRow[]> {
  const reg = registryContract();
  const wanted = '0x' + subject.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const keys = new Map<string, [number, string, string, number]>();
  for (const chainKey of [CHAIN_KEY_ETH_MAINNET, 1]) {
    for (const v of VENUES) for (const e of v.events) keys.set(`${chainKey}|${v.address}|${e.topic0}|${e.subjectTopic}`, [chainKey, v.address, e.topic0, e.subjectTopic]);
  }
  for (const p of policies) keys.set(`${p.chainKey}|${p.venue}|${p.topic0}|${p.subjectTopic}`, [p.chainKey, p.venue, p.topic0, p.subjectTopic]);

  const ids = new Set<number>();
  await Promise.all(
    [...keys.values()].map(async ([chainKey, venue, topic0, slot]) => {
      const key = await reg.keyOf(chainKey, venue, topic0, slot, wanted);
      const rec = await reg.recordOf(key);
      const under = await Promise.all(Array.from({ length: Number(rec.total) }, (_, i) => reg.claimUnderKey(key, i)));
      for (const id of under) ids.add(Number(id));
    }),
  );

  const rows = await Promise.all(
    [...ids].sort((a, b) => a - b).map(async (id) => {
      const c: any = await reg.claimOf(id);
      return {
        id,
        status: Number(c.status),
        kind: Number(c.kind),
        chainKey: Number(c.chainKey),
        venue: c.venue,
        topic0: c.topic0,
        subjectTopic: Number(c.subjectTopic),
        spanFrom: Number(c.spanFrom),
        spanTo: Number(c.spanTo),
        bond: BigInt(c.bondStaked),
      };
    }),
  );
  return rows;
}
