/**
 * Deploy Mirror v2 and its bounty, and record them.
 *
 * Usage:
 *   node src/deploy-mirror-v2.ts [--dry-run]
 *
 * v1 stays on chain and stays cited: it holds 100,801 roots and the evidence of the first
 * refutations. But v1 cannot tell a held empty block from an absent one, and that single defect
 * capped an honest absence window at 61.5 hours. v2 fixes it with a held bitmap and a 2^17-block
 * seal window. The archive is rebuilt by the campaign against the new address; nothing is migrated,
 * because there is nothing to migrate that a fresh continuity proof does not certify better.
 *
 * `deployments.json` keeps the v1 addresses under `contracts.v1` so every historical link in
 * CLAIMS.md still resolves, and every reader of `contracts.EthereumMirror` gets v2.
 */
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, EXPLORER, privateKey } from './config.ts';

const OUT = new URL('../../contracts/out/', import.meta.url);
const DEPLOYMENTS = new URL('../../deployments.json', import.meta.url);

function artifact(file: string, name: string) {
  const j = JSON.parse(readFileSync(new URL(`${file}/${name}.json`, OUT), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object as string };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const provider = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), provider);
  const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));

  console.log('deploying Mirror v2');
  console.log('  deployer:', wallet.address);
  console.log('  balance :', (await provider.getBalance(wallet.address)) / 10n ** 18n, 'tCTC');
  console.log('  v1 mirror stays at', d.contracts.EthereumMirror);
  if (dryRun) return;

  const deploy = async (file: string, name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const c = await new ContractFactory(abi, bytecode, wallet).deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    const addr = await c.getAddress();
    console.log(`  ${name.padEnd(20)} ${addr}  ${Number(rc!.gasUsed).toLocaleString()} gas  block ${rc!.blockNumber}`);
    return { addr, block: rc!.blockNumber };
  };

  const mirror = await deploy('EthereumMirror.sol', 'EthereumMirror', []);
  const bounty = await deploy('MissingHeightBounty.sol', 'MissingHeightBounty', [mirror.addr]);

  // Preserve v1 for the historical record; point everything live at v2.
  d.contracts.v1 = d.contracts.v1 ?? {
    EthereumMirror: d.contracts.EthereumMirror,
    AbsenceRegistry: d.contracts.AbsenceRegistry,
    AbsenceRegistryV2: d.contracts.AbsenceRegistryV2,
    UnderwritingDesk: d.contracts.UnderwritingDesk,
    UnderwritingDesk_v1: d.contracts.UnderwritingDesk_v1,
    MissingHeightBounty: d.contracts.MissingHeightBounty,
    deployBlock: d.deployBlock,
  };
  delete d.contracts.UnderwritingDesk_v1;
  d.contracts.EthereumMirror = mirror.addr;
  d.contracts.MissingHeightBounty = bounty.addr;
  d.deployBlock = mirror.block;
  d.mirrorVersion = 2;
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + '\n');

  console.log('\n  recorded in deployments.json (v1 kept under contracts.v1)');
  console.log(`  ${EXPLORER}/address/${mirror.addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
