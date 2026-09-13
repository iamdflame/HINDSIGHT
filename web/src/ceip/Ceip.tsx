import { useState } from 'react';
import { Page } from '../shell/Page';
import facts from '../lib/record.generated.json';

/**
 * The five pillars, answered with numbers that come from the measured record and nothing else.
 *
 * Two languages, one toggle. The Korean is machine-assisted and has not been reviewed by a native
 * speaker; the page says so at the top of the Korean column, because a translation presented as
 * localisation quality would be a claim the repository cannot back.
 */
const s = (facts as any).summary as {
  held: number; topRun: number; topRunDays: number; sepoliaHeld: number; claims: number; refuted: number; open: number; standing: number;
  burnedWei: string; policies: number; forgeTests: number; fuzzTests: number; differentialChecks: number; differentialDivergences: number; attestors: number; deskCapWei: string;
};
const n = (x: number) => x.toLocaleString('en-US');
const tctc = (w: string) => (Number(BigInt(w)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 1 });

type Pillar = { title: string; en: string[]; ko: string[]; links: { label: string; href: string }[] };

const PILLARS: Pillar[] = [
  {
    title: '1 · User-base expansion',
    en: [
      `The hunt is a job, not a page: every open bounty is listed with what it pays, the measured gas to refute it, and the expected value. The board promises at least four documented lies open at all times, a replenisher keeps it so, and a public gate goes red if it slips. ${n(s.refuted)} refutations so far, ${tctc(s.burnedWei)} tCTC burned.`,
      'A Telegram bot and Mini App answer /assess, /hunt and /bounty from the same contracts; an MCP server gives agents the same seven tools. None of them can spend.',
      'The first loop is not "connect wallet, mint score". It is "find the transaction that contradicts a statement somebody staked money on, and be paid half the stake".',
      'What has not happened: no stranger has refuted a claim, bound an address, or borrowed. The leaderboard says "the house" next to every name on it, and the site says "no vetted stranger" wherever a stranger would matter.',
    ],
    ko: [
      `헌트는 문서가 아니라 일거리입니다. 열려 있는 모든 바운티에 지급액, 반박에 드는 실측 가스, 기대값이 표시됩니다. 보드는 문서화된 거짓 주장을 항상 네 건 이상 열어 두기로 약속하고, 보충기가 이를 유지하며, 어기면 공개 게이트가 빨간색이 됩니다. 지금까지 반박 ${n(s.refuted)}건, 소각 ${tctc(s.burnedWei)} tCTC.`,
      '텔레그램 봇과 미니앱이 같은 컨트랙트에서 /assess, /hunt, /bounty에 답하고, MCP 서버가 에이전트에게 같은 일곱 가지 도구를 제공합니다. 어느 것도 자금을 쓸 수 없습니다.',
      '첫 번째 루프는 "지갑 연결, 점수 발행"이 아닙니다. "누군가 돈을 건 진술을 반박하는 트랜잭션을 찾아, 판돈의 절반을 받는 것"입니다.',
      '아직 일어나지 않은 것: 외부인이 주장을 반박하거나, 주소를 바인딩하거나, 대출을 받은 적이 없습니다. 리더보드의 모든 이름 옆에는 "the house"라고 적혀 있고, 사이트는 외부인이 중요한 모든 곳에서 "검증된 외부인 없음"이라고 말합니다.',
    ],
    links: [{ label: '/hunt', href: '/hunt/' }, { label: 'hindsight-mcp', href: 'https://github.com/iamdflame/HINDSIGHT/tree/master/packages/mcp' }],
  },
  {
    title: '2 · Technical alignment',
    en: [
      `Continuity retained: ${n(s.held)} mainnet heights held, the top ${n(s.topRun)} unbroken (${s.topRunDays.toFixed(1)} days), plus ${n(s.sepoliaHeld)} on Sepolia. Every root came through 0x0FD2; the hole below the run is being repaired with the hosted prover switched off, from 0x0FD3 checkpoints and public receipts.`,
      `Independence: a second transaction in a held block verifies with the precompile deleted for the call, and the controls fail. Differential: ${n(s.differentialChecks)} checks against the live precompile including forgeries, ${s.differentialDivergences} divergences.`,
      `0x0FD4 caps the desk: total lending may not exceed what the ${s.attestors} attestors behind chainKey 3 have bonded (${tctc(s.deskCapWei)} tCTC), read live on every decision. Receipt status is checked before any log is trusted. No state proofs are claimed; no absence is called a proof.`,
      'Sealed spans replace a 648,000-height walk: the ninety-day check is 43,325 gas cold in Foundry and 407,960 on Creditcoin, against 7,041,373 for the superseded desk, both mined. ENSHRINE carries the BlockRootCache RIP with an ABI delta of one event.',
    ],
    ko: [
      `연속성 보존: 메인넷 높이 ${n(s.held)}개 보관, 상단 ${n(s.topRun)}개 무결(${s.topRunDays.toFixed(1)}일), 세폴리아 ${n(s.sepoliaHeld)}개. 모든 루트는 0x0FD2를 거쳤고, 구간 아래의 구멍은 호스팅 프루버 없이 0x0FD3 체크포인트와 공개 영수증으로 수리되고 있습니다.`,
      `독립성: 보관된 블록의 두 번째 트랜잭션은 호출 중 프리컴파일을 삭제해도 검증되며, 대조군은 실패합니다. 차분 검사: 위조를 포함해 실제 프리컴파일과 ${n(s.differentialChecks)}건 비교, 불일치 ${s.differentialDivergences}건.`,
      `0x0FD4가 데스크를 제한합니다: 총 대출은 chainKey 3의 증명자 ${s.attestors}명이 예치한 금액(${tctc(s.deskCapWei)} tCTC)을 넘을 수 없으며, 모든 결정마다 실시간으로 읽습니다. 로그를 신뢰하기 전에 영수증 상태를 확인합니다. 상태 증명을 주장하지 않으며, 부재를 증명이라 부르지 않습니다.`,
      '봉인된 스팬이 648,000 높이 순회를 대체합니다: 90일 검사는 Foundry에서 콜드 43,325 가스, Creditcoin에서 407,960 가스이며, 대체된 데스크는 같은 질문에 7,041,373 가스를 썼습니다(둘 다 채굴됨). ENSHRINE에는 이벤트 하나의 ABI 변경만 있는 BlockRootCache RIP가 있습니다.',
    ],
    links: [{ label: '/independence', href: '/independence/' }, { label: '/status', href: '/status/' }, { label: 'ENSHRINE', href: '/enshrine/' }],
  },
  {
    title: '3 · Product vision',
    en: [
      'Memory, then files, then refusal, then cover: the archive holds roots; the registry holds bonded statements about them; the desk refuses on both; cover prices the risk that a statement is broken before it stands. Each layer reads only the one below it and none has an owner.',
      'Next, in their order, not ours: writability when it is released (freeze title when a loan is live), Bitcoin when a key exists for it. Nothing here pre-empts the protocol roadmap; the RIP asks the node to keep what it already proves.',
      'Not on the roadmap, at any price: a gold NFT, an AI underwriter, a 300–850 number, a ROSCA clone, a pause key. Nothing is minted, nothing is transferable, and there is no number.',
    ],
    ko: [
      '기억, 그다음 파일, 그다음 거절, 그다음 커버: 아카이브는 루트를 보관하고, 레지스트리는 그에 대한 담보 진술을 보관하며, 데스크는 둘 다에 근거해 거절하고, 커버는 진술이 확정되기 전에 깨질 위험을 가격에 반영합니다. 각 층은 바로 아래 층만 읽고, 어느 층에도 소유자가 없습니다.',
      '다음은 우리 순서가 아니라 그들의 순서로: 쓰기 기능이 출시되면(대출 진행 중 소유권 동결), 키가 생기면 비트코인. 여기 있는 어떤 것도 프로토콜 로드맵을 앞지르지 않습니다. RIP는 노드가 이미 증명한 것을 보관해 달라고 요청합니다.',
      '어떤 가격에도 로드맵에 없는 것: 골드 NFT, AI 심사관, 300–850 점수, ROSCA 복제, 일시정지 키. 아무것도 발행되지 않고, 아무것도 양도되지 않으며, 숫자는 없습니다.',
    ],
    links: [{ label: '/files', href: '/files/' }, { label: '/cover', href: '/cover/' }],
  },
  {
    title: '4 · Team and execution',
    en: [
      `Execution is the artefact. ${n(s.forgeTests)} Foundry tests, ${s.fuzzTests} of them fuzzed; every deployment superseded is kept with its reason; CLAIMS.md grades every statement by its evidence and is generated from chain; twenty-two public gates re-run the repository's promises against live state on a cron and on every visit to /status, answering 503 when one fails.`,
      'What is measured is stated with its receipt; what is not measured is not stated. Where the plan and the frozen contracts disagreed — cover on a standing claim — the contracts won and the document says so.',
    ],
    ko: [
      `실행이 곧 결과물입니다. Foundry 테스트 ${n(s.forgeTests)}건, 그중 퍼징 ${s.fuzzTests}건. 대체된 모든 배포는 사유와 함께 보존됩니다. CLAIMS.md는 모든 진술을 증거로 등급화하며 체인에서 생성됩니다. 스물두 개의 공개 게이트가 크론과 /status 방문 시마다 저장소의 약속을 실시간 상태에 대해 재실행하고, 하나라도 실패하면 503으로 답합니다.`,
      '측정된 것은 영수증과 함께 진술하고, 측정되지 않은 것은 진술하지 않습니다. 계획과 동결된 컨트랙트가 충돌한 곳(확정된 주장에 대한 커버)에서는 컨트랙트가 이겼고, 문서가 그렇게 말합니다.',
    ],
    links: [{ label: 'CLAIMS', href: '/claims/' }, { label: '/status', href: '/status/' }],
  },
  {
    title: '5 · Market fit',
    en: [
      `${s.policies} instruments on real venues: Aave V3, Morpho Blue, Compound V3, Spark, and Circle USDC's own Blacklisted event — "never blacklisted" is the negative a counterparty actually wants. A Chainlink completeness claim sits on the registry. Every event signature was verified against live logs before it was filed.`,
      'The question an originator cannot ask its own ledger: was this borrower liquidated on Aave in the last ninety days, with no indexer? Mandate is that question, and the answer names the transaction.',
      'Emerging-markets fit without a fake vault: the desk pays a Creditcoin key that has signed for its Ethereum address, so a real liquidated borrower can be a real applicant. Nobody has yet. The hire-purchase corridor is not built, and this page does not pretend it is.',
    ],
    ko: [
      `실제 거래소의 상품 ${s.policies}개: Aave V3, Morpho Blue, Compound V3, Spark, 그리고 Circle USDC 자체의 Blacklisted 이벤트 — "블랙리스트에 오른 적 없음"은 거래 상대방이 실제로 원하는 부정 진술입니다. 체인링크 완전성 주장이 레지스트리에 있습니다. 모든 이벤트 시그니처는 등록 전에 실시간 로그로 검증되었습니다.`,
      '대출 원천사가 자신의 장부에 물을 수 없는 질문: 이 차입자가 지난 90일 동안 인덱서 없이 Aave에서 청산되었는가? Mandate가 그 질문이며, 답은 트랜잭션을 지목합니다.',
      '가짜 금고 없는 신흥시장 적합성: 데스크는 자신의 이더리움 주소에 서명한 Creditcoin 키에 지급하므로, 실제로 청산된 차입자가 실제 신청자가 될 수 있습니다. 아직 아무도 하지 않았습니다. 할부 구매 회랑은 구축되지 않았고, 이 페이지는 그런 척하지 않습니다.',
    ],
    links: [{ label: '/aella', href: '/aella/' }, { label: '/files', href: '/files/' }],
  },
];

