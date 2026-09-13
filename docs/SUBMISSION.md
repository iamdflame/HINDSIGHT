# DoraHacks / CEIP copy

The words a reviewer sees before they open GitHub. Kept here so the gallery page and the repository say the
same thing.

---

**Name:** Hindsight — and Mandate, the product on it.

**Track:** DeFi (infra).

**One-liner (gallery):**
Attestcoin already proves the roots. Hindsight is where they live until the node does. Mandate is an
underwriting desk on that memory: paste an Ethereum address and a lending contract pays, or refuses and names
the transaction that forbids it. Nothing is minted, nothing is transferable, and there is no number.

**Attestcoin integration summary:**
- `verifyAndEmit` notarises a height and retains the full continuity array the precompile bound.
- Every later verify is `IMirror.verifyOrRevert`: a `view`, a Merkle path, no prover, no `0x0FD2`.
- The archive extends and repairs itself with the hosted prover switched off, from `0x0FD3` checkpoints and
  public receipts; the precompile accepts the locally built chain.
- `0x0FD4` caps the desk's book at what the attestor quorum has bonded, read live on every decision.
- Receipt status is checked before any log is trusted; no state proof is claimed; no absence is called a proof.
- Independence: live `eth_call` with `0x0FD2` deleted, on the home page, on every load.
- Proposal: native `BlockRootCache` — the RIP is in ENSHRINE §5b with a one-event ABI delta.

**CEIP paragraph:**
Creditcoin has recorded $100M+ of real-world loans and cannot yet ask Ethereum a ninety-day cleanliness question
without an indexer. Mandate is that question, on eight instruments across Aave, Morpho, Compound, Spark and
Circle's own blacklist, with sealed spans making the answer 17× cheaper than the desk that walked the bitmap.
Hindsight is the evidence plane under it: ownerless, frozen ABI, twenty-two public gates on a cron, and cheaper
for every Attestcoin dApp as a side-effect. We would rather Gluwa enshrine it than rent it. `/ceip` answers the
five pillars with measured figures, in English and (machine-assisted) Korean.

---

**Links**

- Live: https://hindsight.run — the proof runs as the page loads
- Mandate: https://mandate.hindsight.run — assess · files · cover · versus · hunt
- The ninety-second court: https://hindsight.run/judge/
- The five pillars: https://hindsight.run/ceip/ · the one-question memo: https://hindsight.run/aella/
- The honesty machine: https://hindsight.run/status/ (`/api/gates` answers 503 when a promise breaks)
- API: `/api/assess`, `/api/certificate` (PDF), `/api/dump`, `/openapi.json` · Telegram: **@MandateDeskBot** (`/assess`, `/hunt`, `/bounty`) and the Mini App at mandate.hindsight.run/tg
- Repository: https://github.com/iamdflame/HINDSIGHT · grading: `CLAIMS.md` · runbook: `docs/OPERATIONS.md`
- SDK and CLI: `hindsight-mirror` on npm · agents: `hindsight-run-mcp` · Solidity: `templates/foundry-consumer`
- A consumer in another repository: https://github.com/iamdflame/hindsight-gate (same owner, interfaces only)

**What is not claimed.** No stranger has refuted a claim, bound an Ethereum address, or borrowed; every name on
the leaderboard is the house and the site says so. The unbroken run is ~110 days, not 180: the deepening runs
with the prover off at a measured rate and the `run-unbroken` gate will say when it gets there. The Korean is
machine-assisted and unreviewed. The hire-purchase corridor is not built.

**Sources for the copy above.** Every figure is from `deployments.json` as written by `worker/src/measure.ts`
and graded in `CLAIMS.md`. "17× cheaper" is two mined receipts on Creditcoin in the same block: 7,041,373 gas
for the superseded desk's `assess`, 407,960 for the current one. The $100M figure is Creditcoin's own public
statement about loans recorded through Credal ([creditcoin.org/Credal](https://creditcoin.org/Credal)); it is
quoted, not measured by this project.
