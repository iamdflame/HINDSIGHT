/**
 * Independence: verification with the proving service dead and the precompile deleted.
 *
 * The archive's whole claim is that once a block is notarised, answering a question about it needs
 * neither Gluwa's prover nor the block-prover precompile nor us. Two thirds of that is easy to show
 * in a browser -- rebuild the Merkle path from a public Ethereum node, call a `view` function. The
 * third has always been a Foundry test (`vm.etch(0x0FD2, "")`), which a judge has to take on trust.
 *
 * It does not have to be. Creditcoin's RPC honours `eth_call` state overrides, so the precompile can
 * be deleted *inside the very call that verifies*, against live chain state, on demand.
 *
 * That invites an obvious objection -- "the node ignored your override" -- so `verifyWithOverrides`
 * is always run twice: once with `0x0FD2` blanked, and once with the *mirror itself* blanked. If
 * overrides were being ignored, the second call would succeed too. It must not, and the page shows
 * both results side by side. The control is the point; without it this is theatre.
 */
import { Interface } from 'ethers';
import { CC_RPC, MIRROR_ADDRESS, BLOCK_PROVER, CHAIN_KEY_ETH_MAINNET } from './chain';
import type { Sibling } from './proof';

const iface = new Interface([
  'function verifyOrRevert(uint64 chainKey, uint64 blockNumber, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) view returns (uint64 txIndex)',
]);

export type OverrideResult = {
  ok: boolean;
  txIndex?: number;
  /** Raw JSON-RPC error message when the call failed, for display without interpretation. */
  error?: string;
};

type StateOverride = Record<string, { code?: string; balance?: string }>;

async function ethCall(data: string, overrides?: StateOverride): Promise<OverrideResult> {
  const params: unknown[] = [{ to: MIRROR_ADDRESS, data }, 'latest'];
  if (overrides) params.push(overrides);

  const res = await fetch(CC_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params }),
  });
  const body = await res.json();

  if (body.error) return { ok: false, error: String(body.error.message ?? body.error) };
  // A blanked contract returns empty data rather than reverting: no code, nothing to run.
  if (!body.result || body.result === '0x') return { ok: false, error: 'empty return (no code at target)' };

  try {
    const [txIndex] = iface.decodeFunctionResult('verifyOrRevert', body.result);
    return { ok: true, txIndex: Number(txIndex) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function encode(blockNumber: number, txBytes: string, siblings: Sibling[]): string {
  return iface.encodeFunctionData('verifyOrRevert', [
    CHAIN_KEY_ETH_MAINNET,
    blockNumber,
    txBytes,
    siblings.map((s) => [s.hash, s.isLeft]),
  ]);
}

/** Verify normally, with no overrides at all. */
export function verifyPlain(blockNumber: number, txBytes: string, siblings: Sibling[]) {
  return ethCall(encode(blockNumber, txBytes, siblings));
}

/** Verify with the block-prover precompile deleted for the duration of the call. */
export function verifyWithoutPrecompile(blockNumber: number, txBytes: string, siblings: Sibling[]) {
  return ethCall(encode(blockNumber, txBytes, siblings), { [BLOCK_PROVER]: { code: '0x' } });
}

/**
 * The control. Blanks the mirror instead of the precompile.
 *
 * If this succeeds, the node is ignoring state overrides and the result above proves nothing. It
 * is run every time, and its *failure* is what makes the precompile result meaningful.
 */
export function verifyWithMirrorBlanked(blockNumber: number, txBytes: string, siblings: Sibling[]) {
  return ethCall(encode(blockNumber, txBytes, siblings), { [MIRROR_ADDRESS]: { code: '0x' } });
}

/** Corrupt one sibling, so the path no longer meets the notarised root. */
export function tamperSibling(siblings: Sibling[], level = 0): Sibling[] {
  const out = siblings.map((s) => ({ ...s }));
  if (out.length === 0) return out;
  const i = Math.min(level, out.length - 1);
  const flipped = (BigInt(out[i].hash) ^ 1n).toString(16).padStart(64, '0');
  out[i] = { ...out[i], hash: '0x' + flipped };
  return out;
}
