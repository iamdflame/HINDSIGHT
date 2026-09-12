import { useEffect, useMemo, useRef, useState } from 'react';
import { ClaimRow, describeClaim, tctc } from './ClaimRow';
import { HuntSteps } from './HuntSteps';
import { WalletLine, type WalletView } from './WalletLine';
import type { Claim, Hunt } from './types';
import { Stamp } from '../question/Stamp';
import { CcAddr } from '../shared/CcAddr';
import { EthBlock } from '../shared/EthBlock';
import { EthTx } from '../shared/EthTx';
import type { StepState } from '../shared/Steps';

const ORDER: Record<number, number> = { 1: 0, 3: 1, 2: 2, 0: 3 }; // open · standing · refuted · none

/**
 * Keyless, CORS-open Ethereum endpoints verified to answer historical `eth_getLogs` for a notarised
 * span, tested from a browser origin. The chain layer's default endpoint gates log ranges older than
 * its recent window behind an archive token (and publicnode refuses some browser log queries
 * intermittently), so a claim's span ages out within hours; without failover the hunt, and the verified
 * "this one is a lie", silently stops working for every visitor.
 */
const LOG_SEARCH_RPCS = [
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
}

export function Watch() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [venues, setVenues] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [hunts, setHunts] = useState<Record<number, Hunt>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletView>({ k: 'idle' });
  const [flow, setFlow] = useState<{ id: number; states: [StepState, StepState, StepState]; msg?: string } | null>(null);
  const [justRefuted, setJustRefuted] = useState<number | null>(null);
  const provider = useRef<any>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setErr('');
    try {
      const { registryContract, VENUES } = await import('../lib/chain');
      setVenues(VENUES as any);
      const r = registryContract();
      const n = Number(await r.claimCount());
      const out: Claim[] = [];
      for (let i = 0; i < n; i++) {
        const a = await r.assurance(i);
        const c = await r.claimOf(i);
        out.push({
          id: i, status: Number(a.status), bond: a.bond, openUntil: Number(a.openUntil),
          spanFrom: Number(a.spanFrom), spanTo: Number(a.spanTo),
          venue: c.venue, topic0: c.topic0, subject: c.subject, subjectTopic: Number(c.subjectTopic),
          claimant: c.claimant, refuter: c.refuter,
        });
      }
      setClaims(out);
      // Scan every open claim once, so "this one is a lie" is only ever said about a verified lie.
      // One at a time: parallel log queries get rate-limited by free endpoints.
      void (async () => { for (const c of out.filter((x) => x.status === 1)) await huntFor(c); })();
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    }
  }

  /** Search the claimed span on Ethereum for a transaction that contradicts it (unchanged logic). */
  async function huntFor(c: Claim) {
    setHunts((h) => ({ ...h, [c.id]: { k: 'scanning' } }));
    const topics: (string | null)[] = [c.topic0];
    if (c.subjectTopic > 0) {
      for (let i = 1; i < c.subjectTopic; i++) topics.push(null);
      topics.push(c.subject);
    }
    const filter = { address: c.venue, topics, fromBlock: c.spanFrom, toBlock: c.spanTo };
    const [{ JsonRpcProvider }, { ethereum }] = await Promise.all([import('ethers'), import('../lib/chain')]);
    const attempts = [
      ...LOG_SEARCH_RPCS.map((url) => () =>
        new JsonRpcProvider(url, { chainId: 1, name: 'mainnet' }, { staticNetwork: true, batchMaxCount: 1 }).getLogs(filter)),
      () => ethereum().getLogs(filter),
    ];
    let lastError = 'Public node refused the log query.';
    for (const attempt of attempts) {
      try {
        const logs = await attempt();
        setHunts((h) => ({
          ...h,
          [c.id]: logs.length === 0 ? { k: 'none' } : { k: 'found', txHash: logs[0].transactionHash, block: logs[0].blockNumber },
        }));
        return;
      } catch (e: any) {
        lastError = e?.shortMessage ?? e?.message ?? lastError;
      }
    }
    setHunts((h) => ({ ...h, [c.id]: { k: 'error', msg: lastError } }));
  }

  async function connect() {
    setWallet({ k: 'connecting' });
    try {
      const { connectWallet } = await import('../lib/chain');
      const w = await withTimeout(connectWallet(), 8000);
      if (w.kind === 'ready') { provider.current = w.provider; setWallet({ k: 'ok', address: w.address }); }
      else if (w.kind === 'wrong-network') setWallet({ k: 'wrong' });
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

  /** Commit, wait one block, reveal (unchanged commit–reveal logic, AlreadyCommitted included). */
  async function refute(c: Claim, txHash: string) {
    if (!provider.current) return;
    const mark = (i: 0 | 1 | 2, st: StepState) =>
      setFlow((f) => (f && f.id === c.id ? { ...f, states: f.states.map((x, j) => (j === i ? st : x)) as [StepState, StepState, StepState] } : f));
    setFlow({ id: c.id, states: ['done', 'active', 'todo'] });
    try {
      const [{ hexlify, randomBytes }, { registryContract }, { proofFromEthereum }] = await Promise.all([
        import('ethers'), import('../lib/chain'), import('../lib/proof'),
      ]);
      const proof = await proofFromEthereum(txHash);
      const signer = await provider.current.getSigner();
      const reg = registryContract(signer);
      const salt = hexlify(randomBytes(32));
      const commitment = await reg.commitmentFor(c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt, await signer.getAddress());
      try {
        await (await reg.commitRefutation(commitment)).wait();
      } catch (e: any) {
        // A commitment is only a hash: someone may already have recorded this exact one. It binds our
        // address, so only we can reveal against it — treat it as done rather than stalling.
        const already = /AlreadyCommitted/i.test(e?.shortMessage ?? e?.message ?? '')
          || /0x[0-9a-f]*/.test(e?.data ?? '') && /already/i.test(JSON.stringify(e).slice(0, 400));
        if (!already) throw e;
      }
      mark(1, 'done'); mark(2, 'active');
      const start = await provider.current.getBlockNumber();
      while ((await provider.current.getBlockNumber()) <= start) await new Promise((r) => setTimeout(r, 2500));
      await (await reg.revealRefutation(c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt)).wait();
      mark(2, 'done');
      setJustRefuted(c.id);
      await load();
    } catch (e: any) {
      setFlow((f) => (f && f.id === c.id
        ? { ...f, states: f.states.map((x) => (x === 'active' ? 'failed' : x)) as [StepState, StepState, StepState], msg: e?.shortMessage ?? e?.message ?? String(e) }
        : f));
    }
  }

  const ordered = useMemo(
    () => (claims ?? []).slice().sort((a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.bond > a.bond ? 1 : b.bond < a.bond ? -1 : a.id - b.id)),
    [claims],
  );
  const sel = ordered.find((c) => c.id === selected) ?? null;
  const selHunt = sel ? hunts[sel.id] ?? { k: 'idle' } : null;
  const first = ordered[0];
  const firstIsLie = first && first.status === 1 && hunts[first.id]?.k === 'found';

  return (
    <section id="panel-watch" role="tabpanel" aria-labelledby="tab-watch" className="pane">
      <h1 className="t-title pane-title">What did not happen.</h1>
      <p className="t-body pane-lead">Statements that something did not happen. These are never proven — they are staked.</p>

      {err && (
        <div className="plain-state">
          <p className="t-body">{err}</p>
          <p className="t-caption"><button type="button" className="linkish" onClick={() => void load()}>Try again</button></p>
        </div>
      )}
      {!err && claims === null && <p className="t-caption">Reading claims from Creditcoin…</p>}
      {!err && claims?.length === 0 && <p className="t-body">Nobody has staked a statement of absence on this deployment.</p>}

      {!err && claims && claims.length > 0 && (
        <div className="watch-split">
          <ol className="board">
            {ordered.map((c, i) => {
              const d = describeClaim(c, venues);
              return (
                <li key={c.id}>
                  <ClaimRow
                    claim={c}
                    position={i + 1}
                    event={d.event}
                    subject={d.subject}
                    selected={selected === c.id}
                    onSelect={() => { setSelected(c.id); setFlow(null); }}
                  />
                  {i === 0 && firstIsLie && <p className="lie-caption t-caption">this one is a lie. the bounty is real.</p>}
                  {selected === c.id && c.status === 3 && <p className="lie-caption t-caption">Economic — unrefuted. Not a proof of absence.</p>}
                </li>
              );
            })}
          </ol>

          <div className="hunt" aria-live="polite">
            {sel && sel.status === 1 && (
              <>
                {(!selHunt || selHunt.k === 'idle' || selHunt.k === 'scanning') && (
                  <p className="t-caption">Scanning the claimed span on Ethereum…</p>
                )}
                {selHunt?.k === 'none' && (
                  <p className="t-caption">
                    No contradicting transaction found in this span on a public node. That is not proof the claim is true — only that this scan did not find one.
                  </p>
                )}
                {selHunt?.k === 'error' && (
                  <p className="t-caption">{selHunt.msg} <button type="button" className="linkish" onClick={() => void huntFor(sel)}>retry</button></p>
                )}
                {selHunt?.k === 'found' && (
                  <>
                    <dl className="facts">
                      <dt className="t-ui">counterexample</dt>
                      <dd>block <EthBlock n={selHunt.block} /> · <EthTx hash={selHunt.txHash} /></dd>
                      <dt className="t-ui">bond</dt>
                      <dd>{tctc(sel.bond)} tCTC</dd>
                    </dl>
                    <HuntSteps
                      states={flow?.id === sel.id ? flow.states : [wallet.k === 'ok' ? 'done' : 'todo', 'todo', 'todo']}
                      wallet={<WalletLine view={wallet} onConnect={() => void connect()} onSwitch={() => void switchChain()} />}
                      action={wallet.k === 'ok' && (
                        <span>
                          <button
                            type="button"
                            className="act"
                            disabled={!!flow && flow.id === sel.id && !flow.msg && flow.states[2] !== 'done'}
                            onClick={() => void refute(sel, selHunt.txHash)}
                          >
                            Refute and take {tctc(sel.bond)} tCTC
                          </button>
                        </span>
                      )}
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
                  <dt className="t-ui">bond</dt><dd>{tctc(sel.bond)} tCTC</dd>
                  <dt className="t-ui">claimant</dt><dd><CcAddr addr={sel.claimant} /></dd>
                </dl>
              </>
            )}

            {sel && sel.status === 2 && (
              <>
                <Stamp state="refuted" pressKey={`refuted:${sel.id}`} animate={justRefuted === sel.id} />
                <p className="t-caption">A counterexample was revealed. The bond moved.</p>
                <dl className="facts">
                  <dt className="t-ui">bond</dt><dd>{tctc(sel.bond)} tCTC</dd>
                  <dt className="t-ui">refuted by</dt><dd><CcAddr addr={sel.refuter} /></dd>
                </dl>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
