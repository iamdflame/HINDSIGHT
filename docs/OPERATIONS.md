# Operations — what runs, and what happens when it stops

Nothing here is privileged. Every process below signs with an ordinary wallet and calls functions
anyone may call; if all of them stop, the contracts keep working and the archive stops lengthening
(it never shrinks). This is the list so that "the honesty machine is off" can be checked rather than
alleged.

| Process | Command | Wallet | If it stops |
|---|---|---|---|
| Mainnet follower | `node src/campaign.ts --chain 3 --follow --from <held> --key KEY_C` | `campaign-mainnet-c` | The archive stops at its head; `attested-lag` and then `span-window` go red; `maxStaleness 0` policies refuse `ArchiveTooShallow`. Nothing is lost. |
| Sepolia follower | `node src/campaign.ts --chain 1 --follow --from <held> --key SEPOLIA_KEY` | `sepolia-campaign` | Same, for Sepolia. |
| Span roller | runs inside each follower after every window (`spans.ts: roll`) | the follower's | The top span stops at the last height sealed; the desk refuses any policy whose `maxStaleness` it exceeds. |
| Deep backfill | `node src/deep-mirror.ts --chain 3 --from <hi> --to <lo>` | `deployer` | The hole stays where it is. `holes-closing` stays green (it only demands the count never grow). Resumable from the bitmap. |
| House hunter | `LOG_TIMEOUT_MS=90000 node src/hunter.ts --min-age-hours 144 --interval 900` | `hunter` | Bounties older than six days go unrefuted until a stranger takes them, or stand when their window closes — which is exactly, and only, what `Standing` means. |
| Replenisher | `node src/seed-v3.ts --chain 3 --replenish 4` hourly, `MARKET_KEY` set | `market` | Once the hunter clears the open bounties, `hunt-supply` goes red and `/hunt` says so. The claims already filed are unaffected. |
| Public gates | Vercel Cron, `17 6 * * *`, plus every visitor to `/status` (five-minute cache) | none — read-only | The last cached run is served with its timestamp; nothing is asserted that was not measured. |

Wallets are distinct on purpose: two processes sharing one signer race for the same nonce and one of
them loses its transaction to `replacement transaction underpriced`. The deployer key is used only by
hand and by the deep backfill; nothing scheduled signs with it.

## Keys

Each process reads its key from an environment variable named on its command line (`--key KEY_C`,
`MARKET_KEY`, …), populated from `.secrets/*.json`, which is never committed. Funding them is an
operational duty; a follower that runs dry retries a dropped transaction for an hour and then waits,
and the gates say which chain has stopped moving.

## Restarting

Every process is idempotent from chain state. A follower re-reads the bitmap and continues from the
unbroken run; the backfill skips intervals already fully held; the replenisher counts what is open;
the hunter re-scans. There is no local state to restore.
