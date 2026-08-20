import { useEffect, useRef, useState } from 'react'
import { CHECKLIST, latestRate, useRates, ym as ymKor, useSubway } from './units.js'
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
 * 오피스텔도 같은 결이다: 개별 호실 매매가 얇고, 신축에 전세만 채우는
 * 전세사기 패턴이 다세대와 함께 가장 잦은 유형이다.
 */
function verdict(u) {
  const villa = u.ht === 'R' || u.ht === 'O'
  // 아래 수치 문장("빌라 중 1%" 등)은 전부 연립다세대 실측이다. 오피스텔에
  // 그대로 인용하면 지어낸 숫자가 되므로, 수치는 R에만 붙인다. 오피스텔
  // 실측은 백필이 끝난 뒤 재서 따로 단다.
  //
  // 분모는 전부 "최근 2년 전세 신고가 있는" 물건이다. 데이터셋이 매매·월세만
  // 있는 건물까지 담게 되면서 앱 안의 "빌라 전체"와 이 분모가 갈라졌고,
  // 그냥 "빌라 중"이라고 쓰면 앱이 자기 화면으로 자기 문장을 반증한다.
  // 서울·경기 실측(2026-08, 전세 있는 물건 기준):
  //   빌라 96,608개 - 매매 0건 70.1%, 신축·매매0·전세5건↑ 959개(1.0%),
  //                   매매 3건↑에 전세가율 100% 미만 3,253개(3.4%)
  //   아파트 35,323개 - 매매 0건 22.2%
  // 예전에 "아파트 열에 셋"이라고 쓴 것은 서울만 재던 시절 값(30.7%)이다.
  // 경기가 13.3%라 합치면 열에 둘이다.
  const isR = u.ht === 'R'
  const year = u.apr ?? u.build_year
  const young = year >= 2018
  // 비교 기준이 깨진 값(≥150%)은 위험 판정에 쓰지 않는다. 아래에서 따로 "판단 보류"로 나간다.
  const r = ratioBroken(u.ratio) ? null : u.ratio
  const solid = u.stage === 'A' && u.n_sale_24m >= 3

  // 최근 2년 전세 신고가 없는 건물. 전세가율은 보증금을 매매가로 나눈 값이라
  // 분자가 없으면 낼 수가 없다. 이럴 때 아래 판정들이 조용히 초록이나 회색을
  // 켜면 "재 봤더니 괜찮더라"로 읽힌다. 재지 못했다고 먼저 말한다.
  if (!u.n_jeonse_24m) {
    const have = [
      u.n_sale_24m ? `최근 2년 매매 ${u.n_sale_24m}건${u.med_sale ? ` (중위 ${eok(u.med_sale)})` : ''}` : null,
      u.n_wolse_24m ? `월세 ${u.n_wolse_24m}건` : null,
    ].filter(Boolean)
    return { tone: 'muted', head: '이 건물은 최근 2년 전세 계약이 없습니다',
      // have가 괄호로 끝날 수 있어서 조사를 뒤에 바로 붙이지 않는다.
      body: (have.length ? `${have.join(', ')}. 전세 신고가 없어 ` : '전세 신고가 없어 ')
        + '전세가율을 낼 수 없습니다. 안전하다는 뜻도 위험하다는 뜻도 아닙니다. '
        + '견줄 전세 계약이 없으니 등기부와 보증보험 가입 가능 여부를 먼저 확인하세요.' }
  }

  // 실거래로 확인된 깡통. 증거가 가장 두꺼운 위험이라 다른 무엇보다 먼저 온다.
  // 여기서 초록을 켜면 이 앱이 존재하는 이유와 정확히 반대의 일을 하는 것이다.
  if (solid && r >= 1.0) {
    return { tone: 'critical',
      head: `보증금이 이 건물 매매가보다 ${Math.round((r - 1) * 100)}% 높습니다`,
      body: `최근 2년 이 건물 매매 ${u.n_sale_24m}건으로 확인된 값입니다. 추정이 아닙니다. `
        + '집이 경매로 넘어가면 낙찰가는 보통 시세보다 낮게 잡히므로, 이 상태로는 '
        + '보증금 전액을 돌려받기 어렵습니다.' }
  }
  // 헤드에 결론까지 넣는다. good 분기가 같은 템플릿("보증금이 이 건물 매매가의
  // N%입니다")을 쓰므로, 이 문장만으로는 색 없이 두 판정이 구분되지 않는다.
  if (solid && r >= 0.9) {
    return { tone: 'serious',
      head: `보증금이 매매가의 ${pct0(r)}로 여유가 거의 없습니다`,
      body: `최근 2년 매매 ${u.n_sale_24m}건으로 확인된 값입니다. 집값이 조금만 내려도 `
        + '보증금이 매매가를 넘어섭니다. 여유가 거의 없는 계약입니다.' }
  }

  // 신축인데 매매가 한 건도 없고 전세만 여럿. 전세 있는 빌라 96,608개 중
  // 959개(1.0%)뿐이고, 전세사기 물건에서 반복적으로 나온 모양이다.
  // 70%짜리 기준선과 섞으면 안 된다.
  if (villa && !u.n_sale_24m && young && u.n_jeonse_24m >= 5) {
    return { tone: 'critical', head: '신축인데 매매가 없고 전세만 여럿입니다',
      body: `${year}년 준공, 최근 2년 전세 ${u.n_jeonse_24m}건, 매매 0건. `
        + (isR ? '전세 신고가 있는 빌라 중 1%만 이 모양입니다. ' : '')
        + '시세를 확인할 길이 없는 상태에서 보증금만 '
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
    // 빌라에서 매매 0건은 열에 일곱이다(전세 있는 빌라 기준). 여기에 빨간불을
    // 켜면 정보가 아니라 벽지가 된다.
    return villa
      ? { tone: 'muted', head: '담보 가치를 실거래로 확인할 수 없습니다',
          body: '최근 2년 이 건물 매매 0건입니다. '
            + (isR ? '빌라에서는 흔한 일이라 전세 신고가 있는 빌라 열에 일곱이 그렇습니다. '
                   : '오피스텔에서 개별 호실 매매는 드뭅니다. ')
            + '이 집이 위험하다는 뜻이 아니라, 견줄 매매가가 없다는 뜻입니다. '
            + '아래 확인 항목을 직접 보셔야 합니다.' }
      : { tone: 'serious', head: '아파트인데 최근 2년 매매가 없습니다',
          body: '전세 신고가 있는 아파트 열에 둘뿐인 경우입니다. '
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
    return { tone: 'serious',
      head: `매매 ${u.n_sale_24m}건뿐이라 전세가율이 흔들립니다`,
      body: `최근 2년 이 건물 매매가 ${u.n_sale_24m}건이라, 아래 전세가율은 그 한두 건에 `
        + '좌우됩니다. 그 거래가 지분 거래나 특수관계인 거래였다면 값이 통째로 흔들립니다.' }
  }

  /**
   * 비교 기준이 깨진 값. 여기가 없어서 이 물건들이 good으로 떨어져 초록불을
   * 켜고 있었다. 실측: 전세가율 150% 이상이 서울 604 + 경기 794개인데, 그중
   * 매매 3건 이상이라 초록으로 나가던 것이 34개다. 조원동 639-30은 265.6%인데
   * "실거래로 가격을 확인할 수 있는 드문 경우"라고 적혔다.
   *
   * **자리가 중요하다.** 처음에 이 블록을 매매 0건 분기 앞에 뒀다가 리뷰에서
   * 잡혔다. 그러면 도달 집합이 34건이 아니라 1,212건이 되고 그중 1,069건(88%)이
   * 이 건물 매매 0건짜리다. 그 물건들에게 "이 건물 매매가로 나누면"이라고 말하면
   * 거짓이다. 값은 인근 유사 물건에서 온 추정치이고, 같은 카드 40px 아래
   * metrics가 "중위 매매가 - 사례 없음"이라고 자기 화면으로 반증한다.
   *
   * 더 나쁜 것은 비율을 안 쓰는 증거 판정 둘(아파트 매매 0건 101건, 매매
   * 1~2건 표본 얇음 109건)까지 삼켜 210건이 serious에서 muted로 내려간 것이다.
   * Actions의 urgent가 tone으로 갈리므로 "위 확인이 끝나기 전에는 계약금을
   * 보내지 마세요"가 통째로 사라졌다. 전세가율 763%짜리 숭인동 715-1에서도.
   *
   * 그래서 표본 관련 분기를 전부 지난 뒤, 마지막 추정 비율 판정 앞에 둔다.
   * 여기 도달하면 n_sale_24m >= 3이라 "이 건물 매매가"가 사실이 된다.
   */
  if (ratioBroken(u.ratio)) {
    return { tone: 'muted', head: '전세가율을 낼 수 없습니다',
      body: `보증금을 이 건물 매매가로 나누면 ${pct0(u.ratio)}가 나옵니다. 이 값은 `
        + '비교 기준이 깨졌다는 뜻이지 그만큼 위험하다는 뜻이 아닙니다. 전용면적이 크게 '
        + '다른 호실끼리 견줬거나 그 매매가 지분·특수 거래였을 때 이런 값이 납니다. '
        + '안전하다는 뜻도 아닙니다. 등기부로 직접 확인하셔야 합니다.' }
  }


  // 매매는 있는데 비율이 인근 기준으로 잡힌 드문 조합. 100%를 넘으면 초록일 수 없다.
  if (r >= 1.0) {
    return { tone: 'serious', head: `추정 전세가율이 ${pct0(r)}입니다`,
      body: '보증금이 집값에 육박하거나 넘는 구간입니다. 등기부와 보증보험 가입 가능 '
        + '여부를 확인하기 전에는 계약하지 마세요.' }
  }

  // 헤드라인은 결론을 말한다. 표본 수는 근거라 본문으로 내린다. 이 자리에서
  // "매매 131건"이 초록으로 크게 서면, 읽는 사람은 건수가 좋은 소식인 줄 안다.
  // r은 여기서 절대 null이 아니다. 매매 3건 이상이면 빌더가 med_sale을 채우고,
  // 깨진 값은 바로 위에서 빠진다(실측: 전세 있고 매매 3건 이상인 27,500행 중
  // ratio가 null인 행 0건). 그래서 폴백 문장을 두지 않는다.
  return { tone: 'good',
    head: `보증금이 이 건물 매매가의 ${pct0(r)}입니다`,
    body: `최근 2년 이 건물 매매 ${u.n_sale_24m}건으로 확인된 값입니다. `
      + (isR ? '전세 신고가 있는 빌라 중 3%만 여기 해당하는 드문 경우입니다.'
             : '실거래로 가격을 확인할 수 있는 물건입니다.')
      + (r >= 0.8 ? ' 다만 여유가 넉넉하지는 않습니다.' : '') }
}

/**
 * 이 값을 넘으면 전세가율이 아니라 비교 기준이 깨진 것으로 본다.
 * 실측: 매매 3건 이상인 물건 10,418개의 최대가 209%였다. 763%짜리는 보증금 2.9억에
 * 매매 1건이 붙은 경우였는데, 그 한 건은 지분 거래나 특수 거래일 가능성이 크다.
 * 이런 값을 퍼센트로 내보이면 정확히 잰 숫자처럼 읽힌다. 그게 제일 나쁘다.
 */
export const RATIO_BROKEN = 1.5
export const ratioBroken = (r) => r != null && r >= RATIO_BROKEN

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
const DEAL_CAPS = { j: 15, s: 10, w: 12 }

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
          <h4>{label} <small>
            {deals[k].length >= DEAL_CAPS[k] ? `최근 ${deals[k].length}건` : `${deals[k].length}건`}
          </small></h4>
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

/**
 * 주요 업무지구까지 걸리는 시간. 집에서 역까지 걸어가는 시간(walk)에 지하철
 * 시간표를 더한다. 시간표는 subway.json에 목적지별로 미리 계산돼 있다.
 *
 * 못 가는 역(그래프가 끊긴 구간)은 그 목적지만 빠진다. 억지로 숫자를 만드느니
 * 말하지 않는 편이 낫다.
 */
function commuteText(stations, u) {
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
        <p className="muted-line">
          통근 시간은 역과 역 사이를 각 노선의 평균 속도(정차 시간 포함)로 간다고
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

/** 대장에서 오는 열 전체로 판정한다. 일부만 보면 "층수는 보이는데 대장은
 *  수집 전"이라는 자기모순 화면이 나온다. BuildingFacts와 같은 목록을 쓴다. */
const hasBldgData = (u) =>
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
      <b>{urgent ? '계약 전에 반드시' : '계약 전에 확인'}</b>
      <p className="todo-lead">
        위 숫자는 <strong>실거래 신고 기록</strong>일 뿐입니다. 보증금을 실제로 돌려받을 수
        있는지는 아래를 직접 확인해야 알 수 있고, 여기서는 볼 수 없습니다.
      </p>
      <ul className="checklist">
        {CHECKLIST.map(([what, why, href, where], k) => (
          <li key={what}>
            <b>{what}</b>
            <span>
              {why}
              {/* 첫 항목에만 이 건물의 숫자를 붙인다. 남의 기준이 아니라 지금 보고
                  있는 건물로 말해야 확인할 것이 구체적으로 잡힌다. 전세가 없는
                  건물은 med_jeonse가 null이라 둘 다 있을 때만 쓴다. */}
              {k === 0 && u.med_sale && u.med_jeonse
                && ` (이 건물이면 보증금 ${eok(u.med_jeonse)}, 매매가 ${eok(u.med_sale)})`}
            </span>
            <a href={href} target="_blank" rel="noopener noreferrer">{where} ↗</a>
          </li>
        ))}
      </ul>
      {urgent && <p className="todo-warn">위 확인이 끝나기 전에는 계약금을 보내지 마세요.</p>}
    </div>
  )
}

/** 계약 패키지 가짜 문. 실제 결제는 없다 — 관심을 익명으로 세어 유료화를
 *  결정한다(수익 모델 v2 검증). 누르면 준비 중임을 바로 정직하게 밝힌다. */
const PKG_PRICE = 19900

/** 리포트·감시에 담기는 것. 카드의 상세와 소개 탭이 같은 내용을 말해야 한다.
 *  읽고 마는 자료가 아니라 계약 자리에서 내밀 수 있는 문서로 쓴다. 세입자가
 *  감정이 아니라 실거래로 말하게 하는 것이 이 상품의 쓰임이다. */
export const PKG_REPORT_ITEMS = [
  '이 물건에서 요구할 수 있는 실거래 근거',
  '계약 자리에서 물어볼 질문',
  '등기부등본에서 확인할 목록',
  '계약서에 넣어 달라고 할 특약 문구',
]
export const PKG_GUARD_ITEMS = [
  '실거래 전량을 만기까지 상시 감시',
  '내 보증금보다 낮은 신규 전세 즉시 경보',
  '갱신요구권 통보 기한 등 만기 일정 알림',
]

/**
 * 협상 문서에 들어갈 한 문장. 예시를 지어내지 않고 이 물건의 실제 값으로 만든다.
 * 물건 카드 안에서 남의 숫자를 보여 주면 자기 물건 값으로 읽힌다.
 *
 * 요구할 수 있는 것이 물건마다 다르다. 시세를 확인할 수 없는 집에 보증금 조정을
 * 말하는 건 근거가 없고, 안전한 집이라도 권리 설정 특약은 누구에게나 필요하다.
 */
function pkgQuote(u) {
  if (!u.n_sale_24m) {
    return '이 건물은 최근 2년 매매 신고가 없어 시세를 확인할 수 없습니다. '
      + '보증보험 가입이 불가하면 계약을 해제하고 계약금을 반환한다는 특약을 넣어 주시기 바랍니다.'
  }
  const r = ratioBroken(u.ratio) ? null : u.ratio
  if (u.stage === 'A' && u.n_sale_24m >= 3 && r != null && r >= 0.8) {
    return `이 건물 최근 2년 실거래 ${u.n_sale_24m}건 기준 전세가율이 ${pct0(r)}입니다. `
      + '보증금 조정이나 보증보험 가입 가능 조건을 계약서에 넣어 주시기 바랍니다.'
  }
  return '잔금일 다음 날까지 근저당 등 권리를 설정하지 않는다는 특약을 넣어 주시기 바랍니다. '
    + '위반 시 계약 해제와 손해배상 조건도 함께 요청합니다.'
}

// 출시 전 반드시 할 것: 유상으로 개별 물건에 맞춘 문서에 계약 조항을 담으면
// 성격이 달라진다. 조항은 표준 예문으로만 유지하고, 문서에 법·제도 카드와 같은
// "법률 자문이 아닙니다 / 대한법률구조공단 132" 고지를 넣고, 법률 검토를 한 번 받는다.
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
      <b>계약 패키지 · 협상 근거와 2년 감시</b>
      <p>
        보증금을 조정하거나 특약을 요구하려면 근거가 필요합니다. 이 건물의
        실거래로 만든 협상 근거를 한 부의 문서로 드립니다. 중개사와 집주인에게
        그대로 보여 주실 수 있고, 계약 후 2년 동안은 감시가 이어집니다.
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
          <p className="pkg-quote">
            이 물건이라면 이렇게 씁니다. &ldquo;{pkgQuote(u)}&rdquo;
          </p>
          <b>2년 감시가 하는 일</b>
          <ul className="pkg-list">
            {PKG_GUARD_ITEMS.map((t) => <li key={t}>{t}</li>)}
          </ul>
          {stage === 'detail' && (
            <button className="cmp-btn" onClick={() => { fdTrack('apply', u.id, PKG_PRICE); setStage('applied') }}>
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
            관심은 익명으로 집계되어 출시를 결정하는 근거가 됩니다. 판정 근거는
            지금도 이 화면에서 전부 무료로 보실 수 있습니다.
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

      <div className={`verdict ${v.tone}`}>
        <strong>{v.head}</strong>
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

      <dl className="metrics">
        <div>
          <dt>전세가율</dt>
          <dd className={`big ${ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}`}>
            {u.ratio == null ? '-'
              : ratioBroken(u.ratio) ? '판단 보류'
              : st.exact ? pct0(u.ratio) : `약 ${pct0(u.ratio)}`}
          </dd>
          {/* 전세가 없으면 근거 단계는 매겨져 있어도 쓸 데가 없다. "인근 유사 물건
              기준"만 남으면 무언가를 재 놓고 안 보여 주는 것처럼 읽힌다. */}
          <small>{u.n_jeonse_24m ? `${st.label}${u.n_comps ? ` · 매매 ${u.n_comps}건` : ''}`
            : '전세 신고가 없어 낼 수 없습니다'}</small>
        </div>
        <div>
          <dt>중위 전세보증금</dt>
          <dd>{eok(u.med_jeonse)}</dd>
          <small>
            {u.n_jeonse_24m ? `최근 2년 ${u.n_jeonse_24m}건` : '최근 2년 전세 신고 없음'}
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

      <Asking u={u} pctOf={pctOf} />

      <Actions tone={v.tone} u={u} />

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

      {/* 담아 두기와 감시 걸기. 판정을 읽기 전에 물으면 위험한지 모르는 집을
          먼저 파일링하라는 말이 된다. 전에는 이름 바로 밑에 있었다. */}
      {(compare || guard) && lawd && (
        <div className="save-row">
          {compare && (
            <button className="cmp-btn" aria-pressed={compare.has(u.id)}
                    onClick={() => compare.toggle(lawd, u.id, u.name || u.jibun)}>
              {compare.has(u.id) ? '✓ 비교함에 담김' : '+ 비교함에 담기'}
            </button>
          )}
          {guard && <GuardAdd u={u} lawd={lawd} guard={guard} />}
        </div>
      )}

      <PkgOffer u={u} />
    </div>
  )
}
