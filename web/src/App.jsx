import { useEffect, useMemo, useState } from 'react'
import { LineChart, RankBars } from './charts.jsx'
import Finder from './Finder.jsx'
import Law from './Law.jsx'
import Verify from './Verify.jsx'

const PYEONG = 3.305785
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const pct0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const eok = (manwon) => (manwon == null ? '—' : `${(manwon / 10000).toFixed(2)}억`)
const manwon = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}만`)
/** tier1의 월은 "2026-07" 꼴이다. 화면에는 한글로 읽히게 둔다. */
const ymDot = (s) => (s ? `${s.slice(0, 4)}년 ${+s.slice(5, 7)}월` : '—')

export default function App() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [housing, setHousing] = useState('연립다세대')
  const [gu, setGu] = useState('11500')       // 강서구
  const [tab, setTab] = useState('verify')

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/tier1.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [])

  const view = useMemo(() => {
    if (!data) return null
    const solid = data.months.filter((m) => !data.provisional.includes(m))
    const lastSolid = solid.at(-1)
    const recent12 = solid.slice(-12)

    // 구별 랭킹. 잠정 구간을 뺀 최근 12개월 중위 전세가율
    const byGu = new Map()
    for (const r of data.ratio) {
      if (r.housing_type !== housing || !recent12.includes(r.ym) || r.jeonse_ratio_ppp == null) continue
      if (!byGu.has(r.lawd_cd)) byGu.set(r.lawd_cd, { sgg: r.sgg_nm, vals: [] })
      byGu.get(r.lawd_cd).vals.push(r.jeonse_ratio_ppp)
    }
    const rank = [...byGu.entries()]
      .map(([key, v]) => {
        const s = [...v.vals].sort((a, b) => a - b)
        return { key, label: v.sgg, value: s[Math.floor(s.length / 2)] }
      })
      .sort((a, b) => b.value - a.value)

    // 선택한 구의 시계열
    const rows = data.panel.filter((p) => p.lawd_cd === gu && p.housing_type === housing)
    const pick = (dealType, field) => {
      const m = new Map(rows.filter((r) => r.deal_type === dealType).map((r) => [r.ym, r[field]]))
      return data.months.map((ym) => m.get(ym) ?? null)
    }
    // 평단가는 jeonse_ratio에서 가져온다. monthly_panel의 '전월세'에는 월세 보증금이
    // 섞여 있어 전세가율 차트와 숫자가 어긋난다.
    const guRatio = data.ratio.filter((r) => r.lawd_cd === gu && r.housing_type === housing)
    const ratios = new Map(guRatio.map((r) => [r.ym, r.jeonse_ratio_ppp]))
    const byYm = (field) => {
      const m = new Map(guRatio.map((r) => [r.ym, r[field]]))
      return data.months.map((ym) => m.get(ym) ?? null)
    }

    const guName = rank.find((r) => r.key === gu)?.label
      ?? data.gu.find((g) => g.lawd_cd === gu)?.sgg_nm ?? gu

    const guNames = Object.fromEntries(data.gu.map((g) => [g.lawd_cd, g.sgg_nm]))

    return {
      rank, guName, guNames, lastSolid,
      ppp: [
        { name: '매매 평단가', short: '매매', color: 'var(--series-1)', values: byYm('median_sale_ppp') },
        { name: '전세 평단가', short: '전세', color: 'var(--series-2)', values: byYm('median_jeonse_ppp') },
      ],
      ratio: [{ name: '전세가율', short: '전세가율', color: 'var(--series-1)',
                values: data.months.map((m) => ratios.get(m) ?? null) }],
      deals: [
        { name: '매매 거래건수', short: '매매', color: 'var(--series-1)', values: pick('매매', 'n_deals') },
        { name: '전월세 거래건수', short: '전월세', color: 'var(--series-2)', values: pick('전월세', 'n_deals') },
      ],
      table: data.months.map((ym, i) => ({
        ym,
        sale: byYm('median_sale_ppp')[i],
        jeonse: byYm('median_jeonse_ppp')[i],
        ratio: ratios.get(ym) ?? null,
      })),
    }
  }, [data, housing, gu])

  if (err) return <main className="app"><p>데이터를 불러오지 못했습니다: {err}</p></main>
  if (!data || !view) return <main className="app"><p style={{ color: 'var(--text-muted)' }}>불러오는 중…</p></main>

  return (
    <main className="app">
      <header>
        <h1>전세 계약 전 확인</h1>
        <p>
          국토교통부 실거래가 {ymDot(data.months[0])}~{ymDot(data.months.at(-1))} 신고분 ·
          전용면적 기준 · 마지막 {data.provisional.length}개월은 잠정
        </p>
      </header>

      <div className="seg tabs" role="tablist" aria-label="화면">
        <button role="tab" aria-pressed={tab === 'verify'} onClick={() => setTab('verify')}>계약 전 확인</button>
        <button role="tab" aria-pressed={tab === 'find'} onClick={() => setTab('find')}>동네 살펴보기</button>
        <button role="tab" aria-pressed={tab === 'market'} onClick={() => setTab('market')}>시세 흐름</button>
        <button role="tab" aria-pressed={tab === 'law'} onClick={() => setTab('law')}>법·제도</button>
      </div>

      {tab === 'market' && (
        <div className="controls">
          <div className="seg" role="group" aria-label="주택 유형">
            {['연립다세대', '아파트'].map((t) => (
              <button key={t} aria-pressed={housing === t} onClick={() => setHousing(t)}>{t}</button>
            ))}
          </div>
          <select value={gu} onChange={(e) => setGu(e.target.value)} aria-label="자치구">
            {data.gu.map((g) => <option key={g.lawd_cd} value={g.lawd_cd}>{g.sgg_nm}</option>)}
          </select>
        </div>
      )}

      {tab === 'verify' && <Verify guNames={view.guNames} />}
      {tab === 'find' && <Finder guNames={view.guNames} />}
      {tab === 'law' && <Law />}

      {tab === 'market' && <>
      <section className="card">
        <h2>자치구별 전세가율 ({housing})</h2>
        <p className="sub">최근 12개월({view.lastSolid} 기준) 중위값. 전세 보증금 ÷ 매매가, 평단가 기준. 눌러서 선택</p>
        <RankBars items={view.rank} format={pct0} selected={gu} onSelect={setGu} />
      </section>

      <section className="card">
        <h2>{view.guName} 평단가 추이</h2>
        <p className="sub">전용면적 1평당 만원, 월별 중위값. 전세는 월세 0원 계약만</p>
        <div className="legend">
          <span><i className="swatch" style={{ background: 'var(--series-1)' }} />매매</span>
          <span><i className="swatch" style={{ background: 'var(--series-2)' }} />전세 보증금</span>
        </div>
        <LineChart months={data.months} series={view.ppp} provisional={data.provisional}
                   format={{ tick: (v) => Math.round(v).toLocaleString(), value: manwon }} />
      </section>

      <section className="card">
        <h2>{view.guName} 전세가율 추이</h2>
        <p className="sub">높을수록 보증금이 매매가에 가깝다. 집값이 내려가면 반환 여력이 먼저 사라진다</p>
        <LineChart months={data.months} series={view.ratio} provisional={data.provisional} height={160}
                   format={{ tick: (v) => `${Math.round(v * 100)}%`, value: pct }} />
      </section>

      <section className="card">
        <h2>{view.guName} 거래건수</h2>
        <p className="sub">매매가 마르면 가격 검증 자체가 어려워진다</p>
        <div className="legend">
          <span><i className="swatch" style={{ background: 'var(--series-1)' }} />매매</span>
          <span><i className="swatch" style={{ background: 'var(--series-2)' }} />전월세</span>
        </div>
        <LineChart months={data.months} series={view.deals} provisional={data.provisional} height={160}
                   format={{ tick: (v) => v.toLocaleString(), value: (v) => `${v.toLocaleString()}건` }} />
        <details>
          <summary>표로 보기</summary>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>월</th><th>매매 평단가</th><th>전세 평단가</th><th>전세가율</th></tr></thead>
              <tbody>
                {view.table.slice().reverse().map((r) => (
                  <tr key={r.ym}>
                    <td>{r.ym}{data.provisional.includes(r.ym) ? ' (잠정)' : ''}</td>
                    <td>{manwon(r.sale)}</td><td>{manwon(r.jeonse)}</td><td>{pct(r.ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      </>}

      <p className="note">
        <strong>읽는 법.</strong> 평단가는 <strong>전용면적</strong> 기준이라 공급면적으로 표시하는
        부동산 앱 숫자보다 20~30% 높게 나옵니다. 전세가율은 면적 구성의 차이를 걷어내려고
        평단가끼리 나눈 값입니다. 모든 통계는 중위값이며, 신고 후 해제된 거래는 제외했습니다.
        <br /><br />
        <strong>마지막 두 달은 잠정치입니다.</strong> 계약일로부터 30일이 신고 기한이라 뒤늦게 계속
        채워집니다. 회색 구간의 건수 감소는 시장 변화가 아니라 아직 안 들어온 신고입니다.
        <br /><br />
        <strong>이 수치는 참고용입니다.</strong> 구 단위 통계는 개별 물건의 위험을 말해주지 않습니다.
        계약 판단은 등기부등본·전입세대 확인서·보증보험 가입 가능 여부로 하셔야 합니다.
      </p>
    </main>
  )
}
