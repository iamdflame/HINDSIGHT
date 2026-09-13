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
import { JsonRpcProvider, Contract, Wallet } from 'ethers';

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
