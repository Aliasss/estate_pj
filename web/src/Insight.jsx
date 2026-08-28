import { useEffect, useState } from 'react'
import { LineChart } from './charts.jsx'
// 갱신 시점 계산은 units.js에 산다. 확인 탭도 같은 값을 써야 두 화면이
// 다른 날짜를 말하지 않는다.
import { bldgAt, bldgLate, collectLate, kstDay, nextCollect, parseIso } from './units.js'

const nextLabel = () => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long',
}).format(nextCollect())

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

/* 세 화면(확인·동네 인사이트·소개)이 각자 받으면 같은 6.5KB를 세 번 받는다.
   모듈 수준 프라미스로 묶어 한 번만 받고 나눠 쓴다. */
let _insightsPromise = null
export function useInsights() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    if (!_insightsPromise) {
      _insightsPromise = fetch(`${import.meta.env.BASE_URL}data/insights.json`)
        .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json')
          ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    }
    _insightsPromise
      .then((d) => { if (alive) setData(d) })
      .catch((e) => {
        // 다음 화면이 다시 시도할 수 있게 실패한 프라미스는 버린다.
        _insightsPromise = null
        if (alive) setErr(e.message)
      })
    return () => { alive = false }
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
  // 자료 시점은 insights.json의 freshness 한 곳에서만 가져온다. 이 카드들은
  // 확정월 기준으로 계산하므로 확정월(solid)을 앞에 말하고, 잠정월은 잠정이라
  // 밝힌다. 최신월만 내세우면 다른 화면의 "6월까지"와 어긋난다.
  const rt = data.freshness?.find((f) => f.key === 'rt')
  // 예정일이 지나도록 갱신이 없으면 그 사실을 적는다. 없으면 null이라 문장이 빠진다.
  const late = collectLate(data.generatedAt)
  // 건축물대장은 별개 파이프라인이라 따로 잰다. 실거래가 멀쩡한 날에도 대장만
  // 며칠 멈출 수 있고, 8/27과 8/28이 실제로 그랬다.
  const bAt = bldgAt(data.bldg?.at)
  const bLate = bldgLate(data.bldg?.at, data.bldg?.remaining)
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
        {/* 날짜만 적는다. 시각까지 적으면 수집이 끝나는 때와 어긋난다. */}
        <p className="ins-when">
          {rt?.solid && (rt.asof && rt.asof !== rt.solid
            ? <>자료는 <b>{ymKo(rt.solid)}분까지</b> 확정됐고, {ymKo(rt.asof)}분은 아직 잠정입니다. </>
            : <>자료는 <b>{ymKo(rt.solid)}분까지</b> 확정됐습니다. </>)}
          {parseIso(data.generatedAt) && (
            <>마지막 실거래 수집 <b>{kstDay(parseIso(data.generatedAt))}</b>, </>
          )}
          {/* 멈춰 있는 동안에는 다음 날짜를 약속하지 않는다. 차단이 풀리려면
              사람이 다시 실행해야 하므로, 예정일이 저절로 오지 않는다. */}
          {late
            ? <span className="warning"><b>{kstDay(late.due)}</b>에 받았어야 할 실거래
                자료를 아직 받지 못했습니다. 마지막 수집 이후 {late.days}일째입니다.
                다음 예정은 {nextLabel()}이지만 이번 지연이 풀려야 채워집니다</span>
            : <>다음 수집은 <b>{nextLabel()}</b>입니다</>}
        </p>
        {/* 건물 정보는 실거래와 주기도 파이프라인도 다르다. 한 문장에 섞지 않고
            줄을 나눠 주어를 붙여 적는다. 대장이 없는 산출물에서는 통째로 빠진다. */}
        {bAt && (
          <p className="ins-when">
            건축물대장은 매일 밤 이어받도록 예약되어 있습니다. 마지막으로 받은
            것은 <b>{kstDay(bAt)}</b>
            {bLate
              ? <span className="warning">이고, 그 뒤로 {bLate.days}일째 새로 받은
                  것이 없습니다. 건물 정보는 그날까지 받은 것만 보입니다</span>
              : '입니다'}
          </p>
        )}
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
            이 기준에 해당합니다. 조건으로 찾기의 "확인된 깡통" 필터로 하나씩 확인하실 수 있습니다.
            {onGoFind && <> <button className="ins-link" onClick={onGoFind}>조건으로 찾기 →</button></>}
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
            아파트·연립다세대·오피스텔 기준.
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
        아침 자동으로 수집되고, 그때 이 화면의 실거래 지표가 같은 시점 데이터로 다시
        계산됩니다. 건축물대장은 매일 밤 수집되고, 새로 받은 것이 있으면 그 수집이
        끝나는 대로 건물 단위 판정에 다시 결합됩니다.
        사람 손을 거치지 않고 고정된 방법론으로만 계산되므로, 어제와 오늘을 같은
        기준으로 비교할 수 있습니다.
      </p>
    </>
  )
}
