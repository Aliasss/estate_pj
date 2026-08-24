import { useEffect, useRef, useState } from 'react'
import { CHECKLIST, RATIO_BROKEN, eok, latestRate, pct0, ratioBroken, useRates, verdict, ym as ymKor, useSubway } from './units.js'
// 판정과 금액 표기는 units.js에 산다. 서버 함수(공유 카드)도 같은 것을 써야 해서
// JSX 밖으로 옮겼다. 두 벌이 되면 화면과 공유 카드가 다른 말을 하게 된다.
export { RATIO_BROKEN, eok, pct0, ratioBroken }
import { fdTrack } from './fakedoor.js'
import { naverSearchUrl, placeQuery } from './navermap.js'

const signed = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)

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
 * 오피스텔도 같은 결이다: 개별 호실 매매가 얇고, 신축에 전세만 채우는
 * 전세사기 패턴이 다세대와 함께 가장 잦은 유형이다.
 */


/**
 * 목록 줄 오른쪽 칸에서, 최근 2년 전세 신고가 없는 건물을 어떻게 적을지.
 * 세 화면(계약 전 확인·동네·임장)이 같은 말을 해야 한다.
 *
 * 빈칸이나 '-'로 두면 안 된다. 보증금 자리가 비어 있으면 값이 싸다거나 문제가
 * 없다는 뜻으로 읽힌다. 없는 것은 없다고 적고, 대신 무엇이 있는지를 준다.
 *
 * 이 자리(.u-sig em)는 목록에서 보증금 금액이 앉는 칸이라 숫자로 시작하는 말을
 * 쓰지 않는다. "전세 0건"은 위아래가 전부 "2.40억"인 세로줄 안에서 0원으로
 * 읽힐 여지가 있다. 대신 아랫줄에 중위 매매가를 붙여 준다 - 값이 이미 데이터에
 * 있는데 건수만 주면 아까운 일이다.
 */
export function NoJeonseSig({ ns, nw, sale }) {
  const have = [
    ns ? `매매 ${ns}건${sale != null ? ` · 중위 ${eok(sale)}` : ''}` : null,
    nw ? `월세 ${nw}건` : null,
  ].filter(Boolean)
  return (
    <>
      <em className="muted">전세 신고 없음</em>
      <small>{have.join(' · ')}</small>
    </>
  )
}

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
  // 표준바닥구조 의무화(2005)는 주택법 계열 공동주택 기준이다. 건축법상
  // 업무시설인 오피스텔은 당시 적용 대상이 아니었으므로, 준공연도로 좋은
  // 신호를 켜면 근거 없는 안심이 된다. 오피스텔은 말하지 않는다.
  if (u.ht === 'O') return null
  if (u.strct === 'BR') return { tone: 'serious', text: '벽돌조입니다. 차음에 가장 불리한 구조입니다' }
  if (!u.apr) return null
  // 의무화(2005.7)는 사업계획승인 기준이고 준공은 그보다 2~3년 늦다. 2005~2008년
  // 준공은 이전 설계일 수 있어 초록을 켜지 않는다.
  if (u.apr >= 2008) return { tone: 'good', text: `${u.apr}년 준공. 표준바닥구조 의무화(2005) 이후 설계입니다` }
  if (u.apr >= 2005) return { tone: 'muted', text: `${u.apr}년 준공. 의무화(2005) 직후라 이전 설계일 수 있습니다` }
  return { tone: 'muted', text: `${u.apr}년 준공. 표준바닥구조 의무화(2005) 이전입니다` }
}

/**
 * 살 때 매일 겪는 것들. 대장 숫자를 그대로 두지 않고 생활의 말로 옮긴다.
 *
 * "주차 34대"는 그대로는 판단에 쓸 수 없는 숫자다. 34대가 넉넉한지는 세대수를
 * 알아야 정해진다. 세대수는 이미 가진 값이라 여기서 끝까지 옮겨 준다.
 *
 * 승강기. 표제부의 승용승강기는 자료 없음을 0으로 준다. 이 대장 95,943행에
 * NULL이 한 행도 없고, 15층 이상이면서 승용 0인 6,035행 중 74.4%가 비상용
 * 승강기를 갖고 있다. 고층에서 0은 "없다"가 아니라 "안 적혔다"는 뜻이다.
 * 처음에는 4층 이상 전부에 문구를 달았다가 25층 아파트에 "승강기가 없습니다"가
 * 붙었다(리뷰에서 잡혔고 51층 사례도 있었다). 그래서 승용승강기 의무 대상이
 * 아닌 구간, 곧 연립·다세대 5층 이하로만 말한다. 넓게 잡았을 때 55,689개
 * 물건에 뜨던 것이 48,184개가 되고, 빠진 것은 아파트 5,418개와 오피스텔
 * 1,162개다. 그 6,580개가 오보 위험 구간이었다.
 *
 * 주차 비교값(중위 0.75대)은 뺐다. 그 값은 서울 19개 구까지만 수집된 시점의
 * 것이라 "서울·경기"라고 부를 수 없었고, 유형별로도 아파트 1.04대 대 빌라
 * 0.73대로 갈려 하나의 기준선으로 쓸 수 없다. 대장 수집이 끝난 뒤 유형별로
 * 다시 붙인다. 문턱만 남기며, 세대당 대수 자체는 세대수로 나눈 사실이다.
 *
 * 표시는 반올림이 아니라 내림이다. 0.46을 "0.5대"로 적으면 0.5 미만이라 켠
 * 경고 옆에 0.5가 적히는 자기모순이 생긴다. 실측으로 827건이 그랬다.
 *
 * 어느 쪽도 위험 판정이 아니다. 생활 조건이라 톤을 낮춰 싣는다.
 */
