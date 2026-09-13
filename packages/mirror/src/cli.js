#!/usr/bin/env node
/**
 * hindsight — ask whether an Ethereum transaction happened, from the command line.
 *
 *   npx hindsight-mirror verify 0x3a4b8bcf…              no key, no gas: a view call
 *   npx hindsight-mirror verify 0x… --prover              take the path from Gluwa's prover instead
 *   npx hindsight-mirror verify 0x… --chain 1             Sepolia
 *   npx hindsight-mirror coverage [--chain 1]             what the archive currently holds
 *   npx hindsight-mirror notarise 0x…                     needs PRIVATE_KEY; the one step that costs gas
 *   npx hindsight-mirror mandate assess 0x<address> [--principal 1]   the desk's verdict, every instrument
 *   npx hindsight-mirror checks 0x<tx>                    Dokett's five: status, depth, clock, stall, replay
 *   npx hindsight-mirror usable <claimId> [--exposure 1]  can a standing claim carry this much reliance
 *   npx hindsight-mirror hunt                             open bounties, with what each pays
 *   npx hindsight-mirror bind calldata 0x<cc address>     the 32 bytes to sign from Ethereum
 *   npx hindsight-mirror bind submit 0x<tx>               prove it on Creditcoin (PRIVATE_KEY, gas)
 *
 * Cold, with no npm registry involved:
 *   npx github:iamdflame/HINDSIGHT verify 0x3a4b8bcf…
 */
import { verify, coverage, notarise, assess, checks, usable, claims, bindingCalldata, bind, REFUSAL } from './index.js';
import { parseEther, formatEther } from 'ethers';

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
  hindsight mandate assess <address> [--principal 1]
  hindsight checks <ethereum-tx-hash>
  hindsight usable <claimId> [--exposure 1]
  hindsight hunt
  hindsight bind calldata <creditcoin-address>
  hindsight bind submit <ethereum-tx-hash>       (PRIVATE_KEY in the environment)

Everything but notarise and bind submit is a view: no key, no gas, no wallet.`;

const WHY = {
  None: 'pays',
  ArchiveTooShallow: 'the archive cannot prove it holds the window',
  ClaimUnderHunt: 'an open claim about this address is being hunted',
  ProvenLiar: 'a bonded claim of cleanliness was refuted inside the window',
  NoBondedCleanliness: 'no standing bond covers the window and the principal',
  DeskOutOfFunds: 'the desk does not hold this much',
  EventOnRecord: 'a standing claim lists this event inside the window',
  AlreadyLent: 'already lent to under these terms',
  NeedsBondedCover: 'answers, and will not lend on silence',
  PoolCapReached: 'the desk has lent what the attestors have bonded',
  UnprovenSubject: 'nobody has proven control of this address on Ethereum',
};

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
    case 'mandate': {
      const sub = argv[1];
      const who = argv[2];
      if (sub !== 'assess' || !/^0x[0-9a-fA-F]{40}$/.test(who ?? '')) throw new Error(HELP);
      const principal = parseEther(flag('--principal') ?? '1');
      const r = await assess(who, principal, { chainKey });
      const headline = r.verdicts.find((v) => v.reason === 'ProvenLiar') ?? r.verdicts.find((v) => v.reason === 'EventOnRecord') ?? r.verdicts.find((v) => v.pays) ?? r.verdicts[0];
      console.log(headline?.pays ? 'PAYS' : 'REFUSES', headline ? `— ${headline.reason}: ${WHY[headline.reason] ?? ''}` : '— no instruments');
      console.log('  subject   :', r.subject);
      console.log('  principal :', formatEther(principal), 'tCTC');
      for (const v of r.verdicts) {
        const terms = v.policy.kind === 'BlankFile' ? 'silence accepted   ' : v.policy.requiresBinding ? 'bond + proven owner' : 'bond required      ';
        console.log(`  #${v.policy.id} ${v.pays ? 'pays   ' : 'refuses'} ${v.reason.padEnd(20)} ${terms} ${Math.round((v.policy.window * 12) / 86_400)} d  ${v.window ? `spans ${v.window.spanIds.join(',')} to ${v.window.to}` : 'no sealed window'}`);
      }
      console.log('  nothing is minted, nothing is transferable, and there is no number.');
      process.exit(headline?.pays ? 0 : 1);
    }
    case 'checks': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(arg ?? '')) throw new Error(HELP);
      const k = await checks(arg, { chainKey });
      console.log(k.pass ? 'PASS' : 'FAIL', `— block ${k.blockNumber}, tx index ${k.txIndex ?? '?'}, ${k.mirrored ? (k.verified ? 'verified' : 'NOT VERIFIED') : 'not held'}`);
      for (const name of ['status', 'depth', 'clock', 'stall']) console.log(`  ${name.padEnd(7)} ${k[name].pass ? 'ok  ' : 'FAIL'} ${String(k[name].value).padStart(8)}   ${k[name].rule}`);
      console.log(`  replay  key    ${k.replay.key}   ${k.replay.rule}`);
      process.exit(k.pass ? 0 : 1);
    }
    case 'usable': {
      if (!/^\d+$/.test(arg ?? '')) throw new Error(HELP);
      const u = await usable(Number(arg), parseEther(flag('--exposure') ?? '1'));
      console.log(u.usable ? 'USABLE' : 'NOT USABLE', `— claim #${u.claimId} is ${u.status}, ${formatEther(u.enforceableLoss)} tCTC beyond recovery`);
      console.log('  kind      :', u.kind, '·', u.spanFrom.toLocaleString(), '..', u.spanTo.toLocaleString());
      console.log('  subject   :', u.subject);
      process.exit(u.usable ? 0 : 1);
    }
    case 'hunt': {
      const all = await claims();
      const open = all.filter((c) => c.status === 'Open');
      console.log(`${open.length} open of ${all.length} claims`);
      for (const c of open) console.log(`  #${String(c.id).padStart(3)}  ${c.kind === 'EmptySet' ? 'no' : 'all'} events at ${c.venue.slice(0, 10)}… about 0x${c.subject.slice(26)}  ${c.spanFrom}..${c.spanTo}  pays ${formatEther(c.bondStaked / 2n)} tCTC  until ${new Date(c.openUntil * 1000).toISOString().slice(0, 16)}Z`);
      console.log('  refute with: hindsight-mirror verify <counterexample tx> then the registry\'s commit–reveal (see packages/mirror/README.md)');
      return;
    }
    case 'bind': {
      const sub = argv[1];
      const what = argv[2];
      if (sub === 'calldata') {
        if (!/^0x[0-9a-fA-F]{40}$/.test(what ?? '')) throw new Error(HELP);
        console.log('sign any Ethereum transaction (a zero-value send to yourself will do) with this as its data:');
        console.log(' ', await bindingCalldata(what));
        console.log('then: hindsight bind submit <tx hash>   once the archive holds that block');
        return;
      }
      if (sub === 'submit') {
        if (!/^0x[0-9a-fA-F]{64}$/.test(what ?? '')) throw new Error(HELP);
        const key = process.env.PRIVATE_KEY;
        if (!key) throw new Error('set PRIVATE_KEY — submitting a binding costs gas');
        const b = await bind(what, key, { chainKey });
        console.log(`bound: ${b.controller} now speaks for ${b.subject} (Ethereum height ${b.height})  ${b.tx}`);
        return;
      }
      throw new Error(HELP);
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
