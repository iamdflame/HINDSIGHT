/**
 * The desk on the 90-day policies, on-chain: paid, refused, and why -- recorded as a transcript.
 *
 * Usage:
 *   node src/desk-demo.ts --phase refuse     before the borrower's own claim has stood
 *   node src/desk-demo.ts --phase lend       after it has (15 minutes later)
 *   node src/desk-demo.ts --phase assess     re-ask, without borrowing: verdicts move as the window does
 *   BORROWER_KEY=0x…  the wallet that borrows (its address is the subject of the `borrower` claim)
 *
 * WHAT THIS HAS TO PROVE, AND WHAT IT MUST NOT FAKE
 * -------------------------------------------------
 * `borrow()` underwrites `msg.sender` and takes no subject, so the only address this script can be
 * paid as is one whose key it holds. A refusal about a *real* liquidated Ethereum borrower is shown
 * through `assess(subject, …)`: a `view` over the identical predicate `borrow` gates on -- one
 * `_assess`, no second implementation -- which anyone can re-run against the deployed desk.
 *
 * The wallet this script borrows with is fresh: it has never touched Ethereum mainnet, so the clean
 * claim about it is trivially true. That is said plainly. What the payout demonstrates is the
 * BondedClean mechanism end to end -- a claim that covered the whole 90-day window, stood, and whose
 * unrecoverable half covers the principal -- not that anyone vetted a stranger.
 *
 * Every verdict is written to docs/transcripts/desk-v3.json with the claim that caused it.
 */
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { CC_RPC, EXPLORER } from './config.ts';

const DESK_ABI = [
  'function assess(address subject, uint256 policyId, uint256 principal) view returns (bool ok, uint8 reason)',
  'function borrow(uint256 policyId, uint256 principal)',
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal))',
  'error Rejected(uint8 reason)',
];
const REGISTRY_ABI = [
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function finalize(uint256)',
];
const REFUSAL = ['None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness', 'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent'];
const STATUS = ['None', 'Open', 'Refuted', 'Standing'];
const TRANSCRIPT = new URL('../../docs/transcripts/desk-v3.json', import.meta.url);

