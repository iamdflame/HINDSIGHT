import { readFileSync, existsSync } from 'node:fs';

export const CC_RPC = process.env.CC_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
export const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
export const PROVER = process.env.PROVER ?? 'https://prover.cc3-testnet.creditcoin.network';

export const CHAIN_KEY_ETH_MAINNET = 3;
export const CHAIN_KEY_SEPOLIA = 1;

/** Addresses come from the deployment record, never hardcoded, so worker, tests and frontend
 *  can never disagree about which contracts they are talking to. */
const deployments = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
);
export const MIRROR: string = process.env.MIRROR ?? deployments.contracts.EthereumMirror;
export const REGISTRY: string = process.env.REGISTRY ?? deployments.contracts.AbsenceRegistry;
export const EXPLORER: string = deployments.explorer;

/** Real Ethereum mainnet venues. We deploy nothing here and control none of it. */
export const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
export const TOPIC_LIQUIDATION_CALL = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';
export const TOPIC_REPAY = '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051';

export type Venue = {
  /** Folder name under fixtures/mainnet, and the label the interface shows. */
  key: string;
  label: string;
  protocol: string;
  address: string;
  event: string;
  topic0: string;
  /** Which indexed topic carries the address the claim is about. */
  subjectTopic: number;
  subjectName: string;
};

/**
 * The venues the absence market decodes.
 *
 * Every topic0 here is the keccak of the signature beside it, and each was confirmed against live
 * mainnet logs rather than copied from a block explorer. Aave's value reproduces the constant this
 * project already used, which is what validates the derivation for the other three.
 *
 * A liquidation is the event a borrower most wants to omit, so it is the natural subject of a false
 * absence claim -- but nothing here is Aave-specific. The archive holds whole blocks, so any
 * `topic0` at any address is answerable; these are simply the venues where the interesting lies are.
 */
export const VENUES: Venue[] = [
  {
    key: 'aave-liquidations',
    label: 'Aave V3 · LiquidationCall',
    protocol: 'Aave V3',
    address: AAVE_V3_POOL,
    event: 'LiquidationCall(address,address,address,uint256,uint256,address,bool)',
    topic0: TOPIC_LIQUIDATION_CALL,
    subjectTopic: 3,
    subjectName: 'borrower',
  },
  {
    key: 'aave-repays',
    label: 'Aave V3 · Repay',
    protocol: 'Aave V3',
    address: AAVE_V3_POOL,
    event: 'Repay(address,address,address,uint256,bool)',
    topic0: TOPIC_REPAY,
    subjectTopic: 2,
    subjectName: 'borrower',
  },
  {
    key: 'morpho-liquidates',
    label: 'Morpho Blue · Liquidate',
    protocol: 'Morpho Blue',
    address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    event: 'Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)',
    topic0: '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41',
    subjectTopic: 3,
    subjectName: 'borrower',
  },
  {
    key: 'compound-absorbs',
    label: 'Compound V3 · AbsorbDebt',
    protocol: 'Compound V3 (cUSDCv3)',
    address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    event: 'AbsorbDebt(address,address,uint256,uint256)',
    topic0: '0x1547a878dc89ad3c367b6338b4be6a65a5dd74fb77ae044da1e8747ef1f4f62f',
    subjectTopic: 2,
    subjectName: 'borrower',
  },
];

export function venueByKey(key: string): Venue {
  const v = VENUES.find((x) => x.key === key);
  if (!v) throw new Error(`unknown venue "${key}"; known: ${VENUES.map((x) => x.key).join(', ')}`);
  return v;
}

/**
 * Public Ethereum endpoints for log scanning, tried in order.
 *
 * Wide `eth_getLogs` ranges are rejected by every free tier -- measured: 400 at 40,000 blocks --
 * so callers must chunk. `getLogsChunked` does.
 */
export const ETH_LOG_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
];

