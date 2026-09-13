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
const n = (x: number) => x.toLocaleString('en-US');

const EN = {
  title: 'The court.',
  lede: 'Ninety seconds, six beats, every one of them live against Creditcoin as this page loads. Nothing here is a recording. If you have thirty seconds, watch beats two and three.',
  b1n: '1 · the waste',
  b1h: 'The precompile already certified these. Everyone else throws them away.',
  b1a: (roots: number, from: number, to: number, gas: number, perRoot: number) =>
    `The most recent mirror() call carried ${n(roots)} Ethereum block roots — heights ${n(from)} to ${n(to)} — in one continuity proof that 0x0FD2 verified. Every other integration keeps one transaction from a proof like this and discards the rest. This one kept all of them, for ${n(gas)} gas (${n(perRoot)} per height).`,
  b1b: (fresh: string, day: string, half: string, widest: string) =>
    `Every Attestcoin query carries a continuity proof — measured at ${fresh} for a fresh block, ${day} at a day old, ${half} at 180 days, and ${widest} for a batch anchored at both ends of a window. The precompile binds every root in it. Everyone else keeps one.`,
  theTx: 'The transaction',
  held: (m: number, s: number) => `Held right now: ${n(m)} mainnet heights and ${n(s)} Sepolia heights.`,
  b2n: '2 + 3 · the second question, with the precompile deleted',
  b2h: 'A different transaction in a notarised block. No wallet. Then the same call with 0x0FD2 gone.',
  b2c: 'Row three is the control: the same state override turned on the archive instead. It must fail, and it does, which is how you know the precompile really was deleted in row two. This website is not the verifier. The mirror is.',
  b4n: '4 · a negative that is not an indexer',
  b4h: '“Never liquidated” cannot be proven. It can be bonded, hunted, and burned.',
  b4p: 'A claim that something did not happen — or that a list is complete — is staked, not proven. Anyone who finds the transaction the claimant did not account for takes half the bond; the other half burns, so a liar cannot refute themselves and walk away whole. The desk’s default treats silence as silence, never as innocence.',
  hunt: (id: number, bond: string, loss: string) => `Hunt claim #${id} — ${bond} tCTC, ${loss} unrecoverable`,
  emptySetOver: (blocks: string, chain: string) => `EmptySet over ${blocks} blocks of ${chain}`,
  checkComplete: (id: number) => `Check completeness claim #${id}`,
  completeCaption: '“these are all of them” — refuted by one omitted member',
  askDesk: 'Ask the desk about a liquidated borrower',
  b5n: '5 · the tax',
  b5h: 'Who pays for the same fact twice.',
  cost: 'cost',
  howWeKnow: 'how we know',
  r1: 'notarising a height here, once',
  r1how: 'measured — the transaction in beat 1',
  r2: 'every later question about that height',
  r2how: 'measured — beat 2 is a view call; no transaction exists to pay for',
  r3: 'asking about a 180-day-old block the ordinary way',
  r3how: 'measured — continuity returned by the live prover; paid again by every asker',
  r4: 'index41 proving one mainnet sandwich',
  measured: 'measured',
  theirReceipt: 'their receipt',
  sameOrdering: 'the same ordering is free on',
  onlyMeasured: 'Only numbers we measured are in this table. Figures we could not check at their source are not here.',
  b6n: '6 · enshrine',
  b6h: 'Option B is a native BlockRootCache.',
  b6p: 'The node already computes these roots and discards them. A runtime cache written as a side-effect of every successful query would make this contract unnecessary.',
  b6link: 'We would rather help you build it than be the reason it is not needed.',
  foot1: 'The ledger of what is and is not claimed is at',
  foot2: 'Nothing on this page is a score.',
};

