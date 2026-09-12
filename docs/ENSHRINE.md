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

Measured against the live CC3 testnet prover, September 2026, `chainKey 3`:

| Age of the queried block | Continuity roots returned |
|---|---|
| fresh (head − 50) | **1** |
| 24 hours (head − 7,200) | **11** |
| 7 days | **11** |
| 30 days | **11** |
| 180 days (head − 1,296,000) | **711** |

The count is the distance from the queried height up to the next endpoint above it. Checkpoints on
this network sit one per 100 blocks in recent history and thin out with depth, so the cost of asking
about old history grows — a 180-day-old block costs **711 hashes of continuity to ask one question**,
and that cost is paid again by the next asker.

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
_retain(chainKey, height, continuityRoots);   // rootOf[chainKey][height] = root
```

It adds **no trust assumption**: the precompile certified those roots in the same call. It changes
only the cost structure, and permanently.

Measured on CC3 testnet:

| | Value |
|---|---|
| Gas per root retained | **24,245–24,799** |
| Roots in a single `mirror()` call | up to **901** measured, 711-root call simulated at 17.2M gas |
| Heights currently held (`chainKey 3`) | **100,801**, contiguous, 25,863,300 – 25,964,100 |
| Cost of the whole archive | ~2.4B gas ≈ **1.2 tCTC** at 0.5 gwei |
| Verifying a transaction against a held root | `view` call, no continuity, no prover, no `0x0FD2` |

The archive was built in 112 transactions over 28.8 minutes by one worker against the public prover.

## 4. The part worth your attention

Once a height is held, verification does not call `0x0FD2` at all. That is not a claim we ask you to
take on trust, and not only a Foundry test that etches the precompile to empty — it is observable
against live chain state, because your RPC honours `eth_call` state overrides:

```bash
# verifyOrRevert against a held root, with the block-prover precompile deleted for the call
curl -s $CC_RPC -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[
  {"to":"0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB","data":"0x…"},
  "latest",
  {"0x0000000000000000000000000000000000000FD2":{"code":"0x"}}]}'
```

It returns the transaction index. Blanking the *mirror* instead makes the same call return empty,
which is how we know the override is applied rather than ignored. Both run on
[/independence](https://hindsight-archive.vercel.app/independence).

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

We would prefer B, and we would rather help build it than be the reason it is not needed.

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
npx hindsight verify 0x3a4b8bcf…             # one transaction, no key, no gas
```

No `.env` beyond public RPC URLs is needed for anything that does not spend gas.

---

*Contracts on CC3 testnet — `EthereumMirror` `0x4Bc16e89Beb350859aec04A55A5c2E197C06e2AB`,
`AbsenceRegistryV2` `0x32d507DCC049A228831b7C23E4fe22A62db4E7b6`. Both verified on Blockscout.*
