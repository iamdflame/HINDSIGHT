# hindsight-mcp

The desk, the archive and the hunt, as tools an agent can call. Every tool but one is a `view` on
contracts deployed on Creditcoin: no key, no gas, no wallet, and nothing an agent can be talked into
spending.

```json
{
  "mcpServers": {
    "hindsight": { "command": "npx", "args": ["-y", "hindsight-mcp"] }
  }
}
```

| Tool | Asks | Costs |
|---|---|---|
| `mandate_assess` | Would the desk lend to this Ethereum address? Every instrument's verdict, with the refusal enum and a plain-language reason, and the sealed spans it was priced against so the call can be re-run on chain verbatim | nothing |
| `hindsight_verify` | Did this Ethereum transaction happen? Path rebuilt from a public node, checked against the root Creditcoin holds | nothing |
| `hindsight_checks` | The five things to check before acting on a proof — receipt status, confirmation depth, block age, archive stall, and a replay key to record — each with its number | nothing |
| `hunt_list` | Open bounties: false statements with money staked on them, what each pays, until when | nothing |
| `claim_usable` | Can a standing claim carry this much reliance? Standing, and the burned half of its bond covers the exposure | nothing |
| `archive_coverage` | How much Ethereum history is held, and the sealed ninety-day window available right now | nothing |
| `binding_calldata` | The 32 bytes an Ethereum address signs to prove a Creditcoin address speaks for it | nothing |
| `hunt_refute` | Commit–reveal a counterexample against an open claim. **Only registered when `HINDSIGHT_KEY` is set**; a client without the key cannot see it | gas, twice |

Nothing returned is a score. The desk pays or refuses and names the fact; a refusal is an enum
name beside a sentence, never a number. Nothing is minted, nothing is transferable.

Built on [`hindsight-mirror`](https://www.npmjs.com/package/hindsight-mirror). Contracts, records
and the public gates that check them: [hindsight.run](https://hindsight.run) ·
[mandate.hindsight.run](https://mandate.hindsight.run).