const KO: typeof EN = {
  title: '법정.',
  lede: '90초, 여섯 장면. 모두 이 페이지가 열리는 순간 Creditcoin에 대해 실시간으로 실행됩니다. 녹화된 것은 없습니다. 30초밖에 없다면 두 번째와 세 번째 장면을 보십시오.',
  b1n: '1 · 낭비',
  b1h: '프리컴파일은 이미 이것들을 증명했습니다. 다른 모두는 버립니다.',
  b1a: (roots, from, to, gas, perRoot) =>
    `가장 최근의 mirror() 호출은 0x0FD2가 검증한 하나의 연속성 증명에 이더리움 블록 루트 ${n(roots)}개 — 높이 ${n(from)}부터 ${n(to)}까지 — 를 담고 있었습니다. 다른 모든 통합은 이런 증명에서 트랜잭션 하나만 남기고 나머지를 버립니다. 이 호출은 전부를 보관했고, ${n(gas)} 가스가 들었습니다(높이당 ${n(perRoot)}).`,
  b1b: (fresh, day, half, widest) =>
    `모든 Attestcoin 쿼리는 연속성 증명을 담고 있습니다 — 실측으로 최신 블록은 ${fresh}개, 하루 된 블록은 ${day}개, 180일 된 블록은 ${half}개, 창의 양끝에 고정된 배치는 ${widest}개. 프리컴파일은 그 안의 모든 루트를 묶습니다. 다른 모두는 하나만 남깁니다.`,
  theTx: '해당 트랜잭션',
  held: (m, s) => `지금 보관 중: 메인넷 높이 ${n(m)}개, 세폴리아 높이 ${n(s)}개.`,
  b2n: '2 + 3 · 두 번째 질문, 프리컴파일을 삭제한 채로',
  b2h: '공증된 블록의 다른 트랜잭션. 지갑 없이. 그다음 0x0FD2를 없앤 채 같은 호출.',
  b2c: '세 번째 줄은 대조군입니다: 같은 상태 오버라이드를 아카이브 쪽에 적용한 것. 반드시 실패해야 하고, 실제로 실패합니다. 그래서 두 번째 줄에서 프리컴파일이 정말로 삭제되었음을 알 수 있습니다. 이 웹사이트는 검증자가 아닙니다. 미러가 검증자입니다.',
  b4n: '4 · 인덱서가 아닌 부정 진술',
  b4h: '"청산된 적 없음"은 증명할 수 없습니다. 담보를 걸고, 사냥당하고, 소각될 수는 있습니다.',
  b4p: '어떤 일이 일어나지 않았다는 주장 — 또는 목록이 완전하다는 주장 — 은 증명이 아니라 담보입니다. 주장자가 설명하지 못한 트랜잭션을 찾는 사람은 담보의 절반을 가져가고, 나머지 절반은 소각되어 거짓말쟁이가 스스로 반박하고 온전히 빠져나갈 수 없습니다. 데스크의 기본값은 침묵을 침묵으로 취급하지, 결코 무죄로 취급하지 않습니다.',
  hunt: (id, bond, loss) => `주장 #${id} 사냥하기 — ${bond} tCTC, 회수 불가 ${loss}`,
  emptySetOver: (blocks, chain) => `${chain} 블록 ${blocks}개에 걸친 EmptySet`,
  checkComplete: (id) => `완전성 주장 #${id} 확인하기`,
  completeCaption: '"이것이 전부다" — 누락된 항목 하나로 반박됨',
  askDesk: '청산된 차입자에 대해 데스크에 묻기',
  b5n: '5 · 세금',
  b5h: '같은 사실에 두 번 지불하는 것은 누구인가.',
  cost: '비용',
  howWeKnow: '근거',
  r1: '여기서 높이 하나를 공증하기, 한 번',
  r1how: '실측 — 1번 장면의 트랜잭션',
  r2: '그 높이에 대한 이후의 모든 질문',
  r2how: '실측 — 2번 장면은 view 호출이며, 지불할 트랜잭션이 존재하지 않음',
  r3: '180일 된 블록에 대해 보통 방식으로 묻기',
  r3how: '실측 — 실제 프루버가 반환한 연속성; 묻는 사람마다 다시 지불',
  r4: 'index41이 메인넷 샌드위치 하나를 증명하기',
  measured: '실측',
  theirReceipt: '그들의 영수증',
  sameOrdering: '같은 순서 판정은 무료:',
  onlyMeasured: '이 표에는 우리가 실측한 숫자만 있습니다. 출처에서 확인할 수 없는 수치는 여기 없습니다.',
  b6n: '6 · 노드에 담기',
  b6h: '옵션 B는 네이티브 BlockRootCache입니다.',
  b6p: '노드는 이미 이 루트들을 계산하고 버립니다. 성공한 모든 쿼리의 부수 효과로 기록되는 런타임 캐시가 있다면 이 컨트랙트는 불필요해집니다.',
  b6link: '우리는 그것이 불필요해지는 이유가 되기보다 그것을 함께 만들고 싶습니다.',
  foot1: '주장하는 것과 주장하지 않는 것의 장부는',
  foot2: '이 페이지의 어떤 것도 점수가 아닙니다.',
};

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
        // Walk back in widening windows and stop at the first call that added heights: decoding every
        // event since deployment on the page's thread cost seconds of blocking for one row.
        let last: any;
        for (const [a, b] of [[300, 0], [1_500, 301], [6_000, 1_501], [30_000, 6_001]]) {
          const from = Math.max(chain.DEPLOY_BLOCK, head - a);
          const to = head - b;
          if (to < from) break;
          const logs = await m.queryFilter(m.filters.BlocksMirrored(chain.CHAIN_KEY_ETH_MAINNET), from, to);
          last = logs.filter((l: any) => Number(l.args.newlyAdded) > 0).pop();
          if (last) break;
        }
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

  // Korean behind a toggle. Machine-assisted and unreviewed, and the page says so: the numbers are the
  // same numbers, and the verification underneath is the same verification.
  const [lang, setLang] = useState<'en' | 'ko'>(() => (new URLSearchParams(window.location.search).get('lang') === 'ko' ? 'ko' : 'en'));
  const T = lang === 'en' ? EN : KO;
  return (
    <Page active="judge">
      <div className="court">
        <header className="court-head">
          <h1>{T.title}</h1>
          <p className="t-caption">
            <button type="button" className={`linkish${lang === 'en' ? ' is-active' : ''}`} onClick={() => setLang('en')}>English</button> ·{' '}
            <button type="button" className={`linkish${lang === 'ko' ? ' is-active' : ''}`} onClick={() => setLang('ko')}>한국어</button>
            {lang === 'ko' && <> — 기계 번역 보조, 원어민 검토 없음. 숫자와 검증은 동일합니다.</>}
          </p>
          <p className="lede">{T.lede}</p>
        </header>

        <section className="beat">
          <p className="beat-n t-hash">{T.b1n}</p>
          <h2>{T.b1h}</h2>
          {waste ? (
            <p>
              {T.b1a(waste.roots, waste.from, waste.to, waste.gas, perRoot ?? 0)}{' '}
              <a href={`${EXPLORER}/tx/${waste.tx}`} target="_blank" rel="noreferrer">{T.theTx} ↗</a>
            </p>
          ) : (
            <p>{T.b1b(rootsAt(50), rootsAt(7_200), rootsAt(1_296_000), WIDEST_CALL_ROOTS?.toLocaleString() ?? 'hundreds')}</p>
          )}
          {archive && (
            <p className="t-caption">{T.held(archive.mainnet, archive.sepolia)}</p>
          )}
        </section>

        <section className="beat beat--key">
          <p className="beat-n t-hash">{T.b2n}</p>
          <h2>{T.b2h}</h2>
          <IndependenceModule state={indep} compact />
          <p className="t-caption">{T.b2c}</p>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">{T.b4n}</p>
          <h2>{T.b4h}</h2>
          <p>{T.b4p}</p>
          <ul className="beat-links">
            {lie && (
              <li>
                <a className="cta" href={`/watch/?claim=${lie.id}`}>
                  {T.hunt(lie.id, tctc(lie.bond), tctc(lie.loss))}
                </a>{' '}
                <span className="t-caption">{T.emptySetOver((lie.to - lie.from + 1).toLocaleString(), lie.chainKey === 1 ? 'Sepolia' : 'mainnet')}</span>
              </li>
            )}
            {complete && (
              <li>
                <a className="cta cta--quiet" href={`/watch/?claim=${complete.id}`}>
                  {T.checkComplete(complete.id)}
                </a>{' '}
                <span className="t-caption">{T.completeCaption}</span>
              </li>
            )}
            <li>
              <a className="cta cta--quiet" href="/mandate/">{T.askDesk}</a>
            </li>
          </ul>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">{T.b5n}</p>
          <h2>{T.b5h}</h2>
          <table className="tax">
            <thead>
              <tr><th /><th>{T.cost}</th><th>{T.howWeKnow}</th></tr>
            </thead>
            <tbody>
              {waste && perRoot && (
                <tr>
                  <td>{T.r1}</td>
                  <td className="t-hash">{perRoot.toLocaleString()} gas</td>
                  <td className="t-caption">{T.r1how}</td>
                </tr>
              )}
              <tr>
                <td>{T.r2}</td>
                <td className="t-hash">0 gas</td>
                <td className="t-caption">{T.r2how}</td>
              </tr>
              <tr>
                <td>{T.r3}</td>
                <td className="t-hash">{rootsAt(1_296_000)}</td>
                <td className="t-caption">{T.r3how}</td>
              </tr>
              <tr>
                <td>{T.r4}</td>
                <td className="t-hash">1,092,100 gas</td>
                <td className="t-caption">
                  {T.measured} — <a href={`${EXPLORER}/tx/0xd136dea0524b7e0e9eba54bf9724eec78597c2598047a96849af727f4d243810`} target="_blank" rel="noreferrer">{T.theirReceipt}</a>;{' '}
                  {T.sameOrdering} <a className="linkish" href="/order/">/order</a>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="t-caption">{T.onlyMeasured}</p>
        </section>

        <section className="beat">
          <p className="beat-n t-hash">{T.b6n}</p>
          <h2>{T.b6h}</h2>
          <p>
            {T.b6p} <a className="linkish" href="/enshrine/">{T.b6link}</a>
          </p>
        </section>

        <p className="t-caption court-foot">
          {T.foot1} <a className="linkish" href="/claims/">/claims</a>. {T.foot2}
        </p>
      </div>
    </Page>
  );
}
