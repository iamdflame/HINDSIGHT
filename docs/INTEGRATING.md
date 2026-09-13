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

    function provenSince(address venue, bytes32 topic0, uint8 slot, address subject, uint64 sinceHeight)
        external view returns (bool)
    {
        bytes32 key = ABSENCE.keyOf(ETHEREUM, venue, topic0, slot, bytes32(uint256(uint160(subject))));
        (, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt,) = ABSENCE.recordOf(key);
        return (refuted != 0 && lastEvidenceAt >= sinceHeight) || (lastMemberAt != 0 && lastMemberAt >= sinceHeight);
    }
}
```

Deployed from a fresh address at
[`0xeeFa14CA77cEe451Df6474c9dCcBce38A691a254`](https://creditcoin-testnet.blockscout.com/address/0xeeFa14CA77cEe451Df6474c9dCcBce38A691a254)
and verified on Blockscout. Its tests fork live CC3, verify a real Aave V3 liquidation, delete the
precompile on the fork, and verify it again. Called on-chain with `0x0FD2` blanked by an `eth_call`
state override, it returns position `263` for that liquidation; with the mirror blanked instead, the
same call reverts.

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

**Read a claim through its whole key, never its subject alone.** A claim is about one chain, one venue,
one event, one topic slot and one subject. "No `LiquidationCall` whose topic-1 is `0xabc`" is true of
every borrower — topic 1 is the collateral asset — and a consumer that matched on the subject would
accept it as a clean record. `keyOf(chainKey, venue, topic0, slot, subject)` names the file, and
`recordOf(key)` returns its running totals: open claims, refutations and the highest height any
refutation or listed event sits at. That is one read, whatever else is on the board; do not walk
`claimCount()`, which anyone can inflate for a cent a claim.

## From a script or a server

```bash
npx github:iamdflame/HINDSIGHT verify <ethereum-tx-hash>
```

No key, no gas, no `.env`. It rebuilds the Merkle path from a public Ethereum node and asks the mirror;
the prover is not contacted.

```js
import { verify } from 'hindsight-mirror';
const { mirrored, verified, txIndex } = await verify(txHash);
```

## Addresses

| | CC3 testnet |
|---|---|
| `EthereumMirror` v2 (`IMirror`) | `0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118` |
| `AbsenceRegistryV3` (`IAbsence`, `IAbsenceV3`) | `0x05844C991993F3d80fAf196e10355B12BE648e40` |
| `UnderwritingDesk` | `0xC576E330400ce4D031daB3b9c2dA2423211B6e25` |
| `MissingHeightBounty` | `0xdb2A1eEEbDEEfe35AA43D22a03B06Eda140f238d` |

All ownerless. No pause. No upgrade path. The interface files never change; additions arrive as new
interfaces that inherit the old ones.
