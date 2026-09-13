/**
 * How long a continuity proof is, by the age of the block asked about -- measured against the live
 * prover, written to deployments.json under measured.continuityByAge.
 *
 * Usage: node src/continuity-by-age.ts [--write]
 *
 * For each age, the first transaction of the block at (attested head - age) is asked for with the
 * ordinary single-transaction endpoint every Attestcoin integration uses, and the number of roots in
 * the continuity proof it returns is recorded. A failure is recorded as a failure, not skipped.
 */
import { JsonRpcProvider } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, CHAINS, fetchProof } from './config.ts';

const AGES: [string, number][] = [
  ['fresh (head − 50)', 50],
  ['24 hours', 7_200],
  ['7 days', 50_400],
  ['30 days', 216_000],
  ['90 days', 648_000],
  ['180 days', 1_296_000],
];

async function main() {
  const cc = new JsonRpcProvider(CC_RPC);
  const eth = new JsonRpcProvider(CHAINS[3].ethRpcs[0], undefined, { staticNetwork: true });
  const info = new (await import('ethers')).Contract('0x0000000000000000000000000000000000000FD3', ['function get_latest_attestation_height_and_hash(uint64) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists))'], cc);
  const head = Number((await info.get_latest_attestation_height_and_hash(3)).height);
  const rows: any[] = [];
  for (const [label, age] of AGES) {
    let h = head - age;
    let tx: string | undefined;
    for (let k = 0; k < 20 && !tx; k++, h++) {
      const b = await eth.getBlock(h);
      tx = b?.transactions[0];
    }
    try {
      const p = await fetchProof(3, tx!);
      const roots = p.continuityProof?.roots?.length ?? p.continuityRoots?.length;
      rows.push({ label, age, block: h - 1, tx, roots });
      console.log(`  ${label.padEnd(20)} block ${h - 1}  ${roots} continuity roots`);
    } catch (e) {
      rows.push({ label, age, block: h - 1, tx, error: String((e as Error).message).slice(0, 80) });
      console.log(`  ${label.padEnd(20)} block ${h - 1}  prover refused: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  if (process.argv.includes('--write')) {
    const url = new URL('../../deployments.json', import.meta.url);
    const d = JSON.parse(readFileSync(url, 'utf8'));
    d.measured.continuityByAge = { at: new Date().toISOString(), attestedHead: head, rows };
    writeFileSync(url, JSON.stringify(d, null, 2) + '\n');
    console.log('  written');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
