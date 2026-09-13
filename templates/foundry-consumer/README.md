# A consumer, from nothing

Copy this directory. It is the smallest honest contract that acts on an Ethereum fact from
Creditcoin: a token transfer, proven against a root the archive already holds, with no prover, no
precompile and no oracle in the call path.

```
forge install iamdflame/HINDSIGHT
```

then in `foundry.toml`:

```toml
remappings = [
  "hindsight/=lib/HINDSIGHT/contracts/src/",
  "@gluwa/asc-contracts/=lib/HINDSIGHT/contracts/node_modules/@gluwa/asc-contracts/",
]
via_ir = true
```

Two imports, both frozen:

| Interface | Gives you | Costs |
|---|---|---|
| `IMirror.verifyOrRevert(chainKey, height, txBytes, siblings)` | inclusion, or a revert — a `view` against a held root | nothing |
| `IAbsenceV3.isUsable(claimId, exposure)` | whether a *negative* somebody bonded can carry this much reliance | nothing |

Deployed addresses are in [`deployments.json`](../../deployments.json); pass them to the constructor.

## The tests are the point

`test/PaidInvoice.t.sol` runs against a real mainnet transaction and does the thing the whole
project is a claim about: **it deletes the precompile at `0x0FD2` and the answer does not change**,
then deletes the mirror and the answer cannot be given. An unheld block is unanswerable, not false.
A forged path is refused before your code sees a log.

## Five checks before you act

Named after the list in Dokett's ASC review. Two are in the contract; three are yours.

1. **Status** — the receipt says `1`. A reverted transfer is not a transfer. *(in the contract)*
2. **Replay** — `(chain, height, txIndex, logIndex)` is recorded and never counted twice. *(in the contract)*
3. **Depth** — the block is far enough below the attestation head for your risk. *(yours)*
4. **Clock** — the block is not older than the thing you are paying for. *(yours)*
5. **Stall** — the archive is still following the source chain. *(yours; `/api/gates` says)*

`npx hindsight-mirror checks <tx>` answers all five with numbers and decides nothing.

Nothing here is a score. There is no number.
