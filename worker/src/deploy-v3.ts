/**
 * Deploy the completeness market and the desk against Mirror v2.
 *
 * Usage:
 *   node src/deploy-v3.ts [--desk-only] [--with-binding] [--dry-run]
 *   node src/deploy-v3.ts --cover-only                 deploy Cover against the registry, nothing else
 *
 * `--desk-only` redeploys `UnderwritingDesk` against the registry already on chain. Claims, bonds
 * and spans live in the registry and the mirror; the desk holds nothing but its policies and a
 * float, so replacing it discards nothing a hunter or a claimant owns. The address it replaces is
 * kept under `contracts.superseded` with the reason, because a link in an old transcript should
 * still resolve to something that explains itself.
 *
 * `--with-binding` also deploys a fresh `SubjectBinding` and points the desk at it. Bindings are facts
 * about key custody at an Ethereum height, re-provable from the same transaction by anyone, so nothing
 * is lost by replacing the contract; the old one stays under `contracts.superseded` all the same.
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
  const deskOnly = process.argv.includes('--desk-only');
  const coverOnly = process.argv.includes('--cover-only');
  const reasonArg = process.argv.indexOf('--reason');
  const reason = reasonArg >= 0 ? process.argv[reasonArg + 1] : '';
  const provider = new JsonRpcProvider(CC_RPC);
  const wallet = new Wallet(privateKey(), provider);
  const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));

  console.log(deskOnly ? 'redeploying the desk against the existing registry' : 'deploying registry v3 and the desk');
  console.log('  mirror  :', MIRROR);
  if (deskOnly) console.log('  registry:', d.contracts.AbsenceRegistryV3);
  console.log('  deployer:', wallet.address);
  console.log('  balance :', (await provider.getBalance(wallet.address)) / 10n ** 18n, 'tCTC');
  if (deskOnly && !d.contracts.AbsenceRegistryV3) throw new Error('--desk-only needs contracts.AbsenceRegistryV3 in deployments.json');
  if (!coverOnly && d.contracts.UnderwritingDesk && !reason) throw new Error('this replaces live contracts: pass --reason "<why>" so the record explains itself');
  if (coverOnly && d.contracts.Cover && !reason) throw new Error('this replaces the live Cover: pass --reason "<why>"');
  if (dryRun) {
    console.log('  DRY RUN — nothing will be deployed');
    return;
  }

  const deployed: Record<string, string> = {};
  const blocks: Record<string, number> = {};
  const deploy = async (file: string, name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(file, name);
    const c = await new ContractFactory(abi, bytecode, wallet).deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    const addr = await c.getAddress();
    deployed[name] = addr;
    blocks[name] = rc!.blockNumber;
    console.log(`  ${name.padEnd(20)} ${addr}  ${Number(rc!.gasUsed).toLocaleString()} gas  block ${rc!.blockNumber}`);
    return addr;
  };

  if (coverOnly) {
    await deploy('Cover.sol', 'Cover', [d.contracts.AbsenceRegistryV3]);
  } else {
  const registry = deskOnly ? d.contracts.AbsenceRegistryV3 : await deploy('AbsenceRegistryV3.sol', 'AbsenceRegistryV3', [MIRROR]);
  const withBinding = process.argv.includes('--with-binding') || !d.contracts.SubjectBinding;
  const binding = withBinding ? await deploy('SubjectBinding.sol', 'SubjectBinding', [MIRROR]) : d.contracts.SubjectBinding;
  await deploy('UnderwritingDesk.sol', 'UnderwritingDesk', [MIRROR, registry, binding]);
  }

  d.contracts.superseded = d.contracts.superseded ?? {};
  for (const [name, addr] of Object.entries(deployed)) {
    const previous: string | undefined = d.contracts[name];
    if (previous && previous.toLowerCase() !== addr.toLowerCase()) {
      d.contracts.superseded[`${name}@${previous.slice(0, 10)}`] = { address: previous, replacedBy: addr, reason };
    }
  }
  if (blocks.AbsenceRegistryV3) d.registryDeployBlock = blocks.AbsenceRegistryV3;
  Object.assign(d.contracts, deployed);
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + '\n');
  console.log('\n  recorded in deployments.json');
  for (const [k, v] of Object.entries(deployed)) console.log(`  ${EXPLORER}/address/${v}  ${k}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
