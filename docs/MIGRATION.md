# What a mirrored height would save you

Every number in the **Hindsight** column was measured against the live CC3 testnet deployment.
Numbers in the "today" column are labelled by how we know them: **measured** by us, or **cited** from
the other project's own repository or README. Nothing here is inferred from marketing, and where we
have not measured something we say so rather than estimating quietly.

## The unit

An Attestcoin query pays for continuity: the chain of block roots from the queried height up to an
attestation or checkpoint. A query against an already-notarised height pays for none of it.

Continuity roots returned by the live prover, by age of the queried block (**measured**,
September 2026, `chainKey 3`):

| Age of block | Roots in the continuity proof |
|---|---|
| fresh (head − 50) | 1 |
| 24 hours | 11 |
| 7 days | 11 |
| 30 days | 11 |
| 180 days | **711** |

The cost of asking grows with depth, and every asker pays it again. Against a held root it is zero,
permanently.

## Costs

| | Value | How we know |
|---|---|---|
| Gas per root retained | 24,245 – 24,799 | measured on-chain, 112 campaign transactions |
| Roots retained in one `mirror()` call | up to 901 | measured; 711-root call simulated at 17.2M gas |
| Merkle hashing only, verifying against a held root | 6,228 | measured |
| A real on-chain `verifyOrRevert` for a 7.6 KB transaction | ~217,664 | measured — **calldata dominates** |
| Reading via `eth_call` (no transaction) | free | `view` |

**Both of the last three belong together.** Quoting 6,228 alone is misleading: it is the hashing, not
the call. For a large transaction submitted on-chain, calldata is the real cost. For the ordinary
case — a dApp reading through `eth_call` — there is no gas at all. We have been told off for quoting
one number without the other, correctly, and `CLAIMS.md` records that.

## Who would save what

| Project | What they pay today | Against a mirrored height | Basis |
|---|---|---|---|
| **proof-feed** (Chainlink round, 2023) | 650,223 gas, 529 continuity roots | one notarisation of that block, then `view` calls forever | **cited** from their repo; we have not re-run it |
| **Forum** (3-leg sandwich) | 3 × `verifyAndEmit`, each with full continuity | 1 notarisation + 3 `view` calls | **cited** — three separate verified legs in one block |
| **nomen** (11,147 mainnet events) | continuity per event, growing with age | O(1) per event once the block is held | **cited** event count; gas not measured by us |
| **Kirogi** ("7 days back costs more gas", their README) | continuity to a 7-day-old checkpoint | `view` call | **cited** from their README |
| **CEL** (one mainnet `Paused()`) | one query's continuity | `view` call | **cited** |

The asymmetry worth noticing: **nomen's 11,147th event did not make the 11,148th cheaper.** A
notarised block makes every transaction in it cheap for everyone, including projects that never
integrate with us — because `rootOf` is public and `verifyOrRevert` is a `view` function anyone can
call.

## Switching

```ts
import { verify } from '@hindsight/mirror';
const r = await verify(txHash);   // no key, no gas, no prover
```

or in Solidity, against the frozen interface:

```solidity
uint64 index = IMirror(MIRROR).verifyOrRevert(3, height, txBytes, siblings);
```

If the height is not held yet, `isMirrored` says so and `notarise` fixes it once, for everyone.

## What this table does not claim

We have not re-run any other project's benchmarks. Their figures are quoted from their own
repositories so that a reader can check them at the source, and a row we could not source is absent
rather than estimated. If any of these numbers is wrong, we would rather correct it than keep it.