async function main() {
  const phase = process.argv[process.argv.indexOf('--phase') + 1];
  if (phase !== 'refuse' && phase !== 'lend' && phase !== 'assess') throw new Error('--phase refuse|lend|assess');
  if (phase !== 'assess' && !process.env.BORROWER_KEY) throw new Error('BORROWER_KEY is required: the desk only ever pays the caller');

  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const board = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/board-v3-mainnet.json', import.meta.url), 'utf8'));
  if (board.registry.toLowerCase() !== d.contracts.AbsenceRegistryV3.toLowerCase()) throw new Error('board record is for another registry');

  const cc = new JsonRpcProvider(CC_RPC);
  const borrower = process.env.BORROWER_KEY ? new Wallet(process.env.BORROWER_KEY, cc) : Wallet.createRandom().connect(cc);
  const desk = new Contract(d.contracts.UnderwritingDesk, DESK_ABI, borrower);
  const registry = new Contract(d.contracts.AbsenceRegistryV3, REGISTRY_ABI, borrower);

  const transcript: any = existsSync(TRANSCRIPT) ? JSON.parse(readFileSync(TRANSCRIPT, 'utf8')) : { desk: d.contracts.UnderwritingDesk, registry: d.contracts.AbsenceRegistryV3, entries: [] };
  if (transcript.desk.toLowerCase() !== d.contracts.UnderwritingDesk.toLowerCase()) throw new Error('transcript is for another desk');
  const note = (e: any) => {
    transcript.entries.push({ at: new Date().toISOString(), ...e });
    mkdirSync(new URL('.', TRANSCRIPT), { recursive: true });
    writeFileSync(TRANSCRIPT, JSON.stringify(transcript, null, 1) + '\n');
  };

  const policies = await Promise.all(Array.from({ length: Number(await desk.policyCount()) }, (_, i) => desk.policyOf(i)));
  const blankAave = policies.findIndex((p: any) => Number(p.kind) === 0 && p.venue.toLowerCase() === '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' && Number(p.window) === 648_000);
  const bondedAave = policies.findIndex((p: any) => Number(p.kind) === 1 && p.venue.toLowerCase() === '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' && Number(p.window) === 648_000);
  const policyOfVenue = (venue: string) => policies.findIndex((p: any) => Number(p.kind) === 0 && p.venue.toLowerCase() === venue.toLowerCase() && Number(p.window) === 648_000);
  console.log('the desk —', d.contracts.UnderwritingDesk);
  console.log(`  policies: BlankFile·Aave #${blankAave}, BondedClean·Aave #${bondedAave}`);

  const MIRROR_ABI = ['function highestMirrored(uint64) view returns (uint64)'];
  const mirror = new Contract(d.contracts.EthereumMirror, MIRROR_ABI, cc);
  const assessRow = async (label: string, subject: string, policyId: number, principal: bigint, claim?: any) => {
    const [[ok, reason], head] = await Promise.all([desk.assess(subject, policyId, principal), mirror.highestMirrored(3)]);
    const why = REFUSAL[Number(reason)];
    const c = claim ? await registry.claimOf(claim.claimId) : null;
    // Where the evidence sits relative to the policy's floor: a liquidation older than the window is
    // history this policy does not look back over, and the verdict changes as the archive head moves.
    const floor = Number(head) - Number(policies[policyId].window);
    const evidenceBlock: number | undefined = claim?.counterexample?.block ?? claim?.omitted?.block ?? claim?.members?.at(-1)?.height;
    const position = evidenceBlock === undefined ? '' : evidenceBlock >= floor ? `evidence @${evidenceBlock} inside the window` : `evidence @${evidenceBlock} is ${floor - evidenceBlock} blocks below the 90-day floor`;
    console.log(`  ${ok ? 'PAYS   ' : 'REFUSES'} ${why.padEnd(20)} policy ${policyId}  ${subject}  ${label}${c ? `  (claim #${claim.claimId} ${STATUS[Number(c.status)]})` : ''}${position ? `  ${position}` : ''}`);
    note({ kind: 'assess', label, subject, policyId, principal: principal.toString(), ok: Boolean(ok), reason: why, claimId: claim?.claimId, claimStatus: c ? STATUS[Number(c.status)] : undefined, archiveHead: Number(head), policyFloor: floor, evidenceBlock, evidenceInWindow: evidenceBlock === undefined ? undefined : evidenceBlock >= floor });
    return why;
  };

  const role = (r: string) => board.claims.filter((c: any) => c.role === r);
  const mine = board.claims.find((c: any) => c.role === 'borrower' && (phase === 'assess' || c.subject.toLowerCase() === borrower.address.toLowerCase()));
  if (!mine) throw new Error(`no 'borrower' claim about ${borrower.address} in the board record`);

  // The same predicate, about addresses nobody here controls.
  for (const lie of role('lie')) await assessRow('liquidated; a claim said otherwise', lie.subject, policyOfVenue(lie.venue), parseEther('0.1'), lie);
  for (const c of [...role('omission'), ...role('complete')]) await assessRow('its liquidations are listed on the board', c.subject, policyOfVenue(c.venue), parseEther('0.1'), c);
  for (const c of role('clean').slice(0, 3)) {
    await assessRow('real Aave borrower, nothing against it', c.subject, blankAave, parseEther('0.1'), c);
    await assessRow('same borrower, bonded-clean policy (0.5 tCTC claim covers 0.25)', c.subject, bondedAave, parseEther('1'), c);
  }

  if (phase === 'assess') {
    await assessRow('our own wallet after its loans', mine.subject, bondedAave, parseEther('1'), mine);
    console.log(`\n  transcript: ${TRANSCRIPT.pathname}`);
    return;
  }

  const status = STATUS[Number((await registry.claimOf(mine.claimId)).status)];
  console.log(`\n  borrower ${borrower.address} — its own claim #${mine.claimId} is ${status}`);

  const send = async (label: string, policyId: number, principal: bigint) => {
    const before = await cc.getBalance(borrower.address);
    try {
      await desk.borrow.staticCall(policyId, principal);
    } catch (e: any) {
      const reason = e?.revert?.args?.[0] !== undefined ? REFUSAL[Number(e.revert.args[0])] : String(e?.shortMessage ?? e?.message).slice(0, 80);
      // Mine the refusal too: a reverted transaction on the explorer is a refusal anyone can inspect.
      const tx = await desk.borrow(policyId, principal, { gasLimit: 9_000_000 });
      const rc = await cc.waitForTransaction(tx.hash);
      console.log(`  REFUSED ON-CHAIN  ${reason}  policy ${policyId}  status ${rc?.status}  ${EXPLORER}/tx/${tx.hash}`);
      note({ kind: 'borrow', label, policyId, principal: principal.toString(), ok: false, reason, tx: tx.hash, txStatus: rc?.status });
      return;
    }
    const rc = await (await desk.borrow(policyId, principal)).wait();
    const after = await cc.getBalance(borrower.address);
    const received = after - before + BigInt(rc.gasUsed) * BigInt(rc.gasPrice);
    console.log(`  LENT  ${formatEther(received)} tCTC  policy ${policyId}  ${Number(rc.gasUsed).toLocaleString()} gas  ${EXPLORER}/tx/${rc.hash}`);
    note({ kind: 'borrow', label, policyId, principal: principal.toString(), ok: true, received: received.toString(), gasUsed: Number(rc.gasUsed), tx: rc.hash });
  };

  if (phase === 'refuse') {
    await send('own claim still open', bondedAave, parseEther('1'));
    return;
  }

  if (status === 'Open') {
    const c = await registry.claimOf(mine.claimId);
    if (Date.now() / 1000 <= Number(c.openUntil)) throw new Error(`claim #${mine.claimId} is open until ${new Date(Number(c.openUntil) * 1000).toISOString()}`);
    const rc = await (await registry.finalize(mine.claimId)).wait();
    console.log(`  finalised #${mine.claimId} → Standing  ${EXPLORER}/tx/${rc.hash}`);
    note({ kind: 'finalize', claimId: mine.claimId, tx: rc.hash });
  }
  await assessRow('our own wallet, bonded-clean over the whole window', borrower.address, bondedAave, parseEther('1'), mine);
  await send('bonded-clean: a standing 4 tCTC claim covering 91 days', bondedAave, parseEther('1'));
  await send('blank file', blankAave, parseEther('0.1'));
  await send('a second loan under the same policy', bondedAave, parseEther('1'));
  console.log(`\n  transcript: ${TRANSCRIPT.pathname}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
