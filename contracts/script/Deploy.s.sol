// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistry} from "../src/AbsenceRegistry.sol";

/// @notice Deploys the mirror and the absence registry to Creditcoin.
/// @dev Neither contract has an owner, an admin key, a pause switch or an upgrade path. Once
///      deployed there is nothing for the deployer to retain, which is the point: the archive has
///      to be something other parties can rely on without relying on us.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        EthereumMirror mirror = new EthereumMirror();
        AbsenceRegistry registry = new AbsenceRegistry(mirror);

        vm.stopBroadcast();

        console.log("EthereumMirror :", address(mirror));
        console.log("AbsenceRegistry:", address(registry));
        console.log("chainId        :", block.chainid);
    }
}
