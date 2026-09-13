# What is actually established

Every claim this project makes, graded by the strength of the evidence behind it. Anything not
listed here is not claimed.

Re-run everything below with `forge test`, `node worker/src/differential.ts`,
`node worker/src/measure.ts --check`, and the commands in the README. All on-chain references are
Creditcoin testnet (chain 102031) and Ethereum mainnet. The numbers in this file are produced by
`worker/src/measure.ts` reading live chain state, not typed by hand; CI fails if they drift.

---

## Demonstrated on-chain

| Claim | Evidence |
|---|---|
| A single Attestcoin continuity proof carries the transaction Merkle root of many consecutive Ethereum blocks, and the precompile's acceptance binds all of them | One `mirror()` call retained **901** block commitments. The archive was built from **112** such calls in 28.8 minutes |
| Ethereum's recent history is notarised on Creditcoin at archive scale | **100,801** heights retained, contiguous from **25,863,300 to 25,964,100**. `mirroredBlocks(3)` on [`0x4Bc1…e2AB`](https://creditcoin-testnet.blockscout.com/address/0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB) |
| Retaining a root costs a fixed, small amount | **24,245–24,799 gas per block retained**, measured across the whole campaign. The entire archive cost ~2.4B gas ≈ 1.2 tCTC at 0.5 gwei |
| Once a block is notarised, any transaction in it verifies with a Merkle path alone — no continuity proof, no prover service, **no precompile** | `verifyOrRevert` / `tryVerify` are `view` functions that touch only stored roots. Proven three ways: `test_verifiesRealMainnetTxWithoutPrecompileOrProver` deletes the precompile with `vm.etch(0x0FD2, "")`; [/independence](https://hindsight-archive.vercel.app/independence) deletes it in a live `eth_call` state override; and a control that blanks the mirror instead fails, proving the override is applied |
| Our Solidity verification reaches the same verdict as the block-prover precompile, and fails the same way | `worker/src/differential.ts`: **2,684 checks, 0 divergences** over **122 real mainnet transactions** × 22 adversarial mutations, run against the live precompile. Transcript in `docs/transcripts/` |
| Refutation of a false absence claim works end to end, under commit–reveal | tx [`0x39870a3e…`](https://creditcoin-testnet.blockscout.com/tx/0x39870a3e6ff0ff1a67b68ff5ae6f37bafb004749b2aaaf06e56c6cedf422a769) — 338,156 gas, bond transferred to the refuter |
| The absence market is a board, not a demo | **36 claims** staked on [`0x32d5…E7b6`](https://creditcoin-testnet.blockscout.com/address/0x32d507DCC049A228831b7C23E4fe22A62db4E7b6) across Aave V3, Morpho Blue and Compound V3, **10 of them deliberately false** and recorded in `contracts/test/fixtures/lies.json` |
| A searcher refutes false claims with no human in the loop | `worker/src/hunter.ts`, running as a separate funded wallet [`0xd656…F836`](https://creditcoin-testnet.blockscout.com/address/0xd6567dB4f8939EdCDFC3E736C33a9cb20d4DF836), refuted **all 10 planted lies** — 6 Aave repayments and 4 Aave liquidations — e.g. claim 32 by [`0x6b45392a…`](https://creditcoin-testnet.blockscout.com/tx/0x6b45392aae0caa7be16aa2bcb63ec7c4e3455ff1394d2c1cd251ecd37b6b38ee) and claim 0 by [`0x85cbd051…`](https://creditcoin-testnet.blockscout.com/tx/0x85cbd0515e11d426bd0b2143f2d65d6f496556697682a1f92947ee76eb4f34c3). It scanned the **26 true claims and left every one standing** |
| A lender pays or refuses on facts nobody in this system authored | `UnderwritingDesk` [`0xb1D2…95AF`](https://creditcoin-testnet.blockscout.com/address/0xb1D213c24ECd39475eC337D29Fb5eB60AF2195AF) paid 1.0 tCTC to an unmarked address in [`0x51096418…`](https://creditcoin-testnet.blockscout.com/tx/0x51096418b7c5998dd6b9689af95bff037870914f1c9bc7c5e280ffd0f9bc625c), and returns `ProvenLiar` for `0x180c…397b` and `0x1b1d…e2b1` — real Ethereum borrowers with real Aave liquidations at blocks 25,903,971 and 25,903,972. `assess()` is the same predicate `borrow()` gates on, callable by anyone on Blockscout |
| A second transaction in a notarised block verifies with the precompile gone | Three fixtures in `random-block-second-tx/` at indices **0, 131 and 392** of block 25,954,574 — a block notarised with index 263 — rebuilt from a public node, root byte-identical to the archive's. `test_secondTransactionsVerifyWithThePrecompileDeleted` etches `0x0FD2` to empty and verifies all three |
| Ethereum **mainnet** is a live Attestcoin source chain on Creditcoin **testnet** (`chainKey 3`) | `getLatestAttestedHeightAndHash(3)` on `0x…0fd3`; attested height tracks the mainnet head by ~34 blocks |

## Verified locally, reproducible by anyone

| Claim | Evidence |
|---|---|
| The hosted prover is replaceable for **Merkle paths** | `worker/src/local-proof.ts` rebuilds a block from a public Ethereum node; root and all sibling hashes with direction bits are byte-identical to the prover's. `/independence` does the same in a browser and makes **zero** requests to the prover |
| Transaction index is recoverable from the path shape alone | `MirrorLib.txIndexOf`, matching the precompile's `calculateTxIndex`, plus `testFuzz_txIndexIsRecoverableFromPathShape` over randomly shaped trees |
| Forged evidence cannot pass | **98 `forge test` cases**, of which **19 are fuzz tests at 256 runs each (~4,900 generated cases)**: tampered bytes, mutated siblings, flipped direction bits, truncated and extended paths, one leaf borrowing another's path, lookalike venue, wrong subject, out-of-span evidence, late refutation, every malformed batch |
| A reverted liquidation is not a liquidation | `test/FailedTransaction.t.sol`: the real mainnet leaf with only its receipt status rewritten to 0 is mirrored so its path verifies, and the registry still refuses it with `TransactionFailed`, bond untouched. Fuzzed over every non-1 status. Inclusion is not success |
| Coverage | **90.95% lines overall**; `EthereumMirror` 97.9%, `MissingHeightBounty` 100%, `MirrorLib` 100% after pinning its unreached genesis helper |
| A gap in a sealed span is impossible | `testFuzz_aGapAnywhereMakesTheRangeUnsealable` and `testFuzz_multipleGapsReportTheFirst` fuzz the position, width and multiplicity of the hole |
| The interfaces are genuinely importable by a stranger | `contracts/test/ThrowawayDesk.sol` is written against `IMirror`/`IAbsence` only, and reaches the same facts |

## Economic, not cryptographic — stated precisely

| Claim | What it actually means |
|---|---|
| A claim in **`Standing`** | **Not** that the event never happened. Precisely: *nobody refuted it within its window, over a gap-free sealed range, while a named bond was at risk.* Consumers should call `assurance()` and `holdsWithBond()` and price it themselves |
| The desk's refusal | `UnderwritingDesk` pays or reverts by reading the archive and the claim board. A **`Refuted`** claim blocks lending and is the only status backed by cryptography. An **`Open`** claim also blocks, because somebody is still hunting. `BlankFile` does **not** treat silence as innocence, and is the default; `BondedClean` is the stronger, optional policy and is never the default |
| Refutation bounties are worth hunting | Refuting costs ~338k gas (~1.7×10⁻⁴ CTC at 0.5 gwei) against a minimum bond of 0.01 CTC — roughly two orders of magnitude of headroom. This is an incentive argument, not a proof |
| Commit–reveal defeats bounty theft | The commitment binds `msg.sender`, so a copied commitment is unusable and a reveal cannot be front-run by someone with no aged commitment. Not audited, and not proof against a validator who can reorder or censor |

## Trust assumptions we keep, deliberately

- **Notarising a block requires the Attestcoin attestor set and the block-prover precompile.** Only
  verification *after* notarisation is free of them. These are two different claims and the first
  one is never waived. Attestcoin is the trust root here, by design.
- **The mirror does not independently re-derive the continuity chain.** It checks one thing in its
  own code — that `continuityRoots[0]` is the root of the block it was told about — and delegates
  the rest to the precompile, whose acceptance binds the whole array because altering any root
  diverges the terminal digest. This delegation is sound and also unavoidable: only the attestation
  layer holds the terminal digest to compare against. It is pinned by `test/TrustBoundary.t.sol`.
  - **Known documentation defect:** the NatSpec on `MirrorLib.walkDigests` says the mirror asserts
    this "in its own code". It does not, and cannot. The deployed contract is fully verified on
    Blockscout and is deliberately never redeployed, so the source is left byte-for-byte as
    deployed and the correction lives here and in that test rather than in a comment that would
    break the verification match.
- **A sealed span is only as honest as its contiguity check**, which is one SLOAD per block at seal
  time, capped at `MAX_SEAL_WINDOW`.
- **Public Ethereum RPCs are used to rebuild proofs and to scan logs.** A lying RPC cannot forge a
  *positive*: the reconstructed root would not match the notarised one. A **negative** is different,
  and is handled accordingly — see below.

## Things we found that limit the product, stated rather than hidden

- **Empty Ethereum blocks read as gaps, permanently.** A block with no transactions has a
  transaction Merkle root that genuinely *is* `0x00…0`, and zero is also the contract's "not
  present" sentinel. The archive holds the correct root for all **100,801** heights, but **24** of
  them are empty blocks, so `isMirrored` reports false for those and `sealSpan` cannot cross them.
  - The honest count of heights we can actually answer questions about is **100,777**, and that is
    the number this project uses as its headline. `mirroredBlocks` alone would overstate it by 24.
  - Nothing unsound follows — a block with no transactions cannot hide the transaction that would
    refute a claim — but it is an expressiveness limit: the archive is cut into **25 runs**, and an
    absence claim must live inside one. The longest available run is **18,443 blocks (61.5 hours)**.
  - This is why a "7-day claim" is *not* offered. It is not reachable in this archive.
- **A single public RPC saying "no logs" is not evidence.** Measured: for a query with one matching
  Aave log, `rpc.flashbots.net` returned **0 logs** with no error, while `gateway.tenderly.co` and
  `rpc.mevblocker.io` both returned 1. Since a negative log result is exactly what an absence claim
  rests on, `getLogsChunked` now requires **two independent endpoints** to agree before it reports
  silence, and raises rather than returning empty when a window cannot be served. A positive needs
  no corroboration because it is verified cryptographically downstream.
- **`MAX_SPANS_PER_CLAIM` is 64 and `MAX_OPEN_PER_CLAIMER` is 64.** Both are anti-spam bounds, not
  protocol limits.

## Not claimed

- That absence is ever proven cryptographically. It is not, and this design does not try.
- That a `Standing` claim stays true afterwards. It is scoped to one range and one window; a later
  claim is the recourse.
- That the contracts are audited. They are not.
- That gas verification is "6,228". That figure is the **hashing only**. A real on-chain call for a
  7.6KB transaction costs ~218k because calldata dominates, and an `eth_call` costs nothing at all.
  All three numbers belong together.
- That writability (Creditcoin → Ethereum) is used. It is not released on testnet.
- That we have measured any other project's gas. Figures in `docs/MIGRATION.md` attributed to other
  projects are cited from their own repositories and labelled as such.
- That the archive covers Ethereum from genesis. It covers an attested window, from the head
  backwards, and says exactly where it starts and stops.
- That the hunter will always find a counterexample. It found all ten planted here. It depends on
  public Ethereum RPCs serving logs, which is why a negative now needs two of them to agree.
- That the 26 standing claims are *true*. They are unrefuted after a scan by one hunter over one
  window. That is the sentence, and it is the only sentence.
