/**
 * hindsight-mirror — ask whether an Ethereum transaction happened, from Creditcoin.
 *
 * Attestcoin lets a Creditcoin contract verify a foreign transaction, but every query carries a
 * continuity proof whose length grows with the age of the fact, and every integration throws that
 * proof away after using one transaction from it. Hindsight keeps the block roots those proofs
 * certify. After that, the second question about the same block is a Merkle path against stored
 * state: a `view` call, at a fixed cost, with no proving service and no precompile in the loop.
 *
 * This package is the one-call version of that.
 *
 *   import { verify } from 'hindsight-mirror';
 *   const r = await verify('0x3a4b8bcf…');
 *   //=> { mirrored: true, verified: true, txIndex: 263, source: 'local', blockNumber: 25954574 }
 *
 * `verify` needs no key, no gas and no wallet. `notarise` does need a key, because notarising is
 * the one step that still requires the attestor set and the block-prover precompile -- a
 * distinction this package keeps in its API shape rather than in a footnote.
 *
 * Plain JavaScript on purpose: it runs on any Node ≥ 18 with nothing to compile.
 */
import { JsonRpcProvider, Contract, Wallet, isAddress, getAddress, hexlify, randomBytes } from 'ethers';

export const CC_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const PROVER = 'https://prover.cc3-testnet.creditcoin.network';
export const CHAIN_KEY_ETH_MAINNET = 3;
export const CHAIN_KEY_SEPOLIA = 1;

/** Mirror v2 on Creditcoin CC3 testnet: held bitmap, empty-block-safe. Override for another deployment. */
export const MIRROR_ADDRESS = '0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118';

/** Public Ethereum endpoints tried in order when rebuilding a path locally. */
export const ETH_RPCS = {
  [CHAIN_KEY_ETH_MAINNET]: [
    'https://gateway.tenderly.co/public/mainnet',
    'https://rpc.mevblocker.io',
    'https://eth.drpc.org',
  ],
  [CHAIN_KEY_SEPOLIA]: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.drpc.org',
    'https://gateway.tenderly.co/public/sepolia',
  ],
};

/** Frozen `IMirror` surface plus the additive `heldWord`. */
const MIRROR_ABI = [
  'function rootOf(uint64,uint64) view returns (bytes32)',
  'function isMirrored(uint64,uint64) view returns (bool)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function heldWord(uint64,uint64) view returns (uint256)',
  'function verifyOrRevert(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (uint64)',
  'function tryVerify(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (bool, uint64)',
  'function mirror(uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, (bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (uint64)',
];

/**
 * @typedef {{ hash: string, isLeft: boolean }} Sibling
 * @typedef {{
 *   mirrored: boolean, verified: boolean, blockNumber: number,
 *   txIndex?: number, path?: Sibling[], source: 'local' | 'prover'
 * }} VerifyResult
 * @typedef {{ rpc?: string, mirror?: string, prover?: string, ethRpc?: string, chainKey?: number, source?: 'local' | 'prover' }} Options
 */

function mirrorContract(o = {}, runner) {
  const provider = runner ?? new JsonRpcProvider(o.rpc ?? CC_RPC);
  return new Contract(o.mirror ?? MIRROR_ADDRESS, MIRROR_ABI, provider);
}

async function proofFromProver(txHash, o) {
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const r = await fetch(`${o.prover ?? PROVER}/api/v1/proof-by-tx/${chainKey}/${txHash}`);
  if (!r.ok) throw new Error(`prover returned ${r.status}`);
  const p = await r.json();
  return {
    blockNumber: p.headerNumber,
    txBytes: p.txBytes,
    root: p.merkleProof.root,
    siblings: p.merkleProof.siblings,
    continuity: p.continuityProof,
  };
}

