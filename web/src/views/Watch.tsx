import { useEffect, useState } from 'react';
import { formatEther, hexlify, randomBytes, zeroPadValue } from 'ethers';
import {
  registryContract, mirrorContract, ethereum, connectWallet, switchToCreditcoin,
  CHAIN_KEY_ETH_MAINNET, REGISTRY_ADDRESS, VENUES, type WalletState,
} from '../lib/chain';
import { proofFromEthereum } from '../lib/proof';
import { Assurance, Working, Empty, Failure, Steps, CcAddr, EthBlock, EthTx, Trunc } from '../components/Bits';

const STATUS = ['None', 'Open', 'Refuted', 'Standing'] as const;

type Claim = {
  id: number; status: number; bond: bigint; openUntil: number;
  spanFrom: number; spanTo: number; venue: string; topic0: string;
  subject: string; subjectTopic: number; claimant: string; refuter: string;
};

type Hunt =
  | { k: 'idle' }
  | { k: 'scanning'; msg: string }
  | { k: 'none' }
  | { k: 'found'; txHash: string; block: number }
  | { k: 'error'; msg: string };

export function Watch() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [err, setErr] = useState('');
  const [hunt, setHunt] = useState<Record<number, Hunt>>({});
  const [wallet, setWallet] = useState<WalletState>({ kind: 'absent' });
  const [busy, setBusy] = useState<number | null>(null);
  const [steps, setSteps] = useState<{ label: string; state: 'todo' | 'active' | 'done' | 'failed' }[]>([]);

  useEffect(() => { void load(); }, []);

  async function load() {
    setErr(''); setClaims(null);
    try {
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
      setClaims(out.reverse());
    } catch (e: any) { setErr(e.shortMessage ?? e.message ?? String(e)); }
  }

  function describe(c: Claim) {
    const v = VENUES.find((x) => x.address.toLowerCase() === c.venue.toLowerCase());
    const ev = v?.events.find((e) => e.topic0.toLowerCase() === c.topic0.toLowerCase());
    const subj = c.subjectTopic === 0 ? 'anyone' : '0x' + c.subject.slice(-40);
    return { venue: v?.label ?? c.venue, event: ev?.label ?? c.topic0.slice(0, 12) + '…', subject: subj };
  }

  /** Hunt the claimed span for a transaction that contradicts it. */
  async function huntFor(c: Claim) {
    setHunt((h) => ({ ...h, [c.id]: { k: 'scanning', msg: 'Scanning the claimed span on Ethereum…' } }));
    try {
      const topics: (string | null)[] = [c.topic0];
      if (c.subjectTopic > 0) {
        for (let i = 1; i < c.subjectTopic; i++) topics.push(null);
        topics.push(c.subject);
      }
      const logs = await ethereum().getLogs({
        address: c.venue, topics, fromBlock: c.spanFrom, toBlock: c.spanTo,
      });
      if (logs.length === 0) { setHunt((h) => ({ ...h, [c.id]: { k: 'none' } })); return; }
      setHunt((h) => ({ ...h, [c.id]: { k: 'found', txHash: logs[0].transactionHash, block: logs[0].blockNumber } }));
    } catch (e: any) {
      setHunt((h) => ({ ...h, [c.id]: { k: 'error', msg: e.shortMessage ?? e.message ?? 'Public node refused the log query.' } }));
    }
  }

  async function refute(c: Claim, txHash: string) {
    setBusy(c.id);
    setSteps([
      { label: 'Connect a wallet on Creditcoin testnet', state: 'active' },
      { label: 'Rebuild the evidence from a public Ethereum node', state: 'todo' },
      { label: 'Commit — the evidence stays secret', state: 'todo' },
      { label: 'Wait one block, so a copied commitment is useless', state: 'todo' },
      { label: 'Reveal, and take the bond', state: 'todo' },
    ]);
    const mark = (i: number, st: 'active' | 'done' | 'failed') =>
      setSteps((s) => s.map((x, j) => (j === i ? { ...x, state: st } : x)));

    try {
      const w = await connectWallet();
      setWallet(w);
      if (w.kind === 'absent') { mark(0, 'failed'); return; }
      if (w.kind === 'wrong-network') { mark(0, 'failed'); return; }
      mark(0, 'done'); mark(1, 'active');

      const proof = await proofFromEthereum(txHash);
      mark(1, 'done'); mark(2, 'active');

      const signer = await w.provider.getSigner();
      const reg = registryContract(signer);
      const salt = hexlify(randomBytes(32));
      const commitment = await reg.commitmentFor(
        c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt, await signer.getAddress(),
      );
      // A commitment is just a hash, so anyone may have already recorded this exact one --
      // including a bot copying it from the mempool. That is harmless: the commitment binds our
      // address, so only we can reveal against it. Treat "already committed" as success rather
      // than stalling the flow.
      try {
        await (await reg.commitRefutation(commitment)).wait();
      } catch (e: any) {
        const already = /AlreadyCommitted/i.test(e?.shortMessage ?? e?.message ?? '')
          || /0x[0-9a-f]*/.test(e?.data ?? '') && /already/i.test(JSON.stringify(e).slice(0, 400));
        if (!already) throw e;
      }
      mark(2, 'done'); mark(3, 'active');

      const start = await w.provider.getBlockNumber();
      while ((await w.provider.getBlockNumber()) <= start) await new Promise((r) => setTimeout(r, 2500));
      mark(3, 'done'); mark(4, 'active');

      await (await reg.revealRefutation(c.id, proof.blockNumber, proof.txBytes, proof.siblings, salt)).wait();
      mark(4, 'done');
      await load();
    } catch (e: any) {
      setSteps((s) => s.map((x) => (x.state === 'active' ? { ...x, state: 'failed' } : x)));
      setErr(e.shortMessage ?? e.message ?? String(e));
    } finally { setBusy(null); }
  }

  return (
    <section className="pane">
      <h2 className="pane-title">The watch</h2>
      <p className="pane-intro">
        Statements that something did <em>not</em> happen. These are never proven — they are{' '}
        <strong>staked</strong>. Anyone may destroy one by producing a single contradicting
        transaction, and collect the bond. A claim nobody destroyed is worth exactly as much as the
        money that was at risk, which is why the bond is shown beside every one.
      </p>

      {err && <Failure title="Something went wrong"><p>{err}</p></Failure>}
      {wallet.kind === 'absent' && busy === null && steps.length > 0 && (
        <Failure title="No wallet found">
          <p>Refuting is an on-chain action, so it needs a wallet holding testnet CTC. Reading this page needs neither.</p>
        </Failure>
      )}
      {wallet.kind === 'wrong-network' && (
        <Failure title="Wrong network">
          <p>Your wallet is on chain {wallet.chainId}. This registry lives on Creditcoin testnet (102031).</p>
          <button className="act ghost" onClick={() => switchToCreditcoin()}>Switch to Creditcoin testnet</button>
        </Failure>
      )}

      {claims === null && !err && <Working>Reading claims from Creditcoin…</Working>}
      {claims?.length === 0 && (
        <Empty title="No claims yet"><p>Nobody has staked a statement of absence on this deployment.</p></Empty>
      )}

      {claims?.map((c) => {
        const d = describe(c);
        const h = hunt[c.id] ?? { k: 'idle' as const };
        const open = c.status === 1 && Date.now() / 1000 < c.openUntil;
        return (
          <article key={c.id} style={{ borderTop: '1px solid var(--rule)', padding: '1.4rem 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
              <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.12rem', margin: 0, maxWidth: '38rem' }}>
                “{d.subject} had no <span className="mono">{d.event}</span> on {d.venue} between
                blocks {c.spanFrom.toLocaleString()} and {c.spanTo.toLocaleString()}.”
              </h3>
              <Assurance kind={c.status === 3 ? 'economic' : c.status === 2 ? 'destroyed' : 'pending'} />
            </div>

            <dl className="facts" style={{ marginTop: '.9rem' }}>
              <dt>Status</dt>
              <dd style={{ color: c.status === 2 ? 'var(--refuted)' : c.status === 3 ? 'var(--pending)' : 'inherit' }}>
                {STATUS[c.status]}
                {c.status === 3 && ' — unrefuted, not proven'}
                {c.status === 2 && ' — destroyed by counterexample'}
              </dd>
              <dt>Bond at risk</dt><dd>{formatEther(c.bond)} tCTC</dd>
              <dt>Window</dt><dd>{open ? `closes ${new Date(c.openUntil * 1000).toLocaleString()}` : 'closed'}</dd>
              <dt>Claimant</dt><dd><CcAddr addr={c.claimant} /></dd>
              {c.status === 2 && <><dt>Refuted by</dt><dd><CcAddr addr={c.refuter} /></dd></>}
            </dl>

            {open && (
              <div style={{ marginTop: '1rem' }}>
                {h.k === 'idle' && <button className="act ghost" onClick={() => huntFor(c)}>Hunt for a counterexample</button>}
                {h.k === 'scanning' && <Working>{h.msg}</Working>}
                {h.k === 'none' && (
                  <p className="note">
                    No contradicting transaction found in this span on a public node. That is not proof
                    the claim is true — only that this scan did not find one.
                  </p>
                )}
                {h.k === 'error' && <p className="note" style={{ color: 'var(--refuted)' }}>{h.msg}</p>}
                {h.k === 'found' && (
                  <div>
                    <p className="note" style={{ borderLeftColor: 'var(--refuted)' }}>
                      Counterexample found in block <EthBlock n={h.block} /> — <EthTx hash={h.txHash} />.
                      This claim is false and its bond is collectable.
                    </p>
                    <button className="act" disabled={busy !== null} style={{ marginTop: '.8rem' }}
                      onClick={() => refute(c, h.txHash)}>
                      {busy === c.id ? 'Refuting…' : `Refute and take ${formatEther(c.bond)} tCTC`}
                    </button>
                    {busy === c.id && <Steps items={steps} />}
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}

      <p className="note" style={{ marginTop: '2rem' }}>
        Registry: <CcAddr addr={REGISTRY_ADDRESS} />. Refutation is commit–reveal: a one-shot call
        would put the evidence in public calldata where any searcher could copy it and take the
        bounty first, which would mean nobody ever hunts.
      </p>
    </section>
  );
}
