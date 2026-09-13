#!/usr/bin/env node
/**
 * hindsight-run-mcp — the desk, the archive and the hunt, as tools an agent can call.
 *
 *   npx hindsight-run-mcp                      stdio transport; add to any MCP client's config
 *
 * Every tool but `hunt_refute` is a view on the deployed contracts: no key, no gas, no wallet, and
 * nothing an agent can be talked into spending. `hunt_refute` signs two transactions and only exists
 * when HINDSIGHT_KEY is set in the environment; without it the tool is not registered at all, so a
 * client cannot even see a way to spend money.
 *
 * What comes back is what the chain says, with the enum name beside the plain-language reason, and
 * never a number that could be mistaken for a score. Nothing is minted, nothing is transferable.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { assess, verify, checks, claims, usable, refute, coverage, spanOffer, bindingCalldata, subjectFor, DESK_ADDRESS, REGISTRY_ADDRESS, MIRROR_ADDRESS } from 'hindsight-mirror';
import { formatEther, parseEther } from 'ethers';

const WHY = {
  None: 'Pays. Nothing on the board disqualifies this address under these terms.',
  NoSuchPolicy: 'No such instrument.',
  ArchiveTooShallow: 'Refuses: the archive cannot show it holds every height these terms look back over.',
  ClaimUnderHunt: 'Refuses: an open claim about this address is being hunted right now.',
  ProvenLiar: 'Refuses: a bonded claim that this address was clean was refuted by a real transaction inside the window, checked against the archive.',
  NoBondedCleanliness: 'Refuses: no standing bond covers the whole window with more beyond recovery than the loan.',
  DeskOutOfFunds: 'Refuses: the desk does not hold this much.',
  EventOnRecord: 'Refuses: a standing claim lists this exact event against this address inside the window.',
  AlreadyLent: 'Refuses: already lent to this address under these terms; there is no repayment path.',
  NeedsBondedCover: 'Answers, and will not lend: nothing disqualifies this address and nothing stands behind it. Silence is not collateral.',
  PoolCapReached: 'Refuses: the desk has lent as much as the attestors behind the source chain have bonded.',
  UnprovenSubject: 'Refuses: these terms only answer about Ethereum addresses somebody has proven control of, and nobody has signed for this one.',
};

const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.shortMessage ?? e?.message ?? e) }] });

const server = new McpServer({ name: 'hindsight', version: '0.1.0' });

server.tool(
  'mandate_assess',
  'Would the desk lend to this Ethereum address? A view on the deployed lending contract — the same function that decides whether money moves. Returns every instrument\'s verdict with the refusal enum and a plain-language reason. Not a score: there is no number.',
  { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), principal_tctc: z.string().default('1').describe('amount asked for, in tCTC; "0" asks only what the file says') },
  async ({ address, principal_tctc }) => {
    try {
      const r = await assess(address, parseEther(principal_tctc));
      const headline = r.verdicts.find((v) => v.reason === 'ProvenLiar') ?? r.verdicts.find((v) => v.reason === 'EventOnRecord') ?? r.verdicts.find((v) => v.pays) ?? r.verdicts[0] ?? null;
      return json({
        subject: r.subject,
        principal_tctc,
        verdict: headline ? { pays: headline.pays, reason: headline.reason, why: WHY[headline.reason] ?? '', instrument: headline.policy.id } : null,
        instruments: r.verdicts.map((v) => ({
          id: v.policy.id,
          terms: v.policy.kind === 'BlankFile' ? 'silence accepted' : v.policy.requiresBinding ? 'bond and proven owner required' : 'bond required',
          looks_back_days: Math.round((v.policy.window * 12) / 86_400),
          venue: v.policy.venue,
          pays: v.pays,
          reason: v.reason,
          why: WHY[v.reason] ?? '',
          priced_against: v.window,
        })),
        desk: DESK_ADDRESS,
        re_run_on_chain: `UnderwritingDesk.assess(subject, instrument, principalWei, priced_against.spanIds) at ${DESK_ADDRESS} on Creditcoin 102031`,
        certificate: `https://hindsight.run/api/certificate?subject=${r.subject}`,
        note: 'Nothing is minted, nothing is transferable, and there is no number.',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'hindsight_verify',
  'Did this Ethereum transaction happen? Rebuilds its Merkle path from a public Ethereum node and checks it against the root Creditcoin holds — no prover, no precompile. Returns mirrored/verified and the path.',
  { tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), chain_key: z.number().int().default(3).describe('3 = Ethereum mainnet, 1 = Sepolia') },
  async ({ tx_hash, chain_key }) => {
    try {
      const r = await verify(tx_hash, { chainKey: chain_key });
      return json({ ...r, mirror: MIRROR_ADDRESS, meaning: r.mirrored ? (r.verified ? 'The transaction is in a block whose root Creditcoin holds; this is a cryptographic inclusion fact.' : 'The block is held and this transaction is NOT in it as given.') : 'The block is not held yet: nothing is asserted either way.' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'hindsight_checks',
  'The five things to check before acting on an inclusion proof (receipt status, confirmation depth, block age, archive stall, and a replay key to record), each answered with its number. Decides nothing for you.',
  { tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), chain_key: z.number().int().default(3), min_depth: z.number().int().default(64), max_age_seconds: z.number().int().default(90 * 86_400), max_lag: z.number().int().default(1000) },
  async ({ tx_hash, chain_key, min_depth, max_age_seconds, max_lag }) => {
    try {
      return json(await checks(tx_hash, { chainKey: chain_key, minDepth: min_depth, maxAgeSeconds: max_age_seconds, maxLag: max_lag }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'hunt_list',
  'Open bounties: false statements somebody staked money on, waiting to be refuted. Each pays half its bond to whoever produces the contradicting transaction; the other half burns.',
  {},
  async () => {
    try {
      const all = await claims();
      const open = all.filter((c) => c.status === 'Open');
      return json({
        open: open.map((c) => ({
          claim_id: c.id,
          says: `${c.kind === 'EmptySet' ? 'no' : 'exactly these'} events with topic0 ${c.topic0} at ${c.venue} about 0x${c.subject.slice(26)} in Ethereum blocks ${c.spanFrom}–${c.spanTo}`,
          pays_tctc: formatEther(c.bondStaked / 2n),
          burns_tctc: formatEther(c.bondStaked - c.bondStaked / 2n),
          open_until: new Date(c.openUntil * 1000).toISOString(),
          how: 'find a transaction in that range emitting that event about that address; call hindsight_verify on it; then hunt_refute (needs HINDSIGHT_KEY) or the registry\'s commit–reveal',
        })),
        total_claims: all.length,
        registry: REGISTRY_ADDRESS,
        board: 'https://hindsight.run/hunt/',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'claim_usable',
  'Can a standing claim carry this much reliance? Standing, and the half of its bond a liar could not recover is at least the exposure. Size reliance against that number, never the headline bond.',
  { claim_id: z.number().int().nonnegative(), exposure_tctc: z.string().default('1') },
  async ({ claim_id, exposure_tctc }) => {
    try {
      return json(await usable(claim_id, parseEther(exposure_tctc)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'archive_coverage',
  'How much Ethereum history Creditcoin currently holds through Hindsight, and the sealed window a ninety-day question can be priced against right now.',
  { chain_key: z.number().int().default(3) },
  async ({ chain_key }) => {
    try {
      const [c, offer] = await Promise.all([coverage({ chainKey: chain_key }), spanOffer(648_000, { chainKey: chain_key })]);
      return json({ ...c, days: Math.round((c.heights * 12) / 86_400), ninety_day_window: offer });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'binding_calldata',
  'The 32 bytes an Ethereum address must sign (as the data of any transaction, e.g. a zero-value self-send) to prove that a Creditcoin address speaks for it. Nothing is sent by this tool.',
  { creditcoin_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  async ({ creditcoin_address }) => {
    try {
      return json({ calldata: await bindingCalldata(creditcoin_address), then: 'once the archive holds that block: hindsight-mirror bind submit <tx hash>', currently_speaks_for: await subjectFor(creditcoin_address) });
    } catch (e) {
      return fail(e);
    }
  },
);

// The one tool that spends. Not registered unless a key is present, so a client without one cannot
// even see a way to sign; and a client with one is trusted by whoever set the variable.
if (process.env.HINDSIGHT_KEY) {
  server.tool(
    'hunt_refute',
    'Refute an open claim with a contradicting Ethereum transaction: commit, wait a block, reveal. Half the bond to the signer, half burned. SPENDS GAS from HINDSIGHT_KEY, twice.',
    { claim_id: z.number().int().nonnegative(), counterexample_tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), chain_key: z.number().int().default(3) },
    async ({ claim_id, counterexample_tx_hash, chain_key }) => {
      try {
        return json(await refute(claim_id, counterexample_tx_hash, process.env.HINDSIGHT_KEY, { chainKey: chain_key }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
