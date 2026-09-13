// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {IMirror} from "../src/IMirror.sol";
import {IMirrorSpans} from "../src/IMirrorSpans.sol";

/// @notice Registry v3 and the desk, against an already-deployed Mirror v2.
/// @dev Reference only: Creditcoin's Substrate EVM sets no prevrandao and forge's simulation
///      refuses it. The live deploy runs through `worker/src/deploy-v3.ts` from the same artifacts.
contract DeployV3 is Script {
    function run() external {
        address mirrorAddr = vm.envAddress("MIRROR");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        AbsenceRegistryV3 registry = new AbsenceRegistryV3(EthereumMirror(mirrorAddr));
        UnderwritingDesk desk = new UnderwritingDesk(IMirrorSpans(mirrorAddr), registry);
        vm.stopBroadcast();
        console.log("AbsenceRegistryV3 :", address(registry));
        console.log("UnderwritingDesk  :", address(desk));
    }
}
