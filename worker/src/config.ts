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
export const REGISTRY: string = process.env.REGISTRY ?? deployments.contracts.AbsenceRegistryV3;
/** Creditcoin block the current registry was deployed at; event scans start here. */
export const REGISTRY_DEPLOY_BLOCK: number = deployments.registryDeployBlock ?? deployments.deployBlock ?? 0;
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
  {
    // Circle's compliance action on USDC. "Never blacklisted" is the negative a counterparty actually
    // wants; 141 Blacklisted logs in the 90 days before this venue was added, verified live.
    key: 'usdc-blacklisted',
    label: 'USDC · Blacklisted',
    protocol: 'Circle USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    event: 'Blacklisted(address)',
    topic0: '0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855',
    subjectTopic: 1,
    subjectName: 'account',
  },
  {
    // MakerDAO's Spark lending pool: an Aave V3 fork, so the same LiquidationCall signature at a
    // different address, which is exactly why claims are keyed by venue. 71 logs in 90 days, verified.
    key: 'spark-liquidations',
    label: 'Spark · LiquidationCall',
    protocol: 'Spark (MakerDAO)',
    address: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987',
    event: 'LiquidationCall(address,address,address,uint256,uint256,address,bool)',
    topic0: TOPIC_LIQUIDATION_CALL,
    subjectTopic: 3,
    subjectName: 'borrower',
  },
];

/**
 * Not a venue for the desk: a claim about an *oracle round*, not an address. "These are all the
 * AnswerUpdated events for round N" is a completeness statement the registry can hold and the hunt can
 * refute (an omitted update inside the range), and the subject is the round id rather than an account.
 * The aggregator behind the ETH/USD proxy on 2026-09-13; the proxy itself emits nothing.
 */
export const CHAINLINK_ETH_USD = {
  key: 'chainlink-eth-usd',
  label: 'Chainlink ETH/USD · AnswerUpdated',
  protocol: 'Chainlink',
  address: '0x7d4E742018fb52E48b08BE73d041C18B21de6Fb5',
  event: 'AnswerUpdated(int256,uint256,uint256)',
  topic0: '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f',
  subjectTopic: 2,
  subjectName: 'roundId',
} as const;

/**
 * Venues on Sepolia (chainKey 1). The same Aave V3 event, at Sepolia's own pool: a different file,
 * which is the point of keying claims by chain as well as by address. Measured before use: 185
 * LiquidationCall logs in the 30 days before the board was seeded.
 */
export const SEPOLIA_VENUES: Venue[] = [
  {
    key: 'aave-sepolia-liquidations',
    label: 'Aave V3 (Sepolia) · LiquidationCall',
    protocol: 'Aave V3 Sepolia',
    address: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    event: 'LiquidationCall(address,address,address,uint256,uint256,address,bool)',
    topic0: TOPIC_LIQUIDATION_CALL,
    subjectTopic: 3,
    subjectName: 'borrower',
  },
];

/** Aave V3 `Borrow`: where to find real, active borrowers to make honest clean claims about. */
export const TOPIC_BORROW = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';

export function venueByKey(key: string): Venue {
  const v = VENUES.find((x) => x.key === key);
  if (!v) throw new Error(`unknown venue "${key}"; known: ${VENUES.map((x) => x.key).join(', ')}`);
  return v;
}

/**
 * Public Ethereum endpoints for log scanning, tried in order.
 *
 * Chosen by measurement, not reputation (2026-09-13, Aave V3 LiquidationCall at known heights):
 * Tenderly and mevblocker returned every log; nodies returned them for narrow ranges. `rpc.flashbots.net`
 * returned **zero logs, with no error, for every range asked** -- including a single block holding
 * four -- and publicnode answered 403. An endpoint that says "nothing" when something is there is
 * worse than one that fails, because a negative is exactly what an absence claim rests on, so both
 * are out, and `getLogsAdaptive` additionally canaries every endpoint before believing its silence.
 */
export const ETH_LOG_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://ethereum-public.nodies.app',
];

/**
 * Sepolia log endpoints. `ethereum-sepolia-rpc.publicnode.com` serves blocks from months ago but
 * returns no logs and no receipts for them -- measured on eleven LiquidationCall blocks from August --
 * and `rpc-sepolia.flashbots.net` returned zero for ranges holding logs. Neither is used. OnFinality
 * returned every log Tenderly did.
 */
export const SEPOLIA_LOG_RPCS = [
  'https://gateway.tenderly.co/public/sepolia',
  'https://eth-sepolia.api.onfinality.io/public',
  'https://ethereum-sepolia-public.nodies.app',
];

/** ERC-20 `Transfer`: present in almost every block, so an endpoint with none is not serving that depth. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
  opts: {
    corroboration?: number;
    minChunk?: number;
    timeoutMs?: number;
    onProgress?: (m: string) => void;
    /**
     * Every matching log is needed, not just one. A completeness question -- "is anything missing
     * from this list?" -- is a negative about the *remainder*, so one endpoint's partial answer is
     * not enough even when it found something. Requires `corroboration` endpoints to each cover the
     * whole range, unions them, and throws if they disagree on the count.
     */
    exhaustive?: boolean;
  } = {},
): Promise<any[]> {
  const { JsonRpcProvider } = await import('ethers');
  const corroboration = opts.corroboration ?? 2;
  const minChunk = opts.minChunk ?? 500;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.LOG_TIMEOUT_MS ?? 25_000);

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
  const counts: number[] = [];

  for (const url of urls) {
    try {
      // Canary: before an endpoint's answer can count, it must show it serves logs at the bottom of
      // the range at all. Pruned nodes answer old queries with an empty list, not an error.
      const probe = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
      const canary = await withTimeout(probe.getLogs({ topics: [TRANSFER_TOPIC], fromBlock, toBlock: fromBlock + 4 }));
      if (canary.length === 0) throw new Error(`${new URL(url).host} returned no Transfer logs at ${fromBlock}..${fromBlock + 4}: pruned or lossy, not counted`);
      opts.onProgress?.(`scanning ${fromBlock}..${toBlock} on ${new URL(url).host}`);
      const logs = await cover(url, fromBlock, toBlock);
      covered++;
      counts.push(new Set(logs.map((l) => `${l.transactionHash}:${l.index ?? l.logIndex}`)).size);
      for (const l of logs) seen.set(`${l.transactionHash}:${l.index ?? l.logIndex}`, l);
      // A positive is verified cryptographically downstream; for an existence question, act on it.
      if (!opts.exhaustive && seen.size > 0) break;
      // A negative -- or, when exhaustive, a complete list -- needs `corroboration` full covers.
      if (covered >= corroboration) break;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }

  if (opts.exhaustive) {
    if (covered < corroboration) {
      throw new Error(
        `only ${covered} endpoint(s) covered ${fromBlock}..${toBlock}; an exhaustive list needs ${corroboration} ` +
          `(${failures.join(' | ').slice(0, 200)})`,
      );
    }
    if (counts.some((c) => c !== seen.size)) {
      throw new Error(`endpoints disagree on ${fromBlock}..${toBlock}: ${counts.join(' vs ')} logs (union ${seen.size}); not treating either as complete`);
    }
  } else if (seen.size === 0 && covered < corroboration) {
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
