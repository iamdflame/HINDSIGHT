# hindsight-mirror

Ask whether an Ethereum transaction happened — from Creditcoin, with no key, no gas, no `.env` and no
proving service.

```bash
npx hindsight-mirror verify 0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9
# or, straight from the repository:
npx github:iamdflame/HINDSIGHT verify 0x861c1a91cb194cbc804e21f3b55a07c8ac76362fba49c1037278776db8d1efc9
```

```
verified
  chain     : Ethereum mainnet (chainKey 3)
  block     : 25954574
  tx index  : 131
  path      : 9 siblings
  source    : rebuilt locally (no prover)
  precompile: not called
```

That transaction was never submitted to anyone: its block was notarised through a different transaction
(index 263), and this one verifies against the root that notarisation stored. `--chain 1` asks about Sepolia.

The npm names `hindsight` and `@hindsight/*` belong to other accounts — `npx hindsight` will not run this; `npx hindsight-mirror` will.

## Why this is not just an Attestcoin wrapper

An Attestcoin readability query carries a continuity proof: an array of block roots running from the
queried block up to an attestation. The precompile verifies the whole chain, then every integration
keeps one transaction and discards the rest of the array.

Hindsight keeps them. So the *second* question about a block that has already been notarised is a
Merkle path against stored state — a `view` call, at a fixed cost, however old the block is.

| | Attestcoin query | Against a held root |
|---|---|---|
| Continuity roots | 1 fresh, 41 from a day to ninety days old, 841 at 180 days *(measured on CC3, 2026-09-13)* | none |
| Proving service | required | not contacted |
| Block-prover precompile | required | not called |
| Call type | transaction | `view` |

## API

```ts
import { verify, isMirrored, coverage, notarise } from 'hindsight-mirror';

await verify('0x3a4b…');                    // { mirrored, verified, txIndex, path, source }
await verify('0x3a4b…', { source: 'prover' }); // take the path from Gluwa's prover instead
await isMirrored(25954574);                 // can this height be answered cheaply?
await coverage();                           // { heights, lowest, highest }
await notarise('0x3a4b…', PRIVATE_KEY);     // the one call that costs gas
```

`verify` rebuilds the Merkle path from a public Ethereum node by default, so the hosted prover is
not a dependency of reading. Pass `{ source: 'prover' }` to use it anyway; the two paths produce
byte-identical siblings, which is the point.

## The one thing that still costs something

`notarise` needs a key, gas, the Attestcoin attestor set and the block-prover precompile. That is
never waived and this package does not pretend otherwise — it is why notarising takes a private key
in its signature while everything else does not.

Once a block is notarised, anyone can ask about any transaction in it forever, including people who
have never heard of this package.

## What it cannot do

- **State or storage proofs.** Attestcoin proves transaction inclusion, not account state. Nothing
  here can tell you a balance at a height.
- **Absence.** There is no Merkle path for an event that never happened. Negative facts live in
  `IAbsence`, which is an economic instrument with a bond behind it, not a proof.
- **Writes back to Ethereum.** Not released on testnet, not stubbed here.

## Options

```ts
{ rpc, mirror, prover, ethRpc, source }
```

Defaults target the Creditcoin CC3 testnet deployment. Point `mirror` at another deployment and the
rest follows.

MIT.

## The desk, the registry, the binding

```
npx hindsight-mirror mandate assess 0x7562be20…   [--principal 1]   # the desk's verdict, every instrument
npx hindsight-mirror checks 0x3a4b8bcf…                              # status · depth · clock · stall · replay
npx hindsight-mirror usable 13 --exposure 0.25                       # can a standing claim carry this much
npx hindsight-mirror hunt                                            # open bounties and what they pay
npx hindsight-mirror bind calldata 0x<creditcoin address>            # the 32 bytes to sign from Ethereum
npx hindsight-mirror bind submit 0x<ethereum tx>                     # prove it (PRIVATE_KEY, gas)
```

```js
import { assess, checks, usable, claims, spanOffer, mirrorIfNeeded, bindingCalldata, bind, refute } from 'hindsight-mirror';

const { verdicts } = await assess('0x7562be2022d31a75f9887b7b932256c704f0c8e7', 10n ** 18n);
// → [{ policy, pays: false, reason: 'ProvenLiar', window: { spanIds: [8], from, to } }, …]

const k = await checks('0x3a4b8bcf…');
// → { pass, status, depth, clock, stall, replay: { key: '3:25954574:263' } }  — decide for yourself

await mirrorIfNeeded(txHash, privateKey); // verify; notarise first only if the block is not yet held
```

`assess` is a view on the same `assess` that `borrow` gates on; what it returns is what the money
would do. `checks` answers the five questions in Dokett's ASC review with numbers and decides nothing.
`spanOffer` computes the sealed spans to hand the desk — a convenience, not a permission: the desk
re-checks adjacency, chain, length and freshness itself. Nothing here is a score.
