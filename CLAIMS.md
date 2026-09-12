# What is actually established

Every claim this project makes, graded by the strength of the evidence behind it. Anything not
listed here is not claimed.

Re-run everything below with `node worker/src/differential.ts`, `forge test`, and the commands in
the README. All on-chain references are Creditcoin testnet (chain 102031) and Ethereum mainnet.

---

## Demonstrated on-chain

| Claim | Evidence |
|---|---|
| A single Attestcoin continuity proof carries the transaction Merkle root of ~100 consecutive Ethereum blocks, and all of them are bound by the digest chain the precompile verifies | One `mirror()` call retained **99** block commitments: tx [`0xec14f91a…`](https://creditcoin-testnet.blockscout.com/tx/0xec14f91ab8ff517fd221aa383d0dde2eec19d2c05ca5b55e7a5cc150568a39e7), 2,455,145 gas, **24,799 gas per block retained** |
| Once a block is notarised, any transaction in it verifies with a Merkle path alone — no continuity proof, no prover service, no precompile | `verifyOrRevert` / `tryVerify` are `view` functions that touch only stored roots. Exercised in `test_verifiesRealMainnetTxWithoutPrecompileOrProver`, which **deletes the precompile** (`vm.etch(0x0FD2, "")`) and still verifies |
| Our Solidity verification reaches the same verdict as the block-prover precompile, and fails the same way | `worker/src/differential.ts`: **34 checks, 0 divergences** over 2 real mainnet transactions × 17 adversarial mutations, run against the live precompile |
| Refutation of a false absence claim works end to end, under commit–reveal | tx [`0x39870a3e…`](https://creditcoin-testnet.blockscout.com/tx/0x39870a3e6ff0ff1a67b68ff5ae6f37bafb004749b2aaaf06e56c6cedf422a769) — 338,156 gas, bond transferred to the refuter |
| Ethereum **mainnet** is a live Attestcoin source chain on Creditcoin **testnet** (`chainKey 3`) | `get_supported_chains()` on `0x…0fd3` returns `(3, chainId 1, "Ethereum")`; attested height tracks mainnet head by ~38 blocks |

## Verified locally, reproducible by anyone

| Claim | Evidence |
|---|---|
| The hosted prover is replaceable for **Merkle paths** | `worker/src/local-proof.ts` rebuilds block 25954574 (393 transactions) from a public Ethereum node. Root **and** all 9 sibling hashes with direction bits are byte-identical to the prover's |
| Transaction index is recoverable from the path shape alone | `MirrorLib.txIndexOf` returns 263 and 220 for the two fixtures, matching the precompile's `calculateTxIndex` |
| Forged evidence cannot pass | 31 `forge test` cases including tampered bytes, mutated siblings, flipped direction bits, lookalike venue, wrong subject, out-of-span evidence, late refutation |

## Economic, not cryptographic — stated precisely

| Claim | What it actually means |
|---|---|
| A claim in **`Standing`** | **Not** that the event never happened. Precisely: *nobody refuted it within its window, over one sealed span, while a named bond was at risk.* Consumers should call `assurance()` and `holdsWithBond()` and price it themselves |
| Refutation bounties are worth hunting | Refuting costs ~338k gas (~1.7×10⁻⁴ CTC at 0.5 gwei) against a minimum bond of 0.01 CTC — roughly two orders of magnitude of headroom. This is an incentive argument, not a proof |
| Commit–reveal defeats bounty theft | The commitment binds `msg.sender`, so a copied commitment is unusable, and a reveal cannot be front-run by someone with no aged commitment. Not audited, and not proof against a validator who can reorder or censor |

## Trust assumptions we keep, deliberately

- **Notarising a block requires the Attestcoin attestor set and the block-prover precompile.** Only
  verification *after* notarisation is free of them. These are two different claims and the first
  one is never waived. Attestcoin is the trust root here, by design.
- **A sealed span is only as honest as its contiguity check**, which is one SLOAD per block at seal
  time, capped at `MAX_SEAL_WINDOW`.
- **Public Ethereum RPCs** are used to *rebuild* proofs. They can lie, but a lie fails immediately
  because the reconstructed root will not match the notarised one.

## Not claimed

- That absence is ever proven cryptographically. It is not, and this design does not try.
- That a `Standing` claim stays true afterwards. It is scoped to one span and one window; a later
  claim is the recourse.
- That the contracts are audited. They are not.
- That gas verification is "6,228". That figure is the **hashing only**. A real on-chain call for a
  7.6KB transaction costs ~218k because calldata dominates. Both numbers belong together.
- That writability (Creditcoin → Ethereum) is used. It is not released on testnet.
