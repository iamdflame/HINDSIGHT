# Integrating Hindsight

Your contract never calls `0x0FD2`. It asks the mirror, which already holds the root the precompile
certified once.

## The whole integration

```solidity
import {IMirror} from "hindsight/IMirror.sol";

uint64 index = IMirror(0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118).verifyOrRevert(
    3,            // chainKey: 3 = Ethereum mainnet, 1 = Sepolia
    height,       // the Ethereum block
    txBytes,      // Attestcoin-encoded transaction + receipt
    siblings      // its Merkle path
);
```

That is a `view`. It reverts if the transaction is not in the block — the same fail-closed habit as the
precompile — and returns the transaction's position in the block, recovered from the shape of the path.
Use `tryVerify` only when you genuinely mean to branch on a boolean.

Before relying on a height, ask `isMirrored(chainKey, height)`. If it is false, notarise it once with
`mirror(...)` (the one call that needs the prover's continuity proof and costs gas) and every question
about that block is free from then on, for you and for everyone else.

## A consumer that exists, outside this repository

[`iamdflame/hindsight-gate`](https://github.com/iamdflame/hindsight-gate) is a ~30-line `Gate` written
against the interfaces alone, copied byte-for-byte:

```solidity
contract Gate {
    uint64 public constant ETHEREUM = 3;
    IMirror public immutable MIRROR;
    IAbsenceV3 public immutable ABSENCE;

    function happened(uint64 height, bytes calldata txBytes, MerkleProofEntry[] calldata path)
        external view returns (uint64 position)
    {
        return MIRROR.verifyOrRevert(ETHEREUM, height, txBytes, path);
    }

    function wouldRely(uint256 claimId, uint256 exposure) external view returns (bool) {
        return ABSENCE.isUsable(claimId, exposure);
    }
}
```

Deployed from a fresh address at
[`0x2363930C993cbF3449997cDCdF85007F9041F9dB`](https://creditcoin-testnet.blockscout.com/address/0x2363930C993cbF3449997cDCdF85007F9041F9dB)
and verified on Blockscout. Its tests fork live CC3, verify a real Aave V3 liquidation, delete the
precompile on the fork, and verify it again. Called on-chain with `0x0FD2` blanked by an `eth_call`
state override, it returns position `263` for that liquidation.

It has the same GitHub owner as Hindsight. That is stated rather than hidden: what it proves is that the
published interfaces are sufficient, not that a stranger chose to integrate.

## Negative facts

Inclusion proofs cannot say that something did not happen, or that a list is complete. The registry lets
someone *stake* either statement; anyone who finds the transaction they did not account for takes half
the bond and the other half burns.

```solidity
import {IAbsenceV3} from "hindsight/IAbsenceV3.sol";

// Size your exposure against what a liar cannot recover — not against the headline bond.
if (!IAbsenceV3(REGISTRY).isUsable(claimId, principal)) revert NotEnoughAtStake();
```

`isUsable` is true only when the claim stood through its window **and** its burnable share is at least
your exposure. A `Standing` claim is not a proof. It means nobody refuted it, in its window, while that
much was at risk.

## From a script or a server

```bash
npx github:iamdflame/HINDSIGHT verify <ethereum-tx-hash>
```

No key, no gas, no `.env`. It rebuilds the Merkle path from a public Ethereum node and asks the mirror;
the prover is not contacted.

```js
import { verify } from '@hindsight/mirror';
const { mirrored, verified, txIndex } = await verify(txHash);
```

## Addresses

| | CC3 testnet |
|---|---|
| `EthereumMirror` v2 (`IMirror`) | `0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118` |
| `AbsenceRegistryV3` (`IAbsence`, `IAbsenceV3`) | `0xf0a24364C72dCCfaEfbc3CD10e2a4609De9BCc17` |
| `UnderwritingDesk` | `0xC0B1039C529bAef479D497FAD30DE5fc9321fC44` |
| `MissingHeightBounty` | `0xdb2A1eEEbDEEfe35AA43D22a03B06Eda140f238d` |

All ownerless. No pause. No upgrade path. The interface files never change; additions arrive as new
interfaces that inherit the old ones.
