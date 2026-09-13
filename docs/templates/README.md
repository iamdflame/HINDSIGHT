<!-- Generated from docs/templates/README.md by worker/src/claims-doc.ts. Numbers come from deployments.json; edit the template, not this file. -->
# Hindsight

**Hindsight is the cache Attestcoin forgot to keep.**

Every Attestcoin query already proves a run of Ethereum block roots — the continuity proof — and then
throws them away. Hindsight keeps them. After that, proving any other transaction in those blocks is a
`view` call on Creditcoin: no prover, no `0x0FD2`, no wallet.

**Live: [{{site}}]({{site}})** · the grading of every claim below: [CLAIMS.md](./CLAIMS.md)

---

## The problem

A continuity proof is the chain of transaction roots from the block you ask about up to an attested
height. The precompile verifies the whole chain — so its acceptance binds *every* root in it — and the
call returns, and the roots are gone. The next contract that asks about a different transaction in the
same block pays for the same continuity again. The deeper the block, the longer the chain: measured on
the live prover, {{measured.continuityByAge.rows.0.roots}} root for a fresh block, {{measured.continuityByAge.rows.1.roots}} for a day-old one, **{{measured.continuityByAge.rows.5.roots}}** for a block 180 days old.
Every dApp pays that, every time.

## The number

| | Ethereum mainnet (`chainKey 3`) | Sepolia (`chainKey 1`) |
|---|---|---|
| Heights held on Creditcoin | **{{measured.chains.3.held|n}}** | **{{measured.chains.1.held|n}}** |
| Unbroken run ending at the top | **{{measured.chains.3.topRun|n}}** blocks ≈ **{{measured.chains.3.topRunDays|days}} days** ({{measured.chains.3.topRunFrom|n}} – {{measured.chains.3.highest|n}}) | **{{measured.chains.1.topRun|n}}** blocks ≈ **{{measured.chains.1.topRunDays|days}} days** |
| Empty Ethereum blocks inside, held like any other | {{measured.chains.3.emptyBlocks|n}} | {{measured.chains.1.emptyBlocks|n}} |
| `mirror()` calls that added heights | {{measured.chains.3.mirrorCalls|n}} | {{measured.chains.1.mirrorCalls|n}} |
| Gas per newly held height (median) | **{{measured.chains.3.gasPerNewRoot.median|n}}** | {{measured.chains.1.gasPerNewRoot.median|n}} |
| Most roots retained by one call | **{{measured.chains.3.widestCall.roots|n}}** | {{measured.chains.1.widestCall.roots|n}} |

Verifying a second transaction in any of those blocks: a `view` call. Zero gas off-chain.

## The proof that the prover is not in the loop

Three things happen on the home page as it loads, against a block picked at random near the top of the
archive — never one whose own transaction was submitted to notarise it:

1. The Merkle path is **rebuilt in your browser** from a public Ethereum node. The prover gets no request.
2. `verifyOrRevert` runs as an `eth_call` with **`0x0FD2` deleted by a state override**. It still returns
   the transaction's index.
3. The control: the same call with the **mirror** deleted instead. It fails — so the node really applies
   overrides, and the answer really came from roots Creditcoin holds.

Measured and recorded by `measure.ts`: transaction index **{{measured.acceptance.secondTransaction.expectedIndex}}** of block
{{measured.acceptance.secondTransaction.block|n}} — a block notarised through index {{measured.acceptance.secondTransaction.notarisedWithIndex}} — verifies as
**{{measured.acceptance.secondTransaction.plain.txIndex}}** plainly and **{{measured.acceptance.secondTransaction.precompileBlanked.txIndex}}** with the precompile gone.

**Five minutes, no key, no `.env`:**

| Time | Do this | You should see |
|---|---|---|
| 30 s | open [{{site}}]({{site}}) | four rows settle — verified, verified with `0x0FD2` deleted, control refused, forged path refused — and the stamp |
| 1 min | `npx github:iamdflame/HINDSIGHT verify 0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9` | `verified` · `tx index  : 131` · `source : rebuilt locally (no prover)` · `precompile: not called` |
| 2 min | `cd contracts && forge test` | **{{static.forgeTests}}** tests, **{{static.fuzzTests}}** of them fuzz properties, including the precompile etched to empty |
| 5 min | `cd worker && node src/differential.ts --limit 12` | the mirror and the live precompile accept and reject exactly the same inputs |

The full differential: **{{measured.differential.checks|n}} checks over {{measured.differential.fixtures}} real mainnet transactions, {{measured.differential.divergences}} divergences** ([transcript](./{{measured.differential.transcript}})).

## Negatives — economic, and labelled so

Inclusion proofs cannot say that something did *not* happen, or that a list is *complete*. Hindsight's
registry lets someone stake either statement over a gap-free span of held blocks:

| Kind | Statement | Refuted by |
|---|---|---|
| `EmptySet` | no successful matching log in the range | one matching log, receipt status `0x1` |
| `CompleteSet` | these members are every matching log in the range — each verified against the mirror when filed | one matching log that is not a member |

