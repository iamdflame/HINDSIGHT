/**
 * Deploy the second layer against the existing mirror.
 *
 * Usage:
 *   node src/deploy-v2.ts [--dry-run]
 *
 * The mirror is NOT redeployed. It holds the archive, the archive is the expensive thing, and
 * redeploying it to gain a registry feature would discard every root in it. `AbsenceRegistryV2`,
 * `UnderwritingDesk` and `MissingHeightBounty` are all additive and point at the mirror already on
 * chain.
 *
 * This exists instead of `forge script` because Creditcoin's Substrate EVM does not set
 * `prevrandao` in its block headers, and forge's simulation refuses to run against a chain whose
 * headers fail its validation ("header validation error: `prevrandao` not set"). Deploying straight
 * from the compiled artifacts with ethers sidesteps the simulation entirely and is reproducible by
 * anyone with `forge build` output.
 */
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { CC_RPC, MIRROR, EXPLORER, privateKey } from './config.ts';

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

  console.log('deploying against the existing mirror');
  console.log('  mirror  :', MIRROR);
  console.log('  deployer:', wallet.address);
  console.log('  balance :', (await provider.getBalance(wallet.address)) / 10n ** 18n, 'tCTC');
  if (dryRun) {
    console.log('  DRY RUN — nothing will be deployed');
    return;
  }

  const deployed: Record<string, string> = {};

  const deploy = async (file: string, name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const factory = new ContractFactory(abi, bytecode, wallet);
    const c = await factory.deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    const addr = await c.getAddress();
    deployed[name] = addr;
    console.log(`  ${name.padEnd(20)} ${addr}  ${Number(rc!.gasUsed).toLocaleString()} gas`);
    return addr;
  };

  const registry = await deploy('AbsenceRegistryV2.sol', 'AbsenceRegistryV2', [MIRROR]);
  await deploy('UnderwritingDesk.sol', 'UnderwritingDesk', [MIRROR, registry]);
  await deploy('MissingHeightBounty.sol', 'MissingHeightBounty', [MIRROR]);

  // Record them where every other part of the system reads addresses from.
  const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  Object.assign(d.contracts, deployed);
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + '\n');
  console.log('\n  recorded in deployments.json');
  for (const [k, v] of Object.entries(deployed)) console.log(`  ${EXPLORER}/address/${v}  ${k}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
