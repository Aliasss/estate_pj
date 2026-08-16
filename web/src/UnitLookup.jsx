import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { latestRate, useRates, ym as ymKor, useSubway } from './units.js'
import { fdTrack } from './fakedoor.js'

export const pct0 = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const signed = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
export const eok = (m) => (m == null ? '-' : m >= 10000 ? `${(m / 10000).toFixed(2)}억` : `${m.toLocaleString()}만`)

export const STAGE = {
  A: { label: '이 건물 실거래 기준', exact: true },
  B: { label: '인근 유사 물건 기준', exact: false },
  'B-': { label: '인근 물건 기준 (연식 미보정)', exact: false },
  C: { label: '비교 대상 없음', exact: false },
}

/**
 * 위험 신호는 두 축으로 읽는다.
 *  - 검증 가능성: 이 건물 매매 사례가 있느냐. 없으면 담보 가치를 확인할 방법이 없다.
 *  - 전세가율 수준: 있느냐 없느냐를 통과했을 때만 의미가 있다.
 * 연립다세대에서는 첫째 축이 사실상 위험 그 자체라 화면 맨 위에 온다.
 */
function verdict(u) {
  const villa = u.ht === 'R'
  const year = u.apr ?? u.build_year
  const young = year >= 2018
  // 비교 기준이 깨진 값(≥150%)은 위험 판정에 쓰지 않는다. 아래에서 따로 "판단 보류"로 나간다.
  const r = ratioBroken(u.ratio) ? null : u.ratio
  const solid = u.stage === 'A' && u.n_sale_24m >= 3

  // 실거래로 확인된 깡통. 증거가 가장 두꺼운 위험이라 다른 무엇보다 먼저 온다.
  // 여기서 초록을 켜면 이 앱이 존재하는 이유와 정확히 반대의 일을 하는 것이다.
  if (solid && r >= 1.0) {
    return { tone: 'critical',
      head: `보증금이 이 건물 매매가보다 ${Math.round((r - 1) * 100)}% 높습니다`,
      body: `최근 2년 이 건물 매매 ${u.n_sale_24m}건으로 확인된 값입니다. 추정이 아닙니다. `
        + '집이 경매로 넘어가면 낙찰가는 보통 시세보다 낮게 잡히므로, 이 상태로는 '
        + '보증금 전액을 돌려받기 어렵습니다.' }
  }
  if (solid && r >= 0.9) {
    return { tone: 'serious',
      head: `보증금이 이 건물 매매가의 ${pct0(r)}입니다`,
      body: `최근 2년 매매 ${u.n_sale_24m}건으로 확인된 값입니다. 집값이 조금만 내려도 `
        + '보증금이 매매가를 넘어섭니다. 여유가 거의 없는 계약입니다.' }
  }

  // 신축인데 매매가 한 건도 없고 전세만 여럿. 빌라 65,670개 중 687개(1.0%)뿐이고,
  // 전세사기 물건에서 반복적으로 나온 모양이다. 71%짜리 기준선과 섞으면 안 된다.
  if (villa && !u.n_sale_24m && young && u.n_jeonse_24m >= 5) {
    return { tone: 'critical', head: '신축인데 매매가 없고 전세만 여럿입니다',
      body: `${year}년 준공, 최근 2년 전세 ${u.n_jeonse_24m}건, 매매 0건. `
        + '빌라 중 1%만 이 모양입니다. 시세를 확인할 길이 없는 상태에서 보증금만 '
        + '들어오는 구조라, 전세사기 물건에서 반복적으로 나타난 패턴입니다.' }
  }

  if (!u.n_sale_24m) {
    // 추정치라도 100%를 넘으면 회색으로 둘 수 없다. B단계 오차는 열에 여덟이 10%p 안쪽이다.
    if (r >= 1.0) {
      return { tone: 'serious', head: `추정 전세가율이 ${pct0(r)}입니다`,
        body: '이 건물 매매가 없어 인근 비슷한 물건으로 잡은 추정치입니다만, 추정 오차를 '
          + '감안해도 보증금이 집값에 육박하거나 넘는 구간입니다. 등기부와 보증보험 가입 '
          + '가능 여부를 확인하기 전에는 계약하지 마세요.' }
    }
    // 빌라에서 매매 0건은 열에 일곱이다. 여기에 빨간불을 켜면 정보가 아니라 벽지가 된다.
    return villa
      ? { tone: 'muted', head: '이 건물 최근 2년 매매 0건',
          body: '빌라에서는 흔한 일입니다. 열에 일곱이 그렇습니다. 이 집이 위험하다는 '
            + '뜻이 아니라, 담보 가치를 실거래로 확인해 드릴 수 없다는 뜻입니다. '
            + '아래 확인 항목을 직접 보셔야 합니다.' }
      : { tone: 'serious', head: '이 건물 최근 2년 매매 0건',
          body: '아파트에서는 열에 셋뿐인 경우입니다. '
            + (u.n_sale_all ? `2021년 이후로는 ${u.n_sale_all}건 있었습니다.`
                            : '5년 내내 매매 신고가 없습니다.') }
  }

  if (u.n_sale_24m < 3) {
    // 한두 건 기준으로도 100%를 넘으면 그 사실을 먼저 말한다. 다만 그 한 건 자체가
    // 지분·특수 거래일 수 있으므로 "확인된 깡통"과는 구분한다.
    if (r >= 1.0) {
      return { tone: 'serious', head: `보증금이 매매가를 넘습니다 (매매 ${u.n_sale_24m}건 기준)`,
        body: '매매 표본이 한두 건뿐이라 그 거래가 지분 거래나 특수관계인 거래였다면 '
          + '값이 통째로 흔들립니다. 다만 액면 그대로면 보증금이 집값을 넘는 상태입니다.' }
    }
    return { tone: 'serious', head: `이 건물 최근 2년 매매 ${u.n_sale_24m}건`,
      body: '표본이 얇아 아래 전세가율은 그 한두 건에 좌우됩니다. '
        + '그 거래가 지분 거래나 특수관계인 거래였다면 값이 통째로 흔들립니다.' }
  }

  // 매매는 있는데 비율이 인근 기준으로 잡힌 드문 조합. 100%를 넘으면 초록일 수 없다.
  if (r >= 1.0) {
    return { tone: 'serious', head: `추정 전세가율이 ${pct0(r)}입니다`,
      body: '보증금이 집값에 육박하거나 넘는 구간입니다. 등기부와 보증보험 가입 가능 '
        + '여부를 확인하기 전에는 계약하지 마세요.' }
  }

  return { tone: 'good', head: `이 건물 최근 2년 매매 ${u.n_sale_24m}건`,
    body: (villa ? '빌라 중 3%만 여기 해당합니다. 실거래로 가격을 확인할 수 있는 드문 경우입니다.'
                 : '실거래로 가격을 확인할 수 있는 물건입니다.')
      + (r != null ? ` 전세가율 ${pct0(r)}${r >= 0.8 ? ', 여유가 넉넉하지는 않습니다.' : '.'}` : '') }
}