Refutation is commit–reveal, bound to the refuter's address. **Half the bond goes to the refuter and half
is burned**, so a liar who refutes themselves from a second wallet still loses half. Consumers size against
`enforceableLoss` — that burned half — through `isUsable(claimId, exposure)`.

The board on mainnet covers **{{measured.board.chains.mainnet.spanFrom|n}} – {{measured.board.chains.mainnet.spanTo|n}}**, five sealed spans, ninety-one days.
It holds {{measured.board.chains.mainnet.claims}} claims about real Aave V3, Morpho Blue and Compound V3 borrowers; the ones that are
false are recorded in [`board-v3-mainnet.json`](./contracts/test/fixtures/board-v3-mainnet.json) with the transaction that makes each false.
{{measured.board.refutations}} refutations so far, **{{measured.board.burnedWei|tctc}} tCTC burned**. A standing claim means nobody refuted it in its window while
that much was at risk — never that it is true.

## The desk — a refusal, not a score

`UnderwritingDesk` reads the archive and the board and either pays or refuses with a reason: `ArchiveTooShallow`,
`ProvenLiar`, `EventOnRecord`, `ClaimUnderHunt`, `NoBondedCleanliness`, `AlreadyLent`. Its policies look
back **648,000 blocks — ninety days — and refuse outright unless every one of those heights is held.** On
the live desk that check passes today: {{measured.desk.ninetyDay.0.kind}} policy {{measured.desk.ninetyDay.0.policy}} answers `{{measured.desk.ninetyDay.0.reason}}` for an address nothing is on file about.

Nothing is minted, nothing is transferable, and there is no number. Assess any address, no wallet:
[{{site}}/assess/]({{site}}/assess/).

## Enshrine it

The better home for this cache is the node. [docs/ENSHRINE.md](./docs/ENSHRINE.md) proposes a native
`BlockRootCache` written as a side effect of every successful query — and says we would rather help build
it than be the reason it is not needed.

## Grading

[CLAIMS.md](./CLAIMS.md) grades every statement in this repository by the evidence behind it, including the
ones that limit the product. It is generated from the same measured record as this file. The promises it makes
about live state are re-checked on a schedule, in public: **[{{site}}/status/]({{site}}/status/)** — twelve gates
against Creditcoin, the result at most five minutes old.

---

### Contracts (Creditcoin CC3 testnet, all ownerless, all verified)

| | |
|---|---|
| `EthereumMirror` v2 — `IMirror` | [`{{contracts.EthereumMirror}}`](https://creditcoin-testnet.blockscout.com/address/{{contracts.EthereumMirror}}) |
| `AbsenceRegistryV3` — `IAbsence`, `IAbsenceV3` | [`{{contracts.AbsenceRegistryV3}}`](https://creditcoin-testnet.blockscout.com/address/{{contracts.AbsenceRegistryV3}}) |
| `UnderwritingDesk` | [`{{contracts.UnderwritingDesk}}`](https://creditcoin-testnet.blockscout.com/address/{{contracts.UnderwritingDesk}}) |
| `MissingHeightBounty` | [`{{contracts.MissingHeightBounty}}`](https://creditcoin-testnet.blockscout.com/address/{{contracts.MissingHeightBounty}}) |
| A consumer in another repository | [`hindsight-gate`]({{external.hindsightGate.repository}}) at [`{{external.hindsightGate.address}}`](https://creditcoin-testnet.blockscout.com/address/{{external.hindsightGate.address}}) — same GitHub account, interfaces only |
| A product on the runtime | [`PaidOnEthereum`]({{external.paidOnEthereum.repository}}) at [`{{external.paidOnEthereum.address}}`](https://creditcoin-testnet.blockscout.com/address/{{external.paidOnEthereum.address}}) — proves ERC-20 payments on Ethereum without `0x0FD2`; a second GitHub account of the same person |

Superseded deployments, and why each was replaced, are kept in `deployments.json`.

### Run it

```bash
git clone --recurse-submodules https://github.com/iamdflame/HINDSIGHT && cd HINDSIGHT
(cd contracts && npm install && forge test)
(cd worker && npm install)

node worker/src/differential.ts                 # the mirror vs the live precompile
node worker/src/local-proof.ts                  # rebuild a proof from a public node, compare with the prover
node worker/src/measure.ts --check              # every number above, re-read from the chain
node worker/src/hunter.ts --once --dry-run      # the searcher behind "nobody refuted it"
node worker/src/campaign.ts --chain 3 --follow  # keep the archive current (needs a funded key)
(cd web && npm install && npm run dev)          # the site
```

### Layout

```
contracts/   EthereumMirror · AbsenceRegistryV3 · UnderwritingDesk · MissingHeightBounty · frozen interfaces · tests
worker/      campaign + follower · hunter · board seeder · desk demo · differential · measure · document renderer
packages/    hindsight-mirror — verify from Node, cold
web/         the site: / · /verify · /record · /watch · /assess · /order · /judge · /claims · /enshrine · /integrate · /independence
docs/        ENSHRINE · INTEGRATING · MIGRATION · SUBMISSION · campaign logs · transcripts
```
