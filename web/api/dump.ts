/**
 * GET /api/dump — the whole public state, as one JSON document, cached an hour.
 *
 * For anyone who would rather download than call: every policy as filed, every sealed span, every
 * claim with its status and the tCTC beyond recovery, the archive's shape including what is still
 * missing inside it, and the desk's verdict on every address the board has ever named. All of it is
 * read from the deployed contracts at one block, so the document is internally consistent and any
 * line in it can be re-checked against the chain at that block.
 */
import { parseEther } from 'ethers';
import { contracts, policies, offerFor, assessAll, archive, CORS } from './_desk.js';
import { manifest } from './_manifest.js';

export const config = { maxDuration: 60 };

const STATUS = ['None', 'Open', 'Refuted', 'Standing'];

export async function GET(): Promise<Response> {
  const { cc, desk, mirror, registry } = contracts();
  const block = await cc.getBlockNumber();
  const [ps, arch3, arch1, nSpans, nClaims, budget, outstanding] = await Promise.all([
    policies(desk),
    archive(mirror, 3),
    archive(mirror, 1),
    mirror.spanCount(),
    registry.claimCount(),
    desk.securityBudget(3),
    desk.totalOutstanding(),
  ]);
  const spans = (await Promise.all(Array.from({ length: Number(nSpans) }, async (_, id) => ({ id, s: await mirror.spanOf(id) })))).map((x) => ({ id: x.id, chainKey: Number(x.s.chainKey), from: Number(x.s.fromBlock), to: Number(x.s.toBlock) }));
  const claims = await Promise.all(
    Array.from({ length: Number(nClaims) }, async (_, id) => {
      const [c, loss] = await Promise.all([registry.claimOf(id), registry.enforceableLoss(id)]);
      return { id, status: STATUS[Number(c.status)], kind: Number(c.kind) === 0 ? 'EmptySet' : 'CompleteSet', chainKey: Number(c.chainKey), venue: c.venue, topic0: c.topic0, subject: '0x' + String(c.subject).slice(26), subjectTopic: Number(c.subjectTopic), spanFrom: Number(c.spanFrom), spanTo: Number(c.spanTo), bondStaked: c.bondStaked.toString(), enforceableLoss: loss.toString(), openUntil: Number(c.openUntil), claimant: c.claimant, refuter: c.refuter, members: Number(c.members) };
    }),
  );
  const offers = Object.fromEntries(await Promise.all([...new Set(ps.map((p) => `${p.chainKey}:${p.window}`))].map(async (k) => [k, await offerFor(mirror, Number(k.split(':')[0]), Number(k.split(':')[1]))])));

  // The desk on every address the board has named. Deduplicated; the board is small.
  const subjects = [...new Set(claims.map((c) => c.subject.toLowerCase()))];
  const verdicts = await Promise.all(
    subjects.map(async (s) => ({ subject: s, verdicts: (await assessAll(desk, mirror, s, parseEther('1'))).map((v) => ({ policy: v.policy.id, pays: v.ok, reason: v.reason })) })),
  );

  const body = {
    at: new Date().toISOString(),
    creditcoinBlock: block,
    contracts: Object.fromEntries(Object.entries(manifest.contracts).map(([k, v]) => [k, v.address])),
    archive: { mainnet: arch3, sepolia: arch1 },
    spans,
    policies: ps,
    windows: offers,
    desk: { securityBudget: { attestors: Number(budget[0]), minBondWei: budget[1].toString(), capWei: budget[2].toString() }, outstandingWei: outstanding.toString() },
    claims,
    verdicts,
    gates: `${manifest.site}/api/gates`,
    note: 'Every field is a view on the contracts above at creditcoinBlock. Nothing is minted, nothing is transferable, and there is no number.',
  };
  return Response.json(body, { headers: { ...CORS, 'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' } });
}
