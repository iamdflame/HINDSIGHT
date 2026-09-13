/**
 * Evidence from a public Ethereum node: the Merkle path for one transaction, and where a log sits
 * inside its receipt. Shared by everything that files or refutes a claim, so the seeder and the
 * hunter can never disagree about what a member key is.
 *
 * Nothing here contacts the proving service. A block the mirror already holds is rebuilt from a
 * public node and checked against the mirror's own root before any transaction is sent.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { LOG_RPCS } from './config.ts';

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).proofProvider ? sdkMod : (sdkMod as any).default;
const { proofProvider, encoding } = sdk;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = proofProvider.merkle;

export type Sibling = { hash: string; isLeft: boolean };
export type Member = { height: number; txIndex: number; logIndex: number };
export type Path = { txBytes: string; siblings: Sibling[]; index: number };

const providers = new Map<string, JsonRpcProvider>();
function provider(url: string): JsonRpcProvider {
  if (!providers.has(url)) providers.set(url, new JsonRpcProvider(url, undefined, { staticNetwork: true }));
  return providers.get(url)!;
}

/** Try each endpoint for the chain in turn; a public node failing is routine, not fatal. */
async function anyEndpoint<T>(chainKey: number, what: string, f: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of LOG_RPCS[chainKey]) {
    try {
      return await f(provider(url));
    } catch (e) {
      errors.push(`${new URL(url).host}: ${String((e as Error).message).slice(0, 80)}`);
    }
  }
  throw new Error(`${what} failed on every endpoint: ${errors.join(' | ')}`);
}

export const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** The `topics` filter for (topic0, subject at slot). Slot 0 constrains no subject. */
export function topicsFor(topic0: string, subjectTopic: number, subject: string): (string | null)[] {
  const t: (string | null)[] = [topic0];
  if (subjectTopic > 0) {
    for (let i = 1; i < subjectTopic; i++) t.push(null);
    t.push(subject.length === 42 ? pad32(subject) : subject);
  }
  return t;
}

/**
 * Receipt-local position of a log -- the index the registry and the decoder use -- or -1 if the
 * transaction failed. Not the block-level index `eth_getLogs` returns.
 */
export async function receiptLogIndex(chainKey: number, log: { transactionHash: string; index?: number; logIndex?: number }): Promise<number> {
  const rc = await anyEndpoint(chainKey, `receipt ${log.transactionHash}`, async (p) => {
    const r = await p.getTransactionReceipt(log.transactionHash);
    if (!r) throw new Error('no receipt');
    return r;
  });
  if (rc.status !== 1) return -1;
  const want = log.index ?? log.logIndex;
  const i = rc.logs.findIndex((l) => l.index === want);
  if (i < 0) throw new Error(`log ${want} not found in its own receipt: ${log.transactionHash}`);
  return i;
}

/** Rebuild the block locally and take the path for one transaction. */
export async function pathFor(chainKey: number, blockNumber: number, txHash: string): Promise<Path> {
  const block = await anyEndpoint(chainKey, `block ${blockNumber}`, async (p) => {
    const b = await new SimpleBlockProvider(p).getBlockWithReceipts(blockNumber);
    if (!b) throw new Error('block unavailable');
    return b;
  });
  const { transactions, receipts } = block;
  const leaves = transactions.map((t: any, i: number) => encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi);
  const index = receipts.findIndex((r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase());
  if (index < 0) throw new Error(`transaction ${txHash} not present in rebuilt block ${blockNumber}`);
  const proof = new KeccakMerkleTree(leaves).getProof(index);
  return { txBytes: leaves[index], siblings: proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })), index };
}

/**
 * The same path, checked against the mirror before anyone spends gas on it: the rebuilt block must
 * reproduce the root Creditcoin holds, and the index it proves must be the transaction's own.
 */
export async function verifiedPathFor(mirror: Contract, chainKey: number, blockNumber: number, txHash: string): Promise<Path> {
  const path = await pathFor(chainKey, blockNumber, txHash);
  const [ok, txIndex] = await mirror.tryVerify(chainKey, blockNumber, path.txBytes, path.siblings);
  if (!ok) throw new Error(`rebuilt path for ${txHash} does not meet the mirror's root at ${blockNumber}`);
  if (Number(txIndex) !== path.index) throw new Error(`mirror proves index ${txIndex}, rebuilt block says ${path.index}`);
  return path;
}
