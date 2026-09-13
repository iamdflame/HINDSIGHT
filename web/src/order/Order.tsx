import { useEffect, useState } from 'react';
import { Page } from '../shell/Page';
import { EthTx } from '../shared/EthTx';
import { EthBlock } from '../shared/EthBlock';
import { Trunc } from '../shared/Trunc';
import { EXPLORER } from '../lib/chain';

/**
 * A real Ethereum mainnet sandwich: block 25,764,741, positions 14 → 15 → 16. The same three
 * transactions index41 proved on Creditcoin (their tx 0xd136dea0…, measured here at 1,092,100 gas),
 * which is exactly why it is the worked example: the same fact, asked the second time.
 */
const SANDWICH = {
  block: 25_764_741,
  legs: [
    { role: 'searcher buys', hash: '0xec3777f9d0e55d03b9caa3a4b8a786dd62e16eeb327a9f1c45dfbc79af618436', from: '0x11111215b72E894C60F24E91ac2c8cCb1D373911' },
    { role: 'victim trades', hash: '0x7b054188f739937a2fc2c9257b48f2ccab0ec4440ce5eda7f2ec5ccbb44485a0', from: '0x51f400b9770aD2BDdb7CF74664F5Cd1DAF6A1410' },
    { role: 'searcher sells', hash: '0xb0cae362c6a6dcf08f4adfc1d510cdda851271a913cdea4bc81da010b65be23a', from: '0x11111215b72E894C60F24E91ac2c8cCb1D373911' },
  ],
  index41Tx: '0xd136dea0524b7e0e9eba54bf9724eec78597c2598047a96849af727f4d243810',
  index41Gas: 1_092_100,
};

type Leg = {
  role: string;
  hash: string;
  from: string;
  state: 'waiting' | 'rebuilding' | 'verifying' | 'done' | 'failed';
  siblings?: { hash: string; isLeft: boolean }[];
  txIndex?: number;
  error?: string;
};

type Held = 'checking' | 'held' | 'not-held' | 'error';

/** `isLeft` means the sibling sits on the left, i.e. this node is a right child: bit 1. LSB first. */
function indexFromPath(siblings: { isLeft: boolean }[]): number {
  return siblings.reduce((acc, s, i) => acc + (s.isLeft ? 2 ** i : 0), 0);
}

function Laterality({ siblings, txIndex }: { siblings: { isLeft: boolean }[]; txIndex: number }) {
  // Drawn root-first so the bits read as an ordinary binary number, most significant on the left.
  const levels = [...siblings].reverse();
  const recovered = indexFromPath(siblings);
  return (
    <div className="laterality" aria-label={`path ${levels.map((s) => (s.isLeft ? 'R' : 'L')).join('')} gives index ${recovered}`}>
      <div className="lat-row">
        {levels.map((s, i) => (
          <span key={i} className={`lat-cell ${s.isLeft ? 'is-right' : 'is-left'}`}>
            <span className="lat-side t-hash">{s.isLeft ? 'R' : 'L'}</span>
            <span className="lat-bit t-hash">{s.isLeft ? 1 : 0}</span>
          </span>
        ))}
        <span className="lat-eq t-hash">→ {recovered}</span>
      </div>
      {recovered !== txIndex && <p className="t-caption indep-error">laterality disagrees with the contract: {recovered} vs {txIndex}</p>}
    </div>
  );
}

/**
 * The order court. Three transactions, each verified against the mirror as a `view`, and each one's
 * position in the block recovered from nothing but the shape of its Merkle path -- which side each
 * sibling sits on. That is the precompile's `calculateTxIndex`, reimplemented in `MirrorLib.txIndexOf`
 * and returned by `verifyOrRevert`.
 */