/**
 * 기본 정렬 점수. 확신도와 위험 수준을 함께 본다.
 * 전세가율만으로 줄을 세우면 B단계 추정치(비교군이 어긋나면 200%도 나온다)가 위를 차지하고,
 * 정작 실거래로 확인된 깡통이 아래로 밀린다. 그래서 근거 단계를 먼저 본다.
 */
function riskScore(u) {
  const r = u.ratio
  const solid = u.stage === 'A' && u.n_sale_24m >= 3   // 그 건물 매매 3건 이상
  const thin = u.stage === 'A' && u.n_sale_24m < 3     // 한두 건에 좌우되는 값
  if (solid && r >= 1.0) return 700 + r        // 실거래로 확인된 깡통
  if (solid && r >= 0.9) return 600 + r
  if (thin && r >= 1.0) return 500 + r         // 단일 거래 기준. 그 한 건이 이상할 수 있다
  if (r != null && r >= 1.0) return 400 + r    // 인근 기준 추정
  if (!u.n_sale_24m) return 300 + Math.min(u.n_jeonse_24m ?? 0, 30) / 100   // 검증 불가
  if (r != null && r >= 0.8) return 200 + r
  return r ?? 0
}

/**
 * 이 값을 넘으면 전세가율이 아니라 비교 기준이 깨진 것으로 본다.
 * 실측: 매매 3건 이상인 물건 10,418개의 최대가 209%였다. 763%짜리는 보증금 2.9억에
 * 매매 1건이 붙은 경우였는데, 그 한 건은 지분 거래나 특수 거래일 가능성이 크다.
 * 이런 값을 퍼센트로 내보이면 정확히 잰 숫자처럼 읽힌다. 그게 제일 나쁘다.
 */
export const RATIO_BROKEN = 1.5
export const ratioBroken = (r) => r != null && r >= RATIO_BROKEN

export function ratioTone(ratio) {
  if (ratio == null) return 'muted'
  if (ratio >= 1) return 'critical'
  if (ratio >= 0.9) return 'serious'
  if (ratio >= 0.8) return 'warning'
  return 'good'
}

/**
 * 층간소음은 실측 데이터가 공개된 게 없다. 건축물대장에서 끌어낼 수 있는 근거는 둘뿐이다.
 * 구조로 가르려 했지만 공동주택 3,325동 중 90.2%가 철근콘크리트라 변별이 안 된다.
 * 점수를 매기지 않고 무엇을 보고 하는 말인지를 그대로 낸다.
 */
function quietNote(u) {
  if (u.strct === 'BR') return { tone: 'serious', text: '벽돌조입니다. 차음에 가장 불리한 구조입니다' }
  if (!u.apr) return null
  // 의무화(2005.7)는 사업계획승인 기준이고 준공은 그보다 2~3년 늦다. 2005~2008년
  // 준공은 이전 설계일 수 있어 초록을 켜지 않는다.
  if (u.apr >= 2008) return { tone: 'good', text: `${u.apr}년 준공. 표준바닥구조 의무화(2005) 이후 설계입니다` }
  if (u.apr >= 2005) return { tone: 'muted', text: `${u.apr}년 준공. 의무화(2005) 직후라 이전 설계일 수 있습니다` }
  return { tone: 'muted', text: `${u.apr}년 준공. 표준바닥구조 의무화(2005) 이전입니다` }
}

const ym = (s) => `${String(s).slice(2, 4)}.${String(s).slice(4, 6)}`
/** 층은 반지하 여부를 알려준다. 침수·채광·보증보험 모두 여기서 갈린다. */
const floorText = (f) => (f == null ? '-' : f <= 0 ? '반지하' : `${f}층`)

/**
 * 개별 거래 내역. 중위값만 보여주면 그 값이 어디서 왔는지 알 수 없다.
 * "2.5억"보다 "26.03에 2.6억 3층, 25.11에 2.4억 반지하"가 판단에 훨씬 가깝고,
 * 중위값을 믿을 근거도 된다.
 */
