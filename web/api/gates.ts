/**
 * The honesty machine, running where anyone can watch it: GET /api/gates.
 *
 * GitHub will not start this project's CI (the account is billing-locked), so the promises CI was meant
 * to hold are re-run here instead, against live Creditcoin state, by free schedulers (Vercel Cron daily; any
 * external scheduler holding CRON_SECRET) and by anyone who opens /status. Every expectation comes from
 * `_manifest.ts`, which `worker/src/gates-manifest.ts` writes from the repository; none is typed here.
 *
 * Read-only: no key, no transaction. A public request gets a result at most five minutes old from the
 * CDN; a request carrying the cron secret forces a fresh run. Any query string on a public request is
 * refused, so the cache cannot be bypassed to make this function do work on demand.
 *
 * 200 when every gate passes, 503 when any fails -- so a scheduler that only reads status codes still
 * raises the alarm.
 */
import { JsonRpcProvider, Contract, Interface, keccak256, getBytes, hexlify } from 'ethers';
import { manifest } from './_manifest.js';

export const config = { maxDuration: 60 };

type Gate = { id: string; title: string; pass: boolean; detail: string; ms: number };

const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';
const CHAIN_INFO = '0x0000000000000000000000000000000000000FD3';
const MIRROR_ABI = [
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function isMirrored(uint64, uint64) view returns (bool)',
  'function rootOf(uint64, uint64) view returns (bytes32)',
  'function contiguousFrom(uint64, uint64, uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function spanCovers(uint256, uint64, uint64) view returns (bool)',
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns ((uint64 chainKey, uint64 fromBlock, uint64 toBlock))',
  'function verifyOrRevert(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (uint64)',
  'function tryVerify(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (bool, uint64)',
];
const REGISTRY_ABI = ['function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))'];
const DESK_ABI = [
  'function assess(address, uint256, uint256, uint256[]) view returns (bool ok, uint8 reason)',
  'function securityBudget(uint64) view returns (uint32 attestors, uint128 minBond, uint256 cap)',
  'function totalOutstanding() view returns (uint256)',
];
const CHAIN_INFO_ABI = ['function get_latest_attestation_height_and_hash(uint64) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists) result)'];
const ENFORCEABLE_ABI = ['function enforceableLoss(uint256) view returns (uint256)'];
const REFUSAL = [
  'None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness',
  'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent', 'NeedsBondedCover', 'PoolCapReached', 'UnprovenSubject',
];
const STATUS = ['None', 'Open', 'Refuted', 'Standing'];
const PRECOMPILE_ABI = ['function verify(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) view returns (bool)'];

async function gate(id: string, title: string, run: () => Promise<{ pass: boolean; detail: string }>): Promise<Gate> {
  const t0 = Date.now();
  try {
    const r = await run();
    return { id, title, ...r, ms: Date.now() - t0 };
  } catch (e) {
    // A gate that cannot reach its answer has not passed. It is reported as a failure with the reason.
    return { id, title, pass: false, detail: `could not run: ${String((e as Error).message).slice(0, 160)}`, ms: Date.now() - t0 };
  }
}

