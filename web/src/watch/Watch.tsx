import { useEffect, useMemo, useRef, useState } from 'react';
import { ClaimRow, describeClaim, tctc } from './ClaimRow';
import { HuntSteps } from './HuntSteps';
import { WalletLine, type WalletView } from './WalletLine';
import type { Claim, Hunt, Member } from './types';
import { Stamp } from '../question/Stamp';
import { CcAddr } from '../shared/CcAddr';
import { EthBlock } from '../shared/EthBlock';
import { EthTx } from '../shared/EthTx';
import type { StepState } from '../shared/Steps';
import { Page } from '../shell/Page';

const ORDER: Record<number, number> = { 1: 0, 3: 1, 2: 2, 0: 3 }; // open · standing · refuted · none

/** The newest claims read on load. Anyone can file claims for a cent, so the page must not make
 *  one RPC call per claim ever filed before it can show anything; older pages load on request. */
const PAGE = 150;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
}

function initialSelection(): number | null {
  const q = new URLSearchParams(window.location.search).get('claim');
  return q !== null && /^\d+$/.test(q) ? Number(q) : null;
}

/**
 * The board. Every claim here is a statement inclusion proofs cannot make -- that something did not
 * happen, or that a list is complete -- backed by a bond half of which burns if it is wrong.
 *
 * Hunting runs in this browser. A claim is scanned when it is selected (and the top open claim once
 * on load, so the one sentence this page says about a lie is only ever said about a verified lie).
 * A negative is only reported once two public endpoints have each covered the whole range; anything
 * less is reported as a failed scan, never as silence.
 */
