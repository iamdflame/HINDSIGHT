#!/usr/bin/env node
/**
 * hindsight — ask whether an Ethereum transaction happened, from the command line.
 *
 *   npx hindsight verify 0x3a4b8bcf…      no key, no gas: a view call
 *   npx hindsight verify 0x… --prover     take the path from Gluwa's prover instead of rebuilding
 *   npx hindsight coverage                what the archive currently holds
 *   npx hindsight notarise 0x…            needs PRIVATE_KEY; the one step that still costs gas
 */
import { verify, coverage, notarise } from './index.ts';

const [, , cmd, arg] = process.argv;
const source = process.argv.includes('--prover') ? 'prover' : 'local';

async function main() {
  switch (cmd) {
    case 'verify': {
      if (!arg) throw new Error('usage: hindsight verify <ethereum-tx-hash>');
      const r = await verify(arg, { source });
      if (!r.mirrored) {
        console.log(`not notarised — block ${r.blockNumber} is not in the archive yet`);
        console.log('run: hindsight notarise ' + arg);
        process.exit(2);
      }
      console.log(r.verified ? 'verified' : 'NOT VERIFIED');
      console.log('  block     :', r.blockNumber);
      console.log('  tx index  :', r.txIndex);
      console.log('  path      :', r.path?.length, 'siblings');
      console.log('  source    :', r.source === 'local' ? 'rebuilt locally (no prover)' : "Gluwa's prover");
      process.exit(r.verified ? 0 : 1);
      break;
    }
    case 'coverage': {
      const c = await coverage();
      console.log('heights held :', c.heights.toLocaleString());
      console.log('range        :', c.lowest.toLocaleString(), '..', c.highest.toLocaleString());
      break;
    }
    case 'notarise': {
      if (!arg) throw new Error('usage: hindsight notarise <ethereum-tx-hash>');
      const key = process.env.PRIVATE_KEY;
      if (!key) throw new Error('set PRIVATE_KEY — notarising is the one step that costs gas');
      console.log('notarised in', await notarise(arg, key));
      break;
    }
    default:
      console.log('usage: hindsight <verify|coverage|notarise> [tx-hash] [--prover]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
