# Hindsight

**Ethereum contracts cannot read Ethereum's own history. Creditcoin can.**

Hindsight makes Ethereum's past answerable on Creditcoin — *positively* by cryptographic proof,
*negatively* by a bond anyone can take.

Built for BUIDL CTC 2026 Fall. Track: DeFi. Source chain: **Ethereum mainnet** (Attestcoin
`chainKey 3`). Everything below runs on Creditcoin testnet against real mainnet transactions.

| | |
|---|---|
| `EthereumMirror` | [`0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB`](https://creditcoin-testnet.blockscout.com/address/0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB) |
| `AbsenceRegistry` | [`0x6CD4398974c464F0D782D0640DADb70d7910682d`](https://creditcoin-testnet.blockscout.com/address/0x6CD4398974c464F0D782D0640DADb70d7910682d) |
| Honesty ledger | [CLAIMS.md](./CLAIMS.md) — every claim graded by evidence |

---

## 1. The problem

Cross-chain verification can prove that something happened. **Nothing can prove that something did
not.**

A borrower submits proofs of their repayments and silently omits the proof of their liquidation.
No contract on any chain can tell the difference. Every cross-chain credit, insurance and solvency
design inherits this hole, and all of them plug it the same way: by trusting an indexer. At which
point the indexer — not the chain — is the source of truth.

## 2. Why the existing approaches are not enough

- **Oracles** move a number and ask you to trust the reporter.
- **Indexers** (The Graph, Dune, Etherscan) are companies. Their answer to *"did X not happen?"* is
  an assertion, not evidence.
- **Attestcoin readability**, as used by every integration we found, proves one transaction per
  query and discards everything else the proof carried. It also gets steadily more expensive: a
  continuity proof lengthens as a transaction ages, because attestations decay into checkpoints one
  per 1000 blocks. Gluwa's own gas note puts a one-day-old query at more than 10× a fresh one.

## 3. The primitive we found

Every Attestcoin query carries a continuity proof: an array of transaction Merkle roots running
from the queried block up to an on-chain attestation, chained as
`digest[i] = keccak(number[i], root[i], digest[i-1])`. The precompile verifies that whole chain
terminates at a stored attestation — so **altering any single root breaks the terminal digest**.
The precompile's acceptance therefore binds *every* root in the array, not just the caller's.

In practice a query carries **~100 of them**. Every existing integration throws all but one away.

Hindsight keeps them. That is the whole idea.

## 4. How it works

**`EthereumMirror`** — permissionless, ownerless, no pause, no upgrade path.

- `mirror(...)` verifies one transaction through `0x0FD2` and retains every block commitment the
  proof carried. Measured: **99 blocks from one call, 24,799 gas per block.**
- `verifyOrRevert(...)` / `tryVerify(...)` check any transaction in a notarised block using a Merkle
  path alone. No continuity proof, no prover service, no precompile. `view`, so free off-chain.
- `sealSpan` / `extendSpan` prove a range gap-free, bounded by `MAX_SEAL_WINDOW`. Gaps matter: a gap
  is exactly where a contradicting transaction could hide.

**`AbsenceRegistry`** — the part that makes negatives checkable.

Absence is never enumerated. It is *staked*:

```
assert    O(1)       stake a bond over a sealed, gap-free span
refute    O(log n)   produce one contradicting transaction, take the bond
finalize  O(1)       unrefuted when the window closes, recorded as such
```

The asymmetry does the work: because positive facts are cheap and permissionless to prove, a single
counterexample is always cheap to produce. Lying is only profitable if nobody in the world will
spend a few hundred thousand gas to take your money.

## 5. Two design decisions worth reading

**Verification semantics are split, on purpose.** `0x0FD2` *reverts* on bad input, so a caller who
ignores its return value is accidentally safe. An earlier version of the mirror returned `false`
instead — which would have made that same caller exploitable. `verifyOrRevert` now matches the
precompile exactly and is the default; `tryVerify` is the opt-in boolean form.
`worker/src/differential.ts` asserts the two paths agree: **34 checks, 0 divergences.**

**Refutation is commit–reveal only.** A one-shot `refute()` puts every piece of evidence in public
calldata, where any searcher copies it and resubmits with a higher fee. If bounties can be stolen,
nobody hunts them, and the economic argument collapses. The commitment binds `msg.sender`, so a
copied commitment is worthless. The unsafe single-call path was **removed**, not kept as a
convenience.

## 6. Real data

Nothing here is staged. The venues are real, the borrowers are real, and we deploy nothing on
Ethereum:

- Aave V3 Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`
- A real liquidation: [`0x3a4b8bcf…`](https://etherscan.io/tx/0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61) (block 25,954,574, index 263)
- A real repayment: [`0xcb9cd732…`](https://etherscan.io/tx/0xcb9cd732d95ea9632c02add1afa7d66b5fd94f0ae48a4fdee6f88b2142149c00) (block 25,961,802)

## 7. Verify it yourself

```bash
git clone --recurse-submodules https://github.com/iamdflame/HINDSIGHT && cd HINDSIGHT
(cd contracts && npm install) && (cd worker && npm install)

# contracts — 31 tests, including every forgery class
cd contracts && forge test -vv

# the mirror agrees with the precompile, and fails the same way (live chain)
cd worker && node src/differential.ts

# rebuild a proof from a public Ethereum node only — no Gluwa prover
node src/local-proof.ts

# verify a real mainnet tx against notarised history, prover untouched
node src/verify-offline.ts

# the full negative-fact lifecycle: seal, stake, commit, reveal, collect
node src/demo-absence.ts
```

## 8. The interface

```bash
cd web && npm install && npm run dev
```

Three workflows, matching the three real roles:

- **A question** — paste any Ethereum mainnet transaction. Needs **no wallet, no gas, no setup**,
  because verification is a `view` call. A toggle lets you choose whether the proof comes from
  Gluwa's prover or is **rebuilt in your browser** from a public Ethereum node — the independence
  claim as a control you can flip, not a footnote.
- **The record** — coverage of notarised history, with gaps shown as the subject they are.
- **The watch** — open claims of absence, a counterexample scanner, and the commit→reveal flow.
  There is a live false claim with a **2 tCTC bounty** on it.

Every answer carries an explicit assurance label. `Cryptographic` and `Economic — unrefuted` never
render the same way, because they are not the same fact.

## 9. What is not claimed

Read [CLAIMS.md](./CLAIMS.md). Briefly: absence is never proven cryptographically; a `Standing`
claim means only that nobody refuted it within its window; notarising a block still requires the
Attestcoin attestor set and the precompile, and we do not pretend otherwise; the contracts are not
audited.

## Layout

```
contracts/   MirrorLib · EthereumMirror · AbsenceRegistry, foundry tests, deploy script
worker/      proof building (local + hosted), notarising, differential harness, demos
web/         Vite + React interface
deployments.json   single source of truth for addresses, shared by all three
```
