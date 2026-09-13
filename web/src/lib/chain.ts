import { JsonRpcProvider, BrowserProvider, Contract, type Eip1193Provider } from 'ethers';
import deployments from '../../../deployments.json';

export const CC_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const CC_CHAIN_ID = 102031;
export const EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export const ETHERSCAN = 'https://etherscan.io';

/** Public Ethereum endpoints, tried in order. No key required, so a visitor needs no setup. */
export const ETH_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
];

/** Sepolia, the second source chain the archive holds. */
export const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://gateway.tenderly.co/public/sepolia',
];

export const PROVER = 'https://prover.cc3-testnet.creditcoin.network';

export const CHAIN_KEY_ETH_MAINNET = 3;
export const CHAIN_KEY_SEPOLIA = 1;

/** The chain-info precompile, for the attested head. */
export const CHAIN_INFO = '0x0000000000000000000000000000000000000FD3';

/** Creditcoin block the archive was deployed at. Event queries start here rather than genesis:
 *  scanning millions of empty blocks makes the public RPC refuse the request outright. */
export const DEPLOY_BLOCK: number = (deployments as any).deployBlock ?? 0;
/** Creditcoin block the current registry was deployed at: where its event scans start. */
export const REGISTRY_DEPLOY_BLOCK: number = (deployments as any).registryDeployBlock ?? DEPLOY_BLOCK;

/**
 * Empty Ethereum blocks inside the archive, measured by `worker/src/measure.ts`. Mirror v2 holds
 * them like any other height (a zero root is a real root), so they no longer subtract from the
 * count or break a span. They are kept so the record can still draw them as what they are.
 */
export const EMPTY_BLOCK_HEIGHTS: number[] = (deployments as any).measured?.emptyBlockHeights ?? [];
export const MIRROR_VERSION: number = (deployments as any).mirrorVersion ?? 1;
export { CONTINUITY_BY_AGE, continuityAt, WIDEST_CALL_ROOTS } from './record';
export const V1_ADDRESSES: Record<string, string> = (deployments as any).contracts?.v1 ?? {};

export const MIRROR_ADDRESS: string = deployments.contracts.EthereumMirror;
export const REGISTRY_ADDRESS: string = (deployments as any).contracts.AbsenceRegistryV3;
export const DESK_ADDRESS: string = (deployments as any).contracts.UnderwritingDesk ?? '';
export const BOUNTY_ADDRESS: string = (deployments as any).contracts.MissingHeightBounty ?? '';
export const BLOCK_PROVER = '0x0000000000000000000000000000000000000FD2';

