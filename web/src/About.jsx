import { useEffect, useRef, useState } from 'react'
import { useInsights } from './Insight.jsx'
import { bldgAt, bldgLate, collectLate, kstDay } from './units.js'
import { fdTrack } from './fakedoor.js'
import { RPT_ITEMS, RPT_ITEM_BLDG } from './UnitLookup.jsx'

/**
 * 서비스 소개. 기존 앱들이 간과하는 것, 우리가 다른 이유, 핵심 기능, 그리고
 * 데이터의 출처와 시의성. 시의성 표는 빌드 시점에 계산된 insights.json을
 * 읽으므로, 배치가 돌 때마다 저절로 최신이 된다. 손으로 고치는 날짜는 반드시
 * 낡는다.
 */

const PROBLEMS = [
  ['매물 앱은 위험을 말하기 어렵습니다',
   '중개와 광고로 수익을 내는 구조에서는 "이 집은 위험합니다"라고 말하기 어렵습니다. 나쁜 의도가 아니라 수익 구조의 한계입니다.'],
  ['분석 앱은 투자자의 질문에 답합니다',
   '"어디가 오를까"에 맞춰진 화면에서 "이 보증금을 돌려받을 수 있을까"라는 세입자의 질문은 뒷전이 되기 쉽습니다. 아파트 단지 위주라 빌라 정보는 비어 있는 경우가 많습니다.'],
  ['단점은 광고에 나오지 않습니다',
   '매물 사진은 언덕을 보여주지 않고, 중개사는 층간소음을 먼저 말하지 않습니다. 좋은 소식으로 돈을 버는 구조에서 나쁜 소식은 계약 뒤에야 도착합니다.'],
  ['불확실성은 화면에 표시되지 않습니다',
   '신고가 덜 들어온 달의 거래 급감이나 표본 몇 건으로 계산한 시세도 확정된 숫자처럼 표시됩니다. 잘못된 안심은 모르는 것보다 위험합니다.'],
]

const RULES = [
  ['매물이 없어서 위험을 말할 수 있습니다',
   '사진도, 평면도도, 오늘 계약할 수 있는 방도 없습니다. 팔 것이 없기 때문에 실거래 데이터가 보여주는 위험을 그대로 전할 수 있습니다.'],
  ['근거가 얼마나 탄탄한지 함께 보여줍니다',
   '모든 판정에 근거 단계(A: 이 건물 실거래, B: 인근 추정, C: 검증 불가)가 붙습니다. 몇 건으로 계산한 숫자인지 숨기지 않습니다.'],
  ['모르는 것은 모른다고 말합니다',
   '신고가 끝나지 않은 구간은 잠정으로 표시하고 증감률을 계산하지 않습니다. 비교 기준이 무너진 값은 위험도 안전도 아닌 "판단 보류"로 둡니다.'],
]

const FEATURES = [
  ['계약 전 확인', '주소를 입력하면 그 건물의 실거래 리포트가 나옵니다. 전세가율, 갱신 이력, 옆 평형 시세, 가까운 역·학교·지형 같은 생활 정보, 그리고 등기소·정부24·HUG로 이어지는 체크리스트.'],
  ['호가 검증기', '중개사가 제시한 보증금이 그 동네 비슷한 평형 중 어디쯤인지(백분위)와 그 금액 기준 전세가율을 알려줍니다.'],
  ['임장 비교함', '보러 갈 집을 담아 나란히 비교하고, 집마다 현장에서 물어볼 질문을 만들어 줍니다. 기기에만 저장됩니다.'],
  ['예산 역산', '보증금 예산으로 어느 동네에 "확인된 안전" 선택지가 많은지 알려줍니다.'],
  ['보증금 지킴이', '계약한 집을 등록하면 데이터가 갱신될 때마다 그 건물을 다시 봅니다. 신규 전세가 내 보증금 아래로 내려가는 것 같은 계약 후 위험 신호와 만기 행동 캘린더를 알려드리고, 안드로이드 설치형에서는 앱을 열지 않아도 백그라운드 알림이 옵니다. 등록 정보는 기기에만 저장됩니다.'],
  ['살아온 집', '살아오신 집들을 연표와 지도로 남깁니다. 재건축으로 사라진 건물이나 저희 자료에 없는 집도 이름과 기억하시는 위치로 적으실 수 있습니다. 기기에만 저장되고, 다른 기기로 옮기실 수 있게 내려받기와 불러오기를 둡니다.'],
  ['동네 살펴보기', '예산·면적·역까지 도보 같은 조건과 위험 신호로 건물을 걸러, 보러 갈 후보를 추립니다. 고르고 나면 끝나는 매물 앱과 반대로, 여기서 고른 것은 그대로 검증 리포트로 이어집니다.'],
  ['시세와 인사이트', '거래량 조망(매매·전세·월세), 구별 전세가율·평단가·세대수, 그리고 자동 계산되는 시장 인사이트.'],
]

