import { readFileSync, existsSync } from 'node:fs';

export const CC_RPC = process.env.CC_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
export const ETH_RPC = process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com';
export const PROVER = process.env.PROVER ?? 'https://prover.cc3-testnet.creditcoin.network';

export const CHAIN_KEY_ETH_MAINNET = 3;
export const CHAIN_KEY_SEPOLIA = 1;

/** Source chains the archive holds, keyed by Attestcoin chainKey. */
export const CHAINS: Record<number, { name: string; slug: string; ethRpcs: string[]; blockSeconds: number }> = {
  3: {
    name: 'Ethereum mainnet',
    slug: 'mainnet',
    ethRpcs: [
      'https://gateway.tenderly.co/public/mainnet',
      'https://rpc.mevblocker.io',
      'https://eth.drpc.org',
      'https://rpc.flashbots.net',
      ETH_RPC,
    ],
    blockSeconds: 12,
  },
  1: {
    name: 'Sepolia',
    slug: 'sepolia',
    ethRpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://gateway.tenderly.co/public/sepolia',
    ],
    blockSeconds: 12,
  },
};

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
  'https://rpc.flashbots.net',
  'https://ethereum-rpc.publicnode.com',
];

/** Sepolia log endpoints, ordered by measured range. */
export const SEPOLIA_LOG_RPCS = [
  'https://gateway.tenderly.co/public/sepolia',
  'https://ethereum-sepolia-rpc.publicnode.com',
];

export const LOG_RPCS: Record<number, string[]> = { 3: ETH_LOG_RPCS, 1: SEPOLIA_LOG_RPCS };

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
  'function heldWord(uint64 chainKey, uint64 wordIndex) view returns (uint256)',
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
 * `eth_getLogs` over a wide range, adaptively split, and corroborated.
 *
 * Two failure modes of public endpoints matter here more than for most projects, because a negative
 * log result is the evidence an absence claim stands on.
 *
 *   1. Refusal. Each endpoint refuses a different width. Measured for a filtered mainnet query:
 *      Tenderly served 648,000 blocks in one request (703ms); mevblocker and flashbots cap at 10,000;
 *      drpc refuses outright; publicnode caps at 1,000. On Sepolia, Tenderly served 216,000 and
 *      publicnode 50,000. So each endpoint is asked for the whole range first and the range is halved
 *      on refusal, down to a floor -- never a fixed chunk that is wasteful on one endpoint and
 *      refused on another. A window no endpoint serves raises; it is never counted as empty.
 *
 *   2. Quiet wrongness. Measured against a known Aave log: `rpc.flashbots.net` returned 0 logs for a
 *      query that two other endpoints answered with 1. No error. A single endpoint saying "nothing
 *      here" is not evidence that nothing is there.
 *
 * So the asymmetry the whole project is built on reappears one layer down and is handled the same
 * way. A positive is self-verifying downstream -- the transaction it names either reproduces the
 * notarised root or it does not -- so one endpoint's positive is acted on. A negative must be
 * covered by `corroboration` independent endpoints across the *entire* range before it is believed.
 * Results from every endpoint that answered are unioned, because a found log beats a missed one.
 */
export async function getLogsAdaptive(
  urls: string[],
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
  opts: { corroboration?: number; minChunk?: number; timeoutMs?: number; onProgress?: (m: string) => void } = {},
): Promise<any[]> {
  const { JsonRpcProvider } = await import('ethers');
  const corroboration = opts.corroboration ?? 2;
  const minChunk = opts.minChunk ?? 500;
  const timeoutMs = opts.timeoutMs ?? 25_000;

  const withTimeout = <T,>(p: Promise<T>) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);

  /** Cover [from, to] with one endpoint, halving on refusal. Throws if any sub-window fails at the floor. */
  async function cover(url: string, from: number, to: number): Promise<any[]> {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
    const out: any[] = [];
    const stack: [number, number][] = [[from, to]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      try {
        out.push(...(await withTimeout(p.getLogs({ ...filter, fromBlock: a, toBlock: b }))));
      } catch (e) {
        if (b - a + 1 <= minChunk) throw new Error(`${new URL(url).host} refused ${a}..${b}: ${String((e as Error).message).slice(0, 80)}`);
        const mid = Math.floor((a + b) / 2);
        stack.push([mid + 1, b], [a, mid]);
      }
    }
    return out;
  }

  const seen = new Map<string, any>();
  let covered = 0;
  const failures: string[] = [];

  for (const url of urls) {
    try {
      opts.onProgress?.(`scanning ${fromBlock}..${toBlock} on ${new URL(url).host}`);
      const logs = await cover(url, fromBlock, toBlock);
      covered++;
      for (const l of logs) seen.set(`${l.transactionHash}:${l.index ?? l.logIndex}`, l);
      // A positive is verified cryptographically downstream; act on it.
      if (seen.size > 0) break;
      // A negative needs `corroboration` endpoints that each covered the whole range.
      if (covered >= corroboration) break;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }

  if (seen.size === 0 && covered < corroboration) {
    throw new Error(
      `only ${covered} endpoint(s) covered ${fromBlock}..${toBlock} and none found a log; ` +
        `refusing to report that as silence (${failures.join(' | ').slice(0, 200)})`,
    );
  }
  return [...seen.values()].sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0));
}

/** Back-compatible wrapper used by the corpus and older scripts. Mainnet endpoints. */
export async function getLogsChunked(
  _provider: unknown,
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
): Promise<any[]> {
  return getLogsAdaptive(ETH_LOG_RPCS, filter, fromBlock, toBlock);
}