const PARK_TIGHT = 0.5
const WALKUP_FLOOR = 4
// 6층 이상 공동주택은 건축법상 승용승강기 의무 대상이라 "0대"가 성립하지 않는다.
const WALKUP_MAX = 5

// 문턱과 같은 방향으로 자른다. 반올림하면 경고와 표시가 어긋난다.
const parkPer = (per) => (Math.floor(per * 10) / 10).toFixed(1)

function livingNotes(u) {
  const out = []
  if (u.ht === 'R' && u.elvt === 0 && u.flr >= WALKUP_FLOOR && u.flr <= WALKUP_MAX) {
    out.push(`${u.flr}층 건물에 승강기가 없습니다`)
  }
  if (u.park != null && u.hhld) {
    const per = u.park / u.hhld
    if (per < PARK_TIGHT) {
      out.push(`주차가 세대당 ${parkPer(per)}대입니다`)
    }
  }
  return out
}

const ym = (s) => `${String(s).slice(2, 4)}.${String(s).slice(4, 6)}`
/** 층은 반지하 여부를 알려준다. 침수·채광·보증보험 모두 여기서 갈린다. */
const floorText = (f) => (f == null ? '-' : f <= 0 ? '반지하' : `${f}층`)

/**
 * 개별 거래 내역. 중위값만 보여주면 그 값이 어디서 왔는지 알 수 없다.
 * "2.5억"보다 "26.03에 2.6억 3층, 25.11에 2.4억 반지하"가 판단에 훨씬 가깝고,
 * 중위값을 믿을 근거도 된다.
 */
// 전송량 때문에 종류별 최근 몇 건만 싣는다. build_units.py의 DEAL_CAPS와 같은 값.
// 상한에 닿은 목록은 "6건"이 아니라 "최근 6건"으로 말해야 한다. 거래가 잦은
// 건물에서 "6건"은 전부처럼 읽혀서, 실제로 있는 계약이 없는 것처럼 보인다.
export const DEAL_CAPS = { j: 15, s: 10, w: 12 }

/* 그룹마다 처음 몇 건만 펴 둔다. 전세 15 · 매매 10 · 월세 12건까지 실려서
   다 펴면 표만 1,313px이고 카드 3,800px의 3분의 1이다. 그렇다고 통째로 감추면
   이 앱이 판정의 근거로 삼는 것이 안 보인다. 최근 흐름은 보이고 나머지는
   부르면 오게 한다. */
const DEAL_PEEK = 4

