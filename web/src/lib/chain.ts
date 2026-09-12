import { JsonRpcProvider, BrowserProvider, Contract, type Eip1193Provider } from 'ethers';
import deployments from '../../../deployments.json';

export const CC_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const CC_CHAIN_ID = 102031;
export const EXPLORER = 'https://creditcoin-testnet.blockscout.com';
export const ETHERSCAN = 'https://etherscan.io';

/** Public Ethereum endpoints, tried in order. No key required, so a visitor needs no setup. */
export const ETH_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
];

export const PROVER = 'https://prover.cc3-testnet.creditcoin.network';

export const CHAIN_KEY_ETH_MAINNET = 3;

/** Creditcoin block the archive was deployed at. Event queries start here rather than genesis:
 *  scanning millions of empty blocks makes the public RPC refuse the request outright. */
export const DEPLOY_BLOCK: number = (deployments as any).deployBlock ?? 0;

export const MIRROR_ADDRESS: string = deployments.contracts.EthereumMirror;
// V2 binds a *list* of adjacent spans, so a claim can cover more than one 5,000-block seal.
// The mirror is unchanged and still holds the whole archive; only the registry was redeployed.
export const REGISTRY_ADDRESS: string =
  (deployments as any).contracts.AbsenceRegistryV2 ?? deployments.contracts.AbsenceRegistry;
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
  'function claimOf(uint256) view returns ((address claimant, address refuter, uint64 chainKey, address venue, bytes32 topic0, bytes32 subject, uint8 subjectTopic, uint64 spanFrom, uint64 spanTo, bytes32 spansHash, uint256 bond, uint256 bondStaked, uint64 openUntil, uint8 status))',
  'function holds(uint256) view returns (bool)',
  'function holdsWithBond(uint256, uint256) view returns (bool)',
  'function MIN_BOND() view returns (uint256)',
  'function MIN_WINDOW() view returns (uint64)',
  'function assertAbsence(uint256[], address, bytes32, bytes32, uint8, uint64) payable returns (uint256)',
  'function commitmentFor(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32, address) pure returns (bytes32)',
  'function commitRefutation(bytes32)',
  'function revealRefutation(uint256, uint64, bytes, (bytes32 hash, bool isLeft)[], bytes32)',
];

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
