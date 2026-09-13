import { useCallback, useEffect, useRef, useState } from 'react';
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
import { BLOCK_PROVER, MIRROR_ADDRESS } from '../lib/chain';

/** `0x…0FD2` for the precompile, `0x2d8A…c118` for anything else: the part that identifies it. */
const short = (a: string) => (/^0x0{30,}/i.test(a) ? `0x…${a.slice(-4)}` : `${a.slice(0, 6)}…${a.slice(-4)}`);
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

type Phase = 'idle' | 'picking' | 'rebuilding' | 'verifying' | 'done' | 'failed';

export type Row = {
  label: string;
  detail: string;
  result?: OverrideResult;
  expect: 'pass' | 'fail';
};

export type Target = { block: number; txHash: string; index: number; txCount: number; notarisedIndex?: number };

export type IndependenceState = {
  phase: Phase;
  note: string;
  proof: ProofBundle | null;
  rows: Row[];
  error: string | null;
  target: Target | null;
  proven: boolean;
  run: () => void;
};

/**
 * The experiment, as a hook, so three pages can run the same thing and none of them can drift
 * from the others: pick a held block and a transaction in it that is *not* the one it was notarised
 * with, rebuild the Merkle path from a public Ethereum node with the prover untouched, then ask
 * Creditcoin four times -- plainly, with the precompile deleted for the call, with the archive
 * deleted instead (the control, which must fail), and with one sibling altered.
 */
export function useIndependence(autoRun = true): IndependenceState {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<ProofBundle | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const running = useRef(false);

  const pick = useCallback(async (): Promise<Target> => {
    setNote('finding a notarised block…');
    const { creditcoin, mirrorContract, ethereum, CHAIN_KEY_ETH_MAINNET } = await import('../lib/chain');
    const mirror = mirrorContract(creditcoin());
    const high = Number(await mirror.highestMirrored(CHAIN_KEY_ETH_MAINNET));
    const low = Number(await mirror.lowestMirrored(CHAIN_KEY_ETH_MAINNET));
    const eth = ethereum();
    // Walk back from the top of the archive for a block busy enough that a "second transaction"
    // is unambiguous, and take one from the middle so the Merkle path is full depth.
    for (let h = high - 3; h > low && h > high - 400; h -= 7) {
      if (!(await mirror.isMirrored(CHAIN_KEY_ETH_MAINNET, h))) continue;
      const blk = await eth.getBlock(h);
      if (!blk || blk.transactions.length < 8) continue;
      const index = Math.floor(blk.transactions.length / 2);
      return { block: h, txHash: blk.transactions[index], index, txCount: blk.transactions.length };
    }
    throw new Error('no suitable notarised block found near the head of the archive');
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase('picking');
    setError(null);
    setRows([]);
    setProof(null);
    try {
      const t = await pick();
      setTarget(t);

      setPhase('rebuilding');
      setNote('rebuilding the path in this browser…');
      const bundle = await proofFromEthereum(t.txHash, (m) => setNote(m));
      setProof(bundle);

      setPhase('verifying');
      setNote('asking Creditcoin…');
      const plain = await verifyPlain(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const killed = await verifyWithoutPrecompile(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const control = await verifyWithMirrorBlanked(bundle.blockNumber, bundle.txBytes, bundle.siblings);
      const tampered = await verifyWithoutPrecompile(bundle.blockNumber, bundle.txBytes, tamperSibling(bundle.siblings));

      setRows([
        { label: 'verified', detail: 'an ordinary view call against the notarised root', result: plain, expect: 'pass' },
        {
          label: 'verified with the precompile deleted',
          detail: `${short(BLOCK_PROVER)} blanked for the duration of this call`,
          result: killed,
          expect: 'pass',
        },
        {
          label: 'control — the archive itself deleted',
          detail: `${short(MIRROR_ADDRESS)} blanked instead. This must fail, or the node is ignoring overrides`,
          result: control,
          expect: 'fail',
        },
        { label: 'one sibling altered', detail: 'the root is on Creditcoin; this path does not meet it', result: tampered, expect: 'fail' },
      ]);
      setPhase(killed.ok && !control.ok && !tampered.ok && plain.ok ? 'done' : 'failed');
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
    if (autoRun) void run();
  }, [autoRun, run]);

  return { phase, note, proof, rows, error, target, proven: phase === 'done', run };
}

/** The rows, rendered. A row that did not do what it was supposed to is the one thing that shouts. */
export function IndependenceRows({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="indep-rows">
      {rows.map((r) => {
        const ok = r.result?.ok ?? false;
        const asExpected = r.expect === 'pass' ? ok : !ok;
        return (
          <li key={r.label} className={asExpected ? 'is-expected' : 'is-surprise'}>
            <span className="mark" aria-hidden="true">{asExpected ? '✓' : '!'}</span>
            <div>
              <span className="t-ui">{r.label}</span>
              <span className="t-caption">{r.detail}</span>
              <span className="t-caption outcome">
                {ok ? `verified · transaction index ${r.result?.txIndex}` : `refused · ${r.result?.error ?? 'no result'}`}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The module as it appears on the home page and in the court: target line, three steps, the rows,
 * and the stamp. `compact` drops the explanatory prose that the full page carries.
 */
export function IndependenceModule({ state, compact = false }: { state: IndependenceState; compact?: boolean }) {
  const { phase, note, proof, rows, error, target, proven } = state;
  const reduce = prefersReducedMotion();
  return (
    <div className={`indep-module${compact ? ' is-compact' : ''}`}>
      {target && (
        <p className="t-ui indep-target">
          block <EthBlock n={target.block} /> · transaction {target.index} of {target.txCount} · <EthTx hash={target.txHash} />
          {!compact && (
            <>
              <br />
              <span className="t-caption">
                Not the transaction this block was notarised with. A different transaction, in the same block,
                which is what shows a block was stored rather than a receipt cached.
              </span>
            </>
          )}
        </p>
      )}
      <div className="indep-split">
        <div>
          <Steps
            items={[
              {
                label: proof
                  ? `rebuilt in this browser — ${proof.blockTxCount ?? target?.txCount ?? '—'} transactions hashed, ${proof.siblings.length} siblings, ${seconds(proof.elapsedMs)}, prover not contacted`
                  : `rebuilding in this browser — ${note || 'waiting'}`,
                state: proof ? 'done' : phase === 'failed' ? 'failed' : 'active',
              },
              {
                label: `the precompile deleted — ${short(BLOCK_PROVER)} blanked inside the call`,
                state: rows.length > 0 ? 'done' : proof ? 'active' : 'todo',
              },
              {
                label: 'answered by the archive alone — a view call, no gas, no wallet',
                state: proven ? 'done' : phase === 'failed' ? 'failed' : rows.length > 0 ? 'active' : 'todo',
              },
            ]}
          />
          <IndependenceRows rows={rows} />
          {error && <p className="t-caption indep-error">{error}</p>}
        </div>
        <div className="indep-stamp">
          <Stamp state={proven ? 'proven' : 'idle'} reduceMotion={reduce} pressKey={proven ? `indep-${target?.txHash ?? ''}` : ''} />
          {proven && (
            <p className="t-caption">
              The proving service was not contacted. The precompile was not present. The answer came from a
              root Creditcoin already holds.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
