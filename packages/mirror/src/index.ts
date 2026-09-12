/**
 * @hindsight/mirror — ask whether an Ethereum transaction happened, from Creditcoin.
 *
 * Attestcoin lets a Creditcoin contract verify a foreign transaction, but the query carries a
 * continuity proof whose length grows as the transaction ages, and every integration throws that
 * proof away after using one transaction from it. Hindsight keeps the block roots those proofs
 * certify, so the second question about the same block is a Merkle path against stored state:
 * a `view` call, at a fixed cost, with no proving service in the loop.
 *
 * This package is the one-call version of that.
 *
 *   import { verify } from '@hindsight/mirror';
 *   const r = await verify('0x3a4b8bcf…');
 *   //=> { mirrored: true, txIndex: 263, source: 'local', blockNumber: 25954574, … }
 *
 * `verify` needs no key, no gas and no wallet. `notarise` does need a key, because notarising is
 * the one step that still requires the attestor set and the block-prover precompile -- a
 * distinction this package keeps in its API shape rather than in a footnote.
 */
import { JsonRpcProvider, Contract, Wallet } from 'ethers';

export const CC_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const PROVER = 'https://prover.cc3-testnet.creditcoin.network';
export const CHAIN_KEY_ETH_MAINNET = 3;

/** Deployed on Creditcoin CC3 testnet. Override for another deployment. */
export const MIRROR_ADDRESS = '0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB';

const MIRROR_ABI = [
  'function rootOf(uint64,uint64) view returns (bytes32)',
  'function isMirrored(uint64,uint64) view returns (bool)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function verifyOrRevert(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (uint64)',
  'function tryVerify(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (bool, uint64)',
  'function mirror(uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, (bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (uint64)',
];

export type Sibling = { hash: string; isLeft: boolean };

export type VerifyResult = {
  /** Whether the block is held by the archive. `false` means the question cannot be answered cheaply yet. */
  mirrored: boolean;
  /** True when the transaction verified against the notarised root. */
  verified: boolean;
  blockNumber: number;
  txIndex?: number;
  path?: Sibling[];
  /** Where the Merkle path came from. `local` never contacts the proving service. */
  source: 'local' | 'prover';
};

export type Options = {
  rpc?: string;
  mirror?: string;
  prover?: string;
  /** Ethereum endpoint used to rebuild a path locally. */
  ethRpc?: string;
  /** Force a path source. Defaults to rebuilding locally, falling back to the prover. */
  source?: 'local' | 'prover';
};

function mirrorContract(o: Options = {}, runner?: unknown) {
  const provider = (runner as never) ?? new JsonRpcProvider(o.rpc ?? CC_RPC);
  return new Contract(o.mirror ?? MIRROR_ADDRESS, MIRROR_ABI, provider as never);
}

async function proofFromProver(txHash: string, o: Options) {
  const base = o.prover ?? PROVER;
  const r = await fetch(`${base}/api/v1/proof-by-tx/${CHAIN_KEY_ETH_MAINNET}/${txHash}`);
  if (!r.ok) throw new Error(`prover returned ${r.status}`);
  const p = await r.json();
  return {
    blockNumber: p.headerNumber as number,
    txBytes: p.txBytes as string,
    root: p.merkleProof.root as string,
    siblings: p.merkleProof.siblings as Sibling[],
    continuity: p.continuityProof as { lowerEndpointDigest: string; roots: string[] },
  };
}

/** Rebuild the path from a public Ethereum node. No proving service is contacted. */
async function proofFromEthereum(txHash: string, o: Options) {
  const sdkMod: any = await import('@gluwa/usc-sdk');
  const sdk = sdkMod.proofProvider ? sdkMod : sdkMod.default;
  const { SimpleBlockProvider } = sdk.proofProvider.raw.blockProvider;
  const { KeccakMerkleTree } = sdk.proofProvider.merkle;
  const encoding = sdk.encoding;

  const eth = new JsonRpcProvider(o.ethRpc ?? 'https://eth.drpc.org');
  const tx = await eth.getTransaction(txHash);
  if (!tx?.blockNumber) throw new Error('transaction not found on Ethereum');

  const withReceipts = await new SimpleBlockProvider(eth).getBlockWithReceipts(tx.blockNumber);
  if (!withReceipts) throw new Error('block unavailable from this Ethereum RPC');

  const { transactions, receipts } = withReceipts;
  const leaves = transactions.map((t: any, i: number) => encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi);
  const idx = receipts.findIndex((r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase());
  if (idx < 0) throw new Error('transaction not present in the rebuilt block');

  const proof = new KeccakMerkleTree(leaves).getProof(idx);
  return {
    blockNumber: tx.blockNumber,
    txBytes: leaves[idx] as string,
    siblings: proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })) as Sibling[],
  };
}

/**
 * Verify an Ethereum mainnet transaction against Creditcoin.
 *
 * No key, no gas, no wallet: this is a `view` call. If the block is not yet held by the archive,
 * `mirrored` is false and nothing is asserted -- `notarise` is the way to make it answerable.
 */
export async function verify(txHash: string, o: Options = {}): Promise<VerifyResult> {
  const mirror = mirrorContract(o);
  const source = o.source ?? 'local';

  const built =
    source === 'prover' ? await proofFromProver(txHash, o) : await proofFromEthereum(txHash, o);

  const mirrored = await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, built.blockNumber);
  if (!mirrored) {
    return { mirrored: false, verified: false, blockNumber: built.blockNumber, source };
  }

  const [ok, txIndex] = await mirror.tryVerify(
    CHAIN_KEY_ETH_MAINNET,
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
export async function isMirrored(blockNumber: number, o: Options = {}): Promise<boolean> {
  return mirrorContract(o).isMirrored(CHAIN_KEY_ETH_MAINNET, blockNumber);
}

/** How much of Ethereum the archive currently holds. */
export async function coverage(o: Options = {}) {
  const m = mirrorContract(o);
  const [held, low, high] = await Promise.all([
    m.mirroredBlocks(CHAIN_KEY_ETH_MAINNET),
    m.lowestMirrored(CHAIN_KEY_ETH_MAINNET),
    m.highestMirrored(CHAIN_KEY_ETH_MAINNET),
  ]);
  return { heights: Number(held), lowest: Number(low), highest: Number(high) };
}

/**
 * Notarise the block containing `txHash`, retaining every root its continuity proof carried.
 *
 * This is the one operation that still needs the attestor set, the block-prover precompile, a key
 * and gas. Everything else in this package is a view call precisely because this step already
 * happened for that block.
 */
export async function notarise(txHash: string, privateKey: string, o: Options = {}): Promise<string> {
  const provider = new JsonRpcProvider(o.rpc ?? CC_RPC);
  const wallet = new Wallet(privateKey, provider);
  const mirror = mirrorContract(o, wallet);

  const p = await proofFromProver(txHash, o);
  const tx = await mirror.mirror(
    CHAIN_KEY_ETH_MAINNET,
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