function DealTable({ kind, label, rows, fmt, cap, bare }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, DEAL_PEEK)
  const rest = rows.length - shown.length
  return (
    <div className={`deals deals-${kind}`}>
      {/* bare: 접힘의 summary가 이미 제목 노릇을 할 때. 제목이 두 번 서면 소음이다. */}
      {!bare && <h4>{label} <small>{rows.length >= cap ? `최근 ${rows.length}건` : `${rows.length}건`}</small></h4>}
      <table>
        <tbody>
          {shown.map((r, i) => {
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
      {(rest > 0 || all) && (
        <button className="deal-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? '접기' : `${rest}건 더 보기`}
        </button>
      )}
    </div>
  )
}

function Deals({ deals, med }) {
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
  // 잠정 안내는 접힌 행에도 걸릴 수 있다. 펴 보면 나오는 꼬리표라 미리 설명해 둔다.
  const hasProv = groups.some(([k]) => deals[k].some(prov))
  return (
    <>
      <h3 className="facts-h">최근 거래</h3>
      {/* 판정의 분자는 전세라 전세만 펼친다. 매매·월세는 접되 건수와 중위가
          summary에 남는다. 접혀 있어도 요약이 보여야 숨김이 아니다. */}
      {groups.map(([k, label, fmt]) => k === 'j' ? (
        <DealTable key={k} kind={k} label={label} rows={deals[k]} fmt={fmt} cap={DEAL_CAPS[k]} />
      ) : (
        <details key={k} className="deal-fold">
          <summary>
            {label} {deals[k].length >= DEAL_CAPS[k] ? `최근 ${deals[k].length}건` : `${deals[k].length}건`}
            {k === 's' && med != null ? ` · 2년 중위 ${eok(med)}` : ''}
          </summary>
          <DealTable kind={k} label={label} rows={deals[k]} fmt={fmt} cap={DEAL_CAPS[k]} bare />
        </details>
      ))}
      {hasProv && (
        <p className="fn">
          ※ 잠정: 신고 기한(계약 후 30일)이 아직 안 지난 달의 계약입니다. 늦게 신고되는
          계약이 더 있을 수 있어 위 통계에는 넣지 않았습니다.
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
              {/* 전세가 없는 평형은 보증금 자리를 '-'로 비우지 않는다. 옆 평형과
                  나란히 놓인 줄에서 빈칸은 싸다는 뜻으로 읽힌다. */}
              <b className={s.nj ? undefined : 'muted'}>{s.nj ? eok(s.jeonse) : '전세 없음'}</b>
              <em className={ratioBroken(s.ratio) ? 'muted' : ratioTone(s.ratio)}>
                {s.ratio == null ? '-' : ratioBroken(s.ratio) ? '보류' : pct0(s.ratio)}
              </em>
              <small>{s.nj ? `전세 ${s.nj}건` : `매매 ${s.ns ?? 0}건`}</small>
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
  const overLoan = loan && c > loan.v
    ? `전세자금대출 이자(${loan.v.toFixed(1)}%)를 내는 편이 이 월세보다 쌉니다.`
    : c > dep.v
      ? '월세가 예금 이자보다 비싼 구간입니다. 목돈이 있다면 전세가 계산상 유리합니다.'
      : '예금 이자가 전환율보다 높아, 드물게 월세가 유리한 경우입니다.'
  return (
    <>지금 정기예금(1년) {dep.v.toFixed(1)}%{loan ? `, 전세자금대출 ${loan.v.toFixed(1)}%` : ''}
      (한국은행, {ymKor(dep.ym)}). {overLoan}{' '}</>
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

/**
 * 주요 업무지구까지 걸리는 시간. 집에서 역까지 걸어가는 시간(walk)에 지하철
 * 시간표를 더한다. 시간표는 subway.json에 목적지별로 미리 계산돼 있다.
 *
 * 못 가는 역(그래프가 끊긴 구간)은 그 목적지만 빠진다. 억지로 숫자를 만드느니
 * 말하지 않는 편이 낫다.
 */
export function commuteText(stations, u) {
  const table = stations?.commute
  if (!table || u.stn == null || u.walk == null) return null
  const parts = []
  for (const [dest, times] of Object.entries(table)) {
    const t = times[u.stn]
    if (t == null) continue
    parts.push(`${dest} ${Math.round(u.walk + t)}분`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** 건물 정보. 건축물대장과 좌표 기반 생활정보(역·학교·지형)는 수집 경로가
 *  달라서 따로 왔다 따로 빠진다. 대장이 아직 없어도 생활정보가 있으면
 *  보여 준다 — 대장을 기다리느라 이미 아는 것까지 숨기면 안 된다. */
function BuildingFacts({ u }) {
  // stn 열은 역 번호다. 이름은 지하철 목록에서 찾는다.
  const stations = useSubway()
  // 대장 유무는 대장에서 오는 열 전체로 판정한다. 일부만 보면 "층수는
  // 보이는데 대장은 수집 전"이라는 자기모순 화면이 나올 수 있다.
  const hasBldg = hasBldgData(u)
  const commute = commuteText(stations, u)
  const items = [
    u.apr && ['준공', `${u.apr}년`],
    u.hhld && ['세대수', `${u.hhld}세대`],
    u.flr && ['지상 층수', `${u.flr}층`],
    u.elvt != null && ['승강기', u.elvt ? `${u.elvt}대` : '없음'],
    // 대수만으로는 넉넉한지 알 수 없다. 세대수를 아는 물건은 세대당까지 낸다.
    u.park != null && ['주차', u.park
      ? `${u.park}대${u.hhld ? ` · 세대당 ${parkPer(u.park / u.hhld)}대` : ''}`
      : '없음'],
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
    // 도보 + 지하철. 급행과 배차는 반영하지 못하므로 "약"을 떼지 않는다.
    commute && ['통근 (약, 도보 포함)', commute],
  ].filter(Boolean)
  // 낼 것이 하나도 없으면 이 블록을 아예 안 낸다. 대장이 없다는 사실은 판정
  // 바로 아래에서 이미 말했고, 여기서 또 말하면 같은 화면에 두 번 나온다.
  if (!items.length) return null
  const note = hasBldg ? quietNote(u) : null
  const living = hasBldg ? livingNotes(u) : []
  return (
    <>
      <h3 className="facts-h">건물</h3>
      <ul className="facts">
        {items.map(([k, v]) => (
          // 지형 값은 구조적으로 길다("완만한 오르막 … 역보다 약 18m 높음").
          // 좁은 열에 구겨 넣지 않고 전폭을 준다.
          <li key={k} className={k === '지형' || k.startsWith('통근') ? 'full' : undefined}>
            <span>{k}</span><b>{v}</b>
          </li>
        ))}
      </ul>
      {/* collect_subway.py가 "무엇을 반영하지 못했는지 함께 밝힌다"고 약속했다.
          이 문단이 그 약속을 이행한다. 지울 때는 그쪽 docstring도 함께 볼 것. */}
      {commute && (
        <p className="fn">
          ※ 통근 시간은 역과 역 사이를 각 노선의 평균 속도(정차 시간 포함)로 간다고
          보고 계산한 값입니다. 급행과 배차 간격은 반영하지 못해서, 급행이 서는 먼
          구간은 실제보다 길게, 배차가 뜸한 노선은 짧게 나옵니다.
        </p>
      )}
      {note && (
        <p className="warnline">
          <strong className={note.tone}>층간소음 추정</strong>: {note.text}.{' '}
          실측 소음 자료가 아니라 구조와 준공연도로 미루어 본 것입니다.
        </p>
      )}
      {/* 보증금 위험과는 다른 축이라 warnline을 쓰지 않는다. 이건 경고가 아니라
          살아 보면 매일 만나는 조건이고, 사람에 따라 아무 문제가 아닐 수도 있다. */}
      {living.length > 0 && (
        <p className="muted-line">
          {/* "살 때 겪는 것"이라고 부르면 이게 전부라는 뜻이 된다. 대장이 부분만
              있는 물건이 많아서(주차 자료 없음이 20.8%) 못 본 것과 없는 것이
              뒤섞인다. 완결성을 함의하지 않는 이름을 쓴다. */}
          <strong>눈에 띄는 점</strong>: {living.join('. ')}.
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
  // 전세가 한 건도 없는 건물 앞에 선 사람이 물어야 할 첫 질문이다. 판정으로는
  // 답이 안 나오는 자리라 사람에게 물어보게 넘긴다.
  if (!u.n_jeonse_24m) {
    q.push('이 건물에 최근 2년 전세 계약이 한 건도 없습니다. 앞 세입자가 있었는지, 전세를 안 놓은 이유가 있는지 물어보세요')
  }
  if (u.stage === 'A' && u.n_sale_24m >= 3 && r >= 0.9) {
    q.push('보증금이 이 건물 매매가에 육박합니다. 근저당 잔액과 감액(말소) 조건을 먼저 물어보세요')
  }
  if ((u.ht === 'R' || u.ht === 'O') && !u.n_sale_24m && year >= 2018 && u.n_jeonse_24m >= 5) {
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
        보증금 지킴이 등록
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
         기기에만 저장되며, 등록이 일어났다는 익명 숫자만 집계됩니다.</p>
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
                  if (guard.add(lawd, u, amt, exp)) {
                    // 등록이 일어났다는 사실만 센다. unit_id를 실으면 "어느
                    // 건물에 계약했나"가 기기 밖으로 나가 폼의 "이 기기에만
                    // 저장됩니다" 약속과 충돌한다(CTO 리뷰). cid도 없다.
                    fdTrack('guard_reg', null, null)
                    setOpenForm(false)
                  } else setFull(true)
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
      // 목록이 상한(전세 15건)에 잘린 물건에서 "최근 2년 어느 계약보다"는
      // 검증 안 된 주장이다. 상한 밖의 더 높은 계약이 있었는지 모른다.
      const scope = rows.length >= DEAL_CAPS.j ? `실린 최근 ${rows.length}건의` : '최근 2년'
      if (amt > max) {
        lines.push(<span key="m">이 건물 {scope} 어느 전세 계약보다 높습니다
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
      {/* 전세도 매매도 없는 건물에서는 lines가 빈 배열이 된다. 빈 문단을 그리면
          값을 넣었는데 아무 말도 없는 화면이 되므로, 견줄 것이 없다고 말한다. */}
      {lines?.length
        ? <p>{lines}</p>
        : lines
          ? <p className="muted-line">이 건물에는 견줄 전세·매매 실거래가 없습니다. 같은 동 비슷한 평형과 견주시려면 동네 탭에서 조건으로 찾아 보세요.</p>
          : <p className="muted-line">매물에서 본 보증금을 넣으면 이 건물의 실제 계약과 견줘 드립니다.</p>}
    </div>
  )
}

/**
 * 보고 온 매매 호가 검증. 보증금 검증과 같은 문법의 매수판이다. 호가는
 * 사용자가 부동산에서 들은 값을 직접 넣는다 — 매물 크롤링 없이 성립한다.
 * 전망은 말하지 않는다. 실거래와의 거리라는 사실만 말한다. 견줄 매매가
 * 없는 물건에서는 아예 서지 않는다 — 입력만 받고 아무 말도 못 하는 폼은
 * 없느니만 못하다.
 */
function AskingSale({ u }) {
  const [raw, setRaw] = useState('')
  const amt = raw === '' || isNaN(Number(raw)) ? null : Math.round(Number(raw) * 10000)
  const rows = u.deals?.s ?? []
  if (!rows.length && !u.med_sale) return null
  const amounts = rows.map((r) => r[1])
  const max = amounts.length ? Math.max(...amounts) : null
  // 목록이 상한(매매 10건)에 잘린 물건에서 "어느 계약보다"는 검증 안 된 주장이다.
  const scope = rows.length >= DEAL_CAPS.s ? `실린 최근 ${rows.length}건의` : '최근 2년'

  let lines = null
  if (amt > 0) {
    lines = []
    if (max != null) {
      if (amt > max) {
        lines.push(<span key="m">이 건물 {scope} 어느 매매 계약보다 높습니다
          (최고 {eok(max)} 대비 <strong className="critical">+{Math.round((amt / max - 1) * 100)}%</strong>).
          실거래가 협상의 근거가 됩니다.</span>)
      } else if (u.med_sale && amt > u.med_sale) {
        lines.push(<span key="m">이 건물 매매 중위 {eok(u.med_sale)}보다 높고,{' '}
          {scope} 최고 {eok(max)} 아래입니다.</span>)
      } else if (u.med_sale) {
        lines.push(<span key="m">이 건물 매매 중위 {eok(u.med_sale)} 이하입니다.
          실거래 대비 무리한 호가가 아닙니다.</span>)
      } else {
        lines.push(<span key="m">{scope} 최고 {eok(max)} 아래입니다.</span>)
      }
      const latest = rows[0]
      lines.push(<span key="l"> 가장 최근 매매는 {String(latest[0]).slice(2, 4)}.{String(latest[0]).slice(4, 6)}의 {eok(latest[1])}입니다.</span>)
    } else if (u.med_sale) {
      // 현 빌드에서는 도달 불가다(med_sale이 있으면 deals.s가 비지 않는다,
      // build_units.py:366). 데이터 모양이 바뀌는 날의 안전망으로만 둔다.
      lines.push(<span key="m">이 건물 매매 중위는 {eok(u.med_sale)}입니다.</span>)
    }
    // 표본이 얇으면 그 사실이 판단의 일부다. 세 건으로 만든 중위는 세 건짜리다.
    // 확정 0건(잠정 계약만 실린 물건)도 얇음이다. 게이트로 잠정만으로도
    // critical이 나갈 수 있는데, 그때 경고가 빠지면 한 건짜리 근거가 조용해진다.
    if ((u.n_sale_24m ?? 0) < 3) {
      lines.push(<span key="n"> {u.n_sale_24m
        ? `최근 2년 매매가 ${u.n_sale_24m}건뿐이라 표본이 얇습니다.`
        : ' 확정 집계에 든 매매가 아직 없어 잠정 계약만으로 견줬습니다.'}</span>)
    }
  }

  return (
    <div className="asking">
      <label>
        <b>보고 온 호가 검증</b>
        <span className="asking-in">
          <input type="number" inputMode="decimal" step="0.1" min="0" placeholder="예: 3.5"
                 value={raw} onChange={(e) => setRaw(e.target.value)}
                 aria-label="보고 온 매매 호가(억)" />
          <em>억</em>
        </span>
      </label>
      {lines?.length
        ? <p>{lines}</p>
        : <p className="muted-line">부동산에서 들으신 매매 호가를 넣으면 이 건물의 실제 계약과 견줘 드립니다.</p>}
    </div>
  )
}

/**
 * 공유 링크. /s/{lawd}.{id}는 서버 함수가 받아 이 물건의 판정을 메타에 박은 뒤
 * 앱으로 보낸다. 전에는 ?u= 링크를 그대로 줬는데, 크롤러는 자바스크립트를 안
 * 돌리므로 어느 집이든 첫 화면의 같은 카드가 떴다. 판정을 보여 주려고 복사한
 * 링크에 판정이 없었다.
 *
 * 함수가 죽어도 ?u= 경로는 그대로 살아 있다. 되돌릴 일이 생기면 이 한 줄만
 * 옛 형태로 돌리면 된다.
 *
 * 자리도 옮겼다. 전에는 Verify.jsx 안 카드 밖에 있어서 확인 탭에서만 나왔고,
 * 임장과 동네에서 연 같은 리포트에는 공유가 아예 없었다. 진입 경로에 따라
 * 기능이 달랐던 것이라 카드 안으로 들인다.
 */
/**
 * 공유. 전에는 URL 입력창 + 버튼 한 줄이었는데, 입력창은 정보가 아니라 기능이라
 * 자리만 차지했다. 버튼 하나로 줄여 비교함·지킴이와 같은 줄에 세운다.
 */
function ShareBtn({ lawd, id }) {
  const [done, setDone] = useState(false)
  const url = `${location.origin}/s/${lawd}.${id}`
  return (
    <button className="cmp-btn" onClick={() => {
      navigator.clipboard?.writeText(url).then(() => {
        setDone(true)
        setTimeout(() => setDone(false), 1800)
      })
    }}>{done ? '✓ 링크 복사됨' : '링크 복사'}</button>
  )
}

/** 대장에서 오는 열 전체로 판정한다. 일부만 보면 "층수는 보이는데 대장은
 *  수집 전"이라는 자기모순 화면이 나온다. BuildingFacts와 같은 목록을 쓴다. */
export const hasBldgData = (u) =>
  [u.apr, u.strct, u.hhld, u.flr, u.elvt, u.park, u.n_dong].some((x) => x != null)

/**
 * 판정 다음에 할 일. 숫자를 보여주고 끝나면 읽고 끝난다. 이 앱이 답하지 못하는
 * 부분(등기부·보증보험)으로 가는 문이 판정 바로 아래에 있어야 한다.
 *
 * 전에는 여기 3항목짜리 짧은 판을 두고 같은 화면 4,371px 아래에 7항목짜리 긴
 * 판을 또 뒀다. 짧은 판이 긴 판의 부분집합이라, 짧은 쪽만 본 사람은 갑구
 * (신탁·압류)·전입세대 확인서·세금 체납을 영영 안 봤다. 한 벌로 합친다.
 */
function Actions({ tone, u }) {
  const urgent = tone === 'critical' || tone === 'serious'
  return (
    <div className="todo">
      {/* 질문형 헤더는 겁먹은 사용자가 들고 오는 질문 그대로다. 다만 urgent에서
          질문형은 한가하게 읽히므로 위급 문구를 유지한다. */}
      <b>{urgent ? '계약 전에 반드시' : '계약 전에 무엇을 확인해야 하나요'}</b>
      <p className="todo-lead">
        위 숫자는 <strong>실거래 신고 기록</strong>일 뿐이라, 보증금을 실제로 돌려받을 수
        있는지는 아래를 직접 확인해야 압니다.
      </p>
      {/* 일곱 항목을 한 벌로 합쳤더니 이 블록만 1,082px로 카드의 29%가 됐다.
          항목을 줄이면 다시 "짧은 판만 본 사람이 못 보는" 문제로 돌아가므로,
          무엇을 확인해야 하는지는 일곱 개 다 보이게 두고 왜·어디서만 접는다. */}
      <ul className="checklist">
        {CHECKLIST.map(([what, why, href, where], k) => (
          <li key={what}>
            <details>
              <summary>{what}</summary>
              <p>
                {why}
                {/* 첫 항목에만 이 건물의 숫자를 붙인다. 남의 기준이 아니라 지금 보고
                    있는 건물로 말해야 확인할 것이 구체적으로 잡힌다. 전세가 없는
                    건물은 med_jeonse가 null이라 둘 다 있을 때만 쓴다. */}
                {k === 0 && u.med_sale && u.med_jeonse
                  && ` (이 건물이면 보증금 ${eok(u.med_jeonse)}, 매매가 ${eok(u.med_sale)})`}
              </p>
              <a href={href} target="_blank" rel="noopener noreferrer">{where} ↗</a>
            </details>
          </li>
        ))}
      </ul>
      {urgent && <p className="todo-warn">위 확인이 끝나기 전에는 계약금을 보내지 마세요.</p>}
    </div>
  )
}

/** 계약 패키지 가짜 문. 실제 결제는 없다 — 관심을 익명으로 세어 유료화를
 *  결정한다(수익 모델 v2 검증). 누르면 준비 중임을 바로 정직하게 밝힌다. */
const RPT_PRICE = 14900

/** 사실 리포트에 담기는 것. 카드의 상세와 소개 탭이 같은 내용을 말해야 한다.
 *  전망이나 추천은 한 줄도 없다. 파는 것은 "이 특정 거래에서 손해 보지
 *  않는가"를 실거래와 대장의 사실로 확인해 주는 한 부의 문서다. 항목은
 *  물건마다 실제로 낼 수 있는 것만 문구에 올린다 — 없는 데이터를 목록에
 *  적으면 그 줄이 거짓말이 된다. */
export const RPT_ITEMS = [
  '최근 2년 실거래 전체 이력과 매매 가격대',
  '보고 온 호가와 실거래의 차이를 날짜와 함께 지면에 남긴 기록',
  '등기부등본에서 확인할 목록',
]
export const RPT_ITEM_BLDG = '건축물대장 원문 사실 (위반건축물 표기, 구조, 승강기, 주차)'
// 지형과 역은 파이프라인이 따로라 독립적으로 빠진다(경사만 있고 역이 먼 물건,
// 그 반대). 한 항목으로 묶으면 절반이 거짓인 줄이 생겨서 게이트를 따로 건다.
export const RPT_ITEM_TERRAIN = '언덕 여부와 주변 경사'
export const RPT_ITEM_STN = '역까지 도보, 지하철로 닿는 업무지구 통근 시간'

// 출시 전 반드시 할 것: 문서에 계약 조항이나 법 절차 안내를 담으면 성격이
// 달라진다. 사실(실거래·대장)만 담고, "법률 자문이 아닙니다 / 대한법률구조공단
// 132" 고지를 넣고, 출시 전 법률 검토를 한 번 받는다.
// 위반건축물 표기는 현 수집 파이프라인에 없는 필드다. 출시 시 건당 대장
// 원문(표제부)을 열람해 채우는 절차가 상품 원가에 들어간다 — 채우지 못하면
// 이 항목을 문구에서 빼야 한다.
function FactReportOffer({ u }) {
  // idle(제안만) -> detail(자세히 펼침) -> applied(준비 중 공개)
  const [stage, setStage] = useState('idle')
  const [wait, setWait] = useState(() => {
    try { return !!localStorage.getItem('nec-rpt-wait') } catch { return false }
  })
  // view는 "카드가 열림"이 아니라 "제안이 실제로 화면에 보임"을 센다.
  // 카드가 길어서 여기까지 스크롤하지 않은 사람을 노출로 치면 클릭률이 왜곡된다.
  const boxRef = useRef(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      fdTrack('view', u.id, RPT_PRICE)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        fdTrack('view', u.id, RPT_PRICE)
        io.disconnect()
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [u.id])
  const onWait = () => {
    fdTrack('notify', u.id, RPT_PRICE)
    try { localStorage.setItem('nec-rpt-wait', '1') } catch { /* 표시용 플래그일 뿐 */ }
    setWait(true)
  }
  // 항목은 이 물건에서 실제로 낼 수 있는 것만 문구에 올린다. 대장이 없는
  // 물건에 "건축물대장 원문"을 적으면 그 줄이 거짓말이 된다.
  const items = [
    ...RPT_ITEMS,
    ...(hasBldgData(u) ? [RPT_ITEM_BLDG] : []),
    ...(u.slope != null ? [RPT_ITEM_TERRAIN] : []),
    ...(u.walk != null ? [RPT_ITEM_STN] : []),
  ]
  return (
    <div className="pkg" ref={boxRef}>
      <b>매수를 검토 중이신가요 · 이 집 사실 리포트</b>
      <p>
        이 건물의 실거래와 공적 장부의 사실만 모아 한 부의 문서로 드립니다.
        오를지 내릴지는 저희가 알 수 없어 적지 않습니다. 호가 검증은 위에서
        무료로 하실 수 있고, 리포트는 그 결과를 날짜와 함께 문서로 남겨
        협상 자리에서 내밀 수 있게 해 드립니다.
      </p>
      <div className="pkg-row">
        <span className="pkg-price">{RPT_PRICE.toLocaleString()}원 <small>한 번 결제</small></span>
        {stage === 'idle' && (
          <button className="cmp-btn" onClick={() => { fdTrack('click', u.id, RPT_PRICE); setStage('detail') }}>
            리포트 신청하기
          </button>
        )}
      </div>
      {stage !== 'idle' && (
        <div className="pkg-detail">
          <b>리포트에 담기는 것</b>
          <ul className="pkg-list">
            {items.map((t) => <li key={t}>{t}</li>)}
          </ul>
          {stage === 'detail' && (
            <button className="cmp-btn" onClick={() => { fdTrack('apply', u.id, RPT_PRICE); setStage('applied') }}>
              신청하기
            </button>
          )}
        </div>
      )}
      {stage === 'applied' && (
        <div className="pkg-note">
          {/* 기기 번호(cid)는 이 화면의 이벤트에만 실린다. 이 고지가 그 근거다. */}
          <b>아직 준비 중인 기능입니다</b>
          <p>
            지금은 수요를 확인하는 단계라 결제가 열려 있지 않습니다. 눌러 주신
            관심은 익명으로 집계되어 출시를 결정하는 근거가 됩니다. 판정과
            실거래 근거는 지금도 이 화면에서 전부 무료로 보실 수 있습니다.
          </p>
          {wait
            ? <p className="muted-line">출시되면 이 기기의 앱 화면에서 알려드리겠습니다.</p>
            : <button className="more" onClick={onWait}>출시되면 알려주세요</button>}
        </div>
      )}
    </div>
  )
}

export function UnitCard({ u, lawd, guNames, onClose, onMap, onSibling, rank, compare, guard, pctOf }) {
  const v = verdict(u)
  const st = STAGE[u.stage] ?? STAGE.C
  const nq = placeQuery(lawd, guNames?.[lawd], u.umd, u.jibun)
  const nmap = naverSearchUrl(nq)
  return (
    <div className="card unit-detail">
      <button className="close" onClick={onClose} aria-label="닫기">✕</button>
      <h2>{u.name || '(이름 없음)'}</h2>
      {/* 카드의 헤드라인은 건물 이름이 아니라 판정이다. 이름과 주소는 문맥이라
          판정보다 조용해야 한다. 면적은 항상 전용이라 값은 참이지만,
          "전용" 라벨을 넣으면 390px에서도 두 줄로 감긴다(실측 40px).
          한 줄이 우선이라 라벨 없이 둔다. */}
      <p className="sub sub-tight">
        {u.umd} {u.jibun} · {u.area}m²({(u.area / 3.305785).toFixed(1)}평)
        {u.build_year ? ` · ${u.build_year}년` : ''}
      </p>

      {/* 이 카드의 결론 숫자는 여기 하나다. verdict()가 num을 줄 때만 크게
          세우고, 실측 숫자가 없는 판정은 문장만 남는다. 지어낼 숫자가 없으면
          큰 숫자도 없는 것이 맞다. */}
      <div className={`verdict ${v.tone}`}>
        <strong>{(() => {
          const i = v.num ? v.head.indexOf(v.num) : -1
          return i < 0 ? v.head : (
            <>{v.head.slice(0, i)}<em className="v-num">{v.num}</em>{v.head.slice(i + v.num.length)}</>
          )
        })()}</strong>
        <span>{v.body}</span>
      </div>

      {/* 건축물대장이 없으면 준공·세대수·구조·승강기·주차가 통째로 빈다. 경기는
          아직 0%라 그쪽 이용자에게는 늘 비어 있다. 전에는 그 사실이 카드
          3,733px 아래에 14px 회색으로만 있어서, 화면이 조용한 것을 "그런 건물"로
          읽게 만들었다. 판정 바로 옆에서 밝힌다. */}
      {!hasBldgData(u) && (
        <p className="muted-line">
          이 건물은 <strong>건축물대장이 아직 수집 전</strong>이라 준공·세대수·구조·승강기·주차를
          보여 드리지 못합니다. 위 판정은 실거래만으로 낸 것이고, 건물 자체의 문제는
          여기서 알 수 없습니다. 정부24에서 무료로 발급받아 확인하실 수 있습니다.
        </p>
      )}

      {/* 판정을 무효화하는 정보는 접을 수 없다. 판정 바로 아래 선다. */}
      {ratioBroken(u.ratio) && (
        <p className="warnline">
          <strong className="serious">비교 기준이 정상이 아닙니다.</strong> 계산하면
          {' '}{pct0(u.ratio)}가 나오는데, 이런 값은 전세가율이 높다기보다 비교에 쓴 매매가가
          이 집의 시세가 아니라는 뜻입니다{u.n_sale_24m === 1 ? ' (매매 단 1건 기준)' : ''}.
          지분 거래나 특수관계인 거래가 섞였을 수 있습니다. 등기부등본으로 직접 확인하세요.
        </p>
      )}

      {/* 전세가 없어 계산 접힘이 안 생기는 물건의 직거래 경고. 접힘으로 옮기면서
          이 갈래에서 통째로 사라졌었다(실측 14,293개, 전체의 4.4%). 판정 본문이
          "매매 1건 (중위 4.65억)"을 사실로 인용하는데 그 1건이 직거래 100%인
          물건도 있다. 인용한 중위가가 시세가 아닐 수 있다는 유일한 단서다. */}
      {!u.n_jeonse_24m && u.direct_share > 0 && (
        <p className="warnline">
          최근 매매 중 <strong>직거래 {pct0(u.direct_share)}</strong>. 특수관계인 간 거래가 섞이면
          시세가 실제보다 낮거나 높게 잡힙니다.
        </p>
      )}

      {/* 스탯 스트립. 전세가율은 판정 헤드라인이 이미 34px로 세웠으므로 여기서는
          빠지고, 판정에 숫자가 없는 갈래(추정치·판단 보류)에서만 첫 칸에 선다.
          한 화면에 결론 숫자는 하나라는 규율이다. 칸의 출처·부연은 아래
          "어떻게 계산했나요" 접힘으로 내려갔다. */}
      <dl className="metrics">
        {!v.num && u.ratio != null && (
          <div>
            <dt>전세가율</dt>
            <dd className={`big ${ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}`}>
              {ratioBroken(u.ratio) ? '판단 보류'
                : st.exact ? pct0(u.ratio) : `약 ${pct0(u.ratio)}`}
            </dd>
          </div>
        )}
        <div>
          <dt>중위 전세</dt>
          <dd>{eok(u.med_jeonse)}</dd>
        </div>
        <div>
          <dt>중위 매매</dt>
          <dd>{eok(u.med_sale)}</dd>
        </div>
        <div>
          <dt>갱신 시</dt>
          <dd className={u.renew_hike != null && u.renew_hike <= -0.05 ? 'serious' : ''}>
            {signed(u.renew_hike)}
          </dd>
        </div>
      </dl>

      {/* 어떻게 계산했나요. 근거 단계·표본 수·추세·추정 오차·직거래 경고가 전부
          여기 산다. 흩어져 있던 정직성 문단들의 한 주소다. 접혀 있어도 요약이
          보인다는 것이 규율이다. 특히 인근 추정치라는 사실과 직거래 비중은
          판정을 흔드는 정보라 접힌 상태의 summary에 남는다. */}
      {u.n_jeonse_24m > 0 && (
        <details className="calc">
          <summary>
            어떻게 계산했나요
            {/* 단계는 A/B/B-/C 넷이다. C는 이 건물에도 인근에도 견줄 매매가 없어
                ratio가 null로 빌드된다(실측 7,705개). 거기에 "인근 추정치"라고
                쓰면 추정한 적 없는 물건에 거짓말을 하는 것이다. */}
            {u.ratio == null ? (
              <span> · 전세가율은 못 냈습니다</span>
            ) : (
              <span className={st.exact ? undefined : 'serious'}>
                {' '}· {st.exact ? '이 건물 실거래 기준' : '인근 추정치입니다'}
              </span>
            )}
            {u.direct_share > 0
              ? <span className="serious"> · 직거래 {pct0(u.direct_share)}</span>
              : u.n_sale_24m ? <span> · 매매 {u.n_sale_24m}건</span> : ''}
          </summary>
          <div className="calc-body">
            <p>
              {u.ratio == null
                ? '이 건물에도 인근 비슷한 물건에도 견줄 매매가 없어 전세가율을 내지 못했습니다. '
                : <>전세가율은 보증금을 매매가로 나눈 값입니다. {st.label}
                    {u.n_comps ? ` · 비교 매매 ${u.n_comps}건` : ''}으로 계산했고, </>}
              이 건물의 최근 2년 신고는 전세 {u.n_jeonse_24m}건
              {u.n_sale_24m ? ` · 매매 ${u.n_sale_24m}건` : ' · 매매 없음'}
              {u.n_wolse_24m ? ` · 월세 ${u.n_wolse_24m}건` : ''}입니다.
              {u.renew_hike != null && ' 갱신 시 보증금은 직전 계약 대비 중위값입니다.'}
            </p>
            {rank && (
              <p>{rank.umd} 비슷한 평형 {rank.n}건 중 비싼 쪽에서 {rank.pct}%입니다.</p>
            )}
            {u.ratio_prev != null && u.ratio != null && !ratioBroken(u.ratio) && (
              <p>
                직전 2년 전세가율은 {pct0(u.ratio_prev)}였고,{' '}
                <strong className={u.ratio > u.ratio_prev + 0.03 ? 'serious' : ''}>
                  {u.ratio > u.ratio_prev + 0.03 ? `${Math.round((u.ratio - u.ratio_prev) * 100)}%p 올랐습니다`
                    : u.ratio < u.ratio_prev - 0.03 ? `${Math.round((u.ratio_prev - u.ratio) * 100)}%p 내렸습니다`
                    : '큰 변화 없습니다'}
                </strong>.
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
          </div>
        </details>
      )}

      <Asking u={u} pctOf={pctOf} />
      <AskingSale u={u} />

      <Actions tone={v.tone} u={u} />

      <Siblings u={u} onPick={onSibling} />
      <Wolse deals={u.deals} jeonse={u.med_jeonse} />
      <Deals deals={u.deals} med={u.med_sale} />
      <BuildingFacts u={u} />

      {/* 둘 다 "눌렀는데 아무 데도 안 가면 안 만든 것만 못하다"를 따른다. 다만
          근거가 다르다. 안쪽 지도는 좌표가 있어야 하고(onMap을 안 넘기는 화면도
          있다. 이미 지도 위라서다), 네이버는 지번이 주소 꼴이어야 한다. */}
      {(onMap || nmap) && (
        <div className="go-row">
          {onMap && <button className="more" onClick={onMap}>지도로 보기</button>}
          {/* noreferrer는 취향이 아니라 약속이다. 이걸 지우면 ?u={lawd}.{id}가
              올라온 주소창에서 눌렀을 때 어느 물건을 봤는지가 네이버로 간다. */}
          {nmap && (
            <a className="more more-out" href={nmap} target="_blank" rel="noopener noreferrer">
              네이버 지도 ↗
            </a>
          )}
        </div>
      )}
      {/* 검색어를 그대로 적는다. 이 방식의 값어치는 정확도가 아니라 틀렸을 때
          티가 난다는 것인데, 검색어가 네이버 화면에만 뜨면 누른 뒤에야 안다.
          여기 박아 두면 이상한 주소를 누르기 전에 알아본다. 방법 해설이라
          각주 크기로 내리되 검색어와 한계는 다 남긴다. */}
      {nmap && (
        <p className="fn">
          ※ 네이버 지도에서 <strong>{nq}</strong>로 검색해 거리뷰로 골목과 건물 겉모습을
          미리 볼 수 있습니다. 주소를 못 찾거나 한 지번에 건물이 여럿이면 옆 건물이 나올
          수 있고, 촬영 시점은 저희가 알 수 없으며 안 찍힌 골목도 있습니다.
        </p>
      )}

      {/* 담아 두기와 감시 걸기. 판정을 읽기 전에 물으면 위험한지 모르는 집을
          먼저 파일링하라는 말이 된다. 전에는 이름 바로 밑에 있었다. */}
      {lawd && (compare || guard || u.id) && (
        <div className="save-row">
          {compare && (
            <button className="cmp-btn" aria-pressed={compare.has(u.id)}
                    onClick={() => compare.toggle(lawd, u.id, u.name || u.jibun)}>
              {compare.has(u.id) ? '✓ 비교함에 담김' : '비교함에 담기'}
            </button>
          )}
          {guard && <GuardAdd u={u} lawd={lawd} guard={guard} />}
          {u.id && <ShareBtn lawd={lawd} id={u.id} />}
        </div>
      )}

      {/* v3 가짜 문은 매매 신고가 있는 물건에만 선다. 매매 밴드가 성립해야
          리포트 항목이 참이고, 이 자리의 클릭률이 곧 "트래픽 중 매수 의도
          비율"의 첫 계기판이다(docs/수익모델-검토-2026-08.md). */}
      {u.n_sale_24m > 0 && <FactReportOffer u={u} />}
    </div>
  )
}
