# DoraHacks / CEIP copy

The words a reviewer sees before they open GitHub. Kept here so the gallery page and the repository say the
same thing.

---

**Name:** Hindsight

**Track:** DeFi (infra).

**One-liner (gallery):**
Attestcoin already proves ~100 Ethereum block roots per query and throws them away. Hindsight keeps them. After that, any transaction in those blocks verifies on Creditcoin with no prover and no precompile.

**Attestcoin integration summary:**
- `verifyAndEmit` notarises a height and retains the full continuity array the precompile bound.
- Subsequent verifies are `IMirror.verifyOrRevert` (`view`, Merkle path, `txIndex` from laterality).
- Receipt status `0x1` is checked in the registry; the precompile does not.
- Independence: live `eth_call` with `0x0FD2` deleted.
- Proposal: native `BlockRootCache` (ENSHRINE).

**CEIP paragraph:**
Creditcoin has recorded $100M+ of real-world loans (Aella, Credal) and cannot yet ask Ethereum a 90-day cleanliness question without an indexer. Hindsight is that evidence plane: ownerless, frozen ABI, cheaper for every Attestcoin dApp as a side-effect. We would rather Gluwa enshrine it than rent it.

---

**Links**

- Live: https://hindsight.run — the proof runs as the page loads
- The ninety-second court: https://hindsight.run/judge/
- Assess an address, no wallet: https://hindsight.run/assess/
- Repository: https://github.com/iamdflame/HINDSIGHT · grading: `CLAIMS.md`
- A consumer in another repository: https://github.com/iamdflame/hindsight-gate (same owner, interfaces only)

**Sources for the copy above.** "~100 roots per query" is an order of magnitude, not a measurement. Measured
on the live prover's single-transaction endpoint on 2026-09-13: 1 root for a fresh block, 41 for blocks one day
to ninety days old, 841 for a block 180 days old (the count depends on where a block sits between checkpoints;
`docs/MIGRATION.md` has the table). A batch `mirror()` call has retained up to 901. The
$100M figure is Creditcoin's own public statement about loans Aella has recorded through Credal
([creditcoin.org/Credal](https://creditcoin.org/Credal)); it is quoted, not measured by this project.