async function runGates() {
  const cc = new JsonRpcProvider(manifest.rpc, 102031, { staticNetwork: true });
  const mirrorAddr = manifest.contracts.EthereumMirror.address;
  const mirror = new Contract(mirrorAddr, MIRROR_ABI, cc);
  const registry = new Contract(manifest.contracts.AbsenceRegistryV3.address, REGISTRY_ABI, cc);
  const desk = new Contract(manifest.contracts.UnderwritingDesk.address, DESK_ABI, cc);
  const iface = new Interface(MIRROR_ABI);
  const block = await cc.getBlockNumber();

  /**
   * The sealed spans a caller hands the desk to prove the policy's window. The desk re-checks
   * adjacency, chain, length and freshness itself -- offering them is a convenience, not a key -- so
   * this is exactly what any consumer would compute before calling `assess`.
   */
  const offerFor = async (chainKey: number, window: number) => {
    const n = Number(await mirror.spanCount());
    const spans = (await Promise.all(Array.from({ length: n }, async (_, i) => ({ id: i, s: await mirror.spanOf(i) }))))
      .filter((x) => Number(x.s.chainKey) === chainKey)
      .map((x) => ({ id: x.id, from: Number(x.s.fromBlock), to: Number(x.s.toBlock) }));
    let top = spans[0];
    for (const x of spans) if (!top || x.to > top.to || (x.to === top.to && x.from < top.from)) top = x;
    if (!top) return null;
    const ids = [top.id];
    let from = top.from;
    while (top.to - from < window && ids.length < 8) {
      const below = spans.find((x) => x.to + 1 === from && x.id !== top.id);
      if (!below) break;
      from = below.from;
      ids.unshift(below.id);
    }
    return top.to - from < window ? null : { ids, from, to: top.to };
  };
  const offer = await offerFor(3, manifest.desk.window);

  const call = async (to: string, data: string, override?: Record<string, { code: string }>) => {
    try {
      const out: string = await cc.send('eth_call', override ? [{ to, data }, 'latest', override] : [{ to, data }, 'latest']);
      return { ok: out !== '0x', out };
    } catch {
      return { ok: false, out: '0x' };
    }
  };
  const verifyData = (f: typeof manifest.secondTransaction, siblings = f.siblings) =>
    iface.encodeFunctionData('verifyOrRevert', [3, f.height, f.txBytes, siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft }))]);

  const gates = await Promise.all([
    gate('code', 'The code on chain is the code in this repository', async () => {
      const rows = await Promise.all(
        Object.entries(manifest.contracts).map(async ([name, c]) => {
          const code = getBytes(await cc.getCode(c.address));
          for (const [start, length] of c.immutables) code.fill(0, start, start + length);
          return { name, same: keccak256(code) === c.codeHash };
        }),
      );
      const bad = rows.filter((r) => !r.same).map((r) => r.name);
      return { pass: bad.length === 0, detail: bad.length ? `runtime bytecode differs: ${bad.join(', ')}` : `${rows.length} contracts: runtime bytecode identical to the compiled source, immutables masked` };
    }),

    gate('held', 'The archive never shrinks', async () => {
      const [m, s] = await Promise.all([mirror.mirroredBlocks(3), mirror.mirroredBlocks(1)]);
      const pass = Number(m) >= manifest.held.mainnet && Number(s) >= manifest.held.sepolia;
      return { pass, detail: `mainnet ${Number(m).toLocaleString('en-US')} held (recorded ${manifest.held.mainnet.toLocaleString('en-US')}), Sepolia ${Number(s).toLocaleString('en-US')} (recorded ${manifest.held.sepolia.toLocaleString('en-US')})` };
    }),

    gate('ninety-days', 'Every one of the last 648,000 mainnet heights is held', async () => {
      const head = Number(await mirror.highestMirrored(3));
      const run = Number(await mirror.contiguousFrom(3, head - 648_000, 648_001));
      return { pass: run === 648_001, detail: run === 648_001 ? `${(head - 648_000).toLocaleString('en-US')} – ${head.toLocaleString('en-US')}, no gap` : `first missing height ${(head - 648_000 + run).toLocaleString('en-US')}` };
    }),

    gate('thirty-days', 'Every one of the last 216,000 Sepolia heights is held', async () => {
      const head = Number(await mirror.highestMirrored(1));
      const run = Number(await mirror.contiguousFrom(1, head - 216_000, 216_001));
      return { pass: run === 216_001, detail: run === 216_001 ? `${(head - 216_000).toLocaleString('en-US')} – ${head.toLocaleString('en-US')}, no gap` : `first missing height ${(head - 216_000 + run).toLocaleString('en-US')}` };
    }),

    gate('empty-block', 'An empty Ethereum block is held, and a sealed span crosses it', async () => {
      const e = manifest.emptyBlock;
      const [held, root, covers] = await Promise.all([mirror.isMirrored(3, e.height), mirror.rootOf(3, e.height), mirror.spanCovers(e.spanId, 3, e.height)]);
      const pass = held === true && BigInt(root) === 0n && covers === true;
      return { pass, detail: `block ${e.height.toLocaleString('en-US')}: isMirrored ${held}, root zero ${BigInt(root) === 0n}, span ${e.spanId} covers it ${covers}` };
    }),

    gate('independence', 'A second transaction verifies with 0x0FD2 deleted, and the controls fail', async () => {
      const f = manifest.secondTransaction;
      const flipped = f.siblings.map((s, i) => (i === 0 ? { ...s, hash: hexlify(Uint8Array.from(getBytes(s.hash), (b, k) => (k === 31 ? b ^ 1 : b))) } : s));
      const [plain, killed, control, forged] = await Promise.all([
        call(mirrorAddr, verifyData(f)),
        call(mirrorAddr, verifyData(f), { [PRECOMPILE]: { code: '0x' } }),
        call(mirrorAddr, verifyData(f), { [mirrorAddr]: { code: '0x' } }),
        call(mirrorAddr, verifyData(f, flipped), { [PRECOMPILE]: { code: '0x' } }),
      ]);
      const idx = (r: { ok: boolean; out: string }) => (r.ok ? Number(BigInt(r.out)) : null);
      const pass = idx(plain) === f.txIndex && idx(killed) === f.txIndex && !control.ok && !forged.ok;
      return { pass, detail: `tx index ${f.txIndex} of block ${f.height.toLocaleString('en-US')} (notarised through index ${manifest.notarised.txIndex}): plain → ${idx(plain)}, precompile deleted → ${idx(killed)}, mirror deleted → ${control.ok ? 'answered' : 'refused'}, one sibling altered → ${forged.ok ? 'answered' : 'refused'}` };
    }),

    gate('stranger', 'A contract in another repository verifies without 0x0FD2', async () => {
      const f = manifest.notarised;
      const data = new Interface(['function happened(uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (uint64)']).encodeFunctionData('happened', [f.height, f.txBytes, f.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft }))]);
      const [plain, killed, control] = await Promise.all([call(manifest.gate, data), call(manifest.gate, data, { [PRECOMPILE]: { code: '0x' } }), call(manifest.gate, data, { [mirrorAddr]: { code: '0x' } })]);
      const idx = (r: { ok: boolean; out: string }) => (r.ok ? Number(BigInt(r.out)) : null);
      const pass = idx(plain) === f.txIndex && idx(killed) === f.txIndex && !control.ok;
      return { pass, detail: `Gate ${manifest.gate.slice(0, 6)}…${manifest.gate.slice(-4)} (same GitHub owner): plain → ${idx(plain)}, precompile deleted → ${idx(killed)}, mirror deleted → ${control.ok ? 'answered' : 'refused'}` };
    }),

    gate('second-consumer', 'A product in another repository proves a real payment without 0x0FD2', async () => {
      const p = manifest.paidOnEthereum;
      const f = manifest.secondTransaction;
      const c = new Contract(p.address, ['function paidAtLeast(address, address, address, uint256) view returns (bool)', 'function prove(uint64, bytes, (bytes32 hash, bool isLeft)[], uint32) returns (uint256)', 'error AlreadyCounted(uint64 height, uint64 txIndex, uint32 logIndex)'], cc);
      const paid: boolean = await c.paidAtLeast(p.proven.token, p.proven.from, p.proven.to, BigInt(p.proven.amount));
      // Re-submitting the proven transfer, simulated: it can only reach AlreadyCounted if the mirror verified
      // it first. With 0x0FD2 deleted it must still get there; with the mirror deleted it must not.
      const data = c.interface.encodeFunctionData('prove', [f.height, f.txBytes, f.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })), p.proven.logIndex]);
      const selector = c.interface.getError('AlreadyCounted')!.selector;
      const revertData = async (override?: Record<string, { code: string }>) => {
        const res = await fetch(manifest.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: override ? [{ to: p.address, data }, 'latest', override] : [{ to: p.address, data }, 'latest'] }) });
        const j: any = await res.json();
        return String(j.error?.data ?? '');
      };
      const [killed, control] = await Promise.all([revertData({ [PRECOMPILE]: { code: '0x' } }), revertData({ [mirrorAddr]: { code: '0x' } })]);
      const verifiedWithout = killed.startsWith(selector);
      const controlFailed = !control.startsWith(selector);
      return { pass: paid && verifiedWithout && controlFailed, detail: `PaidOnEthereum ${p.address.slice(0, 6)}…${p.address.slice(-4)} (second account, same person): paidAtLeast → ${paid}; re-proving with precompile deleted → ${verifiedWithout ? 'verified, then AlreadyCounted' : 'did not verify'}; with mirror deleted → ${controlFailed ? 'refused before verification' : 'verified'}` };
    }),

    gate('differential', 'The mirror and the live precompile agree, including on forgeries', async () => {
      const pre = new Contract(PRECOMPILE, PRECOMPILE_ABI, cc);
      let checks = 0;
      const disagreements: string[] = [];
      await Promise.all(
        manifest.differential.map(async (f) => {
          const sib = f.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft }));
          const cases: [string, typeof sib, string][] = [
            ['valid', sib, f.txBytes],
            ['sibling bit flipped', sib.map((s, i) => (i === 0 ? { ...s, hash: hexlify(Uint8Array.from(getBytes(s.hash), (b, k) => (k === 0 ? b ^ 0x80 : b))) } : s)), f.txBytes],
            ['direction flipped', sib.map((s, i) => (i === 0 ? { ...s, isLeft: !s.isLeft } : s)), f.txBytes],
            ['last sibling dropped', sib.slice(0, -1), f.txBytes],
            ['transaction tampered', sib, f.txBytes.slice(0, -2) + (f.txBytes.slice(-2) === '00' ? '01' : '00')],
          ];
          for (const [name, s, tx] of cases) {
            const [p, v, t] = await Promise.all([
              pre.verify(3, f.height, tx, { root: f.root, siblings: s }, { lowerEndpointDigest: f.lowerEndpointDigest, roots: f.continuityRoots }).then((x: boolean) => x).catch(() => false),
              mirror.verifyOrRevert(3, f.height, tx, s).then(() => true).catch(() => false),
              mirror.tryVerify(3, f.height, tx, s).then((x: any) => Boolean(x[0])).catch(() => null),
            ]);
            checks++;
            if (!(p === v && v === t)) disagreements.push(`${f.txHash.slice(0, 10)}… ${name}: precompile ${p}, verifyOrRevert ${v}, tryVerify ${t}`);
          }
        }),
      );
      return { pass: disagreements.length === 0, detail: disagreements.length ? disagreements.join('; ') : `${checks} checks over ${manifest.differential.length} real mainnet liquidations, 0 divergences` };
    }),

    gate('run-unbroken', 'The run the site advertises holds every height, end to end', async () => {
      const { from, length } = manifest.run;
      const run = Number(await mirror.contiguousFrom(3, from, length));
      return { pass: run >= length, detail: run >= length ? `${from.toLocaleString('en-US')} – ${(from + length - 1).toLocaleString('en-US')}, ${length.toLocaleString('en-US')} heights, no gap` : `first missing height ${(from + run).toLocaleString('en-US')} — the advertised run is broken` };
    }),

    gate('holes-closing', 'Heights missing below the advertised run only ever shrink', async () => {
      const [held, lo, hi] = await Promise.all([mirror.mirroredBlocks(3), mirror.lowestMirrored(3), mirror.highestMirrored(3)]);
      const missing = Number(hi) - Number(lo) + 1 - Number(held);
      const was = manifest.run.unheldInRange;
      const pass = missing <= was;
      return { pass, detail: missing === 0 ? `no holes: ${Number(lo).toLocaleString('en-US')} – ${Number(hi).toLocaleString('en-US')} is unbroken` : `${missing.toLocaleString('en-US')} heights still missing between ${Number(lo).toLocaleString('en-US')} and ${Number(hi).toLocaleString('en-US')} (recorded ${was.toLocaleString('en-US')}${missing < was ? `, ${(was - missing).toLocaleString('en-US')} repaired since` : ''})` };
    }),

    gate('span-window', 'A sealed span proves 648,000 heights at the archive head', async () => {
      if (!offer) return { pass: false, detail: 'no adjacent run of sealed spans covers 648,000 heights — the desk would refuse ArchiveTooShallow' };
      const head = Number(await mirror.highestMirrored(3));
      const lag = head - offer.to;
      // A BlankFile policy carries maxStaleness 0: a window that stops below the head refuses outright.
      return { pass: lag === 0, detail: `span${offer.ids.length > 1 ? 's' : ''} ${offer.ids.join(', ')} cover ${(offer.to - offer.from + 1).toLocaleString('en-US')} heights to ${offer.to.toLocaleString('en-US')}${lag === 0 ? ', at the head' : `, ${lag.toLocaleString('en-US')} below the head`}` };
    }),

    gate('attested-lag', 'The archive keeps up with what Creditcoin has attested', async () => {
      const info = new Contract(CHAIN_INFO, CHAIN_INFO_ABI, cc);
      const [att, head] = await Promise.all([info.get_latest_attestation_height_and_hash(3), mirror.highestMirrored(3)]);
      const lag = Number(att.height) - Number(head);
      return { pass: lag <= manifest.attested.maxLag, detail: `attested ${Number(att.height).toLocaleString('en-US')}, mirrored ${Number(head).toLocaleString('en-US')} — ${lag <= 0 ? 'at or ahead of' : lag.toLocaleString('en-US') + ' behind'} the attestation head (budget ${manifest.attested.maxLag})` };
    }),

    gate('desk-gas', 'The desk answers a 90-day question without walking 648,000 heights', async () => {
      if (!offer) return { pass: false, detail: 'no window to price' };
      const data = new Interface(DESK_ABI).encodeFunctionData('assess', [manifest.desk.nobody, manifest.desk.blankFileAave, 0, offer.ids]);
      const now = Number(await cc.estimateGas({ to: manifest.desk.address, data }));
      const prior = manifest.desk.gas.prior;
      return { pass: now <= manifest.desk.gas.budget, detail: `${now.toLocaleString('en-US')} gas to price ninety days (budget ${manifest.desk.gas.budget.toLocaleString('en-US')}); the superseded desk walked the bitmap for ${prior.toLocaleString('en-US')} — ${(prior / now).toFixed(1)}× more` };
    }),

    gate('desk-depth', 'The desk’s 90-day policy answers rather than refusing ArchiveTooShallow', async () => {
      if (!offer) return { pass: false, detail: 'no sealed window to offer: the desk would refuse ArchiveTooShallow' };
      const [ok, reason] = await desk.assess(manifest.desk.nobody, manifest.desk.blankFileAave, 0, offer.ids);
      return { pass: REFUSAL[Number(reason)] === 'None' && ok === true, detail: `BlankFile policy ${manifest.desk.blankFileAave}, an address with nothing on file → ${REFUSAL[Number(reason)]}` };
    }),

    gate('desk-silence', 'The desk answers on silence and refuses to lend against it', async () => {
      if (!offer) return { pass: false, detail: 'no sealed window to offer' };
      const [asked, lend] = await Promise.all([
        desk.assess(manifest.desk.nobody, manifest.desk.blankFileAave, 0, offer.ids),
        desk.assess(manifest.desk.nobody, manifest.desk.blankFileAave, 10n ** 17n, offer.ids),
      ]);
      const pass = REFUSAL[Number(asked[1])] === 'None' && REFUSAL[Number(lend[1])] === 'NeedsBondedCover';
      return { pass, detail: `an address with nothing on file: asked → ${REFUSAL[Number(asked[1])]}; asked for 0.1 tCTC → ${REFUSAL[Number(lend[1])]} (silence is not collateral)` };
    }),

    gate('desk-sizing', 'A loan may not exceed ten times what a lie would have cost', async () => {
      const z = manifest.desk.sizing;
      if (!z || manifest.desk.sizedAave === null || !offer) return { pass: false, detail: 'no standing claim recorded to size against' };
      const reg = new Contract(manifest.contracts.AbsenceRegistryV3.address, ENFORCEABLE_ABI, cc);
      const enforceable: bigint = await reg.enforceableLoss(z.claimId);
      const atLimit = enforceable * BigInt(z.leverage);
      const [inside, outside] = await Promise.all([
        desk.assess(z.subject, manifest.desk.sizedAave, atLimit, offer.ids),
        desk.assess(z.subject, manifest.desk.sizedAave, atLimit + 1n, offer.ids),
      ]);
      const pass = inside[0] === true && REFUSAL[Number(outside[1])] === 'NoBondedCleanliness';
      return { pass, detail: `${z.subject.slice(0, 8)}… claim #${z.claimId} puts ${(Number(enforceable) / 1e18).toFixed(3)} tCTC beyond recovery: ${(Number(atLimit) / 1e18).toFixed(3)} tCTC → ${REFUSAL[Number(inside[1])]}, one wei more → ${REFUSAL[Number(outside[1])]}` };
    }),

    gate('desk-binding', 'Terms that require a proven Ethereum owner refuse a fresh wallet', async () => {
      const z = manifest.desk;
      if (z.boundOnly === null || !z.freshWallet || !offer) return { pass: false, detail: 'no binding-required policy or demo wallet recorded' };
      const [[, fresh], [, sized]] = await Promise.all([
        desk.assess(z.freshWallet, z.boundOnly, 10n ** 17n, offer.ids),
        // The same wallet under the otherwise-identical policy that does not require binding: it has a
        // standing claim about itself, so the *only* thing the binding rule changes is the answer.
        z.sizedAave === null ? Promise.resolve([false, 0]) : desk.assess(z.freshWallet, z.sizedAave, 10n ** 17n, offer.ids),
      ]);
      const pass = REFUSAL[Number(fresh)] === 'UnprovenSubject';
      return { pass, detail: `${z.freshWallet.slice(0, 8)}…, a Creditcoin wallet with a standing claim about itself: bound-only terms → ${REFUSAL[Number(fresh)]}; the same terms without the binding rule → ${REFUSAL[Number(sized)]}` };
    }),

    gate('desk-cap', 'The desk cannot lend past what the attestor quorum has bonded', async () => {
      const [attestors, minBond, cap] = await desk.securityBudget(3);
      const outstanding: bigint = await desk.totalOutstanding();
      const pass = cap === BigInt(attestors) * minBond && outstanding <= cap;
      return { pass, detail: `0x0FD4: ${Number(attestors)} attestors × ${(Number(minBond) / 1e18).toFixed(0)} CTC bonded ⇒ ceiling ${(Number(cap) / 1e18).toFixed(0)} tCTC; ${(Number(outstanding) / 1e18).toFixed(2)} outstanding` };
    }),

    gate('desk-liar', 'The desk refuses a borrower proven liquidated inside its window', async () => {
      const p = manifest.desk.provenLiar;
      if (!p || !offer) return { pass: false, detail: 'no refuted claim recorded to check against' };
      const inWindow = p.evidenceBlock >= offer.to - manifest.desk.window;
      const [, reason] = await desk.assess(p.subject, manifest.desk.blankFileAave, 0, offer.ids);
      const expected = inWindow ? 'ProvenLiar' : 'None';
      return { pass: REFUSAL[Number(reason)] === expected, detail: `${p.subject.slice(0, 8)}… (claim #${p.claimId}, liquidation at ${p.evidenceBlock.toLocaleString('en-US')}, ${inWindow ? 'inside' : 'now below'} the window) → ${REFUSAL[Number(reason)]}, expected ${expected}` };
    }),

    gate('board', 'Settled claims stay settled; no lie stands and no truth is refuted', async () => {
      const statuses = await Promise.all(manifest.board.roles.map(async (c) => ({ ...c, status: STATUS[Number((await registry.claimOf(c.claimId)).status)] })));
      const moved = statuses.filter((c) => (manifest.board.settled as Record<string, string>)[String(c.claimId)] && (manifest.board.settled as Record<string, string>)[String(c.claimId)] !== c.status);
      const liesStanding = statuses.filter((c) => ['lie', 'bounty', 'omission'].includes(c.role) && c.status === 'Standing');
      const truthsRefuted = statuses.filter((c) => ['clean', 'complete', 'borrower'].includes(c.role) && c.status === 'Refuted');
      const open = statuses.filter((c) => c.status === 'Open').length;
      const pass = moved.length === 0 && liesStanding.length === 0 && truthsRefuted.length === 0;
      return { pass, detail: `${statuses.length} claims · ${open} open · settled changed ${moved.length} · lies standing ${liesStanding.map((c) => '#' + c.claimId).join(', ') || 0} · truths refuted ${truthsRefuted.map((c) => '#' + c.claimId).join(', ') || 0}` };
    }),
  ]);

  return { block, gates };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorised = Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
  if (!authorised && url.search) {
    return Response.json({ error: 'public requests take no parameters; results are cached for five minutes' }, { status: 400 });
  }
  const t0 = Date.now();
  const { block, gates } = await runGates();
  const pass = gates.every((g) => g.pass);
  const body = {
    pass,
    ranAt: new Date().toISOString(),
    creditcoinBlock: block,
    durationMs: Date.now() - t0,
    trigger: authorised ? 'scheduler' : 'visitor',
    gates,
    source: 'https://github.com/iamdflame/HINDSIGHT/blob/master/web/api/gates.ts',
  };
  return Response.json(body, {
    status: pass ? 200 : 503,
    headers: {
      'cache-control': authorised ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=900',
      'access-control-allow-origin': '*',
    },
  });
}

/** Uptime monitors often send HEAD; answer with the same status, from the same cached run. */
export async function HEAD(request: Request): Promise<Response> {
  const r = await GET(request);
  return new Response(null, { status: r.status, headers: r.headers });
}
