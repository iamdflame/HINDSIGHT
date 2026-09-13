<!-- Generated from docs/templates/ENSHRINE.md by worker/src/claims-doc.ts; edit the template. -->
# The roots you already hash

**A note for the Attestcoin team on a cache the protocol computes, verifies, and then discards.**

---

## 1. The observation

Every Attestcoin readability query carries a continuity proof: an array of transaction Merkle roots
running from the queried block up to an attestation or checkpoint, chained by

```
digest[i] = keccak(number[i], root[i], digest[i-1])
```

`0x0FD2` verifies that the whole chain terminates at a stored attestation. Altering any single root
diverges the terminal digest, so **acceptance binds every root in the array**, not merely the one
belonging to the caller's transaction.

Then the call returns, and every root in that array is dropped.

The next dApp that wants a different transaction in the same block pays to reconstruct and
re-verify the same continuity all over again.

## 2. What it costs today

Measured against the live CC3 testnet prover's single-transaction endpoint, {{measured.continuityByAge.at}}, `chainKey 3`:

| Age of the queried block | Continuity roots returned |
|---|---|
{{#each measured.continuityByAge.rows}}| {{.label}} | **{{.roots}}** |
{{/each}}

The count is the distance from the queried height up to the next endpoint above it, and endpoints thin out
with depth — so a block half a year old costs hundreds of hashes of continuity to ask one question, and that
cost is paid again by the next asker.

None of this is a criticism of the design. Attestors are deliberately sparse; storing every header
on the attestation layer is exactly what you avoided. The gap is that the *dApp* layer was never
given anywhere to put the roots the protocol already proved.

## 3. What we did about it

`EthereumMirror` is a permissionless, ownerless contract that persists the continuity array after
the precompile validates it:

```solidity
bool ok = VERIFIER.verifyAndEmit(chainKey, height, txBytes, merkleProof, continuityProof);
if (!ok) revert ProofRejected();
if (continuityRoots[0] != merkleRoot) revert ConflictingRoot(...);
_retain(chainKey, height, continuityRoots);   // rootOf[k][h] = root; one held bit per height
```

A held bit, not the root, answers "is this height stored?" — because an empty Ethereum block's transaction
root really is zero, and the first version of this contract could not tell that block from a missing one.

It adds **no trust assumption**: the precompile certified those roots in the same call. It changes
only the cost structure, and permanently.

Measured on CC3 testnet (every figure read from chain state by `worker/src/measure.ts`):

| | Value |
|---|---|
| Gas per newly held height | **{{measured.chains.3.gasPerNewRoot.median|n}}** median ({{measured.chains.3.gasPerNewRoot.min|n}}–{{measured.chains.3.gasPerNewRoot.max|n}}) |
| Roots kept by one `mirror()` call | up to **{{measured.chains.3.widestCall.roots|n}}** |
| Mainnet heights held | **{{measured.chains.3.held|n}}**; the unbroken run ending at the top is {{measured.chains.3.topRun|n}} blocks ≈ {{measured.chains.3.topRunDays|days}} days |
| Sepolia heights held | **{{measured.chains.1.held|n}}**, one unbroken run |
| Empty blocks held among them | {{measured.chains.3.emptyBlocks|n}} mainnet, {{measured.chains.1.emptyBlocks|n}} Sepolia |
| Verifying a transaction against a held root | `view` call, no continuity, no prover, no `0x0FD2` |

## 4. The part worth your attention

Once a height is held, verification does not call `0x0FD2` at all. That is not a claim we ask you to
take on trust, and not only a Foundry test that etches the precompile to empty — it is observable
against live chain state, because your RPC honours `eth_call` state overrides:

```bash
# verifyOrRevert against a held root, with the block-prover precompile deleted for the call
curl -s $CC_RPC -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[
  {"to":"{{contracts.EthereumMirror}}","data":"0x…"},
  "latest",
  {"0x0000000000000000000000000000000000000FD2":{"code":"0x"}}]}'
```

It returns the transaction index. Blanking the *mirror* instead makes the same call return empty,
which is how we know the override is applied rather than ignored. Both run on the home page of
[{{site}}]({{site}}) as it loads, against a block no transaction of which was submitted to notarise it.

## 5. What we think the protocol should do

Three options, cheapest first.

**A. Return the roots for cheap retention.** Let `verifyAndEmit` optionally expose the validated
continuity array to the caller in a form that is cheap to `SSTORE`. This is close to what happens
today; it only stops the data being thrown away at the ABI boundary.

**B. A native `BlockRootCache`.** A runtime-level `rootOf[chainKey][height]`, written as a
side-effect of any successful readability query. Every query makes future queries cheaper, for
everyone, with no dApp having to opt in. The storage cost is bounded by what attestors already prove
and is paid only for heights someone actually asked about.

**C. Nothing, and let this contract be the polyfill.** It is ownerless and permissionless, anyone can
extend it, and `IMirror` is frozen. This works. It is simply slower than putting it in the node, and
it means every chain that adopts Attestcoin re-derives the same cache in Solidity.

We would prefer B. Here it is written down properly, so that "prefer" costs you nothing to evaluate.

## 5b. RIP: `BlockRootCache`

**Storage.** One mapping in the runtime, keyed exactly as the polyfill keys it:

```
rootOf[chainKey][height] -> bytes32      // zero means "not held"; a held zero root is an empty block
held[chainKey][height >> 8] -> uint256   // one bit per height, so an empty block is not a hole
```

**Write.** As a side effect of every *successful* `verifyAndEmit`: for each `(number[i], root[i])` the
continuity array carried, set `rootOf` and the held bit. No new trust: the call has just proven every
one of those roots terminates at a stored attestation, and it is that proof -- not the caller -- that
writes. A failed verification writes nothing. Two callers proving overlapping ranges write the same
values; the second pays only for bits that were clear.

**Read.** A new entrypoint beside `verifyAndEmit`, with the same Merkle-proof argument and *no*
continuity argument:

```
mirrorVerify(chainKey, height, txBytes, merkleProof) -> (bool ok, uint64 txIndex)
```

If `held[chainKey][height]` is set, it checks the Merkle path against `rootOf` and returns; the
continuity walk is skipped because it already happened, once, for everyone. If the height is not
held it returns `(false, 0)` and the caller falls back to `verifyAndEmit` with a continuity proof --
which, on success, holds the height for the next caller. Fail-closed: an unheld height is not "false",
it is "not yet answerable", and the two are distinguishable by `held`.

**ABI delta.** `verifyAndEmit` additionally emits

```
event ContinuityRetained(uint64 indexed chainKey, uint64 indexed fromHeight, uint64 indexed toHeight, uint64 newlyHeld)
```

so an indexer can watch the cache fill without polling. Existing callers are unaffected: nothing they
pass changes and nothing they receive changes.

**What it costs, and what it saves.** Every figure below is measured; nothing is modelled.

| | Today (`0x0FD2` per question) | Polyfill (`EthereumMirror`, measured) | Native cache (this RIP) |
|---|---|---|---|
| First question about a block 180 days old | {{measured.continuityByAge.rows.5.roots|n}} roots hashed, discarded | {{measured.continuityByAge.rows.5.roots|n}} roots hashed by the precompile, then {{measured.chains.3.gasPerNewRoot.median|n}} gas per root to store in Solidity | the same hashes, then one runtime write per root -- no Solidity in the loop |
| Second question about that block | {{measured.continuityByAge.rows.5.roots|n}} roots hashed again | a Merkle path against stored state; `view`, no precompile | a Merkle path against stored state; no continuity argument at all |
| Ten-thousandth question | the same again | the same `view` | the same |
| Who pays to make a height answerable | every asker, every time | whoever notarises it once; {{measured.chains.3.mirrorCalls|n}} calls have held {{measured.chains.3.held|n}} mainnet heights so far | the first asker, as a side effect of asking |
| A consumer's dependency for a second question | the prover and the precompile | one frozen interface, `IMirror` | nothing beyond the runtime |

The polyfill column is what runs at [{{site}}]({{site}}) today: {{measured.chains.3.held|n}} mainnet heights held, the
top {{measured.chains.3.topRun|n}} of them unbroken, verified by a differential of {{measured.differential.checks|n}} checks against the live
precompile with zero divergences. The native column removes the {{measured.chains.3.gasPerNewRoot.median|n}} gas per root
that Solidity storage costs, and the one contract address a consumer has to know.

**What the RIP deliberately does not do.** It does not store headers, so it does not change what
attestors sign. It does not answer state or storage questions. It does not make a negative provable.
It does not add an owner, a pause or a fee. It caches what the protocol already computed and verified.

## 6. What this is not

- Not a state or storage proof. Attestcoin proves inclusion; we never claim a balance at a height.
- Not writability. Creditcoin → Ethereum is not released on testnet and we have not stubbed it.
- Not a proof of absence. There is no Merkle path for an event that never happened. Our negative
  facts are bonded economic claims and are labelled as such everywhere they appear.
- Not a replacement for the attestor set. Notarising a block still requires attestors and `0x0FD2`.
  Only verification *after* notarisation is free of them. These are two different claims and we
  never merge them.

## 7. Reproducing everything here

```bash
git clone --recurse-submodules https://github.com/iamdflame/HINDSIGHT && cd HINDSIGHT
forge test                                   # contracts, including the precompile-deleted test
node worker/src/differential.ts              # our verification vs live 0x0FD2
node worker/src/campaign.ts --dry-run        # the archive campaign, costed but not sent
npx github:iamdflame/HINDSIGHT verify 0x861c1a91…   # a second transaction, no key, no gas
```

No `.env` beyond public RPC URLs is needed for anything that does not spend gas.

---

*Contracts on CC3 testnet — `EthereumMirror` `{{contracts.EthereumMirror}}`, `AbsenceRegistryV3`
`{{contracts.AbsenceRegistryV3}}`. Both ownerless and verified on Blockscout.*

We would rather help you build B than be the reason it is not needed.