function Deals({ deals }) {
  if (!deals) return null
  // 행 끝의 'P'는 신고 기한이 아직 안 지난 달의 계약이다. 월 통계에는 안 들어가지만
  // 신고된 개별 계약은 사실이므로, 꼬리표를 달아 최신 정보로 보여 준다.
  const prov = (r) => r.at(-1) === 'P'
  const groups = [
    ['j', '전세', (r) => [eok(r[1]), floorText(r[2]),
      [r[3] === '갱신' ? '갱신' : '', prov(r) ? '잠정' : ''].filter(Boolean).join('·')]],
    ['s', '매매', (r) => [eok(r[1]), floorText(r[2]), prov(r) ? '잠정' : '']],
    ['w', '월세', (r) => [`${eok(r[1])} / ${r[2]}만`, floorText(r[3]), prov(r) ? '잠정' : '']],
  ].filter(([k]) => deals[k]?.length)
  if (!groups.length) return null
  const hasProv = groups.some(([k]) => deals[k].some(prov))
  return (
    <>
      <h3 className="facts-h">최근 거래</h3>
      {groups.map(([k, label, fmt]) => (
        <div key={k} className="deals">
          <h4>{label} <small>{deals[k].length}건</small></h4>
          <table>
            <tbody>
              {deals[k].map((r, i) => {
                const [amount, floor, tag] = fmt(r)
                return (
                  <tr key={i}>
                    <td className="d-ym">{ym(r[0])}</td>
                    <td className="d-amt">{amount}</td>
                    <td className={floor === '반지하' ? 'serious' : ''}>{floor}</td>
                    <td className="d-tag">{tag}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
      {hasProv && (
        <p className="muted-line">
          '잠정' 표시는 신고 기한(계약 후 30일)이 아직 안 지난 달의 계약입니다. 그 달에
          늦게 신고되는 계약이 더 있을 수 있어, 위쪽 통계에는 넣지 않았습니다.
        </p>
      )}
    </>
  )
}

/**
 * 같은 건물의 다른 평형. 물건이 면적대로 쪼개져 있어서 "이 건물 전체"가 안 보였다.
 * 옆 평형이 얼마에 나가는지는 이 집 보증금이 정상인지 판단하는 데 바로 쓰인다.
 */
function Siblings({ u, onPick }) {
  const sibs = u.siblings
  if (!sibs?.length) return null
  return (
    <>
      <h3 className="facts-h">같은 건물 다른 평형 <small>{sibs.length}개</small></h3>
      <ul className="sibs">
        {sibs.map((s) => (
          <li key={s.id}>
            <button onClick={() => onPick?.(s.id)} disabled={!onPick}>
              <span>전용 {s.area}m² <small>({(s.area / 3.305785).toFixed(1)}평)</small></span>
              <b>{eok(s.jeonse)}</b>
              <em className={ratioBroken(s.ratio) ? 'muted' : ratioTone(s.ratio)}>
                {s.ratio == null ? '-' : ratioBroken(s.ratio) ? '보류' : pct0(s.ratio)}
              </em>
              <small>전세 {s.nj}건</small>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * 전세와 월세 중 어느 쪽이 유리한가. 같은 건물에 둘 다 있으면 바로 견줄 수 있다.
 * 전월세전환율 = 연 월세 ÷ (전세보증금 − 월세보증금). 이 값이 예금 금리보다 높으면
 * 전세가 유리하고, 낮으면 월세가 유리하다. 다만 전세는 보증금을 떼일 위험을 같이 진다.
 */
/**
 * 전환율을 실제 금리와 견준다. "6.0%"만 주면 판단을 못 한다. 예금 금리보다 높으면
 * 월세는 은행 이자보다 비싼 돈이고, 대출 금리보다 높으면 대출 이자를 내는 편이 싸다.
 * 금리 자료가 없으면(키 등록 전) 원래의 일반 문장으로 내려앉는다.
 */
function RateCompare({ rates, conv }) {
  const dep = latestRate(rates, 'deposit') ?? latestRate(rates, 'base')
  const loan = latestRate(rates, 'loan')
  if (!dep) {
    return <>전세보증금을 은행에 넣어 이보다 높은 이자를 받을 수 있다면 월세가 유리하고,
      아니면 전세가 유리합니다.{' '}</>
  }
  const c = conv * 100
  const verdict = loan && c > loan.v
    ? `전세자금대출 이자(${loan.v.toFixed(1)}%)를 내는 편이 이 월세보다 쌉니다.`
    : c > dep.v
      ? '월세가 예금 이자보다 비싼 구간입니다. 목돈이 있다면 전세가 계산상 유리합니다.'
      : '예금 이자가 전환율보다 높아, 드물게 월세가 유리한 경우입니다.'
  return (
    <>지금 정기예금(1년) {dep.v.toFixed(1)}%{loan ? `, 전세자금대출 ${loan.v.toFixed(1)}%` : ''}
      (한국은행, {ymKor(dep.ym)}). {verdict}{' '}</>
  )
}

function Wolse({ deals, jeonse }) {
  const rates = useRates()
  const rows = deals?.w
  if (!rows?.length || !jeonse) return null
  const rates2 = rows
    .map(([, dep, rent]) => (jeonse > dep ? (rent * 12) / (jeonse - dep) : null))
    .filter((r) => r != null && r > 0 && r < 0.3)
  if (!rates2.length) return null
  // 표본 수는 필터를 통과한 건수로 말한다. 6건을 받아 1건만 살아남았는데
  // "6건에서 계산"이라고 쓰면 근거를 부풀리는 말이 된다.
  const rateSamples = rates2.sort((a, b) => a - b)
  const mid = rateSamples.length >> 1
  const rate = rateSamples.length % 2 ? rateSamples[mid] : (rateSamples[mid - 1] + rateSamples[mid]) / 2
  return (
    <p className="warnline">
      <strong>전월세 전환율 {(rate * 100).toFixed(1)}%</strong>.{' '}
      이 건물 월세 계약 {rateSamples.length}건에서 계산한 값입니다.{' '}
      <RateCompare rates={rates} conv={rate} />
      다만 전세는 <strong className="serious">보증금을 떼일 위험</strong>을 같이 집니다.
    </p>
  )
}

/** 건물 정보. 건축물대장과 좌표 기반 생활정보(역·학교·지형)는 수집 경로가
 *  달라서 따로 왔다 따로 빠진다. 대장이 아직 없어도 생활정보가 있으면
 *  보여 준다 — 대장을 기다리느라 이미 아는 것까지 숨기면 안 된다. */
function BuildingFacts({ u }) {
  // stn 열은 역 번호다. 이름은 지하철 목록에서 찾는다.
  const stations = useSubway()
  // 대장 유무는 대장에서 오는 열 전체로 판정한다. 일부만 보면 "층수는
  // 보이는데 대장은 수집 전"이라는 자기모순 화면이 나올 수 있다.
  const hasBldg = [u.apr, u.strct, u.hhld, u.flr, u.elvt, u.park, u.n_dong]
    .some((v) => v != null)
  const items = [
    u.apr && ['준공', `${u.apr}년`],
    u.hhld && ['세대수', `${u.hhld}세대`],
    u.flr && ['지상 층수', `${u.flr}층`],
    u.elvt != null && ['승강기', u.elvt ? `${u.elvt}대` : '없음'],
    u.park != null && ['주차', u.park ? `${u.park}대` : '없음'],
    u.n_dong && ['단지 규모', `${u.n_dong}개 동`],
    // 좌표 수집이 끝난 물건부터 하나씩 붙는다. 직선거리 기반 도보 환산이다.
    u.walk != null && ['가까운 역', `${stations[u.stn] ? `${stations[u.stn].name}역 ` : ''}도보 ${u.walk}분`],
    // 학교 개수도 좌표가 있어야 센다. 0은 "없다"는 뜻이므로 그대로 보여 준다.
    u.sch_e != null && ['학교 (반경 1km)', `초 ${u.sch_e} · 중 ${u.sch_m} · 고 ${u.sch_h}`],
    u.sch_u != null && ['대학 (반경 2km)', u.sch_u ? `${u.sch_u}곳` : '없음'],
    // 위성 지형 기반 근사라 "약"을 떼지 않는다. 역 고도차는 10m부터 말할 가치가 있다.
    u.slope != null && ['지형', `${
      u.slope < 5 ? '평지에 가깝습니다' :
      u.slope < 8 ? `완만한 오르막 (경사 약 ${u.slope}%)` : `언덕 (경사 약 ${u.slope}%)`}${
      u.stn_dh != null && Math.abs(u.stn_dh) >= 10
        ? ` · 역보다 약 ${Math.abs(u.stn_dh)}m ${u.stn_dh > 0 ? '높음' : '낮음'}` : ''}`],
  ].filter(Boolean)
  if (!items.length) {
    return <p className="muted-line">건축물대장 자료가 아직 없는 물건입니다. 수집이 진행 중입니다.</p>
  }
  const note = hasBldg ? quietNote(u) : null
  return (
    <>
      <h3 className="facts-h">건물</h3>
      <ul className="facts">
        {items.map(([k, v]) => (
          // 지형 값은 구조적으로 길다("완만한 오르막 … 역보다 약 18m 높음").
          // 좁은 열에 구겨 넣지 않고 전폭을 준다.
          <li key={k} className={k === '지형' ? 'full' : undefined}>
            <span>{k}</span><b>{v}</b>
          </li>
        ))}
      </ul>
      {!hasBldg && (
        <p className="muted-line">건축물대장(준공·세대수·승강기 등)은 아직 수집 전입니다. 수집되는 대로 이 자리에 붙습니다.</p>
      )}
      {note && (
        <p className="warnline">
          <strong className={note.tone}>층간소음 추정</strong>: {note.text}.{' '}
          실측 소음 자료가 아니라 구조와 준공연도로 미루어 본 것입니다.
        </p>
      )}
    </>
  )
}

/**
 * 임장 질문 생성기. 판정이 이미 계산돼 있으니 "이 집에서 뭘 물어봐야 하나"를
 * 물건마다 다르게 만들 수 있다. 비교함에서 물건별로 보여 준다.
 */
export function questionsFor(u) {
  const q = []
  const r = ratioBroken(u.ratio) ? null : u.ratio
  const year = u.apr ?? u.build_year
  if (u.stage === 'A' && u.n_sale_24m >= 3 && r >= 0.9) {
    q.push('보증금이 이 건물 매매가에 육박합니다. 근저당 잔액과 감액(말소) 조건을 먼저 물어보세요')
  }
  if (u.ht === 'R' && !u.n_sale_24m && year >= 2018 && u.n_jeonse_24m >= 5) {
    q.push('신축인데 매매 없이 전세만 여럿인 패턴입니다. 보증보험 가입 가능 확인을 계약 조건(특약)으로 거세요')
  } else if (!u.n_sale_24m) {
    q.push('매매 사례가 없어 시세 검증이 안 되는 건물입니다. 등기부 을구와 건축물대장 위반 여부를 현장에서 확인하세요')
  }
  if (u.renew_hike != null && u.renew_hike <= -0.05) {
    q.push('갱신에서 보증금이 내린 건물입니다. 직전 계약 대비 감액을 협상 근거로 쓰세요')
  }
  if (u.deals?.w?.length) {
    q.push('이 건물에 월세 계약이 있습니다. 전월세 전환율과 견줘 보증금·월세 조합을 조정할 여지를 물어보세요')
  }
  q.push('전입신고·확정일자는 잔금일에 바로 하고, 잔금일 다음 날까지 근저당 설정 금지 특약을 넣으세요')
  return q.slice(0, 3)
}

/**
 * 호가 검증기. 매물 앱은 호가만 보여주고 그 호가가 실거래 대비 어디쯤인지는 말하지
 * 않는다. 자기 광고주의 값에 "비싸다"고 쓸 수 없는 구조라서다. 우리는 쓸 수 있다.
 * 보고 온 보증금을 넣으면 이 건물의 실제 계약들과 견줘 준다. 협상 카드다.
 */
/**
 * 보증금 지킴이 등록. 계약 전 확인이 끝난 자리에서 바로 계약 후 감시로
 * 이어진다. 보증금과 만기일 두 가지만 받는다 — 그 이상은 물을 이유가 없고,
 * 두 값 모두 기기 밖으로 나가지 않는다.
 */
function GuardAdd({ u, lawd, guard }) {
  const [openForm, setOpenForm] = useState(false)
  const [dep, setDep] = useState('')
  const [exp, setExp] = useState('')
  const [full, setFull] = useState(false)
  if (guard.has(u.id)) {
    return (
      <button className="cmp-btn" aria-pressed onClick={() => guard.remove(u.id)}>
        ✓ 지킴이 감시 중 (해제)
      </button>
    )
  }
  if (!openForm) {
    return (
      <button className="cmp-btn" onClick={() => setOpenForm(true)}>
        + 보증금 지킴이 등록
      </button>
    )
  }
  const amt = dep === '' || isNaN(Number(dep)) ? null : Math.round(Number(dep) * 10000)
  const ok = amt > 0 && exp
  return (
    <div className="asking guard-add">
      <label>
        <b>이 집에 살고 계시거나 계약하셨나요?</b>
      </label>
      <p>보증금과 만기일을 등록하면, 데이터가 갱신될 때마다 이 건물의 새 위험
         신호와 만기 일정을 계약 전 확인 탭에서 알려드립니다. 두 값 모두 이
         기기에만 저장됩니다.</p>
      <div className="guard-form">
        <span className="asking-in">
          <input inputMode="decimal" placeholder="보증금" value={dep} aria-label="보증금 (억)"
                 onChange={(e) => setDep(e.target.value)} />
          <em>억</em>
        </span>
        <span className="asking-in">
          <input type="date" value={exp} aria-label="계약 만기일"
                 onChange={(e) => setExp(e.target.value)} />
        </span>
        <button className="cmp-btn" disabled={!ok}
                onClick={() => {
                  if (guard.add(lawd, u, amt, exp)) setOpenForm(false)
                  else setFull(true)
                }}>
          등록
        </button>
        <button className="cmp-btn" onClick={() => setOpenForm(false)}>취소</button>
      </div>
      {full && (
        <p className="critical">
          등록은 최대 4개입니다. 계약 전 확인 탭의 지킴이에서 기존 등록을 해제한 뒤
          다시 시도해 주세요.
        </p>
      )}
    </div>
  )
}

function Asking({ u, pctOf }) {
  const [raw, setRaw] = useState('')
  const amt = raw === '' || isNaN(Number(raw)) ? null : Math.round(Number(raw) * 10000)
  const rows = u.deals?.j ?? []
  const amounts = rows.map((r) => r[1])
  const max = amounts.length ? Math.max(...amounts) : null

  let lines = null
  if (amt > 0) {
    lines = []
    if (max != null) {
      if (amt > max) {
        lines.push(<span key="m">이 건물 최근 2년 어느 전세 계약보다 높습니다
          (최고 {eok(max)} 대비 <strong className="critical">+{Math.round((amt / max - 1) * 100)}%</strong>).
          내릴 근거가 충분합니다.</span>)
      } else if (u.med_jeonse && amt > u.med_jeonse) {
        lines.push(<span key="m">이 건물 중위 {eok(u.med_jeonse)}보다 높고,
          최고 {eok(max)} 아래입니다.</span>)
      } else {
        lines.push(<span key="m">이 건물 중위 {eok(u.med_jeonse)} 이하입니다.
          값 자체는 무리한 호가가 아닙니다.</span>)
      }
      const latest = rows[0]
      lines.push(<span key="l"> 가장 최근 계약은 {String(latest[0]).slice(2, 4)}.{String(latest[0]).slice(4, 6)}의 {eok(latest[1])}입니다.</span>)
    } else if (u.med_jeonse) {
      lines.push(<span key="m">이 건물 중위 전세보증금은 {eok(u.med_jeonse)}입니다.</span>)
    }
    if (u.med_sale) {
      const rr = amt / u.med_sale
      lines.push(<span key="r"> 이 보증금이면 전세가율은{' '}
        <strong className={ratioTone(rr)}>{pct0(rr)}</strong>입니다.</span>)
    }
    const p = pctOf ? pctOf(amt) : null
    if (p != null) {
      lines.push(<span key="p"> {u.umd} 비슷한 평형 중 비싼 쪽에서 {p}%입니다.</span>)
    }
  }

  return (
    <div className="asking">
      <label>
        <b>보고 온 보증금 검증</b>
        <span className="asking-in">
          <input type="number" inputMode="decimal" step="0.1" min="0" placeholder="예: 3.2"
                 value={raw} onChange={(e) => setRaw(e.target.value)}
                 aria-label="보고 온 보증금(억)" />
          <em>억</em>
        </span>
      </label>
      {lines
        ? <p>{lines}</p>
        : <p className="muted-line">매물에서 본 보증금을 넣으면 이 건물의 실제 계약과 견줘 드립니다.</p>}
    </div>
  )
}

/**
 * 판정 다음에 할 일. 숫자를 보여주고 끝나면 읽고 끝난다. 이 앱이 답하지 못하는
 * 부분(등기부·보증보험)으로 가는 문이 판정 바로 아래에 있어야 한다.
 */
function Actions({ tone, u }) {
  const urgent = tone === 'critical' || tone === 'serious'
  return (
    <div className="todo">
      <b>{urgent ? '계약 전에 반드시' : '계약 전에 확인'}</b>
      <ol>
        <li>
          등기부등본 을구에서 근저당 잔액을 확인하세요. 선순위 채권과 내 보증금
          {u.med_sale ? `(${eok(u.med_jeonse)})의 합이 매매가 ${eok(u.med_sale)}을 넘으면 경매에서 못 받습니다`
                      : '의 합이 집값을 넘으면 경매에서 못 받습니다'}.{' '}
          <a href="https://www.iros.go.kr" target="_blank" rel="noopener noreferrer">인터넷등기소 ↗</a>
        </li>
        <li>
          보증보험 가입 가능 여부를 계약 전에 확인하고, 안 되면 계약을 해제한다는
          특약을 넣으세요. 거절 자체가 신호입니다.{' '}
          <a href="https://www.khug.or.kr" target="_blank" rel="noopener noreferrer">HUG ↗</a>
        </li>
        <li>
          건축물대장에서 위반건축물 표기를 확인하세요. 위반이면 보증보험이 안 됩니다.{' '}
          <a href="https://www.gov.kr" target="_blank" rel="noopener noreferrer">정부24 ↗</a>
        </li>
      </ol>
      {urgent && <p>위 확인이 끝나기 전에는 계약금을 보내지 마세요.</p>}
    </div>
  )
}

/** 계약 패키지 가짜 문. 실제 결제는 없다 — 관심을 익명으로 세어 유료화를
 *  결정한다(수익 모델 v2 검증). 누르면 준비 중임을 바로 정직하게 밝힌다. */
const PKG_PRICE = 19900

/** 리포트·감시에 담기는 것. 카드의 상세와 소개 탭이 같은 내용을 말해야 한다. */
export const PKG_REPORT_ITEMS = [
  '판정 근거 전체와 계산 과정',
  '이 물건에 맞춘 임장 질문',
  '등기부등본에서 확인할 목록',
  '계약서에 넣을 특약 문구 제안',
]
export const PKG_GUARD_ITEMS = [
  '실거래 전량을 만기까지 상시 감시',
  '내 보증금보다 낮은 신규 전세 즉시 경보',
  '갱신요구권 통보 기한 등 만기 일정 알림',
]

function PkgOffer({ u }) {
  // idle(제안만) -> detail(자세히 펼침) -> applied(준비 중 공개)
  const [stage, setStage] = useState('idle')
  const [wait, setWait] = useState(() => {
    try { return !!localStorage.getItem('nec-pkg-wait') } catch { return false }
  })
  // view는 "카드가 열림"이 아니라 "제안이 실제로 화면에 보임"을 센다.
  // 카드가 길어서 여기까지 스크롤하지 않은 사람을 노출로 치면 클릭률이 왜곡된다.
  const boxRef = useRef(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      fdTrack('view', u.id, PKG_PRICE)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        fdTrack('view', u.id, PKG_PRICE)
        io.disconnect()
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [u.id])
  const onWait = () => {
    fdTrack('notify', u.id, PKG_PRICE)
    try { localStorage.setItem('nec-pkg-wait', '1') } catch { /* 표시용 플래그일 뿐 */ }
    setWait(true)
  }
  return (
    <div className="pkg" ref={boxRef}>
      <b>계약 패키지 · 심층 리포트와 2년 감시</b>
      <p>
        이 물건의 판정 근거 전체와 임장 질문, 등기부에서 확인할 목록, 특약 문구
        제안을 한 부의 리포트로 정리해 드리고, 계약 후 2년 동안 실거래 전량을
        감시해 위험 신호를 알려 드립니다.
      </p>
      <div className="pkg-row">
        <span className="pkg-price">{PKG_PRICE.toLocaleString()}원 <small>한 번 결제</small></span>
        {stage === 'idle' && (
          <button className="cmp-btn" onClick={() => { fdTrack('click', u.id, PKG_PRICE); setStage('detail') }}>
            패키지 신청하기
          </button>
        )}
      </div>
      {stage !== 'idle' && (
        <div className="pkg-detail">
          <b>리포트에 담기는 것</b>
          <ul className="pkg-list">
            {PKG_REPORT_ITEMS.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <b>2년 감시가 하는 일</b>
          <ul className="pkg-list">
            {PKG_GUARD_ITEMS.map((t) => <li key={t}>{t}</li>)}
          </ul>
          {/* cid가 실린 click이 이미 나갔다. 고지는 수집과 같은 화면에 있어야 한다. */}
          <p className="muted-line">관심은 기기를 구분하는 무작위 번호와 함께 익명
            숫자로만 집계되어 출시를 결정하는 근거가 됩니다.</p>
          {stage === 'detail' && (
            <button className="cmp-btn" onClick={() => { fdTrack('apply', u.id, PKG_PRICE); setStage('applied') }}>
              신청하기
            </button>
          )}
        </div>
      )}
      {stage === 'applied' && (
        <div className="pkg-note">
          {/* 집계 고지는 바로 위 pkg-detail에 이미 떠 있다. 같은 말을 두 번 하지 않는다. */}
          <b>아직 준비 중인 기능입니다</b>
          <p>
            지금은 수요를 확인하는 단계라 결제가 열려 있지 않습니다. 눌러 주신
            관심은 출시를 결정하는 근거가 됩니다. 판정 근거는 지금도 이 화면에서
            전부 무료로 보실 수 있습니다.
          </p>
          {wait
            ? <p className="muted-line">출시되면 이 기기의 앱 화면에서 알려드리겠습니다.</p>
            : <button className="more" onClick={onWait}>출시되면 알려주세요</button>}
        </div>
      )}
    </div>
  )
}

export function UnitCard({ u, lawd, onClose, onMap, onSibling, rank, compare, guard, pctOf }) {
  const v = verdict(u)
  const st = STAGE[u.stage] ?? STAGE.C
  return (
    <div className="card unit-detail">
      <button className="close" onClick={onClose} aria-label="닫기">✕</button>
      <h2>{u.name || '(이름 없음)'}</h2>
      <p className="sub">
        {u.umd} {u.jibun} · 전용 {u.area}m² ({(u.area / 3.305785).toFixed(1)}평)
        {u.build_year ? ` · ${u.build_year}년 준공` : ''}
      </p>

      {compare && lawd && (
        <button className="cmp-btn" aria-pressed={compare.has(u.id)}
                onClick={() => compare.toggle(lawd, u.id, u.name || u.jibun)}>
          {compare.has(u.id) ? '✓ 비교함에 담김' : '+ 비교함에 담기'}
        </button>
      )}
      {guard && lawd && <GuardAdd u={u} lawd={lawd} guard={guard} />}

      <div className={`verdict ${v.tone}`}>
        <strong>{v.head}</strong>
        <span>{v.body}</span>
      </div>

      <Asking u={u} pctOf={pctOf} />

      <Actions tone={v.tone} u={u} />

      <dl className="metrics">
        <div>
          <dt>전세가율</dt>
          <dd className={`big ${ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}`}>
            {u.ratio == null ? '-'
              : ratioBroken(u.ratio) ? '판단 보류'
              : st.exact ? pct0(u.ratio) : `약 ${pct0(u.ratio)}`}
          </dd>
          <small>{st.label}{u.n_comps ? ` · 매매 ${u.n_comps}건` : ''}</small>
        </div>
        <div>
          <dt>중위 전세보증금</dt>
          <dd>{eok(u.med_jeonse)}</dd>
          <small>
            최근 2년 {u.n_jeonse_24m}건
            {rank && ` · ${rank.umd} 비슷한 평형 ${rank.n}건 중 비싼 쪽에서 ${rank.pct}%`}
          </small>
        </div>
        <div>
          <dt>중위 매매가</dt>
          <dd>{eok(u.med_sale)}</dd>
          <small>{u.n_sale_24m ? `최근 2년 ${u.n_sale_24m}건` : '사례 없음'}</small>
        </div>
        <div>
          <dt>갱신 시 보증금</dt>
          <dd className={u.renew_hike != null && u.renew_hike < -0.05 ? 'serious' : ''}>
            {signed(u.renew_hike)}
          </dd>
          <small>{u.renew_hike == null ? '갱신 신고 없음' : '직전 계약 대비 중위'}</small>
        </div>
      </dl>

      {/* 직전 2년과 견준 추세. 데이터에 있으면서 화면에 없던 값이다. */}
      {u.ratio_prev != null && u.ratio != null && !ratioBroken(u.ratio) && (
        <p className="muted-line">
          직전 2년 전세가율은 {pct0(u.ratio_prev)}였고,{' '}
          <strong className={u.ratio > u.ratio_prev + 0.03 ? 'serious' : ''}>
            {u.ratio > u.ratio_prev + 0.03 ? `${Math.round((u.ratio - u.ratio_prev) * 100)}%p 올랐습니다`
              : u.ratio < u.ratio_prev - 0.03 ? `${Math.round((u.ratio_prev - u.ratio) * 100)}%p 내렸습니다`
              : '큰 변화 없습니다'}
          </strong>.
        </p>
      )}

      {ratioBroken(u.ratio) && (
        <p className="warnline">
          <strong className="serious">비교 기준이 정상이 아닙니다.</strong> 계산하면
          {' '}{pct0(u.ratio)}가 나오는데, 이런 값은 전세가율이 높다기보다 비교에 쓴 매매가가
          이 집의 시세가 아니라는 뜻입니다{u.n_sale_24m === 1 ? ' (매매 단 1건 기준)' : ''}.
          지분 거래나 특수관계인 거래가 섞였을 수 있습니다. 등기부등본으로 직접 확인하세요.
        </p>
      )}
      {!ratioBroken(u.ratio) && !st.exact && u.ratio != null && (
        <p className="warnline">
          이 건물의 매매 사례가 없어 <strong>같은 동의 비슷한 물건{u.stage === 'B' ? '·연식' : ''}</strong>과
          비교한 참고치입니다. 같은 방식으로 계산한 값을 실제 거래가 있는 물건 10,416개에서
          대조해 보니, <strong>열 중 여덟은 오차 10%p 이내</strong>였지만
          <strong className="serious"> 마흔 중 하나는 위험한 물건을 안전하다고</strong> 말했습니다.
          {u.stage === 'B-' && ' 이 물건은 연식을 맞추지 못해 그보다 더 거칠게 잡은 값입니다.'}
        </p>
      )}
      {u.direct_share > 0 && (
        <p className="warnline">
          최근 매매 중 <strong>직거래 {pct0(u.direct_share)}</strong>. 특수관계인 간 거래가 섞이면
          시세가 실제보다 낮거나 높게 잡힙니다.
        </p>
      )}
      {u.n_wolse_24m > 0 && (
        <p className="muted-line">최근 2년 월세 계약 {u.n_wolse_24m}건 (전세 {u.n_jeonse_24m}건)</p>
      )}

      <Siblings u={u} onPick={onSibling} />
      <Wolse deals={u.deals} jeonse={u.med_jeonse} />
      <Deals deals={u.deals} />
      <BuildingFacts u={u} />

      {/* 좌표가 있는 물건에서만 낸다. 눌렀는데 아무 데도 안 가면 안 만든 것만 못하다. */}
      {onMap && <button className="more" onClick={onMap}>지도에서 위치 보기</button>}

      <PkgOffer u={u} />
    </div>
  )
}

const PAGE = 80

/**
 * 필터. 목록을 훑는 것보다 조건으로 좁히는 게 실제 쓰임에 가깝다
 * ("우리 동네에서 매매 사례 없는 빌라").
 */
const FILTERS = [
  // 판단 보류(비교 기준이 깨진 값, RATIO_BROKEN)는 위험이 아니라 모름이므로 세지 않는다.
  // 동네 살펴보기 탭과 같은 정의여야 한다. 두 탭의 숫자가 다르면 어느 쪽도 못 믿게 된다.
  { key: 'confirmed', label: '확인된 깡통',
    hint: '그 건물 매매 3건 이상을 기준으로 보증금이 매매가를 넘습니다',
    test: (u) => u.stage === 'A' && u.n_sale_24m >= 3 && u.ratio >= 1 && u.ratio < RATIO_BROKEN },
  { key: 'high', label: '전세가율 90%↑',
    hint: '근거 단계와 무관하게 전세가율이 90% 이상입니다',
    test: (u) => u.ratio >= 0.9 && u.ratio < RATIO_BROKEN },
  { key: 'nosale', label: '매매 0건',
    hint: '최근 2년 이 건물 매매 신고가 없어 담보 가치를 검증할 수 없습니다',
    test: (u) => !u.n_sale_24m },
  { key: 'reverse', label: '역전세',
    hint: '갱신 계약에서 보증금이 5% 이상 내려갔습니다',
    test: (u) => u.renew_hike != null && u.renew_hike <= -0.05 },
]

export default function UnitLookup({ lawdCd, guName, housing }) {
  const [state, setState] = useState({ status: 'idle' })
  const [q, setQ] = useState('')
  // 펼친 물건의 id만 들고 있는다. 상세를 목록 위에 띄우면 아래쪽 물건을 눌렀을 때
  // 화면 밖에서 열려서 스크롤을 되감아야 한다. 누른 줄 바로 아래에 펼친다.
  const [selId, setSelId] = useState(null)
  const [limit, setLimit] = useState(PAGE)
  const [active, setActive] = useState([])   // 켜진 필터 키
  const [umd, setUmd] = useState('')         // 법정동

  useEffect(() => {
    setSelId(null)
    setState({ status: 'loading' })
    fetch(`${import.meta.env.BASE_URL}data/units/${lawdCd}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        const idx = Object.fromEntries(d.cols.map((c, i) => [c, i]))
        const rows = d.rows.map((r) => Object.fromEntries(d.cols.map((c, i) => [c, r[i]])))
        setState({ status: 'ready', rows, window: d.window, hasHt: d.cols.includes('ht') })
      })
      .catch((e) => setState({ status: 'error', message: e.message }))
  }, [lawdCd])

  const list = useMemo(() => {
    if (state.status !== 'ready') return Object.assign([], { total: 0 })
    const needle = q.trim()
    // ht 없이 만들어진 예전 스냅샷이 배포에 실려도 빈 목록이 되지 않게 한다
    const wantHt = housing === '아파트' ? 'A' : 'R'
    const typed = state.hasHt ? state.rows.filter((r) => r.ht === wantHt) : state.rows
    const tests = FILTERS.filter((f) => active.includes(f.key)).map((f) => f.test)
    const rows = typed.filter((r) =>
      (!umd || r.umd === umd) &&
      tests.every((t) => t(r)) &&
      (!needle || r.name?.includes(needle) || r.umd?.includes(needle) || r.jibun?.includes(needle)))
    // 검색 전에는 위험한 것부터. 매매 사례가 없는 쪽이 먼저 온다.
    const out = [...rows].sort((a, b) => (needle
      ? (b.n_jeonse_24m ?? 0) - (a.n_jeonse_24m ?? 0)
      : riskScore(b) - riskScore(a)))
    return Object.assign(out, { total: typed.length })
  }, [state, q, housing, active, umd])

  // 조건이 바뀌면 다시 처음부터 보여준다
  useEffect(() => { setLimit(PAGE) }, [q, housing, lawdCd, active, umd])
  useEffect(() => { setActive([]); setUmd('') }, [lawdCd])

  // 목록 끝이 보이면 다음 묶음을 이어 붙인다. 전량은 이미 메모리에 있으므로
  // 네트워크 요청 없이 DOM 노드만 늘어난다.
  const sentinel = useRef(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || limit >= list.length) return
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && setLimit((n) => n + PAGE),
      { rootMargin: '400px' }
    )
    io.observe(node)
    return () => io.disconnect()
  }, [limit, list.length])

  const facets = useMemo(() => {
    if (state.status !== 'ready') return { umds: [], counts: {} }
    const wantHt = housing === '아파트' ? 'A' : 'R'
    const typed = state.hasHt ? state.rows.filter((r) => r.ht === wantHt) : state.rows
    const scoped = umd ? typed.filter((r) => r.umd === umd) : typed
    return {
      umds: [...new Set(typed.map((r) => r.umd))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko')),
      counts: Object.fromEntries(FILTERS.map((f) => [f.key, scoped.filter(f.test).length])),
    }
  }, [state, housing, umd])

  const toggle = useCallback((key) => {
    setActive((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
  }, [])

  if (state.status === 'error') {
    return (
      <section className="card">
        <h2>물건 조회</h2>
        <p className="sub">
          {state.message === '404'
            ? '물건 단위 데이터가 아직 배포에 포함되지 않았습니다. 수집 워크플로가 한 번 더 돌면 붙습니다.'
            : `불러오지 못했습니다 (${state.message})`}
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>{guName} 물건 조회</h2>
      <p className="sub">
        {housing} · 건물명·법정동·지번으로 검색. 최근 2년 전세 계약이 있는 물건만 있습니다
        {state.status === 'ready' ? ` (${list.total.toLocaleString()}개)` : ''}
      </p>
      <input className="search" type="search" value={q} placeholder="예: 화곡동, 우성테마빌"
             onChange={(e) => setQ(e.target.value)} aria-label="물건 검색" />

      {state.status === 'ready' && (
        <div className="filters">
          <select value={umd} onChange={(e) => setUmd(e.target.value)} aria-label="법정동">
            <option value="">법정동 전체</option>
            {facets.umds.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {FILTERS.map((f) => (
            <button key={f.key} className="chip" title={f.hint}
                    aria-pressed={active.includes(f.key)}
                    disabled={!facets.counts[f.key] && !active.includes(f.key)}
                    onClick={() => toggle(f.key)}>
              {f.label}<span className="n">{facets.counts[f.key]?.toLocaleString() ?? 0}</span>
            </button>
          ))}
          {(active.length > 0 || umd) && (
            <button className="chip clear" onClick={() => { setActive([]); setUmd('') }}>초기화</button>
          )}
        </div>
      )}

      {state.status === 'loading' && <p className="muted-line">불러오는 중…</p>}

      {state.status === 'ready' && (
        <>
          {!q && (
            <p className="muted-line">
              검색어가 없으면 위험 신호 순으로 보여줍니다. 그 건물 실거래로 확인된 건이 먼저,
              인근 기준 추정치가 다음, 매매 사례가 없어 검증이 불가한 건이 그다음입니다.
            </p>
          )}
          <ul className="unit-list">
            {list.slice(0, limit).map((u) => (
              <li key={u.id}>
                <button aria-expanded={selId === u.id}
                        onClick={() => setSelId((id) => (id === u.id ? null : u.id))}>
                  <span className="u-name">{u.name || '(이름 없음)'}</span>
                  <span className="u-meta">{u.umd} · 전용 {u.area}m²{u.build_year ? ` · ${u.build_year}년` : ''}</span>
                  <span className="u-sig">
                    <em className={ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}>
                      {u.ratio == null ? '비교 불가'
                        : ratioBroken(u.ratio) ? '판단 보류'
                        : `${STAGE[u.stage]?.exact ? '' : '약 '}${pct0(u.ratio)}`}
                    </em>
                    <small className={!u.n_sale_24m ? 'critical' : u.n_sale_24m < 3 ? 'serious' : ''}>
                      {u.stage === 'A' ? `이 건물 매매 ${u.n_sale_24m}건` : `매매 ${u.n_sale_24m}건`}
                    </small>
                  </span>
                </button>
                {selId === u.id && <UnitCard u={u} onClose={() => setSelId(null)} />}
              </li>
            ))}
          </ul>
          {!list.length && (
            <p className="muted-line">
              조건에 맞는 물건이 없습니다.
              {(active.length > 0 || umd) && ' 필터를 줄여 보세요.'}
            </p>
          )}
          {limit < list.length && (
            <>
              <div ref={sentinel} aria-hidden="true" />
              <button className="more" onClick={() => setLimit((n) => n + PAGE)}>
                더 보기 ({list.length - limit}개 남음)
              </button>
            </>
          )}
          {list.length > 0 && (
            <p className="muted-line">
              {list.length.toLocaleString()}개 중 {Math.min(limit, list.length).toLocaleString()}개 표시
            </p>
          )}
        </>
      )}
    </section>
  )
}
