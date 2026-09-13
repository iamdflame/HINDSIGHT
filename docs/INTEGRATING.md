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

## A product, not a demo: PaidOnEthereum

[`davidpraise288-coder/int_hind`](https://github.com/davidpraise288-coder/int_hind) builds something else on the same
interface: proof, on Creditcoin, that an ERC-20 transfer happened on Ethereum. `prove(height, txBytes, path, logIndex)`
asks `IMirror.verifyOrRevert`, decodes the receipt with Gluwa's decoder, requires success and a real `Transfer` log,
and counts it once; `paidAtLeast(token, from, to, amount)` is what a merchant or lender reads. Deployed and verified at
[`0xF2c2e220c34a9048E08A222F7Da546E0d201C85B`](https://creditcoin-testnet.blockscout.com/address/0xF2c2e220c34a9048E08A222F7Da546E0d201C85B),
with two real mainnet transfers already proven. It is a second GitHub account of the same person who built Hindsight,
and says so in its README.

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
import { verify, assess, checks, usable } from 'hindsight-mirror';
const { mirrored, verified, txIndex } = await verify(txHash);
const { verdicts } = await assess('0x…', 10n ** 18n);   // the desk, every instrument, with the spans it was priced against
const five = await checks(txHash);                      // status · depth · clock · stall · replay — numbers, no decision
const ok = await usable(claimId, exposureWei);          // Standing, and the burned half of the bond covers the exposure
```

Or without any code: `GET https://hindsight.run/api/assess?subject=0x…` returns the same verdicts as JSON and
`/api/certificate` the same reading as a one-page PDF; `/openapi.json` describes both. For an agent,
`npx -y hindsight-mcp` exposes them as MCP tools, none of which can spend.

## From Solidity, with nothing but the interfaces

Copy [`templates/foundry-consumer`](../templates/foundry-consumer). Two remappings, two frozen imports —
`IMirror.verifyOrRevert` for inclusion, `IAbsenceV3.isUsable` for a bonded negative — and a test file that
deletes the precompile at `0x0FD2` in your own build and shows the answer does not change. Five checks before
you act are named there: status and replay in the contract, depth, clock and stall yours.

## Borrowing as an Ethereum address

`borrow` underwrites `msg.sender`. To be underwritten as an Ethereum address instead, sign any Ethereum
transaction whose data is the 32 bytes `hindsight-mirror bind calldata <your Creditcoin address>` prints,
wait for the archive to hold that block, and `hindsight-mirror bind submit <tx>`. From then on the desk
reads the Ethereum address's record when your Creditcoin key asks — and instruments that require a proven
owner (`UnprovenSubject` otherwise) will answer. The subject is still not a parameter: it is the `from` of a
transaction you had to be able to sign.

## Addresses

| | CC3 testnet |
|---|---|
| `EthereumMirror` v2 (`IMirror`, `IMirrorSpans`) | `0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118` |
| `AbsenceRegistryV3` (`IAbsence`, `IAbsenceV3`) | `0x05844C991993F3d80fAf196e10355B12BE648e40` |
| `UnderwritingDesk` v5 | `0xc176b4307315F8494A763773385B455aE0b7f9d2` |
| `SubjectBinding` (`ISubjectBinding`) | `0x2d2120Da8877579E4eA58EA6f079d373b71ea7f0` |
| `Cover` | `0xCb0054B41705c8b2050893158523C26BA3f5b922` |
| `MissingHeightBounty` | `0xdb2A1eEEbDEEfe35AA43D22a03B06Eda140f238d` |

All ownerless. No pause. No upgrade path. The interface files never change; additions arrive as new
interfaces that inherit the old ones.
