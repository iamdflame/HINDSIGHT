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
const MIRROR_ABI = [
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function isMirrored(uint64, uint64) view returns (bool)',
  'function rootOf(uint64, uint64) view returns (bytes32)',
  'function contiguousFrom(uint64, uint64, uint64) view returns (uint64)',
  'function spanCovers(uint256, uint64, uint64) view returns (bool)',
  'function verifyOrRevert(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (uint64)',
  'function tryVerify(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (bool, uint64)',
];
const REGISTRY_ABI = ['function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))'];
const DESK_ABI = ['function assess(address, uint256, uint256) view returns (bool ok, uint8 reason)'];
const REFUSAL = ['None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness', 'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent'];
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

    gate('desk-depth', 'The desk’s 90-day policy answers rather than refusing ArchiveTooShallow', async () => {
      const [ok, reason] = await desk.assess(manifest.desk.nobody, manifest.desk.blankFileAave, 10n ** 17n);
      return { pass: REFUSAL[Number(reason)] === 'None' && ok === true, detail: `BlankFile policy ${manifest.desk.blankFileAave}, an address with nothing on file → ${REFUSAL[Number(reason)]}` };
    }),

    gate('desk-liar', 'The desk refuses a borrower proven liquidated inside its window', async () => {
      const p = manifest.desk.provenLiar;
      if (!p) return { pass: false, detail: 'no refuted claim recorded to check against' };
      const head = Number(await mirror.highestMirrored(3));
      const inWindow = p.evidenceBlock >= head - manifest.desk.window;
      const [, reason] = await desk.assess(p.subject, manifest.desk.blankFileAave, 10n ** 17n);
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
