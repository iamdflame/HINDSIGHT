import { useEffect, useState } from 'react';
import { Page } from '../shell/Page';
import { IndependenceModule, useIndependence } from '../independence/IndependenceModule';
import { EXPLORER } from '../lib/chain';
import { continuityAt, WIDEST_CALL_ROOTS } from '../lib/record';
import { tctc } from '../watch/ClaimRow';

/** Continuity length at an age, from the measured record; never a typed number. */
const rootsAt = (age: number) => {
  const n = continuityAt(age);
  return n === undefined ? 'unmeasured' : `${n.toLocaleString()} ${n === 1 ? 'root' : 'roots'}`;
};

type Waste = { tx: string; roots: number; gas: number; from: number; to: number; added: number } | null;
type BoardPick = { id: number; kind: number; bond: bigint; loss: bigint; from: number; to: number; chainKey: number; status: number } | null;

/**
 * The court. Six beats, each one live, each one repeatable by the judge without us in the room.
 * If there are only thirty seconds, beats two and three are the ones -- that pair does not exist
 * anywhere else.
 */
export function Court() {
  const indep = useIndependence(true);
  const [waste, setWaste] = useState<Waste>(null);
  const [lie, setLie] = useState<BoardPick>(null);
  const [complete, setComplete] = useState<BoardPick>(null);
  const [archive, setArchive] = useState<{ mainnet: number; sepolia: number } | null>(null);

  useEffect(() => {
    (async () => {
      const chain = await import('../lib/chain');
      const m = chain.mirrorContract();

      // Beat 1: the most recent mirror() call, decoded from its own calldata.
      try {
        const cc = chain.creditcoin();
        const head = await cc.getBlockNumber();
        const logs = await m.queryFilter(m.filters.BlocksMirrored(chain.CHAIN_KEY_ETH_MAINNET), Math.max(chain.DEPLOY_BLOCK, head - 5_000), head);
        const last = logs.filter((l: any) => Number(l.args.newlyAdded) > 0).pop() as any;
        if (last) {
          const [tx, rc] = await Promise.all([cc.getTransaction(last.transactionHash), cc.getTransactionReceipt(last.transactionHash)]);
          const decoded = m.interface.parseTransaction({ data: tx!.data });
          const roots = (decoded?.args[6] as string[] | undefined)?.length ?? Number(last.args.toBlock) - Number(last.args.fromBlock) + 1;
          setWaste({
            tx: last.transactionHash,
            roots,
            gas: Number(rc!.gasUsed),
            from: Number(last.args.fromBlock),
            to: Number(last.args.toBlock),
            added: Number(last.args.newlyAdded),
          });
        }
      } catch {
        /* beat 1 degrades to its explanation; the other beats do not depend on it */
      }

      try {
        const [mh, sh] = await Promise.all([m.mirroredBlocks(chain.CHAIN_KEY_ETH_MAINNET), m.mirroredBlocks(chain.CHAIN_KEY_SEPOLIA)]);
        setArchive({ mainnet: Number(mh), sepolia: Number(sh) });
      } catch {
        /* masthead carries the same numbers */
      }

      // Beat 4: the largest open EmptySet and CompleteSet claims on the board.
      try {
        const r = chain.registryContract();
        const n = Number(await r.claimCount());
        // The newest 150 only: the court must load in seconds however much has been filed.
        const lo = Math.max(0, n - 150);
        const all = await Promise.all(Array.from({ length: n - lo }, (_, i) => r.claimOf(lo + i)));
        const picks = all
          .map((c: any, k: number) => {
            const staked = BigInt(c.bondStaked);
            return { id: lo + k, kind: Number(c.kind), bond: staked, loss: staked - staked / 2n, from: Number(c.spanFrom), to: Number(c.spanTo), chainKey: Number(c.chainKey), status: Number(c.status) };
          })
          .sort((a, b) => (b.bond > a.bond ? 1 : b.bond < a.bond ? -1 : 0));
        setLie(picks.find((p) => p.kind === 0 && p.status === 1) ?? picks.find((p) => p.kind === 0) ?? null);
        setComplete(picks.find((p) => p.kind === 1 && p.status === 1) ?? picks.find((p) => p.kind === 1) ?? null);
      } catch {
        /* beat 4 links to the watch regardless */
      }
    })();
  }, []);

  const perRoot = waste ? Math.round(waste.gas / Math.max(1, waste.added)) : null;

  return (
    <Page active="judge">
      <div className="court">
        <header className="court-head">
          <h1>The court.</h1>
          <p className="lede">
            Ninety seconds, six beats, every one of them live against Creditcoin as this page loads. Nothing here is a
            recording. If you have thirty seconds, watch beats two and three.
          </p>
        </header>

        <section className="beat">
          <p className="beat-n t-hash">1 · the waste</p>
          <h2>The precompile already certified these. Everyone else throws them away.</h2>
          {waste ? (
            <p>
              The most recent <code>mirror()</code> call carried <strong>{waste.roots.toLocaleString()}</strong> Ethereum block roots —
              heights {waste.from.toLocaleString()} to {waste.to.toLocaleString()} — in one continuity proof that{' '}
              <code>0x0FD2</code> verified. Every other integration keeps one transaction from a proof like this and discards the rest.
              This one kept all of them, for {waste.gas.toLocaleString()} gas ({perRoot?.toLocaleString()} per height).{' '}
              <a href={`${EXPLORER}/tx/${waste.tx}`} target="_blank" rel="noreferrer">The transaction ↗</a>
            </p>
          ) : (
            <p>
              Every Attestcoin query carries a continuity proof — measured at {rootsAt(50)} for a fresh block,{' '}
              {rootsAt(7_200)} at a day old, {rootsAt(1_296_000)} at 180 days, and {WIDEST_CALL_ROOTS?.toLocaleString() ?? 'hundreds'} for a batch anchored at both ends of a window. The precompile binds every root in it. Everyone else keeps one.
            </p>
          )}
          {archive && (
            <p className="t-caption">
              Held right now: {archive.mainnet.toLocaleString()} mainnet heights and {archive.sepolia.toLocaleString()} Sepolia heights.
            </p>
          )}
        </section>

        <section className="beat beat--key">
          <p className="beat-n t-hash">2 + 3 · the second question, with the precompile deleted</p>
          <h2>A different transaction in a notarised block. No wallet. Then the same call with <code>0x0FD2</code> gone.</h2>
          <IndependenceModule state={indep} compact />
          <p className="t-caption">
            Row three is the control: the same state override turned on the archive instead. It must fail, and it does, which is how you
            know the precompile really was deleted in row two. This website is not the verifier. The mirror is.
          </p>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">4 · a negative that is not an indexer</p>
          <h2>“Never liquidated” cannot be proven. It can be bonded, hunted, and burned.</h2>
          <p>
            A claim that something did not happen — or that a list is complete — is staked, not proven. Anyone who finds the transaction
            the claimant did not account for takes half the bond; the other half burns, so a liar cannot refute themselves and walk
            away whole. The desk’s default treats silence as silence, never as innocence.
          </p>
          <ul className="beat-links">
            {lie && (
              <li>
                <a className="cta" href={`/watch/?claim=${lie.id}`}>
                  Hunt claim #{lie.id} — {tctc(lie.bond)} tCTC, {tctc(lie.loss)} unrecoverable
                </a>{' '}
                <span className="t-caption">EmptySet over {(lie.to - lie.from + 1).toLocaleString()} blocks of {lie.chainKey === 1 ? 'Sepolia' : 'mainnet'}</span>
              </li>
            )}
            {complete && (
              <li>
                <a className="cta cta--quiet" href={`/watch/?claim=${complete.id}`}>
                  Check completeness claim #{complete.id}
                </a>{' '}
                <span className="t-caption">“these are all of them” — refuted by one omitted member</span>
              </li>
            )}
            <li>
              <a className="cta cta--quiet" href="/assess/">Ask the desk about a liquidated borrower</a>
            </li>
          </ul>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">5 · the tax</p>
          <h2>Who pays for the same fact twice.</h2>
          <table className="tax">
            <thead>
              <tr><th /><th>cost</th><th>how we know</th></tr>
            </thead>
            <tbody>
              {waste && perRoot && (
                <tr>
                  <td>notarising a height here, once</td>
                  <td className="t-hash">{perRoot.toLocaleString()} gas</td>
                  <td className="t-caption">measured — the transaction in beat 1</td>
                </tr>
              )}
              <tr>
                <td>every later question about that height</td>
                <td className="t-hash">0 gas</td>
                <td className="t-caption">measured — beat 2 is a view call; no transaction exists to pay for</td>
              </tr>
              <tr>
                <td>asking about a 180-day-old block the ordinary way</td>
                <td className="t-hash">{rootsAt(1_296_000)}</td>
                <td className="t-caption">measured — continuity returned by the live prover; paid again by every asker</td>
              </tr>
              <tr>
                <td>index41 proving one mainnet sandwich</td>
                <td className="t-hash">1,092,100 gas</td>
                <td className="t-caption">
                  measured — <a href={`${EXPLORER}/tx/0xd136dea0524b7e0e9eba54bf9724eec78597c2598047a96849af727f4d243810`} target="_blank" rel="noreferrer">their receipt</a>;
                  the same ordering is free on <a className="linkish" href="/order/">/order</a>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="t-caption">Only numbers we measured are in this table. Figures we could not check at their source are not here.</p>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">6 · enshrine</p>
          <h2>Option B is a native <code>BlockRootCache</code>.</h2>
          <p>
            The node already computes these roots and discards them. A runtime cache written as a side-effect of every successful query would
            make this contract unnecessary. <a className="linkish" href="/enshrine/">We would rather help you build it than be the reason it is not needed.</a>
          </p>
        </section>

        <p className="t-caption court-foot">
          The ledger of what is and is not claimed is at <a className="linkish" href="/claims/">/claims</a>. Nothing on this page is a score.
        </p>
      </div>
    </Page>
  );
}