/** Real Ethereum mainnet venues. Nothing here is deployed or controlled by this project. */
export const VENUES = [
  {
    label: 'Aave V3 Pool',
    address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    events: [
      { label: 'LiquidationCall', topic0: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286', subjectTopic: 3, subjectName: 'borrower' },
      { label: 'Repay', topic0: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051', subjectTopic: 2, subjectName: 'borrower' },
      { label: 'Borrow', topic0: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0', subjectTopic: 2, subjectName: 'borrower' },
    ],
  },
  {
    label: 'Morpho Blue',
    address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    events: [
      { label: 'Liquidate', topic0: '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41', subjectTopic: 3, subjectName: 'borrower' },
    ],
  },
  {
    label: 'Compound V3 cUSDCv3',
    address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    events: [
      { label: 'AbsorbDebt', topic0: '0x1547a878dc89ad3c367b6338b4be6a65a5dd74fb77ae044da1e8747ef1f4f62f', subjectTopic: 2, subjectName: 'borrower' },
    ],
  },
  {
    // Sepolia's own Aave V3 pool. A claim here is chainKey 1: a different file from any mainnet claim.
    label: 'Aave V3 Pool (Sepolia)',
    address: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    events: [
      { label: 'LiquidationCall', topic0: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286', subjectTopic: 3, subjectName: 'borrower' },
    ],
  },
] as const;

export const MIRROR_ABI = [
  'function rootOf(uint64, uint64) view returns (bytes32)',
  'function isMirrored(uint64, uint64) view returns (bool)',
  'function mirroredBlocks(uint64) view returns (uint64)',
  'function highestMirrored(uint64) view returns (uint64)',
  'function lowestMirrored(uint64) view returns (uint64)',
  'function contiguousFrom(uint64, uint64, uint64) view returns (uint64)',
  'function spanCount() view returns (uint256)',
  'function spanOf(uint256) view returns (uint64 chainKey, uint64 fromBlock, uint64 toBlock)',
  'function MAX_SEAL_WINDOW() view returns (uint64)',
  'function heldWord(uint64, uint64) view returns (uint256)',
  'function verifyOrRevert(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (uint64)',
  'function tryVerify(uint64, uint64, bytes, (bytes32 hash, bool isLeft)[]) view returns (bool, uint64)',
  'function mirror(uint64, uint64, bytes, bytes32, (bytes32 hash, bool isLeft)[], bytes32, bytes32[]) returns (uint64)',
  'function sealSpan(uint64, uint64, uint64) returns (uint256)',
  'event BlocksMirrored(uint64 indexed chainKey, uint64 indexed fromBlock, uint64 indexed toBlock, uint64 newlyAdded)',
  'event SpanSealed(uint256 indexed spanId, uint64 indexed chainKey, uint64 fromBlock, uint64 toBlock)',
];

export const REGISTRY_ABI = [
  'function claimCount() view returns (uint256)',
  'function assurance(uint256) view returns (uint8 status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)',
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status, uint8 kind, uint32 members, bytes32 membersHash))',
  'function holds(uint256) view returns (bool)',
  'function holdsWithBond(uint256, uint256) view returns (bool)',
  'function kind(uint256) view returns (uint8)',
  'function enforceableLoss(uint256) view returns (uint256)',
  'function isUsable(uint256, uint256) view returns (bool)',
  'function memberCount(uint256) view returns (uint256)',
  'function MIN_BOND() view returns (uint256)',
  'function MIN_WINDOW() view returns (uint64)',
  'function REFUTER_SHARE_BPS() view returns (uint256)',
  'function assertAbsence(uint256[], address, bytes32, bytes32, uint8, uint64) payable returns (uint256)',
  'function assertComplete(uint256[], address, bytes32, bytes32, uint8, uint64, (uint64 height, uint32 logIndex, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings)[]) payable returns (uint256)',
  'function commitmentFor(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32, address) pure returns (bytes32)',
  'function commitmentForComplete(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32, address) pure returns (bytes32)',
  'function commitRefutation(bytes32)',
  'function revealRefutation(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32)',
  'function revealOmission(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], uint32, (uint64 height, uint64 txIndex, uint32 logIndex)[], bytes32)',
  'function finalize(uint256)',
  'function keyOf(uint64 chainKey, address venue, bytes32 topic0, uint8 subjectTopic, bytes32 subject) pure returns (bytes32)',
  'function recordOf(bytes32 key) view returns (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total)',
  'function claimUnderKey(bytes32 key, uint256 index) view returns (uint256)',
  'function owed(address) view returns (uint256)',
  'function withdraw()',
  'event MembersListed(uint256 indexed claimId, (uint64 height, uint64 txIndex, uint32 logIndex)[] members)',
  'event AbsenceRefuted(uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 paidToRefuter, uint256 burned)',
];

export const DESK_ABI = [
  'function policyCount() view returns (uint256)',
  'function policyOf(uint256) view returns ((uint8 kind, uint64 chainKey, uint64 window, uint64 maxStaleness, address venue, bytes32 topic0, uint8 subjectTopic, uint256 minBond, uint256 maxPrincipal, bool requiresBinding))',
  'function assess(address subject, uint256 policyId, uint256 principal, uint256[] spanIds) view returns (bool ok, uint8 reason)',
  'function borrow(uint256 policyId, uint256 principal, uint256[] spanIds)',
  'function lent(address, uint256) view returns (bool)',
  'function totalOutstanding() view returns (uint256)',
  'function securityBudget(uint64 chainKey) view returns (uint32 attestors, uint128 minBond, uint256 cap)',
  'function MAX_CLAIM_SCAN() view returns (uint256)',
  'function MAX_SPANS() view returns (uint256)',
  'function LEVERAGE_ON_ENFORCEABLE_LOSS() view returns (uint256)',
];

/** `UnderwritingDesk.Refusal`, in declaration order. Appended to, never reordered. */
export const REFUSAL = [
  'None',
  'NoSuchPolicy',
  'ArchiveTooShallow',
  'ClaimUnderHunt',
  'ProvenLiar',
  'NoBondedCleanliness',
  'DeskOutOfFunds',
  'EventOnRecord',
  'AlreadyLent',
  'NeedsBondedCover',
  'PoolCapReached',
  'UnprovenSubject',
] as const;

export type Span = { id: number; from: number; to: number };

/**
 * The sealed ranges a caller hands the desk to prove a policy's window.
 *
 * Proving that a stretch of history has no gap costs one storage read per 256 heights; `sealSpan`
 * paid that once and recorded the answer, so the desk reads the receipt instead of redoing the walk.
 * Offering spans is not a permission -- anyone can seal, anyone can pass them, and the desk checks
 * for itself that they are adjacent, on the policy's chain, long enough, and still reaching the head.
 */
export async function sealedSpans(mirror: Contract, chainKey: number): Promise<Span[]> {
  const n = Number(await mirror.spanCount());
  const all = await Promise.all(Array.from({ length: n }, (_, i) => mirror.spanOf(i)));
  return all
    .map((s: any, id: number) => ({ id, chainKey: Number(s.chainKey), from: Number(s.fromBlock), to: Number(s.toBlock) }))
    .filter((s) => s.chainKey === chainKey)
    .map(({ id, from, to }) => ({ id, from, to }));
}

/** The shortest adjacent run of sealed spans covering `window` heights and reaching highest. */
export function spanOffer(spans: Span[], window: number, maxSpans = 8): { ids: number[]; from: number; to: number } | null {
  let top: Span | undefined;
  for (const s of spans) if (!top || s.to > top.to || (s.to === top.to && s.from < top.from)) top = s;
  if (!top) return null;
  const ids = [top.id];
  let from = top.from;
  while (top.to - from < window && ids.length < maxSpans) {
    const below = spans.find((s) => s.to + 1 === from && s.id !== top!.id);
    if (!below) break;
    from = below.from;
    ids.unshift(below.id);
  }
  return top.to - from < window ? null : { ids, from, to: top.to };
}

// The precompile's real selector is snake_case; the SDK's camelCase is a wrapper.
const CHAIN_INFO_ABI = ['function get_latest_attestation_height_and_hash(uint64) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists))'];

let _cc: JsonRpcProvider | null = null;
export function creditcoin(): JsonRpcProvider {
  if (!_cc) _cc = new JsonRpcProvider(CC_RPC, { chainId: CC_CHAIN_ID, name: 'creditcoin-testnet' }, { staticNetwork: true });
  return _cc;
}

/** Ethereum provider with failover: public endpoints rate-limit and occasionally refuse archive
 *  reads, and a visitor should not have to care which one is healthy. */
let _ethIdx = 0;
let _eth: JsonRpcProvider | null = null;
export function ethereum(): JsonRpcProvider {
  if (!_eth) _eth = new JsonRpcProvider(ETH_RPCS[_ethIdx], { chainId: 1, name: 'mainnet' }, { staticNetwork: true });
  return _eth;
}
export function rotateEthereum(): boolean {
  if (_ethIdx >= ETH_RPCS.length - 1) return false;
  _ethIdx += 1;
  _eth = null;
  return true;
}
export function currentEthRpc(): string { return ETH_RPCS[_ethIdx]; }

let _sep: JsonRpcProvider | null = null;
export function sepolia(): JsonRpcProvider {
  if (!_sep) _sep = new JsonRpcProvider(SEPOLIA_RPCS[0], undefined, { staticNetwork: true });
  return _sep;
}

/** The last source-chain height Attestcoin has attested, read from the precompile. */
export async function attestedHead(chainKey: number): Promise<number> {
  const c = new Contract(CHAIN_INFO, CHAIN_INFO_ABI, creditcoin());
  const r = await c.get_latest_attestation_height_and_hash(chainKey);
  return Number(r[0]?.height ?? r[0]?.[0] ?? r[0]);
}

export function deskContract(runner: any = creditcoin()) {
  return new Contract(DESK_ADDRESS, DESK_ABI, runner);
}

export function mirrorContract(runner: any = creditcoin()) {
  return new Contract(MIRROR_ADDRESS, MIRROR_ABI, runner);
}
export function registryContract(runner: any = creditcoin()) {
  return new Contract(REGISTRY_ADDRESS, REGISTRY_ABI, runner);
}

export type WalletState =
  | { kind: 'absent' }
  | { kind: 'wrong-network'; chainId: number }
  | { kind: 'ready'; address: string; provider: BrowserProvider };

export async function connectWallet(): Promise<WalletState> {
  const inj = (window as any).ethereum as Eip1193Provider | undefined;
  if (!inj) return { kind: 'absent' };
  const provider = new BrowserProvider(inj);
  await provider.send('eth_requestAccounts', []);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CC_CHAIN_ID) return { kind: 'wrong-network', chainId: Number(net.chainId) };
  const signer = await provider.getSigner();
  return { kind: 'ready', address: await signer.getAddress(), provider };
}

/** Offer to add/switch to Creditcoin testnet rather than telling the visitor to do it by hand. */
export async function switchToCreditcoin(): Promise<void> {
  const inj = (window as any).ethereum as any;
  if (!inj) throw new Error('No wallet found');
  const hex = '0x' + CC_CHAIN_ID.toString(16);
  try {
    await inj.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code !== 4902) throw e;
    await inj.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: 'Creditcoin Testnet',
        nativeCurrency: { name: 'Test CTC', symbol: 'tCTC', decimals: 18 },
        rpcUrls: [CC_RPC],
        blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}
