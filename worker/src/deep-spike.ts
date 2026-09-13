/**
 * Spike: can a continuity proof built entirely from public data be accepted by `0x0FD2`?
 *
 * Usage: node src/deep-spike.ts [--interval <height>]
 *
 * The hosted prover only serves ~108.5 days and its floor rises daily, so the archive cannot be
 * repaired or deepened through it. Creditcoin stores a continuity checkpoint every 1,000 blocks,
 * readable from `0x0FD3`, and public Ethereum nodes still serve receipts a year back -- so the roots
 * and the chain between two checkpoints can be computed here instead.
 *
 * This spends no gas. It:
 *   1. checks locally computed roots against roots the mirror already holds (proving the computation),
 *   2. builds a proof for one checkpoint interval from public data alone,
 *   3. simulates `mirror()` with `eth_call` and reports what the precompile says.
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { CC_RPC, MIRROR, MIRROR_ABI, LOG_RPCS, CHAIN_KEY_ETH_MAINNET } from './config.ts';

const sdkMod = await import('@gluwa/usc-sdk/dist/index.js');
const sdk: any = (sdkMod as any).proofProvider ? sdkMod : (sdkMod as any).default;
const { proofProvider, chainInfo, encoding } = sdk;
const { computeMerkleRootOfBlock, KeccakMerkleTree } = proofProvider.merkle;
const { SimpleBlockProvider } = proofProvider.raw.blockProvider;

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const eths = LOG_RPCS[CHAIN_KEY_ETH_MAINNET].map((u) => new JsonRpcProvider(u, 1, { staticNetwork: true }));
const providers = eths.map((p) => new SimpleBlockProvider(p));

/** One block's transaction-Merkle root, computed from a public node. Empty blocks have no root. */
async function rootOf(height: number, attempt = 0): Promise<{ root: string; txs: any[]; receipts: any[] }> {
  const bp = providers[(height + attempt) % providers.length];
  try {
    const withReceipts = await bp.getBlockWithReceipts(height);
    if (!withReceipts) throw new Error('block unavailable');
    const { transactions, receipts } = withReceipts;
    if (transactions.length === 0) return { root: '0x' + '00'.repeat(32), txs: [], receipts: [] };
    return { root: computeMerkleRootOfBlock(transactions, receipts, encoding.EncodingVersion.V1), txs: transactions, receipts };
  } catch (e) {
    if (attempt >= providers.length * 2) throw e;
    return rootOf(height, attempt + 1);
  }
}

async function pool<T>(items: number[], width: number, f: (h: number) => Promise<T>): Promise<T[]> {
  const out = new Array<T>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await f(items[i]);
      }
    }),
  );
  return out;
}

async function main() {
  const cc = new JsonRpcProvider(CC_RPC);
  const mirror = new Contract(MIRROR, MIRROR_ABI, cc);
  const info = new chainInfo.PrecompileChainInfoProvider(cc);

  // ---- 1. the computation itself, checked against roots Creditcoin already holds ----------------
  const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
  const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));
  const samples = [high - 11, Math.floor((low + high) / 2), low + 7];
  console.log('checking local root computation against the mirror');
  for (const h of samples) {
    if (!(await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, h))) {
      console.log(`  ${h}: not held, skipped`);
      continue;
    }
    const [held, local] = await Promise.all([mirror.rootOf(CHAIN_KEY_ETH_MAINNET, h), rootOf(h)]);
    const same = String(held).toLowerCase() === local.root.toLowerCase();
    console.log(`  ${h}: ${same ? 'MATCH' : `DIFFER held ${held} local ${local.root}`}`);
    if (!same) throw new Error('local root computation does not reproduce a held root; stop');
  }

  // ---- 2. one checkpoint interval, built from public data alone ---------------------------------
  const at = Number(get('--interval') ?? low - 500);
  const bounds: any = await info.getContinuityBounds(CHAIN_KEY_ETH_MAINNET, at);
  const parent = Number(bounds.parentHeight);
  const child = Number(bounds.childHeight);
  console.log(
    `\ninterval around ${at.toLocaleString()}: checkpoint ${parent.toLocaleString()} ` +
      `(${bounds.parentIsAttestation ? 'attestation' : 'checkpoint'}) → ${child.toLocaleString()} ` +
      `(${bounds.childIsAttestation ? 'attestation' : 'checkpoint'}), ${child - parent} blocks`,
  );

  const heights = Array.from({ length: child - parent }, (_, i) => parent + 1 + i);
  const t0 = Date.now();
  const blocks = await pool(heights, 10, (h) => rootOf(h));
  console.log(`  fetched and hashed ${blocks.length} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const roots = blocks.map((b) => b.root);
  const anchor = blocks[0];
  if (anchor.txs.length === 0) throw new Error(`block ${parent + 1} is empty: no anchor transaction (handled by the worker, not this spike)`);
  const leaves = anchor.txs.map((t: any, i: number) => encoding.abiEncode(t, anchor.receipts[i], encoding.EncodingVersion.V1).abi);
  const proof = new KeccakMerkleTree(leaves).getProof(0);
  const siblings = proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));

  // ---- 3. ask the precompile, without spending gas ----------------------------------------------
  const call = [
    CHAIN_KEY_ETH_MAINNET,
    parent + 1,
    leaves[0],
    roots[0],
    siblings,
    bounds.parentHash,
    roots,
  ] as const;

  for (const [label, args] of [
    ['roots to the child checkpoint', call],
    ['roots stopping short (900)', [...call.slice(0, 6), roots.slice(0, 900)] as any],
  ] as [string, any][]) {
    try {
      const added = await mirror.mirror.staticCall(...args);
      console.log(`  ${label}: ACCEPTED, would retain ${Number(added).toLocaleString()} heights`);
    } catch (e) {
      console.log(`  ${label}: rejected — ${String((e as Error).message).slice(0, 180)}`);
    }
  }

  const gas = await mirror.mirror.estimateGas(...call).catch((e: Error) => e.message.slice(0, 80));
  console.log(`  estimated gas for ${roots.length} roots: ${typeof gas === 'bigint' ? Number(gas).toLocaleString() : gas}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
