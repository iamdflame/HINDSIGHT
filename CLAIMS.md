<!-- Generated from docs/templates/CLAIMS.md by worker/src/claims-doc.ts. Numbers come from deployments.json, which worker/src/measure.ts writes from the chain; CI fails if this file, the template or the chain disagree. -->
# What is actually established

Every claim this project makes, graded by the strength of the evidence behind it. Anything not listed
here is not claimed. All on-chain references are Creditcoin CC3 testnet (chain 102031), with Ethereum
mainnet (`chainKey 3`) and Sepolia (`chainKey 1`) as source chains.

Re-derive every number: `node worker/src/measure.ts --check` (the chain), `forge test` (the code),
`node worker/src/differential.ts` (the precompile), `node worker/src/hunter.ts --audit` (the board).

---

## Demonstrated on-chain

| Claim | Evidence |
|---|---|
| One Attestcoin proof carries the roots of many consecutive blocks, and one `mirror()` call keeps all of them | the widest call retained **901** roots — [`0xa9bb…5d70`](https://creditcoin-testnet.blockscout.com/tx/0xa9bb644f31b88e5a71c296b323a799d03ed7083b23b8b81d02cd1b37a3555d70) |
| Ninety days of Ethereum mainnet are held, with no gap | **779,401** consecutive heights, 25,187,300 – 25,966,700 (≈ 108.3 days), read bit by bit from the mirror's bitmap. 780,302 heights held in all, added by 899 `mirror()` calls ([every call](./docs/CAMPAIGN-mainnet.md)) |
| Thirty days of Sepolia are held, with no gap | **300,601** consecutive heights (≈ 41.8 days) ending at 11,694,200 |
| Keeping a root is cheap and flat | **23,596 gas** per newly held height (median; 23,492–27,232 over 834 calls that each added ≥ 800), from every campaign receipt |
| An empty Ethereum block is held, and a sealed span crosses it | block **25,354,534** has a transaction root of zero (`rootIsZero: true`), `isMirrored` = **true**, and sealed span 0 (25,309,541 – 25,440,612, 131,072 blocks) covers it: `true`. 243 empty blocks are held on mainnet, 32 on Sepolia |
| Proving a span gap-free is one read per 256 blocks | sealing **131,072** blocks cost **1,280,230 gas** — [`0x90d9…11a8`](https://creditcoin-testnet.blockscout.com/tx/0x90d928710400454b263208f6ee194cc4dd1a60a18fe37316acfac84f6c8a11a8); 7 spans sealed |
| A **second** transaction in a notarised block verifies with the precompile gone, and the control fails | transaction index 131 of block 25,954,574 (the block was notarised through index 263): `verifyOrRevert` as a plain `eth_call` → **131**; with `0x0FD2` blanked by a state override → **131**; with the mirror blanked instead → `ok: false`. The home page runs the same three calls live on a block picked as it loads |
| The mirror reaches the same verdict as the precompile, and fails the same way | **2,684 checks over 122 real mainnet transactions × 22 adversarial mutations, 0 divergences**, against the live precompile — [transcript](./docs/transcripts/differential-2026-09-13T03-50-16.md) |
| A contract in another repository uses the frozen interfaces and never calls `0x0FD2` | `Gate` at [`0xeeFa…a254`](https://creditcoin-testnet.blockscout.com/address/0xeeFa14CA77cEe451Df6474c9dCcBce38A691a254): `happened()` returns **263** for a real Aave liquidation plainly and **263** with the precompile blanked; with the mirror blanked it fails (`ok: false`). **Same GitHub owner as Hindsight** — it proves the interfaces are sufficient, not that a stranger chose to integrate |
| A different product runs on the interface alone | [`PaidOnEthereum`](https://github.com/davidpraise288-coder/int_hind) at [`0xF2c2…C85B`](https://creditcoin-testnet.blockscout.com/address/0xF2c2e220c34a9048E08A222F7Da546E0d201C85B) proves ERC-20 transfers on Ethereum against held roots: 44,663.20 of the 18-decimal token `0x7deF…56bE` in [`0x803a…bfa8`](https://creditcoin-testnet.blockscout.com/tx/0x803a8294c887e09a49fc0d5cba8c33c8dd21b85e85bfab768d0a3c374f99bfa8) (212,212 gas) and WETH from Morpho Blue in [`0xbc11…8547`](https://creditcoin-testnet.blockscout.com/tx/0xbc1161ff45cbfa17897ef68d20bab284cac3090fbf6841b992e5736e10958547) — neither Ethereum transaction ever submitted to Attestcoin. **A second GitHub account of the same person, and its deployer was funded from Hindsight's.** It shows a product can be built on `IMirror` alone; it does not show a stranger chose to |
| False negative claims die on-chain, and half of every bond burns | 10 refutations on the v3 board, **10.00 tCTC** paid to the hunter and **10.00 tCTC** burned to `0x…dEaD`. Listed below |
| A completeness claim is refuted by the member it left out | the `omission` rows below: each listed every liquidation of its borrower but one; each was refuted by exactly that one, with the burn |
| The desk's ninety-day policy answers — the archive is not too shallow | BlankFile policy 0 (window 648,000 blocks) returns `None` for an address with nothing on file. It reads `contiguousFrom` over every height of the window, not two endpoints |
| The desk lends and refuses on facts nobody in this system authored | the transactions below, and `docs/transcripts/desk-v3.json` |

### The mainnet board (25,309,541 – 25,964,900, five sealed spans)

| # | Role | Kind | Venue | Status | Refutation |
|---|---|---|---|---|---|
| 0 | lie | EmptySet | Aave V3 · LiquidationCall | **Refuted** | [`0x9273…20ab`](https://creditcoin-testnet.blockscout.com/tx/0x92734f9067d1d99f4a3e65b44c40b3edbf99ee76216bdb14a659eb7ee91c20ab) · paid 1.00 · burned 1.00 |
| 1 | lie | EmptySet | Aave V3 · LiquidationCall | **Refuted** | [`0x448d…38ac`](https://creditcoin-testnet.blockscout.com/tx/0x448d99cf388549fb0610db0c01640941a47b2133b80693ad7b7fc8d534e438ac) · paid 1.00 · burned 1.00 |
| 2 | lie | EmptySet | Aave V3 · LiquidationCall | **Refuted** | [`0xbf4e…a32d`](https://creditcoin-testnet.blockscout.com/tx/0xbf4e9e8ee8d7588a00c56a1d0a153ec1a5ab94988f475c1a443f410c0bbba32d) · paid 1.00 · burned 1.00 |
| 3 | lie | EmptySet | Morpho Blue · Liquidate | **Refuted** | [`0x2642…dce1`](https://creditcoin-testnet.blockscout.com/tx/0x26429c2cc0f3e938694c3aaa87cdbdfdb0a782a6f25860234ebc611e2ce5dce1) · paid 1.00 · burned 1.00 |
| 4 | lie | EmptySet | Morpho Blue · Liquidate | **Refuted** | [`0xd8dd…7392`](https://creditcoin-testnet.blockscout.com/tx/0xd8dd3b5f0006c2032862d73d8b1af6abf3e292a96fe656b23ccdfa3b80b57392) · paid 1.00 · burned 1.00 |
| 5 | lie | EmptySet | Compound V3 · AbsorbDebt | **Refuted** | [`0xbb3c…f8da`](https://creditcoin-testnet.blockscout.com/tx/0xbb3cd9447f4de56f68942d2122b38d2c4e812705c0a44da39e870763548ef8da) · paid 1.00 · burned 1.00 |
| 10 | omission | CompleteSet | Aave V3 · LiquidationCall | **Refuted** | [`0x1c8f…e85c`](https://creditcoin-testnet.blockscout.com/tx/0x1c8fffdcb6f2a72b316c588f791d37732bcd514c70c8cf55aefe6a6cb8b0e85c) · paid 1.00 · burned 1.00 |
| 11 | omission | CompleteSet | Morpho Blue · Liquidate | **Refuted** | [`0x77ea…bd38`](https://creditcoin-testnet.blockscout.com/tx/0x77eae26ffd592d63314dc0c360fd1f6b7f31c382b721207dddabe754e6febd38) · paid 1.00 · burned 1.00 |
| 6 | bounty | EmptySet | Aave V3 · LiquidationCall | Open | left open for anyone; the house hunter waits six days |
| 7 | bounty | EmptySet | Aave V3 · LiquidationCall | Open | left open for anyone; the house hunter waits six days |
| 8 | bounty | EmptySet | Morpho Blue · Liquidate | Open | left open for anyone; the house hunter waits six days |
| 9 | bounty | EmptySet | Compound V3 · AbsorbDebt | Open | left open for anyone; the house hunter waits six days |
| 12 | complete | CompleteSet | Aave V3 · LiquidationCall | Standing | — |
| 13 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 14 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 15 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 16 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 17 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 18 | clean | EmptySet | Aave V3 · LiquidationCall | Standing | — |
| 19 | borrower | EmptySet | Aave V3 · LiquidationCall | Standing | — |

Lies left standing: **0**. True claims refuted: **0**. Every false claim is recorded with the
transaction that makes it false in [`board-v3-mainnet.json`](./contracts/test/fixtures/board-v3-mainnet.json), filed from a separate wallet
from the hunter's. `node worker/src/hunter.ts --audit` re-scans every settled claim: a refuted one must still
have a counterexample and a standing one must not.

### The Sepolia board (11,430,257 – 11,692,400, two sealed spans)

The same event at Sepolia's own Aave V3 pool: a different file from any mainnet claim, because a claim's key includes its chain.

| # | Role | Kind | Status | Refutation |
|---|---|---|---|---|
| 20 | lie | EmptySet | **Refuted** | [`0x85cf…120c`](https://creditcoin-testnet.blockscout.com/tx/0x85cf5d96567370f099ac6864868d02edee5ef04df9644e657974ce2b748c120c) · paid 1.00 · burned 1.00 |
| 21 | lie | EmptySet | **Refuted** | [`0x07bf…c419`](https://creditcoin-testnet.blockscout.com/tx/0x07bf40fd7c8351a44e9228366b3027e2492decb41367fea9bb180da5ec5bc419) · paid 1.00 · burned 1.00 |
| 22 | complete | CompleteSet, 5 members | Standing | — |

The last audit (2026-09-13T09:39:35.796Z) re-scanned **23** claims, 19 of them settled: **0** inconsistent, 0 unscannable.

### The desk's transactions

| What | Policy | Outcome | Gas | Transaction |
|---|---|---|---|---|
| own claim still open | 1 | `ClaimUnderHunt` · receipt status 0 | 7,041,506 | [`0x77f6…a0ff`](https://creditcoin-testnet.blockscout.com/tx/0x77f6188007a9d59e585db1a25954bd369be2f8e2c35fe8a474b262212dcda0ff) |
| bonded-clean: a standing 4 tCTC claim covering 91 days | 1 | `Lent` · receipt status 1 | 7,089,575 | [`0x37e2…a07b`](https://creditcoin-testnet.blockscout.com/tx/0x37e22fb0e1467799e7def88a9c1c39508eaf630b3652b76b9dab4b965bd4a07b) |
| blank file | 0 | `Lent` · receipt status 1 | 7,070,489 | [`0x9935…8e16`](https://creditcoin-testnet.blockscout.com/tx/0x993526fda92b018fcd55337fc5692d6b2edb0363d73c6eaae404f592cb318e16) |
| a second loan under the same policy | 1 | `AlreadyLent` · receipt status 0 | 78,582 | [`0x4137…56ce`](https://creditcoin-testnet.blockscout.com/tx/0x4137262d863081baa55434a77d2a41597ae61d847ebf38a1f94d1ad0c70656ce) |

A refusal about a real liquidated borrower is shown by `assess(subject, …)`, the same predicate `borrow()` gates
on, because the desk only ever pays `msg.sender` and nobody here holds those borrowers' keys. The wallet that
borrowed is fresh and has never touched Ethereum: its clean claim is trivially true, and the loan demonstrates
the `BondedClean` mechanism, not a vetted stranger.

## Verified locally, reproducible by anyone

| Claim | Evidence |
|---|---|
| The code does what this file says | **147** `forge test` cases, **27** of them fuzz properties at 256 runs each |
| The hosted prover is replaceable for Merkle paths | `worker/src/local-proof.ts` rebuilds a block from a public Ethereum node; root and every sibling with its direction bit are byte-identical to the prover's. The home page does the same in the browser and sends the prover nothing |
| Empty blocks were the product limit, and are not now | `test_emptyBlockIsMirroredAndSealCrossesIt`, `test_zeroRootHeldDoesNotLookUnheld`, and a fuzz of the word-wise contiguity check against a per-height reference |
| A listed member must be real, and the omitted one refutes | `testFuzz_completeSetRefutedByOmittedMember` over six real clustered Aave liquidations; fabricated, out-of-order, duplicated and out-of-span members are refused at assertion |
| A liar cannot recover the burned half | `test_selfRefuteCannotRecoverBurn`, `testFuzz_enforceableLossIsExactlyTheBurnedHalf`, `testFuzz_isUsableBoundary` |
| The desk refuses a shallow or holed archive | `test_deskRefusesArchiveTooShallowFor90Days`, `test_holeInsideTheWindowIsTooShallow`, `test_isolatedWindowAboveTheArchiveFailsClosed`, `testFuzz_depthBoundaryIsExact`; the 90-day check costs 7.03M gas cold inside `borrow` (`test_gas_ninetyDayBorrowReadsTheBitmapWordWise`) |
| The desk cannot be handed a true statement about the wrong thing | `test_claimReadThroughAnotherTopicIsNotCleanliness`, `test_claimOnAnotherChainIsIgnored`, `test_listedLiquidationIsEventOnRecordNotCleanliness`, `test_subjectlessRefutationBrandsNobody` |
| Nobody can switch the desk off with volume | `test_junkClaimsCannotSwitchOffTheDesk` files 576 claims; `test_buryingABondedClaimFailsClosed` buries one under 64 |
| A claimant cannot keep its claim open by refusing its bond | `test_claimantRefusingItsBondCannotKeepAClaimOpen`, `test_claimantBurningGasCannotBlockFinalize` |
| A reverted liquidation is not a liquidation | `test/FailedTransaction.t.sol`: a real leaf with only its receipt status rewritten verifies, and the registry still refuses it |

## Economic, not cryptographic — stated precisely

| Claim | What it actually means |
|---|---|
| A claim in **`Standing`** | Nobody refuted it within its window, over a gap-free sealed range, while `enforceableLoss` was at risk. **Not** that the event never happened |
| `isUsable(claimId, exposure)` | Standing, and the burned half of the bond is at least `exposure`. Size reliance against what a liar cannot recover, not the headline bond |
| The desk's refusal | `ProvenLiar` and `EventOnRecord` rest on transactions verified against held roots inside the policy's window. `ClaimUnderHunt` means an open claim exists. `BlankFile` is the default and does not treat silence as innocence; `BondedClean` needs a standing no-event claim covering the whole window, ending within a week of the head |
| Bounties are worth hunting | refutations on this board cost **448,294–4,046,311 gas** each, against bonds of 2–3 tCTC of which half is paid out. An incentive argument, not a proof |
| Commit–reveal defeats bounty theft | the commitment binds `msg.sender`. Not audited, and not proof against a validator who reorders or censors |

## Trust assumptions we keep, deliberately

- **Notarising a block requires the Attestcoin attestor set and `0x0FD2`.** Only verification *after*
  notarisation is free of them. Attestcoin is the trust root, by design.
- **The mirror does not re-derive the continuity chain.** It checks that `continuityRoots[0]` is the root of the
  block it was told about and delegates the rest to the precompile, whose acceptance binds every root in the array.
  Pinned by `test/TrustBoundary.t.sol`. Mirror v2's NatSpec says so correctly; v1's did not.
- **Public Ethereum RPCs are used to rebuild proofs and scan logs.** A lying RPC cannot forge a positive — the
  rebuilt root would not meet the held one. A negative is different: see below.
- **The desk anchors its window on `highestMirrored`.** Anyone may notarise an isolated window above the archive;
  the desk then refuses `ArchiveTooShallow` until the gap is filled, and the follower fills from the unbroken run's
  own top. Fail-closed, and transient.

## Things we found that limit the product, stated rather than hidden

- **Public RPCs say "nothing" when something is there.** Measured on 2026-09-13: `rpc.flashbots.net` returned
  zero Aave `LiquidationCall` logs for a single block holding four, with no error; Sepolia's publicnode serves
  August blocks but no logs or receipts for them. Both are removed. Every endpoint is canaried for logs at the
  bottom of a range before its silence counts, a negative needs two endpoints that each covered the whole range,
  and a completeness scan needs two that agree on the count — the Sepolia board was first refused on exactly that
  (190 logs against 0).
- **The prover's archiver would not serve 25,186,001 – 25,187,000.** Every window touching it failed with
  `failed to get roots from archiver`, across strides of 900 and 500. The mainnet archive therefore has one hole,
  below the unbroken run: 2 runs, 15,299 heights unheld inside the range. Nothing above it is affected.
- **Unpaced campaign workers congest a shared testnet.** Four workers sending 21M-gas calls pushed CC3's base fee
  from 0.5 to 6.7 gwei. Every worker now pauses above 1.5 gwei.
- **Counting concurrent writes by before/after totals is wrong.** It credited one call with every other worker's
  additions. Workers read `newlyAdded` from their own event; `measure.ts` checks the bitmap against a counter window.
- **The first v3 desk and registry were replaced before any claim was filed on them.** The desk matched claims on
  subject alone (a true claim through another topic slot, chain, or a list of liquidations would have counted as a
  clean record), walked every claim ever filed (513 junk claims would have switched it off), and measured depth by
  endpoints; the registry pushed bonds, so a claimant refusing payment could keep a claim open forever. Addresses and
  reasons are under `contracts.superseded` in `deployments.json`.
- **A policy window moves.** A liquidation that slips below the ninety-day floor stops refusing — by design. Two of
  the refuted lies on the board already sit below it; `docs/transcripts/desk-v3.json` records the verdict with the
  evidence height and the floor.
- **A follower is only as current as its wallet.** The Sepolia follower ran out of gas money and spent an hour
  retrying a transaction the node had dropped, re-sent byte-identical and refused as "already known". Followers now
  jitter their tip so every attempt is distinct; funding them remains an operational duty, and the archive stops
  lengthening — it never shrinks — when it lapses.
- **The ninety-day check is not free inside a transaction:** 7.03M gas cold in `borrow`. `assess` is a `view`.
- **GitHub will not run this project's CI** (every job is refused: "account is locked due to a billing issue").
  The promises that do not need a compiler are re-checked instead by [`/api/gates`](https://hindsight-cache.vercel.app/api/gates), in public, at
  [https://hindsight-cache.vercel.app/status/](https://hindsight-cache.vercel.app/status/): the runtime bytecode of every contract against what this repository compiles
  to, ninety days of mainnet and thirty of Sepolia held with no gap, the empty block in its sealed span, the second
  transaction with `0x0FD2` deleted and both controls, the stranger consumer, a differential sample against the live
  precompile, the desk's depth and its refusal, the board, and `PaidOnEthereum` re-verifying its payment with the
  precompile deleted. Vercel Cron runs it daily, and any visitor at most
  every five minutes. A broken gate answers `503`. Expectations come from the repository through
  `worker/src/gates-manifest.ts`, never from the function. `forge test` still runs only where there is a compiler.
- **Bounties depend on somebody running a hunter.** The house hunter leaves claims younger than six days to humans.
  If nobody hunts and it is not running, a false claim will stand — which is exactly, and only, what `Standing` means.

## v1, kept as history

The first mirror, [`0x4Bc1…e2AB`](https://creditcoin-testnet.blockscout.com/address/0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB), held
**100,801** heights of which **100,777** were answerable: its zero-root sentinel could not tell an empty block from a
missing one, cutting the archive into **25** runs with a longest of **18,443** blocks. Its registry held
36 claims, 10 of them refuted by the hunter. Mirror v2 exists because of those numbers. Every v1
contract stays on-chain; nothing was migrated in place.

## Not claimed

- That absence is ever proven cryptographically.
- That a `Standing` claim stays true afterwards, or was true: it is scoped to one range and one window.
- That the contracts are audited.
- That the archive starts at genesis. It covers the stated ranges and says where each stops.
- That `hindsight-gate` or `PaidOnEthereum` is a third party. The first has the same GitHub account; the second, a
  second account of the same person. No independent team has integrated Hindsight yet.
- That other projects' gas figures are ours. `docs/MIGRATION.md` quotes their READMEs, row by row, with links.
- That writability (Creditcoin → Ethereum) is used. It is not released on testnet.
- Any figure about Creditcoin's lending history. The $100M in `docs/SUBMISSION.md` is Creditcoin's own public statement ([creditcoin.org/Credal](https://creditcoin.org/Credal)), quoted, not measured here.
- No score, rating or passport of any kind: the desk pays or refuses and says why.