/** Signing key for write operations. Taken from PRIVATE_KEY, or from a local, git-ignored
 *  `.secrets/deployer.json` as produced by `cast wallet new --json`. Never committed. */
export function privateKey(): string {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const path = new URL('../../.secrets/deployer.json', import.meta.url);
  if (!existsSync(path)) {
    throw new Error('No signing key: set PRIVATE_KEY, or create .secrets/deployer.json with `cast wallet new --json`.');
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const w = Array.isArray(raw) ? raw[0] : raw;
  return w.private_key;
}

export const MIRROR_ABI = [
  'function mirror(uint64 chainKey, uint64 blockHeight, bytes encodedTransaction, bytes32 merkleRoot, (bytes32 hash, bool isLeft)[] siblings, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (uint64)',
  'function verifyOrRevert(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (uint64 txIndex)',
  'function tryVerify(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (bool valid, uint64 txIndex)',
  'function mirrorBatch(uint64 chainKey, uint64[] heights, bytes[] encodedTransactions, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings)[] merkleProofs, uint64 rootsFromBlock, bytes32 lowerEndpointDigest, bytes32[] continuityRoots) returns (uint64)',
  'function extendSpan(uint256 spanId, uint64 newToBlock)',
  'function MAX_SEAL_WINDOW() view returns (uint64)',
  'function rootOf(uint64, uint64) view returns (bytes32)',
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function isMirrored(uint64, uint64) view returns (bool)',
  'function contiguousFrom(uint64 chainKey, uint64 fromBlock, uint64 maxScan) view returns (uint64)',
  'function sealSpan(uint64 chainKey, uint64 fromBlock, uint64 toBlock) returns (uint256)',
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns (uint64 chainKey, uint64 fromBlock, uint64 toBlock)',
  'event BlocksMirrored(uint64 indexed chainKey, uint64 indexed fromBlock, uint64 indexed toBlock, uint64 newlyAdded)',
  'event SpanSealed(uint256 indexed spanId, uint64 indexed chainKey, uint64 fromBlock, uint64 toBlock)',
];

export const REGISTRY_ABI = [
  'function assertAbsence(uint256 spanId, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 window) payable returns (uint256)',
  'function commitmentFor(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt, address refuter) pure returns (bytes32)',
  'function commitRefutation(bytes32 commitment)',
  'function revealRefutation(uint256 claimId, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings, bytes32 salt)',
  'function assurance(uint256 claimId) view returns (uint8 status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
  'function holdsWithBond(uint256 claimId, uint256 minBond) view returns (bool)',
  'function MIN_BOND() view returns (uint256)',
  'function MIN_WINDOW() view returns (uint64)',
  'function finalize(uint256 claimId)',
  'function holds(uint256 claimId) view returns (bool)',
  'function claimCount() view returns (uint256)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint256 spanId, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status))',
  'event AbsenceAsserted(uint256 indexed claimId, address indexed claimant, uint256 indexed spanId, address venue, bytes32 topic0, bytes32 subject, uint256 bond, uint64 openUntil)',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 bondPaid)',
];

/** Fetch a proof from the hosted prover. Used for convenience; see local-proof.ts for the
 *  demonstration that this service is not a dependency. */
export async function fetchProof(chainKey: number, txHash: string) {
  const r = await fetch(`${PROVER}/api/v1/proof-by-tx/${chainKey}/${txHash}`);
  if (!r.ok) throw new Error(`prover returned ${r.status}`);
  return r.json() as Promise<any>;
}

/** Raised when the prover refuses a batch, carrying the code it gave so callers can react to
 *  `BatchSpanTooLarge` differently from a transient archiver failure. */