const ASK = {
  en: 'A ticket toward: archive capital from 180 days to a year (the deep backfill runs with the prover switched off and costs time and gas, both measured); a CertiK review of L0 and L1; Telegram distribution; one hire-purchase corridor with a real counterparty; and a bounty for the first integrator this project does not operate. Milestoned, and every milestone a gate on /status.',
  ko: '요청: 아카이브 자본을 180일에서 1년으로(심층 백필은 프루버 없이 실행되며 시간과 가스가 들고, 둘 다 측정됨); L0와 L1에 대한 CertiK 검토; 텔레그램 배포; 실제 상대방이 있는 할부 구매 회랑 하나; 이 프로젝트가 운영하지 않는 첫 통합자에게 주는 바운티. 마일스톤별로, 모든 마일스톤은 /status의 게이트입니다.',
};

export function Ceip() {
  const [lang, setLang] = useState<'en' | 'ko'>('en');
  return (
    <Page active="ceip">
      <section className="pane">
        <h1 className="t-title pane-title">{lang === 'en' ? 'Five pillars, filled in.' : '다섯 가지 기둥, 채워 넣기.'}</h1>
        <p className="t-caption">
          <button type="button" className={`linkish${lang === 'en' ? ' is-active' : ''}`} onClick={() => setLang('en')}>English</button> ·{' '}
          <button type="button" className={`linkish${lang === 'ko' ? ' is-active' : ''}`} onClick={() => setLang('ko')}>한국어</button>
          {lang === 'ko' && <> — 기계 번역 보조, 원어민 검토 없음. 숫자는 측정 기록에서 옵니다.</>}
          {lang === 'en' && <> — every figure is from the measured record; the Korean is machine-assisted and unreviewed.</>}
        </p>
        <p className="t-body pane-lead">
          {lang === 'en'
            ? 'Answers to the five questions the ecosystem programme asks, with the numbers the repository can back and the things it cannot yet claim said in the same breath.'
            : '생태계 프로그램이 묻는 다섯 가지 질문에 대한 답. 저장소가 뒷받침할 수 있는 숫자와, 아직 주장할 수 없는 것을 같은 호흡으로 말합니다.'}
        </p>
        {PILLARS.map((p) => (
          <article key={p.title} className="beat">
            <h2>{p.title}</h2>
            {(lang === 'en' ? p.en : p.ko).map((para, i) => (
              <p key={i} className="t-body">{para}</p>
            ))}
            <p className="t-caption">
              {p.links.map((l, i) => (
                <span key={l.href}>{i > 0 && ' · '}<a className="linkish" href={l.href}>{l.label}</a></span>
              ))}
            </p>
          </article>
        ))}
        <article className="beat beat--key">
          <h2>{lang === 'en' ? 'The ask' : '요청'}</h2>
          <p className="t-body">{ASK[lang]}</p>
        </article>
      </section>
    </Page>
  );
}
