# What a mirrored height would save you

<!-- Generated from docs/templates/MIGRATION.md by worker/src/claims-doc.ts; edit the template. -->
Every Hindsight number here is read from `deployments.json`, which `worker/src/measure.ts` writes from the live CC3
testnet deployment.
Numbers about other projects are **cited** from their own READMEs, linked row by row, and were
checked at the source on 2026-09-13. Nothing here is inferred from marketing, and where we
have not measured something we say so rather than estimating quietly.

## The unit

An Attestcoin query pays for continuity: the chain of block roots from the queried height up to the next
attested or checkpointed height above it. A query against an already-notarised height pays for none of it.

Continuity roots returned by the live prover's single-transaction endpoint — the one every integration
uses — for the first transaction of a block at each age (**measured** 2026-09-13T08:05:44.642Z, attested head
25,967,160):

| Age of block | Block | Roots in the continuity proof |
|---|---|---|
| fresh (head − 50) | 25,967,110 | **1** |
| 24 hours | 25,959,960 | **41** |
| 7 days | 25,916,760 | **41** |
| 30 days | 25,751,160 | **41** |
| 90 days | 25,319,160 | **41** |
| 180 days | 24,671,160 | **841** |

The count is the distance to the next endpoint above the block, so it depends on where the block sits
between checkpoints as well as on its age — and endpoints thin out with depth. Every asker pays it again.
Against a held root it is zero, permanently.

## Costs

| | Value | How we know |
|---|---|---|
| Gas per newly held height | 23,492 – 27,232, median 23,596 | measured from 834 mainnet `mirror()` receipts |
| Roots retained in one `mirror()` call | up to 901 | measured on-chain |
| Proving 131,072 heights gap-free | 1,280,230 gas | measured on-chain |
| Merkle hashing only, verifying against a held root | 6,228 | measured in Foundry against Mirror v1; v2's verification path differs by one bitmap read |
| A real on-chain `verifyOrRevert` for a 7.6 KB transaction | 217,664 | measured on-chain against Mirror v1 — **calldata dominates** |
| Reading via `eth_call` (no transaction) | free | `view` |

**The last three belong together.** Quoting 6,228 alone is misleading: it is the hashing, not the call.
For a large transaction submitted on-chain, calldata is the real cost. For the ordinary case — a dApp
reading through `eth_call` — there is no gas at all.

## Who would save what

Every row below was checked against the project's own README on 2026-09-13, and links to it. A figure
we could not find at its source is not in this table. We have not re-run anyone's benchmark.

| Project | What their README reports | Against a mirrored height | Source |
|---|---|---|---|
| **proof-feed** — Chainlink round | one proof: **650,223 gas, 529 continuity roots** | one notarisation of that block, then `view` calls | [AdityaZulkarnaen/proof-feed](https://github.com/AdityaZulkarnaen/proof-feed) README, *Gas* row |
| **index41** — one mainnet sandwich | block 25,764,741, positions 14 → 15 → 16, proven in one transaction of **1,092,100 gas** | the three legs as three `view` calls once the block is held — see [/order](/order/) | [edycutjong/index41](https://github.com/edycutjong/index41) README |
| **nomen** — credit events | **11,147** mainnet events proven one by one over 3.1 days; six failed permanently because the prover payload exceeded the RPC body limit | O(1) per event once its block is held; no payload to the prover at all | [seekdaseek/nomen](https://github.com/seekdaseek/nomen) README, first paragraph |
| **Kirogi** — remittance settlement | **441,364** and **453,390** gas per settlement, with 4 and 5 continuity roots | a `view` call against the held root, plus their own settlement logic | [choiaewoooon/kirogi](https://github.com/choiaewoooon/kirogi) README |
| **Forum** — MEV court *(same GitHub owner as Hindsight)* | a batch of 10 transactions from one block against **21 shared continuity roots** | ten `view` calls, no continuity proof | [iamdflame/forum-attestcoin](https://github.com/iamdflame/forum-attestcoin) README |

The asymmetry worth noticing: **nomen's 11,147th event did not make the 11,148th cheaper.** A
notarised block makes every transaction in it cheap for everyone, including projects that never
integrate with us — because `rootOf` is public and `verifyOrRevert` is a `view` function anyone can
call.

## Switching

```ts
import { verify } from 'hindsight-mirror';
const r = await verify(txHash);   // no key, no gas, no prover
```

or in Solidity, against the frozen interface:

```solidity
uint64 index = IMirror(MIRROR).verifyOrRevert(3, height, txBytes, siblings);
```

If the height is not held yet, `isMirrored` says so and `notarise` fixes it once, for everyone.

## What this table does not claim

We have not re-run any other project's benchmarks. Their figures are quoted from their own READMEs so
that a reader can check them at the source; two rows in an earlier version of this page (a
single-event project and a characterisation of Forum's verification) could not be matched to a source
sentence and were removed rather than kept. If any number here is wrong, we would rather correct it
than keep it.
