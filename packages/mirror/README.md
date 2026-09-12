# @hindsight/mirror

Ask whether an Ethereum mainnet transaction happened — from Creditcoin, with no key, no gas and no
proving service.

```bash
npx hindsight verify 0x3a4b8bcfd53d78187c3ba6f03b7ae4cbff473cbf270362f8de4e9f9b9610df61
```

```
verified
  block     : 25954574
  tx index  : 263
  path      : 9 siblings
  source    : rebuilt locally (no prover)
```

## Why this is not just an Attestcoin wrapper

An Attestcoin readability query carries a continuity proof: an array of block roots running from the
queried block up to an attestation. The precompile verifies the whole chain, then every integration
keeps one transaction and discards the rest of the array.

Hindsight keeps them. So the *second* question about a block that has already been notarised is a
Merkle path against stored state — a `view` call, at a fixed cost, however old the block is.

| | Attestcoin query | Against a held root |
|---|---|---|
| Continuity roots | 1 fresh, 11 at a day old, 711 at 180 days *(measured on CC3)* | none |
| Proving service | required | not contacted |
| Block-prover precompile | required | not called |
| Call type | transaction | `view` |

## API

```ts
import { verify, isMirrored, coverage, notarise } from '@hindsight/mirror';

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
