import { useEffect, useState } from 'react';
import { MandatePage } from './MandatePage';
import { Trunc } from '../shared/Trunc';
import { house } from '../../../deployments.json';
import board from '../../../contracts/test/fixtures/board-v3-mainnet.json';

/**
 * Cover: insurance on a claim while the hunt is still running, settled by the hunt.
 *
 * An underwriter locks a payout and names a premium. A buyer pays the premium. If the claim is refuted
 * before its window closes, the buyer collects the payout; if it stands, the underwriter takes the
 * payout back and keeps the premium. No oracle: the registry's status is the only input, and anyone
 * may call settle.
 *
 * There is no cover on a standing claim, and the page says why: the registry will not take a
 * refutation against one, so there would be nothing left to insure.
 */

type Offer = { id: number; claimId: number; underwriter: string; buyer: string; payout: bigint; premium: bigint; state: number; claimStatus: number; openUntil: number; subject: string };
type Wallet = { kind: 'none' } | { kind: 'absent' } | { kind: 'wrong-network' } | { kind: 'ready'; address: string; provider: any };

const STATE = ['none', 'on offer', 'live', 'closed'];
const STATUS = ['none', 'open', 'refuted', 'standing'];
const HOUSE = new Set(Object.values(house).filter((v) => typeof v === 'string' && v.startsWith('0x')).map((v) => (v as string).toLowerCase()));
const documented = new Map<number, string>((board as any).claims.map((c: any) => [c.claimId, c.role]));
const tctc = (w: bigint) => (Number(w) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 3 });