export class ProverError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProverError';
    this.status = status;
    this.code = code;
  }
  /** Archiver hiccups and rate limits are worth retrying; a span the prover will never serve is not. */
  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * One continuity proof covering every block between the lowest and highest transaction given.
 *
 * This is the call the archive is built on. A single-transaction proof carries only the roots
 * between its block and the next endpoint above it -- measured at 1 root for a fresh block and 11
 * for a day-old one -- whereas a batch anchored at both ends of a window carries the whole window.
 * Two transactions are enough; adding more does not widen the range and is measurably slower.
 *
 * The prover caps a batch at 1000 blocks, and its archiver reads in checkpoint-aligned chunks, so
 * a window that straddles an extra 100-block boundary is refused even under that cap. Callers
 * should align `from` to a checkpoint boundary. See `campaign.ts`.
 */
export async function fetchBatchProof(chainKey: number, txHashes: string[]) {
  const r = await fetch(`${PROVER}/api/v1/proof-batch-by-tx/${chainKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(txHashes),
  });
  const text = await r.text();
  if (!r.ok) {
    let code = 'Unknown';
    let message = text.slice(0, 300);
    try {
      const body = JSON.parse(text);
      code = body.code ?? code;
      message = body.message ?? message;
    } catch {
      /* non-JSON error body: keep the raw text */
    }
    throw new ProverError(r.status, code, `prover ${r.status} ${code}: ${message}`);
  }
  return JSON.parse(text) as any;
}

/**
 * `eth_getLogs` over a wide range, chunked, and corroborated.
 *
 * Two separate failure modes of public endpoints matter here, and they matter more for this project
 * than for most, because a negative log result is the evidence an absence claim stands on.
 *
 *   1. Refusal. Every free tier rejects wide windows -- measured: 400 at 40,000 blocks -- and each
 *      refuses a different size. A window nobody serves must raise, never be counted as empty.
 *
 *   2. Quiet wrongness. Measured against a known Aave log: `rpc.flashbots.net` returned **0 logs**
 *      for a query that `gateway.tenderly.co` and `rpc.mevblocker.io` both answered with 1. No
 *      error, no warning -- just a wrong empty array.
 *
 * The second is the dangerous one. A single endpoint saying "nothing here" is not evidence that
 * nothing is there, and treating it as such would let an indexing gap manufacture a false economic
 * fact: a claim would stand because nobody could see the transaction that refutes it.
 *
 * So the asymmetry this whole project is built on reappears one layer down, and is handled the same
 * way. A **positive** result is self-verifying: the transaction it names either reproduces the
 * notarised Merkle root or it does not, and a lying endpoint is caught immediately. A **negative**
 * result proves nothing on its own, so it must be corroborated by a second, independent endpoint
 * before it is believed. Results are unioned, because a found log beats a missed one.
 */
export async function getLogsChunked(
  provider: { getLogs: (f: any) => Promise<any[]> },
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
  chunk = 800,
  corroboration = 2,
): Promise<any[]> {
  const { JsonRpcProvider } = await import('ethers');
  const pool = [provider, ...ETH_LOG_RPCS.map((u) => new JsonRpcProvider(u) as any)];
  const out: any[] = [];
  const seen = new Set<string>();

  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    let answered = 0;
    let found = false;
    let lastError: unknown = null;

    for (const p of pool) {
      try {
        const logs = await p.getLogs({ ...filter, fromBlock: from, toBlock: to });
        answered++;
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.index ?? l.logIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(l);
          }
          found = true;
        }
        // A positive is self-verifying downstream, so one endpoint is enough to act on it.
        // A negative needs a second opinion before it counts as silence.
        if (found || answered >= corroboration) break;
      } catch (e) {
        lastError = e;
      }
    }

    if (answered === 0) {
      throw new Error(
        `no endpoint served logs for ${from}..${to}: ${String((lastError as Error)?.message ?? lastError).slice(0, 120)}`,
      );
    }
    if (!found && answered < corroboration) {
      throw new Error(
        `only ${answered} endpoint(s) answered for ${from}..${to} and none found a log; ` +
          `refusing to report that as silence`,
      );
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0));
}
