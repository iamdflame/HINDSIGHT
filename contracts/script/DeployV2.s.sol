// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV2} from "../src/AbsenceRegistryV2.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {MissingHeightBounty} from "../src/MissingHeightBounty.sol";
import {IMirror} from "../src/IMirror.sol";

/// @notice Deploys the second layer against the *existing* mirror.
///
/// @dev The mirror address is passed in rather than deployed. That is the whole point of this
///      script: the archive is the expensive thing, it is already on-chain, and redeploying it to
///      gain a registry feature would throw away every root in it. Everything here is additive.
contract DeployV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address mirrorAddr = vm.envAddress("MIRROR");

        vm.startBroadcast(pk);

        AbsenceRegistryV2 registry = new AbsenceRegistryV2(EthereumMirror(mirrorAddr));
        UnderwritingDesk desk = new UnderwritingDesk(IMirror(mirrorAddr), registry);
        MissingHeightBounty bounty = new MissingHeightBounty(EthereumMirror(mirrorAddr));

        vm.stopBroadcast();

        console.log("EthereumMirror (existing):", mirrorAddr);
        console.log("AbsenceRegistryV2       :", address(registry));
        console.log("UnderwritingDesk        :", address(desk));
        console.log("MissingHeightBounty     :", address(bounty));
        console.log("chainId                 :", block.chainid);
    }
}
