import { useCallback, useEffect, useRef, useState } from 'react';
import { Masthead } from '../shell/Masthead';
import { Colophon } from '../shell/Colophon';
import { useArchiveStats } from '../shell/useArchiveStats';
import { Stamp } from '../question/Stamp';
import { Steps } from '../shared/Steps';
import { EthTx } from '../shared/EthTx';
import { EthBlock } from '../shared/EthBlock';
import { prefersReducedMotion } from '../shared/motion';
import { proofFromEthereum, type ProofBundle } from '../lib/proof';
import {
  verifyPlain,
  verifyWithoutPrecompile,
  verifyWithMirrorBlanked,
  tamperSibling,
  type OverrideResult,
} from '../lib/independence';
import { BLOCK_PROVER, MIRROR_ADDRESS, EXPLORER } from '../lib/chain';

type Phase = 'idle' | 'rebuilding' | 'verifying' | 'done' | 'failed';

type Row = {
  label: string;
  detail: string;
  result?: OverrideResult;
  /** What this row is supposed to show: a pass, or a deliberate failure. */
  expect: 'pass' | 'fail';
};

/**
 * The independence page.
 *
 * Three claims are made about a notarised block, and all three are run here rather than asserted:
 * the hosted prover is not needed, the block-prover precompile is not needed, and this website is
 * not needed. The second of those used to live only in a Foundry test. Creditcoin's RPC honours
 * `eth_call` state overrides, so it can be shown against live chain state instead.
 *
 * The second transaction matters. Verifying the transaction the block was notarised *with* would
 * only show a cached receipt. Verifying a different transaction, at a different index in the same
 * block, is what demonstrates a whole block was stored.
 */
