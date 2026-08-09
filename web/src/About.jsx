import { useInsights } from './Insight.jsx'

/**
 * 서비스 소개. 기존 앱들이 간과하는 것, 우리가 다른 이유, 핵심 기능, 그리고
 * 데이터의 출처와 시의성. 시의성 표는 빌드 시점에 계산된 insights.json을
 * 읽으므로, 배치가 돌 때마다 저절로 최신이 된다. 손으로 고치는 날짜는 반드시
 * 낡는다.
 */

const PROBLEMS = [
  ['매물 앱은 위험을 말하기 어렵습니다',
   '중개·광고로 수익을 내는 구조에서 "이 집 위험합니다"는 상품 진열대를 부수는 말입니다. 나쁜 의도가 아니라 구조의 문제입니다.'],
  ['분석 앱은 투자자의 질문에 답합니다',
   '"어디가 오르는가"를 묻는 화면에서 세입자의 질문("이 보증금을 돌려받을 수 있는가")은 뒷전이 됩니다. 아파트 단지 위주라 빌라는 자주 비어 있습니다.'],
  ['불확실성은 화면에 표시되지 않습니다',
   '신고가 덜 들어온 달의 급감, 표본 몇 건으로 낸 시세가 확정된 숫자처럼 표시됩니다. 틀린 안심은 모르는 것보다 나쁩니다.'],
]

const RULES = [
  ['매물이 없어서, 위험을 말할 수 있습니다',
   '사진도 평면도도 오늘 계약 가능한 방도 없습니다. 팔 것이 없으므로 실거래가 말하는 위험을 그대로 전합니다.'],
  ['근거의 두께를 함께 보여줍니다',
   '모든 판정에 근거 단계(A: 이 건물 실거래, B: 인근 추정, C: 검증 불가)가 붙습니다. 몇 건으로 낸 숫자인지 숨기지 않습니다.'],
  ['모르는 것은 모른다고 말합니다',
   '신고 미완 구간은 잠정으로 표시하고 증감률을 내지 않습니다. 비교 기준이 깨진 값은 위험도 안전도 아닌 "판단 보류"입니다.'],
]

const FEATURES = [
  ['계약 전 확인', '주소를 넣으면 그 건물의 실거래 리포트가 나옵니다. 전세가율, 갱신 이력, 옆 평형 시세, 그리고 등기소·정부24·HUG로 이어지는 체크리스트.'],
  ['호가 검증기', '중개사가 부른 보증금이 그 동네 비슷한 평형에서 어디쯤인지(백분위)와 그 값 기준 전세가율을 돌려줍니다.'],
  ['임장 비교함', '보러 갈 집을 담아 나란히 비교하고, 집마다 현장에서 물어볼 질문을 만들어 줍니다. 기기에만 저장됩니다.'],
  ['예산 역산', '보증금 예산으로 어느 동네에 "확인된 안전" 선택지가 많은지 셉니다.'],
  ['동네 살펴보기', '확인된 깡통, 신축 빌라 매매 0건 같은 위험 신호로 데이터가 닿는 모든 건물을 거릅니다.'],
  ['시세와 인사이트', '거래량 조망(매매·전세·월세), 구별 전세가율·평단가·세대수, 그리고 자동 계산되는 시장 인사이트.'],
]

const REFUSALS = [
  '동네에 범죄율 배지를 달지 않습니다. 관할 단위가 어긋난 통계는 낙인만 남깁니다. 치안은 국가 생활안전지도로 연결합니다.',
  '매물을 긁어오지 않습니다. 호가는 사용자가 직접 넣습니다.',
  '개인 데이터를 서버에 두지 않습니다. 비교함은 기기(localStorage)에만 저장되고 계정도 없습니다.',
  '방향 없는 숫자(유동인구 등)를 싣지 않습니다. 해석을 떠넘기는 지표는 소음입니다.',
]

export default function About({ onBack }) {
  const { data, err } = useInsights()

  return (
    <>
      <section className="card">
        <h2>내 집 내놔는 어떻게 다른가</h2>
        <p className="sub">
          보증금은 대부분의 사람에게 전 재산입니다. 그런데 그 돈의 위험을 정면으로
          말해주는 화면이 없었습니다
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
        <h2>핵심 기능</h2>
        <ul className="about-feats">
          {FEATURES.map(([h, b]) => (
            <li key={h}><b>{h}</b><span>{b}</span></li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>데이터의 출처와 시의성</h2>
        <p className="sub">
          전부 공공데이터이고, 수집·검증·배포가 자동입니다. 아래 시점은 데이터가
          갱신될 때마다 함께 갱신됩니다
        </p>
        {data?.freshness?.length ? (
          <div className="scroll-x">
            <table className="data fresh-table">
              <thead>
                <tr><th>데이터</th><th>어디까지</th><th>갱신 주기</th></tr>
              </thead>
              <tbody>
                {data.freshness.map((f) => (
                  <tr key={f.key}>
                    <td>{f.name}</td>
                    <td>{f.asof ?? '—'}<small className="delta">{f.note}</small></td>
                    <td>{f.cycle}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted-line">{err ? '시의성 표는 다음 데이터 갱신 때 표시됩니다.' : '시의성 정보를 불러오는 중…'}</p>}
        <p className="method">
          수집 파이프라인에는 적재 0건, 오류율 20% 초과, 응답 절단, 커버리지 미달,
          합계 검산 불일치를 배포 전에 막는 가드가 걸려 있습니다. 실패는 배포를
          멈추고, 성공만 화면에 도착합니다.
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
          전세 계약의 정보 비대칭을 없애는 것. 계약서에 도장을 찍기 전, 누구나
          공공데이터가 이미 알고 있는 위험을 3분 안에 확인할 수 있게 하는 것.
          우리는 그 확인이 <strong>당연한 절차</strong>가 되는 세상을 만들고 싶습니다.
        </p>
        {onBack && <button className="more" onClick={onBack}>확인하러 가기</button>}
      </section>
    </>
  )
}