export function Watch() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [venues, setVenues] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [hunts, setHunts] = useState<Record<number, Hunt>>({});
  const [selected, setSelected] = useState<number | null>(initialSelection);
  const [wallet, setWallet] = useState<WalletView>({ k: 'idle' });
  const [flow, setFlow] = useState<{ id: number; states: [StepState, StepState, StepState]; msg?: string } | null>(null);
  const [justRefuted, setJustRefuted] = useState<number | null>(null);
  const provider = useRef<any>(null);
  const scanning = useRef(new Set<number>());

  useEffect(() => {
    void load(limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  async function load(want: number = limit) {
    setErr('');
    try {
      const { registryContract, VENUES } = await import('../lib/chain');
      setVenues(VENUES as any);
      const r = registryContract();
      const [n, shareBps] = await Promise.all([r.claimCount(), r.REFUTER_SHARE_BPS()]);
      const count = Number(n);
      setTotal(count);
      // Newest first window; a deep link to an older claim widens it to include that claim.
      const wanted = selected !== null && selected < count ? Math.max(want, count - selected) : want;
      const lo = Math.max(0, count - wanted);
      const ids = Array.from({ length: count - lo }, (_, i) => lo + i);
      const rows = await Promise.all(ids.map((i) => r.claimOf(i)));
      const out: Claim[] = rows.map((c: any, k: number) => {
        const staked = BigInt(c.bondStaked);
        return {
          id: ids[k],
          status: Number(c.status),
          kind: Number(c.kind) as 0 | 1,
          chainKey: Number(c.chainKey),
          bond: staked,
          enforceableLoss: staked - (staked * BigInt(shareBps)) / 10_000n,
          openUntil: Number(c.openUntil),
          spanFrom: Number(c.spanFrom),
          spanTo: Number(c.spanTo),
          venue: c.venue,
          topic0: c.topic0,
          subject: c.subject,
          subjectTopic: Number(c.subjectTopic),
          claimant: c.claimant,
          refuter: c.refuter,
          members: Number(c.members),
        };
      });
      setClaims(out);
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    }
  }

  async function membersOf(claimId: number): Promise<Member[]> {
    const { registryContract, REGISTRY_DEPLOY_BLOCK } = await import('../lib/chain');
    const r = registryContract();
    const logs = await r.queryFilter(r.filters.MembersListed(claimId), REGISTRY_DEPLOY_BLOCK, 'latest');
    if (logs.length !== 1) throw new Error(`the registry holds ${logs.length} member lists for claim ${claimId}`);
    const parsed = r.interface.parseLog(logs[0] as any)!;
    return (parsed.args.members as any[]).map((m) => ({ height: Number(m.height), txIndex: Number(m.txIndex), logIndex: Number(m.logIndex) }));
  }

  /** Search the claim's range for a transaction the claimant did not account for. */
  async function huntFor(c: Claim) {
    if (scanning.current.has(c.id)) return;
    scanning.current.add(c.id);
    const note = (m: string) => setHunts((h) => ({ ...h, [c.id]: { k: 'scanning', note: m } }));
    note('scanning the claimed range…');
    try {
      const { scanLogs, receiptLogIndex } = await import('../lib/logs');
      const topics: (string | null)[] = [c.topic0];
      if (c.subjectTopic > 0) {
        for (let i = 1; i < c.subjectTopic; i++) topics.push(null);
        topics.push(c.subject);
      }
      const { logs, corroboratedBy } = await scanLogs(c.chainKey, { address: c.venue, topics }, c.spanFrom, c.spanTo, note, 2, c.kind === 1);

      const members = c.kind === 1 ? await membersOf(c.id) : undefined;
      const listed = new Set((members ?? []).map((m) => `${m.height}:${m.txIndex}:${m.logIndex}`));

      for (const log of logs) {
        note(`checking ${log.transactionHash.slice(0, 10)}…`);
        const li = await receiptLogIndex(c.chainKey, log);
        if (li < 0) continue; // a failed transaction is not evidence
        if (c.kind === 1 && listed.has(`${log.blockNumber}:${log.transactionIndex}:${li}`)) continue;
        setHunts((h) => ({
          ...h,
          [c.id]: { k: 'found', txHash: log.transactionHash, block: log.blockNumber, txIndex: log.transactionIndex, logIndex: li, members },
        }));
        return;
      }
      setHunts((h) => ({ ...h, [c.id]: { k: 'none', corroboratedBy, scanned: c.spanTo - c.spanFrom + 1 } }));
    } catch (e: any) {
      setHunts((h) => ({ ...h, [c.id]: { k: 'error', msg: e?.shortMessage ?? e?.message ?? String(e) } }));
    } finally {
      scanning.current.delete(c.id);
    }
  }

  const ordered = useMemo(
    () =>
      (claims ?? [])
        .slice()
        .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.bond > a.bond ? 1 : b.bond < a.bond ? -1 : a.id - b.id)),
    [claims],
  );
  const first = ordered[0];

  // Scan the selected claim, and the top open claim once, so "this one is a lie" is earned.
  useEffect(() => {
    if (!claims) return;
    const sel = claims.find((c) => c.id === selected);
    if (sel && sel.status === 1 && !hunts[sel.id]) void huntFor(sel);
    if (first && first.status === 1 && !hunts[first.id]) void huntFor(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims, selected]);

  async function connect() {
    setWallet({ k: 'connecting' });
    try {
      const { connectWallet } = await import('../lib/chain');
      const w = await withTimeout(connectWallet(), 8000);
      if (w.kind === 'ready') {
        provider.current = w.provider;
        setWallet({ k: 'ok', address: w.address });
      } else if (w.kind === 'wrong-network') setWallet({ k: 'wrong' });
      else setWallet({ k: 'failed' });
    } catch {
      setWallet({ k: 'failed' });
    }
  }

  async function switchChain() {
    try {
      const { switchToCreditcoin } = await import('../lib/chain');
      await switchToCreditcoin();
      await connect();
    } catch {
      setWallet({ k: 'failed' });
    }
  }

  /** Commit, wait for the commitment to age a block, reveal. Half the bond to you, half burned. */
  async function refute(c: Claim, found: Extract<Hunt, { k: 'found' }>) {
    if (!provider.current) return;
    const mark = (i: 0 | 1 | 2, st: StepState) =>
      setFlow((f) => (f && f.id === c.id ? { ...f, states: f.states.map((x, j) => (j === i ? st : x)) as [StepState, StepState, StepState] } : f));
    setFlow({ id: c.id, states: ['done', 'active', 'todo'] });
    try {
      const [{ hexlify, randomBytes }, { registryContract }, { proofFromEthereum }] = await Promise.all([
        import('ethers'),
        import('../lib/chain'),
        import('../lib/proof'),
      ]);
      const proof = await proofFromEthereum(found.txHash, undefined, c.chainKey);
      const signer = await provider.current.getSigner();
      const me = await signer.getAddress();
      const reg = registryContract(signer);
      const salt = hexlify(randomBytes(32));
      const members = found.members ?? [];

      const commitment =
        c.kind === 0
          ? await reg.commitmentFor(c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt, me)
          : await reg.commitmentForComplete(c.id, proof.blockNumber, proof.txBytes, proof.siblings, found.logIndex, members, salt, me);
      try {
        await (await reg.commitRefutation(commitment)).wait();
      } catch (e: any) {
        // A commitment binds our address, so an identical one already on-chain is still ours to reveal.
        if (!/AlreadyCommitted/i.test(e?.shortMessage ?? e?.message ?? '')) throw e;
      }
      mark(1, 'done');
      mark(2, 'active');
      const start = await provider.current.getBlockNumber();
      while ((await provider.current.getBlockNumber()) <= start) await new Promise((r) => setTimeout(r, 2500));
      const tx =
        c.kind === 0
          ? await reg.revealRefutation(c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt)
          : await reg.revealOmission(c.id, proof.blockNumber, proof.txBytes, proof.siblings, found.logIndex, members, salt);
      await tx.wait();
      mark(2, 'done');
      setJustRefuted(c.id);
      await load();
    } catch (e: any) {
      setFlow((f) =>
        f && f.id === c.id
          ? { ...f, states: f.states.map((x) => (x === 'active' ? 'failed' : x)) as [StepState, StepState, StepState], msg: e?.shortMessage ?? e?.message ?? String(e) }
          : f,
      );
    }
  }

  function select(id: number) {
    setSelected(id);
    setFlow(null);
    const url = new URL(window.location.href);
    url.searchParams.set('claim', String(id));
    window.history.replaceState(null, '', url);
  }

  const sel = ordered.find((c) => c.id === selected) ?? null;
  const selHunt = sel ? hunts[sel.id] ?? { k: 'idle' } : null;
  const firstIsLie = first && first.status === 1 && hunts[first.id]?.k === 'found';
  const counts = useMemo(() => {
    const c = { open: 0, standing: 0, refuted: 0, complete: 0 };
    for (const x of claims ?? []) {
      if (x.status === 1) c.open++;
      if (x.status === 3) c.standing++;
      if (x.status === 2) c.refuted++;
      if (x.kind === 1) c.complete++;
    }
    return c;
  }, [claims]);

  return (
    <Page active="watch">
      <section className="pane">
        <h1 className="t-title pane-title">What did not happen.</h1>
        <p className="t-body pane-lead">
          Two statements inclusion proofs cannot make — <em>none of these happened</em>, and <em>these are all of
          them</em> — staked instead of proven. Refute one with a transaction the claimant did not account for,
          and take half the bond. The other half burns, so a liar cannot refute themselves and walk away whole.
        </p>

        {claims && claims.length > 0 && (
          <p className="t-ui board-summary">
            {total > claims.length ? `newest ${claims.length} of ${total}` : claims.length} claims · {counts.open} open · {counts.standing} standing ·{' '}
            {counts.refuted} refuted · {counts.complete} completeness claims
            {total > claims.length && (
              <>
                {' '}·{' '}
                <button type="button" className="linkish" onClick={() => setLimit((l) => l + PAGE)}>
                  load {Math.min(PAGE, total - claims.length)} older
                </button>
              </>
            )}
          </p>
        )}

        {err && (
          <div className="plain-state">
            <p className="t-body">{err}</p>
            <p className="t-caption">
              <button type="button" className="linkish" onClick={() => void load(limit)}>
                Try again
              </button>
            </p>
          </div>
        )}
        {!err && claims === null && <p className="t-caption">Reading claims from Creditcoin…</p>}
        {!err && claims?.length === 0 && <p className="t-body">Nobody has staked a claim on this registry yet.</p>}

        {!err && claims && claims.length > 0 && (
          <div className="watch-split">
            <ol className="board">
              {ordered.map((c, i) => {
                const d = describeClaim(c, venues);
                return (
                  <li key={c.id}>
                    <ClaimRow claim={c} position={i + 1} event={d.event} subject={d.subject} selected={selected === c.id} onSelect={() => select(c.id)} />
                    {i === 0 && firstIsLie && <p className="lie-caption t-caption">this one is a lie. the bounty is real.</p>}
                    {selected === c.id && c.status === 3 && <p className="lie-caption t-caption">Economic — unrefuted. Not a proof.</p>}
                  </li>
                );
              })}
            </ol>

            <div className="hunt" aria-live="polite">
              {!sel && <p className="t-caption">Select a claim to hunt it. Nothing is scanned until you do.</p>}

              {sel && (
                <dl className="facts">
                  <dt className="t-ui">claim</dt>
                  <dd>
                    #{sel.id} · {sel.kind === 1 ? `CompleteSet, ${sel.members} members` : 'EmptySet'} · {sel.chainKey === 1 ? 'Sepolia' : 'Ethereum mainnet'}
                  </dd>
                  <dt className="t-ui">range</dt>
                  <dd>
                    {sel.spanFrom.toLocaleString()} – {sel.spanTo.toLocaleString()} · {(sel.spanTo - sel.spanFrom + 1).toLocaleString()} blocks ≈{' '}
                    {(((sel.spanTo - sel.spanFrom + 1) * 12) / 86_400).toFixed(1)} days
                  </dd>
                  <dt className="t-ui">bond</dt>
                  <dd>
                    {tctc(sel.bond)} tCTC · {tctc(sel.enforceableLoss)} unrecoverable if wrong
                  </dd>
                </dl>
              )}

              {sel && sel.status === 1 && (
                <>
                  {(!selHunt || selHunt.k === 'idle' || selHunt.k === 'scanning') && (
                    <p className="t-caption">{selHunt?.k === 'scanning' ? selHunt.note : 'Scanning the claimed range on Ethereum…'}</p>
                  )}
                  {selHunt?.k === 'none' && (
                    <p className="t-caption">
                      No {sel.kind === 1 ? 'unlisted matching log' : 'matching successful log'} in {selHunt.scanned.toLocaleString()} blocks,
                      corroborated by {selHunt.corroboratedBy.join(' and ')}. That is not proof the claim is true — only that this scan,
                      on two independent public nodes, did not find a counterexample.
                    </p>
                  )}
                  {selHunt?.k === 'error' && (
                    <p className="t-caption">
                      {selHunt.msg}{' '}
                      <button type="button" className="linkish" onClick={() => { setHunts((h) => ({ ...h, [sel.id]: { k: 'idle' } })); void huntFor(sel); }}>
                        retry
                      </button>
                    </p>
                  )}
                  {selHunt?.k === 'found' && (
                    <>
                      <dl className="facts">
                        <dt className="t-ui">{sel.kind === 1 ? 'omitted member' : 'counterexample'}</dt>
                        <dd>
                          block <EthBlock n={selHunt.block} /> · tx {selHunt.txIndex} · log {selHunt.logIndex} · <EthTx hash={selHunt.txHash} />
                        </dd>
                        <dt className="t-ui">you take</dt>
                        <dd>{tctc(sel.bond - sel.enforceableLoss)} tCTC · the rest burns</dd>
                      </dl>
                      <HuntSteps
                        states={flow?.id === sel.id ? flow.states : [wallet.k === 'ok' ? 'done' : 'todo', 'todo', 'todo']}
                        wallet={<WalletLine view={wallet} onConnect={() => void connect()} onSwitch={() => void switchChain()} />}
                        action={
                          wallet.k === 'ok' && (
                            <span>
                              <button
                                type="button"
                                className="act"
                                disabled={!!flow && flow.id === sel.id && !flow.msg && flow.states[2] !== 'done'}
                                onClick={() => void refute(sel, selHunt)}
                              >
                                Refute and take {tctc(sel.bond - sel.enforceableLoss)} tCTC
                              </button>
                            </span>
                          )
                        }
                      />
                      {flow?.id === sel.id && flow.msg && <p className="t-caption">{flow.msg}</p>}
                    </>
                  )}
                </>
              )}

              {sel && sel.status === 3 && (
                <>
                  <Stamp state="standing" pressKey={`standing:${sel.id}`} animate={false} />
                  <dl className="facts">
                    <dt className="t-ui">claimant</dt>
                    <dd><CcAddr addr={sel.claimant} /></dd>
                  </dl>
                </>
              )}

              {sel && sel.status === 2 && (
                <>
                  <Stamp state="refuted" pressKey={`refuted:${sel.id}`} animate={justRefuted === sel.id} />
                  <p className="t-caption">A counterexample was revealed. Half the bond went to the refuter; half was burned.</p>
                  <dl className="facts">
                    <dt className="t-ui">refuted by</dt>
                    <dd><CcAddr addr={sel.refuter} /></dd>
                  </dl>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </Page>
  );
}
