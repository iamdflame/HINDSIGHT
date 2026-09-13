<!-- Generated from docs/templates/README.md by worker/src/claims-doc.ts. Numbers come from deployments.json; edit the template, not this file. -->
# Hindsight

**Hindsight is the cache Attestcoin forgot to keep.**

Every Attestcoin query already proves a run of Ethereum block roots — the continuity proof — and then
throws them away. Hindsight keeps them. After that, proving any other transaction in those blocks is a
`view` call on Creditcoin: no prover, no `0x0FD2`, no wallet.

**Live: [https://hindsight.run](https://hindsight.run)** · the grading of every claim below: [CLAIMS.md](./CLAIMS.md)

---

*[한국어 (기계 번역 보조, 미검토)](./README.ko.md)*

## The problem

A continuity proof is the chain of transaction roots from the block you ask about up to an attested
height. The precompile verifies the whole chain — so its acceptance binds *every* root in it — and the
call returns, and the roots are gone. The next contract that asks about a different transaction in the
same block pays for the same continuity again. The deeper the block, the longer the chain: measured on
the live prover, 1 root for a fresh block, 41 for a day-old one, **841** for a block 180 days old.
Every dApp pays that, every time.

## The number

| | Ethereum mainnet (`chainKey 3`) | Sepolia (`chainKey 1`) |
|---|---|---|
| Heights held on Creditcoin | **792,101** | **303,301** |
| Unbroken run ending at the top | **791,200** blocks ≈ **109.9 days** (25,179,001 – 25,970,200) | **303,301** blocks ≈ **42.1 days** |
| Empty Ethereum blocks inside, held like any other | 243 | 32 |
| `mirror()` calls that added heights | 899 | 332 |
| Gas per newly held height (median) | **23,596** | 23,594 |
| Most roots retained by one call | **901** | 901 |

Verifying a second transaction in any of those blocks: a `view` call. Zero gas off-chain.

## The proof that the prover is not in the loop

Three things happen on the home page as it loads, against a block picked at random near the top of the
archive — never one whose own transaction was submitted to notarise it:

1. The Merkle path is **rebuilt in your browser** from a public Ethereum node. The prover gets no request.
2. `verifyOrRevert` runs as an `eth_call` with **`0x0FD2` deleted by a state override**. It still returns
   the transaction's index.
3. The control: the same call with the **mirror** deleted instead. It fails — so the node really applies
   overrides, and the answer really came from roots Creditcoin holds.

Measured and recorded by `measure.ts`: transaction index **131** of block
25,954,574 — a block notarised through index 263 — verifies as
**131** plainly and **131** with the precompile gone.

**Five minutes, no key, no `.env`:**

| Time | Do this | You should see |
|---|---|---|
| 30 s | open [https://hindsight.run](https://hindsight.run) | four rows settle — verified, verified with `0x0FD2` deleted, control refused, forged path refused — and the stamp |
| 1 min | `npx github:iamdflame/HINDSIGHT verify 0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9` | `verified` · `tx index  : 131` · `source : rebuilt locally (no prover)` · `precompile: not called` |
| 2 min | `cd contracts && forge test` | **176** tests, **27** of them fuzz properties, including the precompile etched to empty |
| 5 min | `cd worker && node src/differential.ts --limit 12` | the mirror and the live precompile accept and reject exactly the same inputs |

The full differential: **2,684 checks over 122 real mainnet transactions, 0 divergences** ([transcript](./docs/transcripts/differential-2026-09-13T03-50-16.md)).

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

The board on mainnet covers **25,314,741 – 25,970,100**, five sealed spans, ninety-one days.
It holds 26 claims about real Aave V3, Morpho Blue and Compound V3 borrowers; the ones that are
false are recorded in [`board-v3-mainnet.json`](./contracts/test/fixtures/board-v3-mainnet.json) with the transaction that makes each false.
13 refutations so far, **13.50 tCTC burned**. A standing claim means nobody refuted it in its window while
that much was at risk — never that it is true.

## The desk — a refusal, not a score

`UnderwritingDesk` reads the archive and the board and either pays or refuses with a reason: `ArchiveTooShallow`,
`ProvenLiar`, `EventOnRecord`, `ClaimUnderHunt`, `NoBondedCleanliness`, `NeedsBondedCover`, `UnprovenSubject`,
`PoolCapReached`, `AlreadyLent`. Its 8 instruments look back **648,000 blocks — ninety days — and refuse outright
unless every one of those heights is proven held**, by sealed spans the caller offers and the desk re-checks
(43,325 gas cold in Foundry; 407,960 gas on Creditcoin, where the superseded desk that walked the bitmap
spent 7,041,373 for the same question). A loan may not exceed ten times what a liar could not recover, the
book may not exceed what the attestors behind the source chain have bonded, silence is answered and never
lent against, and an instrument may insist the borrower has signed for its Ethereum address.

Nothing is minted, nothing is transferable, and there is no number. Ask about any address, no wallet:
[mandate.hindsight.run](https://mandate.hindsight.run) — or `GET /api/assess?subject=0x…`, or
`npx hindsight-mirror mandate assess 0x…`, or the `hindsight-mcp` tool `mandate_assess`, all the same view.

**Mandate** is the product face: [assess](https://mandate.hindsight.run/mandate/) ·
[files](https://mandate.hindsight.run/files/) · [cover](https://mandate.hindsight.run/cover/) ·
[versus](https://mandate.hindsight.run/versus/) · [hunt](https://mandate.hindsight.run/hunt/). Same paper,
same wax, same runtime; the word *precompile* does not appear on it.

## Enshrine it

The better home for this cache is the node. [docs/ENSHRINE.md](./docs/ENSHRINE.md) proposes a native
`BlockRootCache` written as a side effect of every successful query — and says we would rather help build
it than be the reason it is not needed.

## Grading

[CLAIMS.md](./CLAIMS.md) grades every statement in this repository by the evidence behind it, including the
ones that limit the product. It is generated from the same measured record as this file. The promises it makes
about live state are re-checked on a schedule, in public: **[https://hindsight.run/status/](https://hindsight.run/status/)** — twelve gates
against Creditcoin, the result at most five minutes old.

---

### Contracts (Creditcoin CC3 testnet, all ownerless, all verified)

| | |
|---|---|
| `EthereumMirror` v2 — `IMirror` | [`0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118`](https://creditcoin-testnet.blockscout.com/address/0x2d8A4d5A34120FF9742d7a4dad37F4ff6335c118) |
| `AbsenceRegistryV3` — `IAbsence`, `IAbsenceV3` | [`0x05844C991993F3d80fAf196e10355B12BE648e40`](https://creditcoin-testnet.blockscout.com/address/0x05844C991993F3d80fAf196e10355B12BE648e40) |
| `UnderwritingDesk` | [`0xc176b4307315F8494A763773385B455aE0b7f9d2`](https://creditcoin-testnet.blockscout.com/address/0xc176b4307315F8494A763773385B455aE0b7f9d2) |
| `MissingHeightBounty` | [`0xdb2A1eEEbDEEfe35AA43D22a03B06Eda140f238d`](https://creditcoin-testnet.blockscout.com/address/0xdb2A1eEEbDEEfe35AA43D22a03B06Eda140f238d) |
| A consumer in another repository | [`hindsight-gate`](https://github.com/iamdflame/hindsight-gate) at [`0xeeFa14CA77cEe451Df6474c9dCcBce38A691a254`](https://creditcoin-testnet.blockscout.com/address/0xeeFa14CA77cEe451Df6474c9dCcBce38A691a254) — same GitHub account, interfaces only |
| A product on the runtime | [`PaidOnEthereum`](https://github.com/davidpraise288-coder/int_hind) at [`0xF2c2e220c34a9048E08A222F7Da546E0d201C85B`](https://creditcoin-testnet.blockscout.com/address/0xF2c2e220c34a9048E08A222F7Da546E0d201C85B) — proves ERC-20 payments on Ethereum without `0x0FD2`; a second GitHub account of the same person |

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
packages/    hindsight-mirror — the SDK and CLI (verify · assess · checks · usable · hunt · bind) · hindsight-mcp — the MCP server
templates/   foundry-consumer — a consumer that deletes the precompile in its own tests and keeps working
web/         hindsight.run: / · /verify · /record · /watch · /assess · /order · /judge · /claims · /enshrine · /integrate · /independence · /status
             mandate.hindsight.run: /mandate · /files · /cover · /versus · /hunt · /tg — and /api/assess · /api/certificate · /api/dump · /api/gates · /api/telegram · /openapi.json
docs/        ENSHRINE (with the BlockRootCache RIP) · INTEGRATING · OPERATIONS · MIGRATION · SUBMISSION · campaign logs · transcripts
```