export function Order() {
  const [held, setHeld] = useState<Held>('checking');
  const [legs, setLegs] = useState<Leg[]>(SANDWICH.legs.map((l) => ({ ...l, state: 'waiting' })));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { mirrorContract, CHAIN_KEY_ETH_MAINNET } = await import('../lib/chain');
        const isHeld = await mirrorContract().isMirrored(CHAIN_KEY_ETH_MAINNET, SANDWICH.block);
        if (cancelled) return;
        setHeld(isHeld ? 'held' : 'not-held');
        if (!isHeld) return;

        const [{ proofFromEthereum }, { verifyWithoutPrecompile }] = await Promise.all([import('../lib/proof'), import('../lib/independence')]);
        for (let i = 0; i < SANDWICH.legs.length; i++) {
          const set = (patch: Partial<Leg>) => setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
          try {
            set({ state: 'rebuilding' });
            const proof = await proofFromEthereum(SANDWICH.legs[i].hash);
            set({ state: 'verifying', siblings: proof.siblings });
            // The precompile is deleted for the call: ordering comes from the archive alone.
            const r = await verifyWithoutPrecompile(proof.blockNumber, proof.txBytes, proof.siblings);
            if (!r.ok) throw new Error(r.error ?? 'did not verify');
            set({ state: 'done', txIndex: r.txIndex });
          } catch (e) {
            set({ state: 'failed', error: (e as Error).message });
          }
          if (cancelled) return;
        }
      } catch {
        if (!cancelled) setHeld('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const done = legs.every((l) => l.state === 'done');
  const ordered = done && legs[0].txIndex! < legs[1].txIndex! && legs[1].txIndex! < legs[2].txIndex!;

  return (
    <Page active="order">
      <section className="pane order">
        <h1 className="t-title pane-title">Which came first.</h1>
        <p className="t-body pane-lead">
          A transaction’s position in its block is not in its payload, and no oracle reports it. It is written in the
          shape of its Merkle path: at every level, is the sibling on the left or the right? Read those sides as bits and
          the position falls out. Below, three real transactions from one mainnet block, verified against the archive with
          the precompile deleted, ordered by nothing but that shape.
        </p>

        <p className="t-ui">
          block <EthBlock n={SANDWICH.block} /> · a real sandwich
        </p>

        {held === 'checking' && <p className="t-caption">checking the archive holds this block…</p>}
        {held === 'error' && <p className="t-caption">The Creditcoin RPC did not answer. Reload to try again.</p>}
        {held === 'not-held' && (
          <p className="t-body">
            The archive does not hold block {SANDWICH.block.toLocaleString()} yet. The campaign walks down from Ethereum’s head
            and this block is on its path; until it lands, this page refuses to order transactions it cannot verify rather than
            asking the prover to do it instead.
          </p>
        )}

        {held === 'held' && (
          <ol className="legs">
            {legs.map((l, i) => (
              <li key={l.hash} className={`leg leg--${l.state}`}>
                <div className="leg-head">
                  <span className="t-ui">{l.role}</span>
                  <EthTx hash={l.hash} />
                  <span className="t-caption">from <Trunc v={l.from} /></span>
                </div>
                {l.state === 'waiting' && <p className="t-caption">waiting</p>}
                {l.state === 'rebuilding' && <p className="t-caption">rebuilding the block in this browser…</p>}
                {l.state === 'verifying' && <p className="t-caption">verifying with the precompile deleted…</p>}
                {l.state === 'failed' && <p className="t-caption indep-error">{l.error}</p>}
                {l.siblings && l.txIndex !== undefined && (
                  <>
                    <Laterality siblings={l.siblings} txIndex={l.txIndex} />
                    <p className="t-caption">
                      position <strong className="t-hash">{l.txIndex}</strong> · {l.siblings.length} levels · verified, <code>0x0FD2</code> absent
                      {i > 0 && legs[i - 1].txIndex !== undefined && <> · after {legs[i - 1].txIndex}</>}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}

        {ordered && (
          <p className="t-body order-verdict">
            {legs[0].txIndex} → {legs[1].txIndex} → {legs[2].txIndex}. The same searcher before and after the victim, in one block,
            established from the archive alone.
          </p>
        )}

        <h2>The second time is free</h2>
        <table className="tax">
          <thead>
            <tr><th /><th>gas</th><th>how we know</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>index41 proving this sandwich on Creditcoin</td>
              <td className="t-hash">{SANDWICH.index41Gas.toLocaleString()}</td>
              <td className="t-caption">
                measured: receipt of <a href={`${EXPLORER}/tx/${SANDWICH.index41Tx}`} target="_blank" rel="noreferrer">their transaction</a>, three{' '}
                <code>verifyAndEmit</code> calls
              </td>
            </tr>
            <tr>
              <td>asking the same three questions against the archive</td>
              <td className="t-hash">0</td>
              <td className="t-caption">three <code>eth_call</code>s on this page — views, no transaction, no gas</td>
            </tr>
          </tbody>
        </table>
        <p className="t-caption">
          index41 is right that position is a fact nothing else reports. The archive does not make their contract wrong; it makes
          the second question about that block free, for them and for anyone. Their on-chain ruling still needs a transaction; the
          ordering itself does not.
        </p>
      </section>
    </Page>
  );
}
