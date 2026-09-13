/**
 * Rebuild `docs/CAMPAIGN-<chain>.md` from the mirror's own events.
 *
 * Usage:
 *   node src/campaign-log.ts [--chain 3|1]
 *
 * The campaign workers append a row per call as they go, and that is useful while watching. It is not
 * the record. Three mainnet workers wrote concurrently, and an early version computed "newly added" as
 * `mirroredBlocks` after minus before -- which, with other workers writing in the same interval,
 * counted their additions too. The published log is therefore regenerated here from the chain:
 * every `BlocksMirrored` event (which carries the exact count that call added), its transaction, its
 * receipt's gas, and its sender. Nothing printed by a worker is trusted.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, MIRROR_ABI, EXPLORER, CHAINS } from './config.ts';

async function main() {
  const i = process.argv.indexOf('--chain');
  const chainKey = i >= 0 ? Number(process.argv[i + 1]) : 3;
  const cfg = CHAINS[chainKey];
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const cc = new JsonRpcProvider(CC_RPC);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);

  const head = await cc.getBlockNumber();
  const events: any[] = [];
  const STEP = 5_000;
  for (let from = d.deployBlock; from <= head; from += STEP) {
    const to = Math.min(from + STEP - 1, head);
    events.push(...(await mirror.queryFilter(mirror.filters.BlocksMirrored(chainKey), from, to)));
  }

  const rows: string[] = [];
  let held = 0;
  let totalGas = 0n;
  const senders = new Map<string, number>();
  let added = 0;
  for (const ev of events) {
    const [rc, blk, tx] = await Promise.all([ev.getTransactionReceipt(), ev.getBlock(), cc.getTransaction(ev.transactionHash)]);
    const n = Number(ev.args.newlyAdded);
    held += n;
    added += n;
    totalGas += rc.gasUsed;
    senders.set(tx!.from, (senders.get(tx!.from) ?? 0) + 1);
    const roots = Number(ev.args.toBlock) - Number(ev.args.fromBlock) + 1;
    rows.push(
      `| ${new Date(blk.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)} | ${ev.args.fromBlock} | ${ev.args.toBlock} | ` +
        `${roots} | ${n} | ${rc.gasUsed} | ${held} | \`${tx!.from.slice(0, 8)}…\` | [\`${ev.transactionHash.slice(0, 10)}…\`](${EXPLORER}/tx/${ev.transactionHash}) |`,
    );
  }

  const onChain = Number(await mirror.mirroredBlocks(chainKey));
  const lo = Number(await mirror.lowestMirrored(chainKey));
  const hi = Number(await mirror.highestMirrored(chainKey));
  const first = rows.length ? rows[0].split('|')[1].trim() : '—';
  const last = rows.length ? rows[rows.length - 1].split('|')[1].trim() : '—';

  const body = [
    `# Campaign log — ${cfg.name} (chainKey ${chainKey})`,
    '',
    `Regenerated from \`BlocksMirrored\` events on Mirror v2 \`${MIRROR}\` by \`worker/src/campaign-log.ts\`. Every row is`,
    'a transaction on Creditcoin; the "newly added" column is the count that call\'s own event reports.',
    '',
    '## Summary',
    '',
    '| | |',
    '|---|---|',
    `| Calls | **${rows.length}** |`,
    `| First / last call (UTC) | ${first} → ${last} |`,
    `| Heights retained (sum of events) | **${added.toLocaleString()}** |`,
    `| \`mirroredBlocks(${chainKey})\` on chain | **${onChain.toLocaleString()}** ${onChain === added ? '(agrees)' : '(DISAGREES)'} |`,
    `| Range | ${lo.toLocaleString()} – ${hi.toLocaleString()} (${(hi - lo + 1).toLocaleString()} blocks) |`,
    `| Total gas | ${totalGas.toLocaleString()} ≈ ${(Number(totalGas) * 0.5e-9).toFixed(2)} tCTC at 0.5 gwei |`,
    `| Mean gas per height | ${added ? Math.round(Number(totalGas) / added).toLocaleString() : '—'} |`,
    `| Workers (distinct senders) | ${senders.size}: ${[...senders.entries()].map(([a, c]) => `\`${a.slice(0, 8)}…\` ${c}`).join(', ')} |`,
    '',
    '## Every call',
    '',
    '| when (UTC) | from | to | roots | newly added | gas | cumulative | sender | tx |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');

  writeFileSync(new URL(`../../docs/CAMPAIGN-${cfg.slug}.md`, import.meta.url), body);
  console.log(`${cfg.name}: ${rows.length} calls, ${added.toLocaleString()} added, on-chain ${onChain.toLocaleString()} ${onChain === added ? 'agrees' : 'DISAGREES'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