export function CoverPage() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Wallet>({ kind: 'none' });
  const [owed, setOwed] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  async function load() {
    try {
      const { coverContract, registryContract } = await import('../lib/chain');
      const cover = coverContract();
      const reg = registryContract();
      const n = Number(await cover.offerCount());
      const rows = await Promise.all(Array.from({ length: n }, (_, i) => cover.offerOf(i)));
      const out: Offer[] = await Promise.all(
        rows.map(async (o: any, id: number) => {
          const c: any = await reg.claimOf(o.claimId);
          return { id, claimId: Number(o.claimId), underwriter: o.underwriter, buyer: o.buyer, payout: BigInt(o.payout), premium: BigInt(o.premium), state: Number(o.state), claimStatus: Number(c.status), openUntil: Number(c.openUntil), subject: '0x' + String(c.subject).slice(26) };
        }),
      );
      setOffers(out);
      setNow(Math.floor(Date.now() / 1000));
      if (wallet.kind === 'ready') setOwed(BigInt(await cover.owed(wallet.address)));
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.kind === 'ready' ? wallet.address : '']);

  async function connect() {
    const { connectWallet } = await import('../lib/chain');
    const w = await connectWallet();
    if (w.kind === 'ready') setWallet({ kind: 'ready', address: w.address, provider: w.provider });
    else setWallet(w.kind === 'absent' ? { kind: 'absent' } : { kind: 'wrong-network' });
  }

  async function act(label: string, f: (cover: any) => Promise<any>) {
    if (wallet.kind !== 'ready') return;
    setBusy(label);
    try {
      const { coverContract } = await import('../lib/chain');
      const signer = await wallet.provider.getSigner();
      const tx = await f(coverContract(signer));
      await tx.wait();
      await load();
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  const live = offers?.filter((o) => o.state === 1 || o.state === 2) ?? [];
  const closed = offers?.filter((o) => o.state === 3) ?? [];

  return (
    <MandatePage active="cover" subtitle="insurance on a claim, settled by the hunt">
      <section className="pane">
        <h1 className="t-title pane-title">Cover.</h1>
        <p className="t-body pane-lead">
          A claim is open for a window during which anyone may refute it. Somebody who means to rely on it once it
          stands carries the risk that it is refuted first; cover sells that risk. An underwriter locks a payout and
          names a premium; a buyer pays the premium; the claim's own outcome decides who gets the payout. No oracle —
          the hunt is the oracle — and no cover on a claim that has already settled, because a standing claim cannot be
          refuted and there would be nothing left to insure.
        </p>

        <p className="t-caption">
          {wallet.kind === 'ready' ? (
            <>
              Connected as <Trunc v={wallet.address} />. {owed > 0n && <>You are owed {tctc(owed)} tCTC — <button type="button" className="linkish" disabled={busy !== null} onClick={() => act('withdraw', (c) => c.withdraw())}>withdraw</button>.</>}
            </>
          ) : wallet.kind === 'absent' ? (
            'No wallet found. Reading is free; buying, writing and settling need one.'
          ) : wallet.kind === 'wrong-network' ? (
            'Your wallet is on another network; switch to Creditcoin Testnet (102031).'
          ) : (
            <button type="button" className="linkish" onClick={() => void connect()}>Connect a wallet</button>
          )}{' '}
          {busy && <em>· {busy}…</em>}
        </p>
        {err && <p className="t-body">{err}</p>}

        {offers === null && !err && <p className="t-caption">reading the offers…</p>}

        {offers !== null && (
          <>
            <h2 className="t-ui">On offer, and live</h2>
            <table className="tax">
              <thead>
                <tr><th>offer</th><th>on claim</th><th>about</th><th>pays</th><th>premium</th><th>underwriter</th><th>state</th><th>the claim</th><th></th></tr>
              </thead>
              <tbody>
                {live.map((o) => {
                  const canBuy = o.state === 1 && o.claimStatus === 1 && o.openUntil > now;
                  const canSettle = o.state === 2 && (o.claimStatus === 2 || o.claimStatus === 3);
                  const isHouse = HOUSE.has(o.underwriter.toLowerCase());
                  const doc = documented.get(o.claimId);
                  return (
                    <tr key={o.id}>
                      <td className="t-hash">#{o.id}</td>
                      <td><a className="linkish" href={`/watch/?claim=${o.claimId}`}>#{o.claimId}</a></td>
                      <td className="t-hash"><Trunc v={o.subject} /></td>
                      <td>{tctc(o.payout)} tCTC</td>
                      <td>{tctc(o.premium)} tCTC</td>
                      <td className="t-caption">{isHouse ? 'the house' : <Trunc v={o.underwriter} />}</td>
                      <td className="t-caption">{STATE[o.state]}{o.state === 2 ? <> · buyer <Trunc v={o.buyer} /></> : ''}</td>
                      <td className="t-caption">
                        {STATUS[o.claimStatus]}{o.claimStatus === 1 ? `, ${Math.max(0, Math.floor((o.openUntil - now) / 3600))} h left` : ''}
                        {doc && ['lie', 'bounty', 'omission'].includes(doc) && <><br />documented false in the repository</>}
                      </td>
                      <td>
                        {canBuy && wallet.kind === 'ready' && <button type="button" className="act" disabled={busy !== null} onClick={() => act(`buying #${o.id}`, (c) => c.buy(o.id, { value: o.premium }))}>buy</button>}
                        {canSettle && wallet.kind === 'ready' && <button type="button" className="act" disabled={busy !== null} onClick={() => act(`settling #${o.id}`, (c) => c.settle(o.id))}>settle</button>}
                        {o.state === 2 && o.claimStatus === 1 && <span className="t-caption">waiting on the hunt</span>}
                      </td>
                    </tr>
                  );
                })}
                {live.length === 0 && <tr><td colSpan={9} className="t-caption">No offers. Anyone may write one on any open claim.</td></tr>}
              </tbody>
            </table>
            <p className="t-caption">
              Offers marked "the house" are written by this project on bounties the repository documents as false, so
              whoever buys one is paid when the hunt settles the claim. That is not a bet the house expects to win: it
              is the settlement path, run in public with real money, once per open claim.
            </p>

            {closed.length > 0 && (
              <>
                <h2 className="t-ui">Settled</h2>
                <table className="tax">
                  <thead><tr><th>offer</th><th>on claim</th><th>pays</th><th>outcome</th></tr></thead>
                  <tbody>
                    {closed.map((o) => (
                      <tr key={o.id}>
                        <td className="t-hash">#{o.id}</td>
                        <td><a className="linkish" href={`/watch/?claim=${o.claimId}`}>#{o.claimId}</a></td>
                        <td>{tctc(o.payout)} tCTC</td>
                        <td className="t-caption">{o.buyer === '0x0000000000000000000000000000000000000000' ? 'withdrawn unbought' : o.claimStatus === 2 ? `claim refuted — paid to the buyer` : `claim stood — returned to the underwriter`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>
    </MandatePage>
  );
}
