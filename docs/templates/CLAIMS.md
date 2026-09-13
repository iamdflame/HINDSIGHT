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
| One Attestcoin proof carries the roots of many consecutive blocks, and one `mirror()` call keeps all of them | the widest call retained **{{measured.chains.3.widestCall.roots|n}}** roots — [`{{measured.chains.3.widestCall.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{measured.chains.3.widestCall.tx}}) |
| Ninety days of Ethereum mainnet are held, with no gap | **{{measured.chains.3.topRun|n}}** consecutive heights, {{measured.chains.3.topRunFrom|n}} – {{measured.chains.3.highest|n}} (≈ {{measured.chains.3.topRunDays|days}} days), read bit by bit from the mirror's bitmap. {{measured.chains.3.held|n}} heights held in all, added by {{measured.chains.3.mirrorCalls|n}} `mirror()` calls ([every call](./docs/CAMPAIGN-mainnet.md)) |
| Thirty days of Sepolia are held, with no gap | **{{measured.chains.1.topRun|n}}** consecutive heights (≈ {{measured.chains.1.topRunDays|days}} days) ending at {{measured.chains.1.highest|n}} |
| Keeping a root is cheap and flat | **{{measured.chains.3.gasPerNewRoot.median|n}} gas** per newly held height (median; {{measured.chains.3.gasPerNewRoot.min|n}}–{{measured.chains.3.gasPerNewRoot.max|n}} over {{measured.chains.3.gasPerNewRoot.calls|n}} calls that each added ≥ 800), from every campaign receipt |
| An empty Ethereum block is held, and a sealed span crosses it | block **{{measured.acceptance.emptyBlockInSealedSpan.height|n}}** has a transaction root of zero (`rootIsZero: {{measured.acceptance.emptyBlockInSealedSpan.rootIsZero}}`), `isMirrored` = **{{measured.acceptance.emptyBlockInSealedSpan.isMirrored}}**, and sealed span {{measured.acceptance.emptyBlockInSealedSpan.spanId}} ({{measured.acceptance.emptyBlockInSealedSpan.spanFrom|n}} – {{measured.acceptance.emptyBlockInSealedSpan.spanTo|n}}, {{measured.acceptance.emptyBlockInSealedSpan.spanBlocks|n}} blocks) covers it: `{{measured.acceptance.emptyBlockInSealedSpan.spanCovers}}`. {{measured.chains.3.emptyBlocks|n}} empty blocks are held on mainnet, {{measured.chains.1.emptyBlocks|n}} on Sepolia |
| Proving a span gap-free is one read per 256 blocks | sealing **{{measured.acceptance.sealing.widest|n}}** blocks cost **{{measured.acceptance.sealing.gasForWidest|n}} gas** — [`{{measured.acceptance.sealing.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{measured.acceptance.sealing.tx}}); {{measured.acceptance.sealing.spans}} spans sealed |
| A **second** transaction in a notarised block verifies with the precompile gone, and the control fails | transaction index {{measured.acceptance.secondTransaction.expectedIndex}} of block {{measured.acceptance.secondTransaction.block|n}} (the block was notarised through index {{measured.acceptance.secondTransaction.notarisedWithIndex}}): `verifyOrRevert` as a plain `eth_call` → **{{measured.acceptance.secondTransaction.plain.txIndex}}**; with `0x0FD2` blanked by a state override → **{{measured.acceptance.secondTransaction.precompileBlanked.txIndex}}**; with the mirror blanked instead → `ok: {{measured.acceptance.secondTransaction.mirrorBlanked.ok}}`. The home page runs the same three calls live on a block picked as it loads |
| The mirror reaches the same verdict as the precompile, and fails the same way | **{{measured.differential.checks|n}} checks over {{measured.differential.fixtures}} real mainnet transactions × 22 adversarial mutations, {{measured.differential.divergences}} divergences**, against the live precompile — [transcript](./{{measured.differential.transcript}}) |
| A contract in another repository uses the frozen interfaces and never calls `0x0FD2` | `Gate` at [`{{measured.acceptance.strangerConsumer.address|short}}`](https://creditcoin-testnet.blockscout.com/address/{{measured.acceptance.strangerConsumer.address}}): `happened()` returns **{{measured.acceptance.strangerConsumer.plain.txIndex}}** for a real Aave liquidation plainly and **{{measured.acceptance.strangerConsumer.precompileBlanked.txIndex}}** with the precompile blanked; with the mirror blanked it fails (`ok: {{measured.acceptance.strangerConsumer.mirrorBlanked.ok}}`). **Same GitHub owner as Hindsight** — it proves the interfaces are sufficient, not that a stranger chose to integrate |
| A different product runs on the interface alone | [`PaidOnEthereum`]({{external.paidOnEthereum.repository}}) at [`{{external.paidOnEthereum.address|short}}`](https://creditcoin-testnet.blockscout.com/address/{{external.paidOnEthereum.address}}) proves ERC-20 transfers on Ethereum against held roots: {{external.paidOnEthereum.proofs.0.amount|tctc}} of the 18-decimal token `{{external.paidOnEthereum.proofs.0.token|short}}` in [`{{external.paidOnEthereum.proofs.0.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{external.paidOnEthereum.proofs.0.tx}}) ({{external.paidOnEthereum.proofs.0.gasUsed|n}} gas) and WETH from Morpho Blue in [`{{external.paidOnEthereum.proofs.1.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{external.paidOnEthereum.proofs.1.tx}}) — neither Ethereum transaction ever submitted to Attestcoin. **A second GitHub account of the same person, and its deployer was funded from Hindsight's.** It shows a product can be built on `IMirror` alone; it does not show a stranger chose to |
| False negative claims die on-chain, and half of every bond burns | {{measured.board.refutations}} refutations on the v3 board, **{{measured.board.paidWei|tctc}} tCTC** paid to the hunter and **{{measured.board.burnedWei|tctc}} tCTC** burned to `0x…dEaD`. Listed below |
| A completeness claim is refuted by the member it left out | the `omission` rows below: each listed every liquidation of its borrower but one; each was refuted by exactly that one, with the burn |
| The desk's ninety-day policy answers — the archive is not too shallow | {{measured.desk.ninetyDay.0.kind}} policy {{measured.desk.ninetyDay.0.policy}} (window {{measured.desk.ninetyDay.0.window|n}} blocks) returns `{{measured.desk.ninetyDay.0.reason}}` for an address with nothing on file. It reads `contiguousFrom` over every height of the window, not two endpoints |
| The desk lends and refuses on facts nobody in this system authored | the transactions below, and `docs/transcripts/desk-v3.json` |

### The mainnet board ({{measured.board.chains.mainnet.spanFrom|n}} – {{measured.board.chains.mainnet.spanTo|n}}, five sealed spans)

| # | Role | Kind | Venue | Status | Refutation |
|---|---|---|---|---|---|
{{#each measured.board.chains.mainnet.rows where role=lie,omission}}| {{.claimId}} | {{.role}} | {{.kind}} | {{.venue}} | **{{.status}}** | [`{{.refutation.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{.refutation.tx}}) · paid {{.refutation.paidWei|tctc}} · burned {{.refutation.burnedWei|tctc}} |
{{/each}}
{{#each measured.board.chains.mainnet.rows where role=bounty}}| {{.claimId}} | bounty | {{.kind}} | {{.venue}} | {{.status}} | left open for anyone; the house hunter waits six days |
{{/each}}
{{#each measured.board.chains.mainnet.rows where role=complete,clean,borrower}}| {{.claimId}} | {{.role}} | {{.kind}} | {{.venue}} | {{.status}} | — |
{{/each}}

Lies left standing: **{{measured.board.chains.mainnet.liesStanding}}**. True claims refuted: **{{measured.board.chains.mainnet.truthsRefuted}}**. Every false claim is recorded with the
transaction that makes it false in [`board-v3-mainnet.json`](./contracts/test/fixtures/board-v3-mainnet.json), filed from a separate wallet
from the hunter's. `node worker/src/hunter.ts --audit` re-scans every settled claim: a refuted one must still
have a counterexample and a standing one must not.

### The Sepolia board ({{measured.board.chains.sepolia.spanFrom|n}} – {{measured.board.chains.sepolia.spanTo|n}}, two sealed spans)

The same event at Sepolia's own Aave V3 pool: a different file from any mainnet claim, because a claim's key includes its chain.

| # | Role | Kind | Status | Refutation |
|---|---|---|---|---|
{{#each measured.board.chains.sepolia.rows where role=lie}}| {{.claimId}} | {{.role}} | {{.kind}} | **{{.status}}** | [`{{.refutation.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{.refutation.tx}}) · paid {{.refutation.paidWei|tctc}} · burned {{.refutation.burnedWei|tctc}} |
{{/each}}
{{#each measured.board.chains.sepolia.rows where role=complete}}| {{.claimId}} | {{.role}} | {{.kind}}, {{.members}} members | {{.status}} | — |
{{/each}}

The last audit ({{measured.board.audit.at}}) re-scanned **{{measured.board.audit.claims}}** claims, {{measured.board.audit.settled}} of them settled: **{{measured.board.audit.inconsistent}}** inconsistent, {{measured.board.audit.unscannable}} unscannable.

### The desk's transactions

| What | Policy | Outcome | Gas | Transaction |
|---|---|---|---|---|
{{#each measured.desk.transactions where kind=borrow}}| {{.label}} | {{.policyId}} | `{{.reason}}` · receipt status {{.status}} | {{.gasUsed|n}} | [`{{.tx|short}}`](https://creditcoin-testnet.blockscout.com/tx/{{.tx}}) |
{{/each}}

A refusal about a real liquidated borrower is shown by `assess(subject, …)`, the same predicate `borrow()` gates
on, because the desk only ever pays `msg.sender` and nobody here holds those borrowers' keys. The wallet that
borrowed is fresh and has never touched Ethereum: its clean claim is trivially true, and the loan demonstrates
the `BondedClean` mechanism, not a vetted stranger.

## Verified locally, reproducible by anyone

| Claim | Evidence |
|---|---|
| The code does what this file says | **{{static.forgeTests}}** `forge test` cases, **{{static.fuzzTests}}** of them fuzz properties at 256 runs each |
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
| Bounties are worth hunting | refutations on this board cost **{{measured.board.refutationGas.min|n}}–{{measured.board.refutationGas.max|n}} gas** each, against bonds of 2–3 tCTC of which half is paid out. An incentive argument, not a proof |
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
  below the unbroken run: {{measured.chains.3.runs}} runs, {{measured.chains.3.unheldInRange|n}} heights unheld inside the range. Nothing above it is affected.
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
  The promises that do not need a compiler are re-checked instead by [`/api/gates`]({{site}}/api/gates), in public, at
  [{{site}}/status/]({{site}}/status/): the runtime bytecode of every contract against what this repository compiles
  to, ninety days of mainnet and thirty of Sepolia held with no gap, the empty block in its sealed span, the second
  transaction with `0x0FD2` deleted and both controls, the stranger consumer, a differential sample against the live
  precompile, the desk's depth and its refusal, the board, and `PaidOnEthereum` re-verifying its payment with the
  precompile deleted. Vercel Cron runs it daily, and any visitor at most
  every five minutes. A broken gate answers `503`. Expectations come from the repository through
  `worker/src/gates-manifest.ts`, never from the function. `forge test` still runs only where there is a compiler.
- **Bounties depend on somebody running a hunter.** The house hunter leaves claims younger than six days to humans.
  If nobody hunts and it is not running, a false claim will stand — which is exactly, and only, what `Standing` means.

## v1, kept as history

The first mirror, [`{{contracts.v1.EthereumMirror|short}}`](https://creditcoin-testnet.blockscout.com/address/{{contracts.v1.EthereumMirror}}), held
**{{measured.v1.heightsRetained|n}}** heights of which **{{measured.v1.heightsAnswerable|n}}** were answerable: its zero-root sentinel could not tell an empty block from a
missing one, cutting the archive into **{{measured.v1.contiguousRuns}}** runs with a longest of **{{measured.v1.longestRunBlocks|n}}** blocks. Its registry held
{{measured.v1.claimsTotal}} claims, {{measured.v1.claimsRefuted}} of them refuted by the hunter. Mirror v2 exists because of those numbers. Every v1
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
