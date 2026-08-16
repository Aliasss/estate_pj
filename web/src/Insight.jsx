import { useEffect, useState } from 'react'
import { LineChart } from './charts.jsx'

/**
 * 인사이트. 우리 데이터로만 답할 수 있는 질문들을 골라, 고정된 방법론으로
 * 매 배치마다 다시 계산해 보여준다. 사람이 쓰는 칼럼이 아니라 기계가 다시
 * 세는 지표라서 낡지 않고, 방법론이 고정이라 어제와 오늘을 비교할 수 있다.
 * 계산은 빌드 시점(insights.json)에 끝나 있다. 13MB 원본을 화면이 다시
 * 내려받지 않게 하기 위해서다.
 */

const pctPt = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`)
const signed = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
const ymKo = (m) => (m ? `${m.slice(0, 4)}년 ${+m.slice(5, 7)}월` : '')

export function useInsights() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/insights.json`)
      .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json')
        ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [])
  return { data, err }
}

function Method({ children }) {
  return <p className="method">{children}</p>
}

export default function Insight({ onGoFind }) {
  const { data, err } = useInsights()

  if (err) {
    return (
      <section className="card">
        <h2>인사이트</h2>
        <p className="sub">아직 준비되지 않았습니다. 다음 데이터 갱신 때 함께 배포됩니다</p>
      </section>
    )
  }
  if (!data) {
    return <section className="card"><h2>인사이트</h2><p className="sub">불러오는 중…</p></section>
  }

  const { cards } = data
  const ws = cards.wolseShare
  // 헤드라인 수치는 확정월 기준이다. 잠정월 값으로 1년 증감을 말하면
  // "잠정 구간은 증감률을 내지 않는다"는 우리 약속을 첫 카드가 어긴다.
  let wsIdx = -1
  if (ws) {
    for (let i = ws.values.length - 1; i >= 0; i--) {
      if (ws.values[i] != null && !ws.provisional.includes(ws.months[i])) { wsIdx = i; break }
    }
  }
  const wsLast = wsIdx >= 0 ? ws.values[wsIdx] : null
  const wsPrev = wsIdx >= 12 ? ws.values[wsIdx - 12] : null

  return (
    <>
      <section className="card">
        <h2>인사이트</h2>
        <p className="sub">
          우리가 수집한 실거래·인구 데이터를 고정된 방법론으로 자동 계산한
          지표입니다. 데이터가 갱신되면 이 화면도 함께 갱신됩니다
        </p>
      </section>

      {cards.kkangtong && (
        <section className="card">
          <h2>확인된 깡통이 많은 동네</h2>
          <p className="sub">
            그 건물의 실거래 매매 3건 이상을 근거로, 전세 보증금이 매매가를 넘는
            건물이 많은 시군구입니다. 추정이 아니라 확인입니다
          </p>
          <ol className="ins-rank">
            {cards.kkangtong.top.map((r) => (
              <li key={r.lawd}>
                <span>{r.name}</span>
                <em>{r.count.toLocaleString()}개 건물</em>
              </li>
            ))}
          </ol>
          <p className="muted-line">
            지금 데이터가 확보된 범위에서 {cards.kkangtong.total.toLocaleString()}개 건물이
            이 기준에 해당합니다. 동네 탭의 "확인된 깡통" 필터로 하나씩 확인하실 수 있습니다.
            {onGoFind && <> <button className="ins-link" onClick={onGoFind}>동네 탭으로 →</button></>}
          </p>
          <Method>
            방법론: 근거 A단계(그 건물 매매 3건 이상)이면서 중위 전세가 중위 매매의
            100~150%인 건물 수. 150% 초과는 비교 기준이 깨진 것으로 보고 제외.
          </Method>
        </section>
      )}

      {cards.reverse && (cards.reverse.seoul != null || cards.reverse.gg != null) && (
        <section className="card">
          <h2>갱신에서 보증금이 내려간 건물의 비율</h2>
          <p className="sub">
            역전세의 직접적인 신호입니다. 집주인이 보증금 일부를 돌려주고 있다는
            뜻이고, 다음 세입자에게는 협상 근거가 됩니다
          </p>
          <div className="ins-pair">
            {cards.reverse.seoul != null && (
              <div>
                <em>{pctPt(cards.reverse.seoul)}</em>
                <span>서울 · 갱신이 신고된 건물·평형 {cards.reverse.seoulN.toLocaleString()}곳 중</span>
              </div>
            )}
            {cards.reverse.gg != null && (
              <div>
                <em>{pctPt(cards.reverse.gg)}</em>
                <span>경기 · 갱신이 신고된 건물·평형 {cards.reverse.ggN.toLocaleString()}곳 중</span>
              </div>
            )}
          </div>
          {cards.reverse.gg == null && (
            <p className="muted-line">경기는 갱신 데이터가 쌓이는 대로 추가됩니다.</p>
          )}
          <Method>
            방법론: 같은 건물·평형의 갱신 계약 보증금 중위 변동이 5% 이상 하락인
            곳의 비율. 월세 낀 계약과 전월세 전환은 제외합니다.
          </Method>
        </section>
      )}

      {ws && (
        <section className="card">
          <h2>전세는 줄고, 월세가 늘고 있습니다</h2>
          <p className="sub">
            서울·경기 전월세 신고에서 월세가 차지하는 비중입니다. 임대차 시장의
            중심이 전세에서 월세로 얼마나 옮겨갔는지 보여줍니다
          </p>
          <div className="ins-stat">
            <em>{pctPt(wsLast)}</em>
            <span>
              {ws.months[wsIdx] ? ymKo(ws.months[wsIdx]) : '최근 확정월'} 월세 비중
              {wsPrev != null && <> · 1년 전보다 <b>{signed(wsLast - wsPrev)}p</b></>}
            </span>
          </div>
          <LineChart months={ws.months} provisional={ws.provisional} height={170}
                     series={[{ name: '월세 비중', short: '월세 비중', color: 'var(--series-3)',
                                values: ws.values }]}
                     format={{ tick: (v) => `${Math.round(v * 100)}%`, value: pctPt }} />
          <Method>
            방법론: 월별 전월세 신고 중 월세액이 있는 계약의 비율. 갱신 계약 포함,
            아파트·연립다세대 기준.
            {ws.jeonseChange != null && ws.jeonseChange < -0.02 && (
              <> 같은 기간 전세 신고 절대량도 {signed(ws.jeonseChange)} 줄어,
              비중 상승이 분모 착시가 아닙니다.</>
            )}
          </Method>
        </section>
      )}

      {cards.saleYoy && (
        <section className="card">
          <h2>매매 거래량은 검증의 기반입니다</h2>
          <p className="sub">
            매매 실거래는 보증금을 비교할 기준이 됩니다. 매매 거래가 줄면
            "확인된 안전"을 판정할 근거도 함께 줄어듭니다
          </p>
          <div className="ins-stat">
            <em>{cards.saleYoy.now.toLocaleString()}건</em>
            <span>
              {ymKo(cards.saleYoy.ym)} 매매 신고 · 전년 동월보다{' '}
              <b>{signed(cards.saleYoy.now / cards.saleYoy.prev - 1)}</b>
            </span>
          </div>
          <LineChart months={cards.saleYoy.months} provisional={cards.saleYoy.provisional} height={170}
                     series={[{ name: '매매', short: '매매', color: 'var(--series-1)',
                                values: cards.saleYoy.series }]}
                     format={{ tick: (v) => v >= 10000 ? `${(v / 10000).toFixed(1)}만` : v.toLocaleString(),
                               value: (v) => `${v.toLocaleString()}건` }} />
          <Method>방법론: 최근 확정월의 매매 신고 건수와 전년 동월 대비. 해제 거래 제외.</Method>
        </section>
      )}

      {data.history && (() => {
        // 마지막 기록은 지금 화면의 값과 같은 회차라 "지난" 기록은 그 앞까지다
        const past = data.history.slice(0, -1).reverse().slice(0, 24)
        return (
          <section className="card">
            <h2>지난 인사이트</h2>
            <p className="sub">
              데이터가 갱신되어 수치가 바뀔 때마다 그 시점의 기록을 남깁니다.
              위 지표들이 어디서 와서 어디로 가는지 볼 수 있습니다
            </p>
            {past.length ? (
              <ul className="ins-archive">
                {past.map((h, i) => (
                  <li key={`${h.date}-${i}`}>
                    <em>{h.date}</em>
                    <span>
                      월세 비중 {pctPt(h.wolseShare?.value)}({ymKo(h.wolseShare?.ym)})
                      {' · '}매매 {h.saleYoy?.now?.toLocaleString()}건({ymKo(h.saleYoy?.ym)})
                      {' · '}확인된 깡통 {h.kkangtong?.total?.toLocaleString()}개 건물
                      {' · '}역전세 서울 {pctPt(h.reverse?.seoul)}
                      {h.reverse?.gg != null && <> · 경기 {pctPt(h.reverse.gg)}</>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-line">
                아직 지난 기록이 없습니다. 다음 데이터 갱신부터 이 자리에 쌓입니다.
              </p>
            )}
          </section>
        )
      })()}

      <p className="note">
        <strong>이 숫자들은 어떻게 갱신되나.</strong> 실거래·금리·인구는 매주 화요일
        아침 자동으로 수집되고, 그때 이 화면의 모든 지표가 같은 시점 데이터로 다시
        계산됩니다. 건축물대장은 매일 수집되어 화요일 재계산 때 함께 반영됩니다.
        사람 손을 거치지 않고 고정된 방법론으로만 계산되므로, 어제와 오늘을 같은
        기준으로 비교할 수 있습니다.
      </p>
    </>
  )
}
