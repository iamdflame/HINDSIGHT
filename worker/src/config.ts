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
