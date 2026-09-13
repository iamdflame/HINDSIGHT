/**
 * Proof acquisition — deliberately offered two ways.
 *
 * A notarised block can be verified with nothing but a Merkle path, and that path can be obtained
 * either from Gluwa's hosted prover or rebuilt from scratch against a public Ethereum node. The
 * two must produce byte-identical results, and the app exposes the choice as a control rather
 * than a footnote, so the claim "the proving service is replaceable" is something a visitor can
 * test instead of something they have to take on faith.
 *
 * What this does NOT claim: notarising a block in the first place still requires the Attestcoin
 * attestation layer and the block-prover precompile. Only verification against already-notarised
 * history is free of them.
 */
import sdk from '@gluwa/usc-sdk';
import { ethereum, rotateEthereum, sepolia, PROVER, CHAIN_KEY_ETH_MAINNET, CHAIN_KEY_SEPOLIA } from './chain';
import { proofFromEthereum } from './proof-client';

export { proofFromEthereum };

const anySdk = sdk as any;
const { SimpleBlockProvider } = anySdk.proofProvider.raw.blockProvider;
const { KeccakMerkleTree } = anySdk.proofProvider.merkle;
const encoding = anySdk.encoding;

export type Sibling = { hash: string; isLeft: boolean };

export type ProofBundle = {
  source: 'prover' | 'local';
  chainKey: number;
  blockNumber: number;
  txHash: string;
  txIndex: number;
  txBytes: string;
  root: string;
  siblings: Sibling[];
  /** Present only from the hosted prover; required to notarise a not-yet-mirrored block. */
  continuity?: { lowerEndpointDigest: string; roots: string[] };
  /** How many Ethereum transactions were in the block. Only known on the local path. */
  blockTxCount?: number;
  elapsedMs: number;
};

export type Progress = (msg: string) => void;

/** Fetch a ready-made proof from the hosted prover. One request, fast. */
export async function proofFromProver(txHash: string, onProgress?: Progress): Promise<ProofBundle> {
  const t0 = performance.now();
  onProgress?.('Requesting proof from the Attestcoin prover…');
  const res = await fetch(`${PROVER}/api/v1/proof-by-tx/${CHAIN_KEY_ETH_MAINNET}/${txHash}`);
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'The prover has no proof for that transaction. It may be too recent to be attested yet, or not on Ethereum mainnet.'
        : `Prover returned HTTP ${res.status}.`,
    );
  }
  const d = await res.json();
  return {
    source: 'prover',
    chainKey: d.chainKey,
    blockNumber: d.headerNumber,
    txHash: d.txHash,
    txIndex: d.txIndex,
    txBytes: d.txBytes,
    root: d.merkleProof.root,
    siblings: d.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })),
    continuity: { lowerEndpointDigest: d.continuityProof.lowerEndpointDigest, roots: d.continuityProof.roots },
    elapsedMs: performance.now() - t0,
  };
}

/**
 * Rebuild the proof from public Ethereum data alone: fetch the whole block with receipts,
 * re-encode every transaction, rebuild the Merkle tree, and extract the path.
 *
 * Slower by design — it is doing the prover's work in the browser. That it agrees is the point.
 */
export async function rebuildInThisThread(
  txHash: string,
  onProgress?: Progress,
  chainKey: number = CHAIN_KEY_ETH_MAINNET,
): Promise<ProofBundle> {
  const t0 = performance.now();
  let attempt = 0;

  for (;;) {
    try {
      const eth = chainKey === CHAIN_KEY_SEPOLIA ? sepolia() : ethereum();
      onProgress?.('Locating the transaction on Ethereum…');
      const tx = await eth.getTransaction(txHash);
      if (!tx || tx.blockNumber == null) throw new Error('NOT_FOUND');

      onProgress?.(`Fetching block ${tx.blockNumber} with every receipt…`);
      const bp = new SimpleBlockProvider(eth);
      const withReceipts = await bp.getBlockWithReceipts(tx.blockNumber);
      if (!withReceipts) throw new Error('ARCHIVE');
      const { transactions, receipts } = withReceipts;

      onProgress?.(`Re-encoding ${transactions.length} transactions and rebuilding the Merkle tree…`);
      const leaves: string[] = transactions.map((t: any, i: number) =>
        encoding.abiEncode(t, receipts[i], encoding.EncodingVersion.V1).abi,
      );
      const idx = receipts.findIndex(
        (r: any) => (r.hash ?? r.transactionHash)?.toLowerCase() === txHash.toLowerCase(),
      );
      if (idx < 0) throw new Error('NOT_IN_BLOCK');

      const tree = new KeccakMerkleTree(leaves);
      const proof = tree.getProof(idx);

      return {
        source: 'local',
        chainKey,
        blockNumber: tx.blockNumber,
        txHash,
        txIndex: idx,
        txBytes: leaves[idx],
        root: tree.getRoot(),
        siblings: proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })),
        blockTxCount: transactions.length,
        elapsedMs: performance.now() - t0,
      };
    } catch (e: any) {
      if (e?.message === 'NOT_FOUND') throw new Error(`No such transaction on ${chainKey === CHAIN_KEY_SEPOLIA ? 'Sepolia' : 'Ethereum mainnet'}.`);
      if (e?.message === 'NOT_IN_BLOCK') throw new Error('The transaction was not present in the block it claims.');
      attempt += 1;
      if (attempt > 2 || chainKey === CHAIN_KEY_SEPOLIA || !rotateEthereum()) {
        throw new Error(
          'Could not rebuild the proof from a public Ethereum node. Free endpoints often refuse ' +
          'whole-block receipt reads or archive history. Try the prover source, or a more recent block.',
        );
      }
      onProgress?.('Public node refused; trying another endpoint…');
    }
  }
}

export function acquireProof(
  source: 'prover' | 'local',
  txHash: string,
  onProgress?: Progress,
): Promise<ProofBundle> {
  return source === 'prover' ? proofFromProver(txHash, onProgress) : proofFromEthereum(txHash, onProgress);
}

/** Normalise a user-supplied transaction hash, or explain why it is not one. */
export function normaliseTxHash(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!v) throw new Error('Enter an Ethereum mainnet transaction hash.');
  const withPrefix = v.startsWith('0x') ? v : '0x' + v;
  if (!/^0x[0-9a-f]{64}$/.test(withPrefix)) {
    throw new Error('That is not a transaction hash — expected 32 bytes of hex (0x followed by 64 characters).');
  }
  return withPrefix;
}
