import { useEffect, useMemo, useState } from 'react'
import { LineChart, RankBars } from './charts.jsx'
import Finder from './Finder.jsx'
import Law from './Law.jsx'
import Verify from './Verify.jsx'
import { REGIONS, useRates } from './units.js'

const PYEONG = 3.305785
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const pct0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const eok = (manwon) => (manwon == null ? '—' : `${(manwon / 10000).toFixed(2)}억`)
const manwon = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}만`)
/** tier1의 월은 "2026-07" 꼴이다. 화면에는 한글로 읽히게 둔다. */
const ymDot = (s) => (s ? `${s.slice(0, 4)}년 ${+s.slice(5, 7)}월` : '—')
// 구 단위에도 면적 믹스가 깨진 달이 있다 (2022-09 영등포 아파트 168.9%). 물건 단위와
// 같은 기준으로, 정상 범위를 벗어난 값은 차트와 표에 내지 않는다.
const sane = (r) => (r != null && r < 1.5 ? r : null)


/** 하단 탭바. 화면 위 탭 줄보다 엄지에 가깝고, 앱으로 읽힌다. */
const TABS = [
  ['verify', '계약 전 확인',
   'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z M9.5 11.5l2 2 3.5-3.5'],
  ['find', '동네',
   'M12 21s-6.5-5.2-6.5-10A6.5 6.5 0 0 1 12 4.5 6.5 6.5 0 0 1 18.5 11c0 4.8-6.5 10-6.5 10z M12 13a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z'],
  ['market', '시세',
   'M4 19h16 M4 15l4-4 3 3 5-6 4 4'],
  ['law', '법·제도',
   'M12 4v16 M6 7h12 M6 7l-2.5 5a2.7 2.7 0 0 0 5 0L6 7z M18 7l-2.5 5a2.7 2.7 0 0 0 5 0L18 7z M9 20h6'],
]

function TabBar({ tab, onTab }) {
  return (
    <nav className="tabbar" role="tablist" aria-label="화면">
      {TABS.map(([key, label, d]) => (
        <button key={key} role="tab" aria-pressed={tab === key} onClick={() => onTab(key)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"
               stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d={d} />
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [housing, setHousing] = useState('연립다세대')
  const [region, setRegion] = useState('11')  // 서울. 법정동코드 앞 2자리
  const [gu, setGu] = useState('11500')       // 강서구
  const [tab, setTab] = useState('verify')
  const rates = useRates()

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/tier1.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [])

  // 지역을 바꾸면 선택 구가 다른 지역 것으로 남는다. 그 지역 첫 구로 옮겨 준다.
  useEffect(() => {
    if (!data || gu.startsWith(region)) return
    const first = data.gu.find((g) => g.lawd_cd.startsWith(region))
    if (first) setGu(first.lawd_cd)
  }, [region, data, gu])

  const view = useMemo(() => {
    if (!data) return null
    const solid = data.months.filter((m) => !data.provisional.includes(m))
    const lastSolid = solid.at(-1)
    const recent12 = solid.slice(-12)
    // 시세 탭은 지역 단위로 본다. 서울과 경기를 한 랭킹에 섞으면 축만 길어진다.
    const guList = data.gu.filter((g) => g.lawd_cd.startsWith(region))

    // 구별 랭킹. 잠정 구간을 뺀 최근 12개월 중위 전세가율
    const byGu = new Map()
    for (const r of data.ratio) {
      if (!r.lawd_cd.startsWith(region)) continue
      if (r.housing_type !== housing || !recent12.includes(r.ym) || sane(r.jeonse_ratio_ppp) == null) continue
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
    const ratios = new Map(guRatio.map((r) => [r.ym, sane(r.jeonse_ratio_ppp)]))
    const byYm = (field) => {
      const m = new Map(guRatio.map((r) => [r.ym, r[field]]))
      return data.months.map((ym) => m.get(ym) ?? null)
    }

    const guName = rank.find((r) => r.key === gu)?.label
      ?? data.gu.find((g) => g.lawd_cd === gu)?.sgg_nm ?? gu

    const guNames = Object.fromEntries(data.gu.map((g) => [g.lawd_cd, g.sgg_nm]))

    return {
      rank, guName, guNames, guList, lastSolid,
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
  }, [data, housing, gu, region])

  if (err) return <main className="app"><p>데이터를 불러오지 못했습니다: {err}</p></main>
  if (!data || !view) return <main className="app"><p style={{ color: 'var(--text-muted)' }}>불러오는 중…</p></main>

  return (
    <main className="app">
      <header className="hero">
        <p className="hero-hi">전세 계약, 도장 찍기 전에</p>
        <h1>내 집 내놔</h1>
        {/* 법·제도는 전국 공통이라 지역 토글이 소음이다 */}
        {tab !== 'law' && (
          <div className="seg region-seg" role="group" aria-label="지역">
            {Object.entries(REGIONS).map(([code, label]) => (
              <button key={code} aria-pressed={region === code} onClick={() => setRegion(code)}>{label}</button>
            ))}
          </div>
        )}
      </header>

      {tab === 'market' && view.guList.length > 0 && (
        <div className="controls">
          <div className="seg" role="group" aria-label="주택 유형">
            {['연립다세대', '아파트'].map((t) => (
              <button key={t} aria-pressed={housing === t} onClick={() => setHousing(t)}>{t}</button>
            ))}
          </div>
          <select value={gu} onChange={(e) => setGu(e.target.value)} aria-label="시군구">
            {view.guList.map((g) => <option key={g.lawd_cd} value={g.lawd_cd}>{g.sgg_nm}</option>)}
          </select>
        </div>
      )}

      {tab === 'verify' && <Verify guNames={view.guNames} region={region} />}
      {tab === 'find' && <Finder guNames={view.guNames} region={region} />}
      {tab === 'law' && <Law />}

      {tab === 'market' && view.guList.length === 0 && (
        <section className="card">
          <h2>{REGIONS[region]} 시세</h2>
          <p className="sub">
            {REGIONS[region]} 실거래 데이터를 수집하고 있습니다. 수집이 끝나면 이 화면에서
            시군구별 전세가율과 평단가 추이를 보실 수 있습니다.
          </p>
        </section>
      )}

      {tab === 'market' && view.guList.length > 0 && <>
      <section className="card">
        <h2>{REGIONS[region]} 시군구별 전세가율 ({housing})</h2>
        <p className="sub">최근 12개월({ymDot(view.lastSolid)} 기준) 중위값입니다. 전세 보증금을 매매가로 나눈 값이고, 평단가 기준입니다. 막대를 누르면 그 구가 선택됩니다</p>
        <RankBars items={view.rank} format={pct0} selected={gu} onSelect={setGu} />
      </section>

      <section className="card">
        <h2>{view.guName} 평단가 추이</h2>
        <p className="sub">전용면적 1평당 만원, 월별 중위값입니다. 전세는 월세 0원 계약만 셉니다</p>
        <div className="legend">
          <span><i className="swatch" style={{ background: 'var(--series-1)' }} />매매</span>
          <span><i className="swatch" style={{ background: 'var(--series-2)' }} />전세 보증금</span>
        </div>
        <LineChart months={data.months} series={view.ppp} provisional={data.provisional} height={240}
                   format={{ tick: (v) => Math.round(v).toLocaleString(), value: manwon }} />
      </section>

      <section className="card">
        <h2>{view.guName} 전세가율 추이</h2>
        <p className="sub">높을수록 보증금이 매매가에 가깝습니다. 집값이 내려가면 반환 여력이 먼저 사라집니다</p>
        <LineChart months={data.months} series={view.ratio} provisional={data.provisional} height={210}
                   format={{ tick: (v) => `${Math.round(v * 100)}%`, value: pct }} />
      </section>

      {rates?.series?.base && (
        <section className="card">
          <h2>기준금리</h2>
          <p className="sub">
            한국은행 기준금리입니다. 금리가 오르면 매매가가 먼저 식고, 전세가율 위험은
            그 뒤에 옵니다. 위 전세가율 차트와 월이 나란합니다
          </p>
          <LineChart months={data.months} provisional={data.provisional} height={160}
                     series={[{ name: '기준금리', short: '기준금리', color: 'var(--series-1)',
                                values: data.months.map((m) => rates.series.base[m.replace('-', '')] ?? null) }]}
                     format={{ tick: (v) => `${v}%`, value: (v) => `${v.toFixed(2)}%` }} />
        </section>
      )}

      <section className="card">
        <h2>{view.guName} 거래건수</h2>
        <p className="sub">매매가 마르면 가격 검증 자체가 어려워집니다</p>
        <div className="legend">
          <span><i className="swatch" style={{ background: 'var(--series-1)' }} />매매</span>
          <span><i className="swatch" style={{ background: 'var(--series-2)' }} />전월세</span>
        </div>
        <LineChart months={data.months} series={view.deals} provisional={data.provisional} height={210}
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

      {/* 평단가·잠정치 설명은 전부 시세 흐름 얘기다. 확인 탭에 온 사람에게는 소음이다. */}
      {tab === 'market' && view.guList.length > 0 && <p className="note">
        <strong>읽는 법.</strong> 평단가는 <strong>전용면적</strong> 기준이라 공급면적으로 표시하는
        부동산 앱 숫자보다 20~30% 높게 나옵니다. 전세가율은 면적 구성의 차이를 걷어내려고
        평단가끼리 나눈 값입니다. 모든 통계는 중위값이며, 신고 후 해제된 거래는 제외했습니다.
        <br /><br />
        <strong>마지막 두 달은 잠정치입니다.</strong> 계약일로부터 30일이 신고 기한이라 뒤늦게 계속
        채워집니다. 회색 구간의 건수 감소는 시장 변화가 아니라 아직 안 들어온 신고입니다.
        <br /><br />
        <strong>이 수치는 참고용입니다.</strong> 구 단위 통계는 개별 물건의 위험을 말해주지 않습니다.
        계약 판단은 등기부등본·전입세대 확인서·보증보험 가입 가능 여부로 하셔야 합니다.
      </p>}

      <TabBar tab={tab} onTab={setTab} />
    </main>
  )
}