/** First Ethereum endpoint that answers. Public RPCs fail often enough that one is never enough. */
async function ethProvider(o) {
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const urls = o.ethRpc ? [o.ethRpc] : ETH_RPCS[chainKey] ?? ETH_RPCS[CHAIN_KEY_ETH_MAINNET];
  let last;
  for (const u of urls) {
    try {
      const p = new JsonRpcProvider(u, undefined, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`no Ethereum RPC answered: ${last?.message ?? 'unknown'}`);
}

/** Rebuild the path from a public Ethereum node. No proving service is contacted. */
async function proofFromEthereum(txHash, o) {
  const sdkMod = await import('@gluwa/usc-sdk');
  const sdk = sdkMod.proofProvider ? sdkMod : sdkMod.default;
  const { SimpleBlockProvider } = sdk.proofProvider.raw.blockProvider;
  const { KeccakMerkleTree } = sdk.proofProvider.merkle;
  const encoding = sdk.encoding;

  const eth = await ethProvider(o);
  const tx = await eth.getTransaction(txHash);
  if (!tx?.blockNumber) throw new Error('transaction not found on Ethereum');

  const withReceipts = await new SimpleBlockProvider(eth).getBlockWithReceipts(tx.blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this Ethereum RPC');

  const { transactions, receipts } = withReceipts;
  const leaves = transactions.map((t, i) => encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi);
  const idx = receipts.findIndex((r) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase());
  if (idx < 0) throw new Error('transaction not present in the rebuilt block');

  const proof = new KeccakMerkleTree(leaves).getProof(idx);
  return {
    blockNumber: tx.blockNumber,
    txBytes: leaves[idx],
    siblings: proof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
  };
}

/**
 * Verify an Ethereum transaction against Creditcoin.
 *
 * No key, no gas, no wallet: this is a `view` call. If the block is not yet held by the archive,
 * `mirrored` is false and nothing is asserted -- `notarise` is the way to make it answerable.
 *
 * @param {string} txHash
 * @param {Options} [o]
 * @returns {Promise<VerifyResult>}
 */
export async function verify(txHash, o = {}) {
  const mirror = mirrorContract(o);
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const source = o.source ?? 'local';

  const built = source === 'prover' ? await proofFromProver(txHash, o) : await proofFromEthereum(txHash, o);

  const mirrored = await mirror.isMirrored(chainKey, built.blockNumber);
  if (!mirrored) return { mirrored: false, verified: false, blockNumber: built.blockNumber, source };

  const [ok, txIndex] = await mirror.tryVerify(
    chainKey,
    built.blockNumber,
    built.txBytes,
    built.siblings.map((s) => [s.hash, s.isLeft]),
  );

  return {
    mirrored: true,
    verified: Boolean(ok),
    blockNumber: built.blockNumber,
    txIndex: Number(txIndex),
    path: built.siblings,
    source,
  };
}

/** Whether a height can be answered cheaply right now. */
export async function isMirrored(blockNumber, o = {}) {
  return mirrorContract(o).isMirrored(o.chainKey ?? CHAIN_KEY_ETH_MAINNET, blockNumber);
}

/** How much of the source chain the archive currently holds. */
export async function coverage(o = {}) {
  const m = mirrorContract(o);
  const k = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const [held, low, high] = await Promise.all([m.mirroredBlocks(k), m.lowestMirrored(k), m.highestMirrored(k)]);
  return { chainKey: k, heights: Number(held), lowest: Number(low), highest: Number(high) };
}

/**
 * Notarise the block containing `txHash`, retaining every root its continuity proof carried.
 *
 * This is the one operation that still needs the attestor set, the block-prover precompile, a key
 * and gas. Everything else in this package is a `view` precisely because this step already
 * happened for that block.
 */
export async function notarise(txHash, privateKey, o = {}) {
  const provider = new JsonRpcProvider(o.rpc ?? CC_RPC);
  const wallet = new Wallet(privateKey, provider);
  const mirror = mirrorContract(o, wallet);
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;

  const p = await proofFromProver(txHash, o);
  const tx = await mirror.mirror(
    chainKey,
    p.blockNumber,
    p.txBytes,
    p.root,
    p.siblings.map((s) => [s.hash, s.isLeft]),
    p.continuity.lowerEndpointDigest,
    p.continuity.roots,
  );
  await tx.wait();
  return tx.hash;
}

// ---------------------------------------------------------------------------------------------------
// The desk, the registry and the binding. Everything below is a view unless it says it costs gas.
// Addresses are the current deployments; superseded ones are listed in deployments.json with reasons.
// ---------------------------------------------------------------------------------------------------

export const REGISTRY_ADDRESS = '0x05844C991993F3d80fAf196e10355B12BE648e40';
export const DESK_ADDRESS = '0xc176b4307315F8494A763773385B455aE0b7f9d2';
export const BINDING_ADDRESS = '0x2d2120Da8877579E4eA58EA6f079d373b71ea7f0';
export const CHAIN_INFO = '0x0000000000000000000000000000000000000FD3';

export const REFUSAL = [
  'None', 'NoSuchPolicy', 'ArchiveTooShallow', 'ClaimUnderHunt', 'ProvenLiar', 'NoBondedCleanliness',
  'DeskOutOfFunds', 'EventOnRecord', 'AlreadyLent', 'NeedsBondedCover', 'PoolCapReached', 'UnprovenSubject',
];
export const STATUS = ['None', 'Open', 'Refuted', 'Standing'];

const SPAN_ABI = [
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns ((uint64 chainKey, uint64 fromBlock, uint64 toBlock))',
];
const DESK_ABI = [
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal, bool requiresBinding))',
  'function assess(address, uint256, uint256, uint256[]) view returns (bool ok, uint8 reason)',
  'function subjectOf(address caller, uint256 policyId) view returns (address)',
  'function borrow(uint256 policyId, uint256 principal, uint256[] spanIds)',
  'function securityBudget(uint64) view returns (uint32 attestors, uint128 minBond, uint256 cap)',
  'function totalOutstanding() view returns (uint256)',
  'error Rejected(uint8 reason)',
];
const REGISTRY_ABI = [
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function enforceableLoss(uint256) view returns (uint256)',
  'function isUsable(uint256 claimId, uint256 exposure) view returns (bool)',
  'function commitmentFor(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt, address refuter) pure returns (bytes32)',
  'function commitRefutation(bytes32 commitment)',
  'function revealRefutation(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt)',
];
const BINDING_ABI = [
  'function bindingCalldata(address controller) pure returns (bytes)',
  'function bind(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) returns (address controller, address subject)',
  'function subjectFor(address controller, uint64 chainKey) view returns (address)',
  'function controllerOf(uint64 chainKey, address subject) view returns (address)',
];
const CHAIN_INFO_ABI = ['function get_latest_attestation_height_and_hash(uint64) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists) result)'];

const ccProvider = (o = {}) => new JsonRpcProvider(o.rpc ?? CC_RPC);
const deskContract = (o = {}, runner) => new Contract(o.desk ?? DESK_ADDRESS, DESK_ABI, runner ?? ccProvider(o));
const registryContract = (o = {}, runner) => new Contract(o.registry ?? REGISTRY_ADDRESS, REGISTRY_ABI, runner ?? ccProvider(o));
const bindingContract = (o = {}, runner) => new Contract(o.binding ?? BINDING_ADDRESS, BINDING_ABI, runner ?? ccProvider(o));

/**
 * The sealed spans to hand the desk for a window: the shortest adjacent run that reaches highest.
 * Offering spans is a convenience, not a permission -- the desk re-checks adjacency, chain, length and
 * freshness itself. Null means no such run exists and the desk would refuse `ArchiveTooShallow`.
 */
export async function spanOffer(window, o = {}) {
  const k = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const m = new Contract(o.mirror ?? MIRROR_ADDRESS, SPAN_ABI, ccProvider(o));
  const n = Number(await m.spanCount());
  const all = await Promise.all(Array.from({ length: n }, async (_, i) => ({ id: i, s: await m.spanOf(i) })));
  const spans = all.filter((x) => Number(x.s.chainKey) === k).map((x) => ({ id: x.id, from: Number(x.s.fromBlock), to: Number(x.s.toBlock) }));
  let top;
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
  return top.to - from < window ? null : { spanIds: ids, from, to: top.to };
}

/** Every policy the desk holds, as filed. */
export async function policies(o = {}) {
  const d = deskContract(o);
  const n = Number(await d.policyCount());
  const rows = await Promise.all(Array.from({ length: n }, (_, i) => d.policyOf(i)));
  return rows.map((p, id) => ({
    id,
    kind: Number(p.kind) === 0 ? 'BlankFile' : 'BondedClean',
    chainKey: Number(p.chainKey),
    window: Number(p.window),
    maxStaleness: Number(p.maxStaleness),
    venue: p.venue,
    topic0: p.topic0,
    subjectTopic: Number(p.subjectTopic),
    minBond: p.minBond,
    maxPrincipal: p.maxPrincipal,
    requiresBinding: Boolean(p.requiresBinding),
  }));
}

/**
 * Ask the desk about an address. A view on the same `assess` that `borrow` gates on, so what this
 * returns is what the money would do. `principal` in wei (bigint); 0 asks only what the file says.
 *
 * @returns {Promise<{ subject: string, verdicts: { policy: object, pays: boolean, reason: string, window: object|null }[] }>}
 */
export async function assess(subject, principal = 0n, o = {}) {
  if (!isAddress(subject)) throw new Error('subject must be an Ethereum address');
  const d = deskContract(o);
  const ps = await policies(o);
  const offers = new Map();
  for (const p of ps) {
    const key = `${p.chainKey}:${p.window}`;
    if (!offers.has(key)) offers.set(key, await spanOffer(p.window, { ...o, chainKey: p.chainKey }));
  }
  const verdicts = await Promise.all(
    ps.map(async (policy) => {
      const window = offers.get(`${policy.chainKey}:${policy.window}`) ?? null;
      const [ok, reason] = await d.assess(subject, policy.id, principal, window?.spanIds ?? []);
      return { policy, pays: Boolean(ok), reason: REFUSAL[Number(reason)] ?? String(reason), window };
    }),
  );
  return { subject: getAddress(subject), verdicts };
}

/**
 * Whether a standing claim can be relied on for `exposure` wei: Standing, and the half of its bond that
 * a liar could not recover is at least that much. Size reliance against that number, not the headline bond.
 */
export async function usable(claimId, exposure, o = {}) {
  const r = registryContract(o);
  const [c, loss, ok] = await Promise.all([r.claimOf(claimId), r.enforceableLoss(claimId), r.isUsable(claimId, exposure)]);
  return {
    claimId: Number(claimId),
    usable: Boolean(ok),
    status: STATUS[Number(c.status)],
    kind: Number(c.kind) === 0 ? 'EmptySet' : 'CompleteSet',
    bondStaked: c.bondStaked,
    enforceableLoss: loss,
    spanFrom: Number(c.spanFrom),
    spanTo: Number(c.spanTo),
    subject: c.subject,
    venue: c.venue,
    topic0: c.topic0,
  };
}

/** Every claim on the registry, newest last. The board is small; this is a handful of calls. */
export async function claims(o = {}) {
  const r = registryContract(o);
  const n = Number(await r.claimCount());
  const rows = await Promise.all(Array.from({ length: n }, (_, i) => r.claimOf(i)));
  return rows.map((c, id) => ({
    id,
    status: STATUS[Number(c.status)],
    kind: Number(c.kind) === 0 ? 'EmptySet' : 'CompleteSet',
    chainKey: Number(c.chainKey),
    venue: c.venue,
    topic0: c.topic0,
    subject: c.subject,
    subjectTopic: Number(c.subjectTopic),
    spanFrom: Number(c.spanFrom),
    spanTo: Number(c.spanTo),
    bondStaked: c.bondStaked,
    openUntil: Number(c.openUntil),
    claimant: c.claimant,
    refuter: c.refuter,
  }));
}

/**
 * Verify, and notarise first if the block is not yet held. The only step that can cost gas is the
 * notarisation, and it only happens when `mirrored` would otherwise be false.
 */
export async function mirrorIfNeeded(txHash, privateKey, o = {}) {
  const first = await verify(txHash, o);
  if (first.mirrored) return { ...first, notarised: null };
  if (!privateKey) throw new Error(`block ${first.blockNumber} is not held and no key was given to notarise it`);
  const hash = await notarise(txHash, privateKey, o);
  const second = await verify(txHash, o);
  return { ...second, notarised: hash };
}

/**
 * The five things a consumer should check before acting on an inclusion proof, named after the list
 * in Dokett's ASC review, each answered rather than assumed:
 *
 *   status    the transaction succeeded (a reverted transfer is not a transfer)
 *   depth     the block is at least `minDepth` below the attestation head (reorg margin)
 *   clock     the block is not older than `maxAgeSeconds` (a payment from last year is not this invoice)
 *   stall     the archive is within `maxLag` of the attestation head (the source is still being followed)
 *   replay    the (height, txIndex) pair a consumer must record so the same leaf is never counted twice
 *
 * Nothing here decides for the consumer; it returns each check with its number so the consumer can.
 */
export async function checks(txHash, o = {}) {
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const v = await verify(txHash, o);
  const eth = await ethProvider(o);
  const [receipt, block] = await Promise.all([eth.getTransactionReceipt(txHash), eth.getBlock(v.blockNumber)]);
  const info = new Contract(CHAIN_INFO, CHAIN_INFO_ABI, ccProvider(o));
  const m = mirrorContract(o);
  const [att, head] = await Promise.all([info.get_latest_attestation_height_and_hash(chainKey), m.highestMirrored(chainKey)]);
  const attested = Number(att.height);
  const minDepth = o.minDepth ?? 64;
  const maxAge = o.maxAgeSeconds ?? 90 * 86_400;
  const maxLag = o.maxLag ?? 1_000;
  const now = Math.floor(Date.now() / 1000);
  const out = {
    txHash,
    mirrored: v.mirrored,
    verified: v.verified,
    blockNumber: v.blockNumber,
    txIndex: v.txIndex ?? null,
    status: { pass: receipt?.status === 1, value: receipt?.status ?? null, rule: 'receipt status must be 1' },
    depth: { pass: attested - v.blockNumber >= minDepth, value: attested - v.blockNumber, rule: `at least ${minDepth} blocks below the attestation head` },
    clock: { pass: block ? now - block.timestamp <= maxAge : false, value: block ? now - block.timestamp : null, rule: `no older than ${maxAge} seconds` },
    stall: { pass: attested - Number(head) <= maxLag, value: attested - Number(head), rule: `archive within ${maxLag} of the attestation head` },
    replay: { key: v.txIndex === undefined ? null : `${chainKey}:${v.blockNumber}:${v.txIndex}`, rule: 'record this key; refuse to act on it twice' },
  };
  out.pass = out.mirrored && out.verified && out.status.pass && out.depth.pass && out.clock.pass && out.stall.pass;
  return out;
}

/** The 32 bytes an Ethereum address must sign to say `controller` speaks for it. */
export async function bindingCalldata(controller, o = {}) {
  return bindingContract(o).bindingCalldata(controller);
}

/** Who a Creditcoin address speaks for on a source chain: itself unless it has proven otherwise. */
export async function subjectFor(controller, o = {}) {
  return bindingContract(o).subjectFor(controller, o.chainKey ?? CHAIN_KEY_ETH_MAINNET);
}

/**
 * Submit a binding: prove an Ethereum transaction whose calldata names a Creditcoin address. Costs gas.
 * Anyone may submit anyone's proof; it can only bind the pair the signer named.
 */
export async function bind(txHash, privateKey, o = {}) {
  const chainKey = o.chainKey ?? CHAIN_KEY_ETH_MAINNET;
  const p = await proofFromEthereum(txHash, o);
  const wallet = new Wallet(privateKey, ccProvider(o));
  const b = bindingContract(o, wallet);
  const [controller, subject] = await b.bind.staticCall(chainKey, p.blockNumber, p.txBytes, p.siblings.map((s) => [s.hash, s.isLeft]));
  const tx = await b.bind(chainKey, p.blockNumber, p.txBytes, p.siblings.map((s) => [s.hash, s.isLeft]));
  await tx.wait();
  return { controller, subject, height: p.blockNumber, tx: tx.hash };
}

/**
 * Refute an open EmptySet claim with a transaction inside its range: commit, wait a block, reveal. Half
 * the bond to the refuter, half burned. Costs gas twice. The proof is rebuilt from a public node.
 */
export async function refute(claimId, txHash, privateKey, o = {}) {
  const wallet = new Wallet(privateKey, ccProvider(o));
  const r = registryContract(o, wallet);
  const p = await proofFromEthereum(txHash, o);
  const sib = p.siblings.map((s) => [s.hash, s.isLeft]);
  const salt = hexlify(randomBytes(32));
  const commitment = await r.commitmentFor(claimId, p.blockNumber, p.txBytes, sib, salt, wallet.address);
  const c = await r.commitRefutation(commitment);
  await c.wait();
  // The registry requires the commitment to have aged at least one block before the reveal.
  const target = (await wallet.provider.getBlockNumber()) + 1;
  while ((await wallet.provider.getBlockNumber()) < target) await new Promise((res) => setTimeout(res, 3000));
  const rv = await r.revealRefutation(claimId, p.blockNumber, p.txBytes, sib, salt);
  const rc = await rv.wait();
  return { claimId: Number(claimId), commitTx: c.hash, revealTx: rc.hash, height: p.blockNumber };
}
