// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {MissingHeightBounty} from "../src/MissingHeightBounty.sol";

/// @notice Mirror v2 and the bounty that extends it. Everything else (registry, desk) is deployed
///         against these addresses afterwards, once they are known.
/// @dev Kept for reference; Creditcoin's Substrate EVM sets no prevrandao and forge's simulation
///      refuses it, so the live deploy runs through `worker/src/deploy-mirror-v2.ts` from the same
///      artifacts.
contract DeployMirrorV2 is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        EthereumMirror mirror = new EthereumMirror();
        MissingHeightBounty bounty = new MissingHeightBounty(mirror);
        vm.stopBroadcast();
        console.log("EthereumMirror v2   :", address(mirror));
        console.log("MissingHeightBounty :", address(bounty));
    }
}