const REFUSALS = [
  '어디가 오를지 전망하거나 물건을 추천하지 않습니다. 전망을 팔기 시작하는 순간, 나쁜 소식을 말할 수 있다는 이 앱의 존재 이유가 무너집니다.',
  '동네에 범죄율 배지를 달지 않습니다. 집계 단위가 맞지 않는 통계는 동네에 낙인만 남기기 쉽습니다. 치안 정보는 국가 생활안전지도로 연결합니다.',
  '매물 정보를 수집하지 않습니다. 호가는 사용자가 직접 입력합니다.',
  '개인 데이터를 서버에 두지 않습니다. 비교함, 지킴이 등록, 살아온 집 기록은 이 기기에만 저장되고 계정도 없습니다. 내려받으신 파일은 기기 밖으로 나가므로 그 보관은 사용자께 달려 있습니다.',
  '해석 기준이 없는 숫자(유동인구 등)는 싣지 않습니다. 해석을 사용자에게 떠넘기는 지표는 혼란만 더합니다.',
]

/** 계약 패키지 준비 소식. 가짜 문 테스트의 소개 탭 진입점이라 처음부터
 *  준비 중임을 밝히고, 관심(출시 알림 신청)만 익명으로 센다. */
function PkgPlan() {
  const [wait, setWait] = useState(() => {
    try { return !!localStorage.getItem('nec-rpt-wait') } catch { return false }
  })
  const boxRef = useRef(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      fdTrack('about_view')
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        fdTrack('about_view')
        io.disconnect()
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const onWait = () => {
    fdTrack('about_notify')
    try { localStorage.setItem('nec-rpt-wait', '1') } catch { /* 표시용 플래그일 뿐 */ }
    setWait(true)
  }
  return (
    <section className="card" ref={boxRef}>
      <h2>준비하고 있는 것 · 이 집 사실 리포트</h2>
      <p className="sub">
        매수를 검토하는 분께, 그 건물의 실거래와 공적 장부의 사실만 모은 한 부의
        문서를 준비하고 있습니다. 오를지 내릴지는 저희가 알 수 없어 적지
        않습니다. 아직 출시 전이며, 지금은 관심을 익명 숫자로만 세어 출시를
        결정하는 단계입니다
      </p>
      <div className="about-item">
        <b>리포트에 담기는 것</b>
        <span>{[...RPT_ITEMS, RPT_ITEM_BLDG].join(', ')} 등. 물건에 따라
        담기는 항목이 다릅니다. 전망이나 추천은 한 줄도 없습니다. 반박할 수
        있는 사실만 드리는 것이 이 문서의 쓰임입니다.</span>
      </div>
      <p className="sub">예상 가격은 14,900원, 한 번 결제입니다. 지금 보시는
        판정과 근거는 출시와 무관하게 계속 무료입니다</p>
      {wait
        ? <p className="muted-line">출시되면 이 기기의 앱 화면에서 알려드리겠습니다.</p>
        : <button className="more" onClick={onWait}>출시되면 알려주세요</button>}
    </section>
  )
}

export default function About({ onBack }) {
  const { data, err } = useInsights()
  // 시의성 표에 지연을 적기 위한 두 값. 파이프라인이 둘이라 각자 잰다.
  const rtLate = collectLate(data?.generatedAt)
  const bldgStale = bldgLate(data?.bldg?.at, data?.bldg?.remaining)
  const bldgDay = bldgAt(data?.bldg?.at)

  return (
    <>
      <section className="card">
        <h2>necessities는 무엇이 다른가요</h2>
        <p className="sub">
          necessities는 집을 골라 드리는 앱이 아닙니다. <strong>골라 온 집을
          계약하기 전에 확인해 드리는 앱</strong>입니다. 매물을 찾는 곳과 시세를
          구경하는 곳은 많지만, 도장을 찍기 전에 "이 계약 괜찮은가"를 데이터로
          확인해 주는 곳은 없었습니다
        </p>
        {PROBLEMS.map(([h, b]) => (
          <div className="about-item" key={h}>
            <b>{h}</b><span>{b}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>그래서 우리는 이렇게 만듭니다</h2>
        {RULES.map(([h, b]) => (
          <div className="about-item rule" key={h}>
            <b>{h}</b><span>{b}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>무엇을 확인해 드리나요</h2>
        <p className="sub">
          계약하고 나서야 알게 되는 것들을 계약하기 전에. 부동산 계약의 후회는
          두 가지이고, 둘 다 미리 확인할 수 있습니다
        </p>
        <div className="about-item">
          <b>돈의 후회, "속았다"</b>
          <span>보증금이 집값에 육박하는 깡통전세, 실거래보다 부풀려진 호가,
          등록 뒤에 내려앉는 시세. 실거래 기록과 견줘 판정하고, 계약 후에도
          지킴이가 만기까지 지켜봅니다.</span>
        </div>
        <div className="about-item">
          <b>삶의 후회, "몰랐다"</b>
          <span>가파른 언덕 위의 집, 생각보다 먼 역, 아이 학교까지의 거리,
          구조와 준공연도가 알려주는 층간소음 가능성. 광고가 말하지 않는 생활 정보를
          공공데이터에서 꺼내 물건마다 붙입니다.</span>
        </div>
      </section>

      <section className="card">
        <h2>핵심 기능</h2>
        <ul className="about-feats">
          {FEATURES.map(([h, b]) => (
            <li key={h}><b>{h}</b><span>{b}</span></li>
          ))}
        </ul>
      </section>

      <PkgPlan />

      <section className="card">
        <h2>데이터의 출처와 시의성</h2>
        <p className="sub">
          모두 공공데이터이며, 수집·검증·배포가 자동으로 이뤄집니다. 아래 시점은
          데이터가 갱신될 때마다 함께 갱신됩니다
        </p>
        {/* 표는 "어디까지"만 말하고 늦었다는 말은 안 했다. 확인 탭과 동네
            인사이트가 지연을 밝히는데 이 표만 침묵하면, 자료 시점을 보러 온
            사람이 정작 못 본다. 두 파이프라인을 각자 잰다. */}
        {data?.freshness?.length ? (
          <div className="scroll-x">
            <table className="data fresh-table">
              <thead>
                <tr><th>데이터</th><th>어디까지</th><th>갱신 주기</th></tr>
              </thead>
              <tbody>
                {data.freshness.map((f) => {
                  // 대장은 월 단위 asof가 없다. 이어받는 누적 수집이라
                  // "어디까지"에 해당하는 값이 수집한 날짜다. 날짜가 없으면
                  // 붙임표가 아니라 공백이다. 이 표의 다른 asof 없는 행(지형·
                  // 지하철)이 공백이라, 한 표 안에 빈 값 표기가 둘이 되면 안 된다.
                  const at = f.key === 'bldg' ? (bldgDay ? kstDay(bldgDay) : '') : f.asof
                  const stale = f.key === 'rt' ? rtLate : f.key === 'bldg' ? bldgStale : null
                  return (
                    <tr key={f.key}>
                      <td>{f.name}</td>
                      <td>
                        {at}{at && ' '}<small className="delta">{f.note}</small>
                        {stale && (
                          <small className="delta warning">
                            {stale.days}일째 새로 받은 것이 없습니다
                          </small>
                        )}
                      </td>
                      <td>{f.cycle}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted-line">{err ? '시의성 표는 다음 데이터 갱신 때 표시됩니다.' : '시의성 정보를 불러오는 중…'}</p>}
        <p className="method">
          실거래는 계약일로부터 30일 안에 신고하게 되어 있습니다. 그래서 신고 기한이
          지나지 않은 달은 잠정으로 표시하고, 전세가율 판정에는 기한이 지난 달까지만
          씁니다. 진행 중인 이번 달은 아직 계약이 일어나는 중이라 월 통계에 넣지
          않습니다. 신고된 개별 거래는 수집 회차마다 물건 화면에 잠정 표시와 함께
          실립니다.
        </p>
        <p className="method">
          수집 파이프라인에는 적재 0건, 오류율 20% 초과, 응답 절단, 커버리지 미달,
          합계 검산 불일치를 배포 전에 걸러내는 가드가 있습니다. 검증에 실패하면
          배포가 중단되고, 통과한 데이터만 화면에 반영됩니다.
        </p>
      </section>

      <section className="card">
        <h2>일부러 하지 않는 것</h2>
        <ul className="about-refuse">
          {REFUSALS.map((t) => <li key={t}>{t}</li>)}
        </ul>
      </section>

      <section className="card about-vision">
        <h2>비전</h2>
        <p>
          수술을 권유받으면 다른 병원에 한 번 더 물어봅니다. 그런데 부동산에는
          그 "다른 병원"이 없었습니다. 중개사도 매물 앱도, 거래가 성사되어야
          돈을 버는 같은 편이기 때문입니다. necessities는 <strong>부동산
          계약의 세컨드 오피니언</strong>이 되려 합니다. 매물을 팔지 않으므로
          광고가 말하지 않는 것을 말할 수 있고, 계약하고 나서야 알게 되는
          것들을 계약하기 전에 보여드릴 수 있습니다. 지금은 서울·경기 전세에서
          시작하지만 매매와 월세, 모든 부동산 계약으로 넓혀갑니다. 우리는
          모든 계약 앞에 그 <strong>확인이 당연한 절차</strong>가 되는 세상을
          만들고 싶습니다.
        </p>
        {onBack && <button className="more" onClick={onBack}>확인하러 가기</button>}
      </section>
    </>
  )
}