export function Independence() {
  const stats = useArchiveStats();
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<ProofBundle | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ block: number; txHash: string; index: number } | null>(null);
  const reduce = prefersReducedMotion();
  const running = useRef(false);

  /** A block the archive holds, and a transaction in it that is not the one it was notarised with. */
  const pick = useCallback(async () => {
    setNote('finding a notarised block…');
    const { creditcoin, mirrorContract, ethereum, CHAIN_KEY_ETH_MAINNET } = await import('../lib/chain');
    const mirror = mirrorContract(creditcoin());
    const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));
    const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));

    // Walk back from the top of the archive for a block with enough transactions that a
    // "second transaction" is unambiguous.
    const eth = ethereum();
    for (let h = high - 3; h > low && h > high - 400; h -= 7) {
      if (!(await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, h))) continue;
      const blk = await eth.getBlock(h);
      if (!blk || blk.transactions.length < 8) continue;
      // Deliberately not index 0: a middle index exercises a full-depth Merkle path.
      const index = Math.floor(blk.transactions.length / 2);
      return { block: h, txHash: blk.transactions[index], index };
    }
    throw new Error('no suitable notarised block found near the head of the archive');
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase('rebuilding');
    setError(null);
    setRows([]);
    setProof(null);

    try {
      const t = await pick();
      setTarget(t);

      // 1. Rebuild the path in this browser. The prover is never contacted on this path.
      setNote('rebuilding the path in this browser…');
      const bundle = await proofFromEthereum(t.txHash, (m) => setNote(m));
      setProof(bundle);

      // 2. Four calls: the plain one, the precompile deleted, the control, and a tampered path.
      setPhase('verifying');
      setNote('asking Creditcoin…');

      const plain = await verifyPlain(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const killed = await verifyWithoutPrecompile(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const control = await verifyWithMirrorBlanked(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const tampered = await verifyWithoutPrecompile(
        bundle.blockNumber,
        bundle.txBytes,
        tamperSibling(bundle.siblings),
      );

      setRows([
        {
          label: 'verified',
          detail: 'an ordinary view call against the notarised root',
          result: plain,
          expect: 'pass',
        },
        {
          label: 'verified with the precompile deleted',
          detail: `${BLOCK_PROVER.slice(0, 10)}… blanked for the duration of this call`,
          result: killed,
          expect: 'pass',
        },
        {
          label: 'control — the archive itself deleted',
          detail: 'blanks the mirror instead. This must fail, or the node is ignoring overrides',
          result: control,
          expect: 'fail',
        },
        {
          label: 'one sibling altered',
          detail: 'the root is on Creditcoin; this path does not meet it',
          result: tampered,
          expect: 'fail',
        },
      ]);

      setPhase(killed.ok && !control.ok && !tampered.ok ? 'done' : 'failed');
      setNote('');
    } catch (e) {
      setError((e as Error).message);
      setPhase('failed');
      setNote('');
    } finally {
      running.current = false;
    }
  }, [pick]);

  useEffect(() => {
    void run();
    // Runs once on mount: the page's whole purpose is the demonstration, so it should not wait
    // behind a button the visitor has to find.
  }, [run]);

  const proven = phase === 'done';

  return (
    <div className="shell">
      <Masthead
        withLegend={false}
        stats={stats}
        onDateline={() => {
          window.location.href = '/?tab=record';
        }}
      />
      <main id="main" className="doc indep">
        <h1>Without the prover, without the precompile, without us.</h1>

        <p className="lede">
          Once a block is notarised, answering a question about it is a Merkle path and a stored
          root. Everything below runs in this browser, against Creditcoin, right now.
        </p>

        {target && (
          <p className="t-ui indep-target">
            block <EthBlock n={target.block} /> · transaction at index {target.index} ·{' '}
            <EthTx hash={target.txHash} />
            <br />
            <span className="t-caption">
              Not the transaction this block was notarised with. A different transaction, at a
              different index, in the same block — which is what shows a block was stored rather
              than a receipt cached.
            </span>
          </p>
        )}

        <div className="indep-split">
          <div>
            <Steps
              items={[
                {
                  label: proof
                    ? `rebuilt in this browser — ${proof.blockTxCount ?? '—'} transactions hashed, ${proof.siblings.length} siblings, ${proof.elapsedMs}ms`
                    : `rebuilding in this browser — ${note || 'waiting'}`,
                  state: proof ? 'done' : phase === 'failed' ? 'failed' : 'active',
                },
                {
                  label: `the precompile deleted — ${BLOCK_PROVER.slice(0, 10)}… blanked inside the call`,
                  state: rows.length > 0 ? 'done' : proof ? 'active' : 'todo',
                },
                {
                  label: `answered by the archive alone — a view call, no gas, no wallet`,
                  state: proven ? 'done' : phase === 'failed' ? 'failed' : rows.length > 0 ? 'active' : 'todo',
                },
              ]}
            />

            {rows.length > 0 && (
              <ul className="indep-rows">
                {rows.map((r) => {
                  const ok = r.result?.ok ?? false;
                  const asExpected = r.expect === 'pass' ? ok : !ok;
                  return (
                    <li key={r.label} className={asExpected ? 'is-expected' : 'is-surprise'}>
                      <span className="mark" aria-hidden="true">
                        {asExpected ? '✓' : '!'}
                      </span>
                      <div>
                        <span className="t-ui">{r.label}</span>
                        <span className="t-caption">{r.detail}</span>
                        <span className="t-caption outcome">
                          {ok
                            ? `verified · transaction index ${r.result?.txIndex}`
                            : `refused · ${r.result?.error ?? 'no result'}`}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {error && <p className="t-caption indep-error">{error}</p>}
          </div>

          <div className="indep-stamp">
            <Stamp state={proven ? 'proven' : 'idle'} reduceMotion={reduce} pressKey={proven ? 'indep' : ''} />
            {proven && (
              <p className="t-caption">
                The proving service was not contacted. The precompile was not present. The answer
                came from a root Creditcoin already holds.
              </p>
            )}
          </div>
        </div>

        <h2>Why the control is there</h2>
        <p>
          A state override that the node quietly ignored would make the row above meaningless — the
          call would have succeeded whether or not the precompile was deleted. So the same override
          mechanism is turned on the archive itself. Blanking the mirror must break verification,
          and it does. The override is real, and therefore so is the deletion.
        </p>

        <h2>What is still needed</h2>
        <p>
          Notarising a block in the first place requires the Attestcoin attestor set and the
          block-prover precompile, and that is never waived. These are two different claims, and
          only the second one — verification <em>after</em> notarisation — is free of them.
        </p>
        <p className="t-caption">
          Reproduce without this page:{' '}
          <a href={`${EXPLORER}/address/${MIRROR_ADDRESS}#readContract`} rel="noreferrer" target="_blank">
            call <code>verifyOrRevert</code> on Blockscout
          </a>
          , or <code>forge test --match-test test_verifiesRealMainnetTxWithoutPrecompileOrProver</code>,
          which deletes the precompile in the EVM rather than in one call.
        </p>
      </main>
      <Colophon />
    </div>
  );
}
