/**
 * Build the fixture corpus from real Ethereum mainnet history.
 *
 * Usage:
 *   node src/corpus.ts [--venue <key>] [--count 20] [--from <height>] [--to <height>]
 *   node src/corpus.ts --list
 *
 * Why a corpus at all
 * -------------------
 * The differential harness is the strongest evidence this project has: it compares our Solidity
 * verification against the live block-prover precompile and asserts they accept exactly the same
 * things and fail the same way. That evidence is only as broad as its inputs. Run against two
 * hardcoded transactions it is a spot check; run across a folder of real liquidations, repayments
 * and absorbs it starts to be a machine.
 *
 * Every fixture here is a transaction that happened on Ethereum mainnet, found by scanning the
 * venue's logs. Nothing is synthesised, and nothing is authored by us -- which is the point, since
 * a corpus we could shape is a corpus that proves nothing.
 *
 * Fixtures are only harvested from blocks the archive already holds, because a proof against an
 * unmirrored height has nothing to be differentially compared to.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import {
  CC_RPC,
  ETH_RPC,
  MIRROR,
  MIRROR_ABI,
  CHAIN_KEY_ETH_MAINNET,
  VENUES,
  venueByKey,
  fetchProof,
  getLogsChunked,
  type Venue,
} from './config.ts';

const FIXTURES = new URL('../../contracts/test/fixtures/mainnet/', import.meta.url);

type Args = { venue?: string; count: number; from?: number; to?: number; list: boolean };

function parseArgs(argv: string[]): Args {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    venue: get('--venue'),
    count: Number(get('--count') ?? 20),
    from: get('--from') ? Number(get('--from')) : undefined,
    to: get('--to') ? Number(get('--to')) : undefined,
    list: argv.includes('--list'),
  };
}

async function harvest(v: Venue, count: number, from: number, to: number) {
  const eth = new JsonRpcProvider(ETH_RPC);
  const dir = new URL(`${v.key}/`, FIXTURES);
  mkdirSync(dir, { recursive: true });

  const already = new Set(
    existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, '').toLowerCase()) : [],
  );

  console.log(`\n${v.label}`);
  console.log(`  scanning ${from.toLocaleString()}..${to.toLocaleString()} for ${v.event}`);

  const logs = await getLogsChunked(eth as any, { address: v.address, topics: [v.topic0] }, from, to);
  console.log(`  found ${logs.length} events`);
  if (logs.length === 0) return 0;

  let written = 0;
  const seen = new Set<string>();

  for (const log of logs) {
    if (written >= count) break;
    const txHash: string = log.transactionHash;
    if (seen.has(txHash)) continue; // one fixture per transaction, even if it emitted several
    seen.add(txHash);
    if (already.has(txHash.toLowerCase())) {
      written++;
      continue;
    }

    try {
      const p = await fetchProof(CHAIN_KEY_ETH_MAINNET, txHash);
      const subject =
        log.topics.length > v.subjectTopic ? '0x' + log.topics[v.subjectTopic].slice(-40) : null;

      const fixture = {
        chainKey: p.chainKey,
        headerNumber: p.headerNumber,
        txIndex: p.txIndex,
        txHash: p.txHash,
        txBytes: p.txBytes,
        root: p.merkleProof.root,
        siblingHashes: p.merkleProof.siblings.map((s: any) => s.hash),
        siblingIsLeft: p.merkleProof.siblings.map((s: any) => s.isLeft),
        lowerEndpointDigest: p.continuityProof.lowerEndpointDigest,
        continuityRoots: p.continuityProof.roots,
        // Provenance, so a reader can re-derive why this transaction is in the corpus at all.
        venue: { key: v.key, protocol: v.protocol, address: v.address, event: v.event, topic0: v.topic0 },
        subject,
        subjectTopic: v.subjectTopic,
      };

      writeFileSync(new URL(`${txHash}.json`, dir), JSON.stringify(fixture, null, 1));
      written++;
      console.log(
        `  + ${txHash.slice(0, 12)}… block ${p.headerNumber} index ${p.txIndex} ` +
          `${String(p.continuityProof.roots.length).padStart(4)} roots` +
          (subject ? `  ${v.subjectName} ${subject.slice(0, 10)}…` : ''),
      );
    } catch (e) {
      console.log(`  ! ${txHash.slice(0, 12)}…: ${(e as Error).message.slice(0, 90)}`);
    }
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    for (const v of VENUES) console.log(`${v.key.padEnd(22)} ${v.label}`);
    return;
  }

  // Only harvest from history the archive actually holds; an unmirrored height cannot be part of
  // a differential comparison.
  const cc = new JsonRpcProvider(CC_RPC);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);
  const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
  const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));

  const from = Math.max(args.from ?? low, low);
  const to = Math.min(args.to ?? high, high);
  console.log(`archive holds ${low.toLocaleString()}..${high.toLocaleString()}`);
  if (to < from) throw new Error('requested range lies outside the archive');

  const venues = args.venue ? [venueByKey(args.venue)] : VENUES;
  let total = 0;
  for (const v of venues) total += await harvest(v, args.count, from, to);

  console.log(`\n  ${total} fixtures in the corpus for this run`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
