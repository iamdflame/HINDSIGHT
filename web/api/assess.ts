/**
 * GET /api/assess?subject=0x…[&principal=1]
 *
 * The desk's answer about an address, as JSON, for anything that cannot run a browser: a bot, an
 * agent, a spreadsheet, a curl. It is a `view` on the deployed lending contract -- the same `assess`
 * that `borrow` gates on, with the same arguments -- and it moves no money. Nothing is a score.
 *
 * Read-only, unauthenticated, rate-limited only by the CDN: the result for one address is cached for
 * sixty seconds. The window each verdict was priced against is returned with it, so a caller who wants
 * to re-run the call on chain has everything they need.
 */
import { parseEther } from 'ethers';
import { contracts, checksummed, assessAll, filesOn, policies, archive, CORS } from './_desk.js';
import { manifest } from './_manifest.js';

export const config = { maxDuration: 30 };

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const subject = checksummed(url.searchParams.get('subject') ?? url.searchParams.get('q'));
  if (!subject) return Response.json({ error: 'subject must be an Ethereum address: ?subject=0x… (40 hex characters)' }, { status: 400, headers: CORS });
  let principal: bigint;
  try {
    principal = parseEther(url.searchParams.get('principal') ?? '1');
  } catch {
    return Response.json({ error: 'principal must be a number of tCTC' }, { status: 400, headers: CORS });
  }

  const { cc, desk, mirror, registry } = contracts();
  const [block, ps, verdicts, arch] = await Promise.all([cc.getBlockNumber(), policies(desk), assessAll(desk, mirror, subject, principal), archive(mirror, 3)]);
  const files = await filesOn(registry, subject, ps);

  const headline = verdicts.find((v) => v.reason === 'ProvenLiar') ?? verdicts.find((v) => v.reason === 'EventOnRecord') ?? verdicts.find((v) => v.ok) ?? verdicts[0] ?? null;
  const body = {
    subject,
    principal: principal.toString(),
    creditcoinBlock: block,
    at: new Date().toISOString(),
    desk: manifest.contracts.UnderwritingDesk.address,
    verdict: headline ? { pays: headline.ok, reason: headline.reason, why: headline.why, policy: headline.policy.id } : null,
    verdicts: verdicts.map((v) => ({ policy: v.policy.id, kind: v.policy.kind, requiresBinding: v.policy.requiresBinding, venue: v.policy.venue, topic0: v.policy.topic0, window: v.policy.window, pays: v.ok, reason: v.reason, why: v.why, provenBy: v.window })),
    files,
    archive: arch,
    certificate: `${manifest.site ?? 'https://hindsight.run'}/api/certificate?subject=${subject}`,
    note: 'Nothing is minted, nothing is transferable, and there is no number. Re-run on chain: UnderwritingDesk.assess(subject, policy, principal, provenBy.spanIds).',
  };
  return Response.json(body, { headers: { ...CORS, 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' } });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
