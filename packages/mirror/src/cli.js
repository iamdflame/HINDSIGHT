#!/usr/bin/env node
/**
 * hindsight — ask whether an Ethereum transaction happened, from the command line.
 *
 *   npx @hindsight/mirror verify 0x3a4b8bcf…              no key, no gas: a view call
 *   npx @hindsight/mirror verify 0x… --prover              take the path from Gluwa's prover instead
 *   npx @hindsight/mirror verify 0x… --chain 1             Sepolia
 *   npx @hindsight/mirror coverage [--chain 1]             what the archive currently holds
 *   npx @hindsight/mirror notarise 0x…                     needs PRIVATE_KEY; the one step that costs gas
 *
 * Cold, with no npm registry involved:
 *   npx github:iamdflame/HINDSIGHT verify 0x3a4b8bcf…
 */
import { verify, coverage, notarise } from './index.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv.find((a, i) => i > 0 && !a.startsWith('--'));
const flag = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const source = argv.includes('--prover') ? 'prover' : 'local';
const chainKey = Number(flag('--chain') ?? 3);

const HELP = `usage:
  hindsight verify <ethereum-tx-hash> [--prover] [--chain 3|1]
  hindsight coverage [--chain 3|1]
  hindsight notarise <ethereum-tx-hash>          (PRIVATE_KEY in the environment)

verify and coverage need no key, no gas and no wallet.`;

async function main() {
  switch (cmd) {
    case 'verify': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(arg ?? '')) throw new Error(HELP);
      const r = await verify(arg, { source, chainKey });
      if (!r.mirrored) {
        console.log(`not notarised — block ${r.blockNumber} is not in the archive yet`);
        console.log(`run: hindsight notarise ${arg}`);
        process.exit(2);
      }
      console.log(r.verified ? 'verified' : 'NOT VERIFIED');
      console.log('  chain     :', chainKey === 3 ? 'Ethereum mainnet' : 'Sepolia', `(chainKey ${chainKey})`);
      console.log('  block     :', r.blockNumber);
      console.log('  tx index  :', r.txIndex);
      console.log('  path      :', r.path?.length, 'siblings');
      console.log('  source    :', r.source === 'local' ? 'rebuilt locally (no prover)' : "Gluwa's prover");
      console.log('  precompile: not called');
      process.exit(r.verified ? 0 : 1);
    }
    case 'coverage': {
      const c = await coverage({ chainKey });
      console.log('chain        :', chainKey === 3 ? 'Ethereum mainnet' : 'Sepolia', `(chainKey ${chainKey})`);
      console.log('heights held :', c.heights.toLocaleString());
      console.log('range        :', c.lowest.toLocaleString(), '..', c.highest.toLocaleString());
      return;
    }
    case 'notarise': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(arg ?? '')) throw new Error(HELP);
      const key = process.env.PRIVATE_KEY;
      if (!key) throw new Error('set PRIVATE_KEY — notarising is the one step that costs gas');
      console.log('notarised in', await notarise(arg, key, { chainKey }));
      return;
    }
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
