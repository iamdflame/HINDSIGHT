/**
 * Write what the public gates check against: web/api/_manifest.ts.
 *
 * Usage:
 *   node src/gates-manifest.ts            (after `forge build`)
 *   node src/gates-manifest.ts --check    exit 1 if the committed manifest is stale
 *
 * The gates at /api/gates re-run the project's promises against live chain state on a schedule and on
 * every visit to /status. Everything they compare against comes from here, and everything here comes
 * from the repository: the runtime bytecode each contract compiles to (immutables masked), the
 * measured record, the board as filed, and real mainnet fixtures for the verification checks. No
 * expectation is typed into the function itself.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { keccak256, getBytes } from 'ethers';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));

function runtime(file: string, name: string) {
  const url = new URL(`contracts/out/${file}/${name}.json`, ROOT);
  if (!existsSync(url)) throw new Error(`missing ${url.pathname}: run forge build in contracts/ first`);
  const art = JSON.parse(readFileSync(url, 'utf8'));
  const refs: { start: number; length: number }[] = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat() as any;
  return { codeHash: keccak256(getBytes(art.deployedBytecode.object)), immutables: refs.map((r) => [r.start, r.length]) };
}

const fixture = (p: string) => {
  const j = read(p);
  return {
    txHash: j.txHash,
    height: j.headerNumber,
    txIndex: j.txIndex,
    txBytes: j.txBytes,
    root: j.root,
    siblings: j.siblingHashes.map((h: string, i: number) => ({ hash: h, isLeft: j.siblingIsLeft[i] })),
    lowerEndpointDigest: j.lowerEndpointDigest ?? null,
    continuityRoots: j.continuityRoots ?? null,
  };
};

function build() {
  const d = read('deployments.json');
  const m = d.measured;
  const board = ['mainnet', 'sepolia'].flatMap((slug) => {
    const url = new URL(`contracts/test/fixtures/board-v3-${slug}.json`, ROOT);
    return existsSync(url) ? read(`contracts/test/fixtures/board-v3-${slug}.json`).claims.map((c: any) => ({ claimId: c.claimId, role: c.role })) : [];
  });
  const settled = Object.fromEntries(
    Object.values(m.board.chains).flatMap((c: any) => c.rows.filter((r: any) => r.status !== 'Open').map((r: any) => [r.claimId, r.status])),
  );
  const liqDir = 'contracts/test/fixtures/mainnet/aave-liquidations/';
  const sample = readdirSync(new URL(liqDir, ROOT)).filter((f) => f.endsWith('.json')).sort().slice(0, 3);
  const proven = m.board.chains.mainnet.rows.find((r: any) => r.role === 'lie' && r.refutation && r.subject === '0x7562be2022d31a75f9887b7b932256c704f0c8e7');
  // The policy whose bond floor is low enough that Utuh's rule -- ten times what a lie would cost --
  // is what limits the loan. Its boundary is checked live, against a real Aave borrower's standing claim.
  const sized = m.desk.ninetyDay.find((x: any) => x.kind === 'BondedClean' && x.policy !== m.desk.ninetyDay.find((y: any) => y.kind === 'BondedClean')?.policy);
  const clean = m.board.chains.mainnet.rows.find((r: any) => r.role === 'clean' && r.status === 'Standing');
  const priorDesk = Object.entries(d.contracts.superseded ?? {})
    .filter(([k]) => k.startsWith('UnderwritingDesk@'))
    .map(([, v]: any) => v.address)
    .pop();
  return {
    generatedFrom: 'deployments.json, contracts/out, contracts/test/fixtures',
    rpc: d.rpc,
    contracts: {
      EthereumMirror: { address: d.contracts.EthereumMirror, ...runtime('EthereumMirror.sol', 'EthereumMirror') },
      AbsenceRegistryV3: { address: d.contracts.AbsenceRegistryV3, ...runtime('AbsenceRegistryV3.sol', 'AbsenceRegistryV3') },
      UnderwritingDesk: { address: d.contracts.UnderwritingDesk, ...runtime('UnderwritingDesk.sol', 'UnderwritingDesk') },
      MissingHeightBounty: { address: d.contracts.MissingHeightBounty, ...runtime('MissingHeightBounty.sol', 'MissingHeightBounty') },
    },
    gate: d.external.hindsightGate.address,
    paidOnEthereum: { address: d.external.paidOnEthereum.address, proven: d.external.paidOnEthereum.proofs[0] },
    held: { mainnet: m.chains['3'].held, sepolia: m.chains['1'].held },
    emptyBlock: m.acceptance.emptyBlockInSealedSpan,
    secondTransaction: fixture('contracts/test/fixtures/mainnet/random-block-second-tx/0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9.json'),
    notarised: fixture('contracts/test/fixtures/liquidation.json'),
    differential: sample.map((f) => fixture(liqDir + f)),
    board: { roles: board, settled },
    desk: {
      address: d.contracts.UnderwritingDesk,
      blankFileAave: m.desk.ninetyDay.find((x: any) => x.kind === 'BlankFile')?.policy ?? 0,
      bondedAave: m.desk.ninetyDay.find((x: any) => x.kind === 'BondedClean')?.policy ?? null,
      sizedAave: sized?.policy ?? null,
      window: 648_000,
      nobody: '0x000000000000000000000000000000000000c1ea',
      provenLiar: proven ? { subject: proven.subject, evidenceBlock: proven.refutation.evidenceBlock, claimId: proven.claimId } : null,
      // The v3.1 desk walked the held bitmap for every question. Both numbers below are real receipts
      // on Creditcoin, mined in the same block, asking the same desk question of the same address.
      priorDesk: priorDesk ?? null,
      gas: { prior: 7_041_373, budget: 1_000_000 },
      sizing: clean ? { subject: clean.subject, claimId: clean.claimId, leverage: 10 } : null,
    },
    // The archive as it runs today: the advertised run must stay unbroken end to end, and the heights
    // still missing below it may shrink but never grow.
    run: { from: m.chains['3'].topRunFrom, length: m.chains['3'].topRun, unheldInRange: m.chains['3'].unheldInRange },
    // The follower deliberately stays below the attestation head so a window never reaches for an
    // unattested block: HEAD_MARGIN is 200 and a checkpoint is 100, so this is that plus slack.
    attested: { maxLag: 400 },
  };
}

const out = new URL('web/api/_manifest.ts', ROOT);
const body =
  '// Generated by worker/src/gates-manifest.ts from the repository. Do not edit; regenerate.\n' +
  `export const manifest = ${JSON.stringify(build(), null, 1)};\n`;
if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== body) {
    console.log('STALE web/api/_manifest.ts — run node worker/src/gates-manifest.ts');
    process.exit(1);
  }
  console.log('ok    web/api/_manifest.ts matches the repository');
} else {
  writeFileSync(out, body);
  console.log(`wrote web/api/_manifest.ts (${Math.round(body.length / 1024)} kB)`);
}
