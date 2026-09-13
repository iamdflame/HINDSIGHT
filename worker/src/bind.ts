/**
 * Prove that a Creditcoin address speaks for an Ethereum address.
 *
 * Usage:
 *   node src/bind.ts --calldata 0x<creditcoin address>
 *       Print the 32 bytes an Ethereum address must sign (any transaction, e.g. a zero-value send to
 *       itself, with this as its data). Nothing is sent.
 *
 *   node src/bind.ts --tx 0x<ethereum tx hash> --chain 3|1 [--key ENV_VAR] [--dry-run]
 *       Build the transaction's Merkle path locally from a public Ethereum node, check the block is
 *       held, and call `SubjectBinding.bind`. Anyone may submit anyone's proof: the calldata names the
 *       controller, so submitting it can only bind the pair its signer chose.
 *
 * The leaf is built the way `local-proof.ts` and the browser build it -- block and receipts from a
 * public node, hashed with the SDK's encoder -- so this never touches the hosted prover. If the block
 * is not yet held, the answer is to wait for the follower, not to ask a service.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { readFileSync } from 'node:fs';
import { CC_RPC, EXPLORER, LOG_RPCS, CHAINS, privateKey } from './config.ts';
import { BlockPool, KeccakMerkleTree } from './blocks.ts';

const BINDING_ABI = [
  'function bindingCalldata(address controller) pure returns (bytes)',
  'function bind(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32 hash, bool isLeft)[] siblings) returns (address controller, address subject)',
  'function subjectFor(address controller, uint64 chainKey) view returns (address)',
  'function controllerOf(uint64 chainKey, address subject) view returns (address)',
  'function boundAtHeight(uint64 chainKey, address subject) view returns (uint64)',
  'error NotABindingTransaction()',
  'error TransactionReverted()',
  'error NotNewer(uint64 have, uint64 offered)',
  'error NotMirrored(uint64 chainKey, uint64 blockNumber)',
  'error ProofInvalid(uint64 chainKey, uint64 blockNumber)',
];

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const d = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'));
  const cc = new JsonRpcProvider(CC_RPC);
  const keyEnv = get('--key');
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !key) throw new Error(`--key ${keyEnv} is set but that variable is empty`);
  const binding = new Contract(d.contracts.SubjectBinding, BINDING_ABI, new Wallet(key ?? privateKey(), cc));

  const controller = get('--calldata');
  if (controller) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(controller)) throw new Error('--calldata takes the Creditcoin address that should speak for the signer');
    const data: string = await binding.bindingCalldata(controller);
    console.log('sign any Ethereum transaction with this as its data — a zero-value send to yourself is enough:');
    console.log('  ', data);
    console.log(`\nthen: node src/bind.ts --tx <hash> --chain 3   (once the follower holds that block)`);
    return;
  }

  const txHash = get('--tx');
  const chain = Number(get('--chain') ?? 3);
  if (!txHash) throw new Error('pass --calldata <address> or --tx <hash> --chain 3|1');
  const dryRun = process.argv.includes('--dry-run');

  const eth = new JsonRpcProvider((LOG_RPCS[chain] ?? [])[0], undefined, { staticNetwork: true });
  const receipt = await eth.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`${txHash} is not on ${CHAINS[chain].name}, or the node has not seen it`);
  const height = receipt.blockNumber;
  console.log(`${CHAINS[chain].name} tx ${txHash}`);
  console.log(`  block ${height.toLocaleString()} · index ${receipt.index} · status ${receipt.status}`);

  // The leaf and its path, from public data. Same code the deep backfill hashes roots with.
  const pool = new BlockPool(chain);
  const { leaves } = await pool.rootOf(height, true);
  if (!leaves || leaves.length === 0) throw new Error('block has no transactions');
  const tree = new KeccakMerkleTree(leaves);
  const proof = tree.getProof(receipt.index);
  const siblings = proof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft }));
  const encoded = leaves[receipt.index];
  console.log(`  leaf ${encoded.length / 2 - 1} bytes · ${siblings.length} siblings · root ${tree.getRoot().slice(0, 18)}…`);

  try {
    const [who, subject] = await binding.bind.staticCall(chain, height, encoded, siblings);
    console.log(`  would bind: ${who} speaks for ${subject}`);
  } catch (e: any) {
    const name = e?.revert?.name ?? e?.shortMessage ?? String(e?.message).slice(0, 120);
    const args = e?.revert?.args ? ` ${JSON.stringify(e.revert.args.map(String))}` : '';
    console.log(`  the binding contract refuses: ${name}${args}`);
    if (name === 'NotMirrored') console.log('  the block is not held yet — the follower will reach it; nothing to do but wait');
    process.exit(2);
  }
  if (dryRun) return;

  const tx = await binding.bind(chain, height, encoded, siblings);
  const rc = await tx.wait();
  console.log(`  bound  ${Number(rc.gasUsed).toLocaleString()} gas  ${EXPLORER}/tx/${tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
