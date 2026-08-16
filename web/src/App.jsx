import { useEffect, useMemo, useState } from 'react'
import { LineChart, RankBars } from './charts.jsx'
import Finder from './Finder.jsx'
import Law from './Law.jsx'
import Verify from './Verify.jsx'
import Insight from './Insight.jsx'
import About from './About.jsx'
import Wordmark from './Wordmark.jsx'
import { REGIONS, usePop, useRates, ym as ymKo } from './units.js'

const PYEONG = 3.305785
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`)
const pct0 = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const eok = (manwon) => (manwon == null ? '-' : `${(manwon / 10000).toFixed(2)}억`)
const manwon = (v) => (v == null ? '-' : `${Math.round(v).toLocaleString()}만`)
/** tier1의 월은 "2026-07" 꼴이다. 화면에는 한글로 읽히게 둔다. */
const ymDot = (s) => (s ? `${s.slice(0, 4)}년 ${+s.slice(5, 7)}월` : '-')
// 구 단위에도 면적 믹스가 깨진 달이 있다 (2022-09 영등포 아파트 168.9%). 물건 단위와
// 같은 기준으로, 정상 범위를 벗어난 값은 차트와 표에 내지 않는다.
const sane = (r) => (r != null && r < 1.5 ? r : null)

// 거래량 조망의 세 계열. 키는 volumes의 열 이름과 같다.
const VOL_DEFS = [
  ['s', '매매', 'var(--series-1)'],
  ['j', '전세', 'var(--series-2)'],
  ['w', '월세', 'var(--series-3)'],
]
const delta = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)


/** 하단 탭바. 화면 위 탭 줄보다 엄지에 가깝고, 앱으로 읽힌다. */
const TABS = [
  ['verify', '계약 전 확인',
   'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z M9.5 11.5l2 2 3.5-3.5'],
  ['find', '동네',
   'M12 21s-6.5-5.2-6.5-10A6.5 6.5 0 0 1 12 4.5 6.5 6.5 0 0 1 18.5 11c0 4.8-6.5 10-6.5 10z M12 13a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z'],
  ['market', '시세',
   'M4 19h16 M4 15l4-4 3 3 5-6 4 4'],
  ['insight', '인사이트',
   'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.6 1 1.4 1 2.5h6c0-1.1.3-1.9 1-2.5A6 6 0 0 0 12 3z'],
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
  const [volRegion, setVolRegion] = useState('all')  // 거래량 조망: 전체/서울/경기
  const [volLines, setVolLines] = useState({ s: true, j: true, w: true })
  const [volGran, setVolGran] = useState('month')    // 표 단위: month | half
  const rates = useRates()
  const pop = usePop()

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

  // 서울·경기 거래량 조망. 시장 전체가 어디로 가는지는 구 단위 차트로는 안 보인다.
  // 전월세 행의 n_jeonse/n_wolse를 나눠 세므로 전세와 월세가 분리된다.
  const volumes = useMemo(() => {
    if (!data) return null
    const want = (r) => volRegion === 'all' || r.lawd_cd.startsWith(volRegion)
    const acc = new Map()
    for (const r of data.panel) {
      if (!want(r)) continue
      let a = acc.get(r.ym)
      if (!a) { a = { s: 0, j: 0, w: 0 }; acc.set(r.ym, a) }
      if (r.deal_type === '매매') a.s += r.n_deals ?? 0
      else { a.j += r.n_jeonse ?? 0; a.w += r.n_wolse ?? 0 }
    }
    const pick = (k) => data.months.map((m) => (acc.has(m) ? acc.get(m)[k] : null))
    return { s: pick('s'), j: pick('j'), w: pick('w') }
  }, [data, volRegion])

  // 표: 월별(전월비·전년동월비) 또는 반기(전반기비·전년동기비). 집계가 덜 끝난
  // 구간(잠정 월, 6개월이 안 찼거나 잠정을 품은 반기)은 비교치를 내지 않는다.
  // 덜 채워진 분자로 만든 증감률은 숫자 모양을 한 오보다.
  const volTable = useMemo(() => {
    if (!volumes || !data) return null
    const months = data.months
    const keys = ['s', 'j', 'w']
    if (volGran === 'month') {
      const rows = []
      for (let i = months.length - 1; i >= Math.max(0, months.length - 12); i--) {
        const prov = data.provisional.includes(months[i])
        const cells = {}
        for (const k of keys) {
          const v = volumes[k][i]
          const cmp = (j, base_prov) => (v != null && !prov && !base_prov && j >= 0
            && volumes[k][j] ? v / volumes[k][j] - 1 : null)
          cells[k] = {
            v,
            d1: cmp(i - 1, data.provisional.includes(months[i - 1] ?? '')),
            yoy: cmp(i - 12, data.provisional.includes(months[i - 12] ?? '')),
          }
        }
        rows.push({ label: months[i].replace('-', '.'), partial: prov,
                    partialNote: ['잠정'], cells })
      }
      return { rows, d1Label: '전월' }
    }
    const halves = []
    for (let i = 0; i < months.length; i++) {
      const [y, mm] = months[i].split('-')
      const label = `${y} ${+mm <= 6 ? '상반기' : '하반기'}`
      let e = halves.at(-1)
      if (!e || e.label !== label) {
        e = { label, n: 0, prov: false, sums: { s: 0, j: 0, w: 0 }, any: false }
        halves.push(e)
      }
      e.n++
      if (data.provisional.includes(months[i])) e.prov = true
      for (const k of keys) {
        const v = volumes[k][i]
        if (v != null) { e.sums[k] += v; e.any = true }
      }
    }
    for (const e of halves) e.partial = e.n < 6 || e.prov
    const rows = halves.map((e, idx) => {
      const cells = {}
      for (const k of keys) {
        const v = e.any ? e.sums[k] : null
        const cmp = (o) => (o && !o.partial && !e.partial && v != null && o.sums[k]
          ? v / o.sums[k] - 1 : null)
        cells[k] = { v, d1: cmp(halves[idx - 1]), yoy: cmp(halves[idx - 2]) }
      }
      // "집계 중"만으로는 6분의 1짜리 합계가 급락으로 읽힌다. 몇 달치인지 같이 쓴다.
      // 390px에서 한 줄이면 첫 열이 표를 밀어내므로 두 줄로 나눈다.
      return { label: e.label, partial: e.partial,
               partialNote: ['집계 중', `${e.n}/6개월`], cells }
    }).reverse()
    return { rows, d1Label: '전반기' }
  }, [volumes, volGran, data])

  if (err) return <main className="app"><p>데이터를 불러오지 못했습니다: {err}</p></main>
  if (!data || !view) return <main className="app"><p style={{ color: 'var(--text-muted)' }}>불러오는 중…</p></main>

  return (
    <main className="app">
      <header className="hero">
        <p className="hero-hi">부동산 계약의 세컨드 오피니언</p>
        <h1><Wordmark /></h1>
        {/* 처음 온 사람이 3초 안에 "고르는 앱이 아니라 확인하는 앱"임을 알아야 한다.
            브랜드 태그라인("계약 전에 꼭 필요한 것들")은 소개와 앱 설명에 산다. */}
        <p className="hero-tag">계약하고 나서야 알게 되는 것들을 계약하기 전에</p>
        {tab !== 'about' && (
          <button className="about-link" onClick={() => setTab('about')}>
            어떤 서비스인가요 →
          </button>
        )}
        {/* 법·제도는 전국 공통, 인사이트·소개는 서울·경기 통합이라 지역 토글이 소음이다 */}
        {['verify', 'find', 'market'].includes(tab) && (
          <div className="seg region-seg" role="group" aria-label="지역">
            {Object.entries(REGIONS).map(([code, label]) => (
              <button key={code} aria-pressed={region === code} onClick={() => setRegion(code)}>{label}</button>
            ))}
          </div>
        )}
      </header>

      {tab === 'verify' && <Verify guNames={view.guNames} region={region} />}
      {tab === 'find' && <Finder guNames={view.guNames} region={region} />}
      {tab === 'law' && <Law />}
      {tab === 'insight' && <Insight onGoFind={() => setTab('find')} />}
      {tab === 'about' && <About onBack={() => setTab('verify')} />}

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
      {/* 서울·경기 조망. 히어로의 지역 토글과 무관하게 자기 세그로 전체/서울/경기를
          오간다. 시장이 어디로 가는지 보고 나서 구 단위로 내려가는 순서다.
          '수도권'이라 부르지 않는다. 인천이 없다. */}
      <section className="card">
        <h2>서울·경기 거래량 조망</h2>
        <p className="sub">
          아파트·연립다세대·오피스텔 실거래 신고 건수입니다({ymDot(data.months[0])}부터
          월별, 전월세는 갱신 계약 포함, 단독주택은 수집 범위에 포함되지 않습니다).
          회색 잠정 구간에서 줄어드는 것처럼 보이는 부분은 실제 감소가 아니라
          아직 접수되지 않은 신고입니다
        </p>
        <div className="seg" role="group" aria-label="거래량 범위" style={{ marginBottom: 8 }}>
          {[['all', '전체'], ['11', '서울'], ['41', '경기']].map(([v, label]) => (
            <button key={v} aria-pressed={volRegion === v} onClick={() => setVolRegion(v)}>{label}</button>
          ))}
        </div>
        {/* 범례가 곧 필터다. 세 선이 수렴 구간에서 겹치므로 눌러서 하나만 남길 수
            있게 한다. 표의 열도 함께 따라간다. 마지막 하나는 못 끈다. */}
        <div className="filters" style={{ marginBottom: 6 }}>
          {VOL_DEFS.map(([k, name, color]) => (
            <button key={k} className="chip" aria-pressed={volLines[k]}
                    disabled={volLines[k] && Object.values(volLines).filter(Boolean).length === 1}
                    onClick={() => setVolLines((cur) => {
                      const next = { ...cur, [k]: !cur[k] }
                      return Object.values(next).some(Boolean) ? next : cur
                    })}>
              <i className="swatch" style={{ background: color, display: 'inline-block', marginRight: 6 }} />
              {name}
            </button>
          ))}
        </div>
        <LineChart months={data.months} provisional={data.provisional} height={230}
                   series={VOL_DEFS.filter(([k]) => volLines[k])
                     .map(([k, name, color]) => ({ name, short: name, color, values: volumes[k] }))}
                   format={{ tick: (v) => v >= 10000 ? `${(v / 10000).toFixed(1)}만` : v.toLocaleString(),
                             value: (v) => `${v.toLocaleString()}건` }} />

        <div className="seg" role="group" aria-label="표 단위" style={{ margin: '10px 0 4px' }}>
          {[['month', '월별'], ['half', '반기']].map(([v, label]) => (
            <button key={v} aria-pressed={volGran === v} onClick={() => setVolGran(v)}>{label}</button>
          ))}
        </div>
        <div className="scroll-x">
          <table className="data vol-table">
            <thead>
              <tr>
                <th>{volGran === 'month' ? '월' : '반기'}</th>
                {VOL_DEFS.filter(([k]) => volLines[k]).map(([k, name]) => <th key={k}>{name}</th>)}
              </tr>
            </thead>
            <tbody>
              {volTable.rows.map((r) => (
                <tr key={r.label}>
                  <td>
                    {r.label}
                    {r.partial && r.partialNote.map((t) => <small key={t} className="delta">{t}</small>)}
                  </td>
                  {VOL_DEFS.filter(([k]) => volLines[k]).map(([k]) => (
                    <td key={k}>
                      {r.cells[k].v == null ? '-' : r.cells[k].v.toLocaleString()}
                      <small className="delta">{volTable.d1Label} {delta(r.cells[k].d1)}</small>
                      <small className="delta">전년 {delta(r.cells[k].yoy)}</small>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ marginTop: 6 }}>
          집계 중인 구간(잠정 월, 안 찬 반기)은 증감률을 내지 않습니다. 덜 채워진 숫자로
          만든 비교는 틀린 신호가 됩니다
        </p>
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


      {/* 여기부터 시군구 상세. 유형·시군구 필터는 자기가 지배하는 카드들 바로 위에
          앉는다. 조망 카드 위에 두면 "아파트를 눌렀는데 첫 차트가 안 움직이는"
          경험이 된다. 화면 순서가 조망(전체) -> 상세(선택한 구)라는 위계와 같아진다. */}
      <div className="detail-head">
        <h2>시군구 상세</h2>
        <p>여기서 고른 시군구와 유형이 아래 차트에 적용됩니다 (세대수는 유형 구분이 없습니다)</p>
      </div>
      <div className="controls detail-controls">
        <div className="seg" role="group" aria-label="주택 유형">
          {/* 오피스텔은 데이터가 실제로 있을 때만 버튼을 낸다. 백필이 끝나기 전
              빈 차트로 안내하는 것보다 없는 편이 낫다. */}
          {['연립다세대', '아파트', '오피스텔']
            .filter((t) => t !== '오피스텔' || data.panel.some((p) => p.housing_type === t))
            .map((t) => (
              <button key={t} aria-pressed={housing === t} onClick={() => setHousing(t)}>{t}</button>
            ))}
        </div>
        <select value={gu} onChange={(e) => setGu(e.target.value)} aria-label="시군구">
          {view.guList.map((g) => <option key={g.lawd_cd} value={g.lawd_cd}>{g.sgg_nm}</option>)}
        </select>
      </div>

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

      {/* 세대수 추이. 구 단위 배경 지표라 시세 탭에만 산다. 물건 리포트에는
          붙이지 않는다. 구 통계는 개별 물건의 위험을 말해주지 않는다. */}
      {pop?.series && (() => {
        const hh = data.months.map((m) => pop.series[gu]?.[m.replace('-', '')]?.[1] ?? null)
        const lastIdx = hh.reduce((a, v, i) => (v != null ? i : a), -1)
        if (lastIdx < 0) return null
        // 기준 시점은 파일 전체의 asof가 아니라 이 구의 마지막 값이다. 커버리지
        // 가드는 10%까지 결측을 허용하므로 전역 asof는 그 구에서 거짓말이 된다.
        const guAsof = data.months[lastIdx].replace('-', '')
        return (
          <section className="card">
            <h2>{view.guName} 세대수 추이</h2>
            <p className="sub">
              세대가 줄면 매매 수요부터 마르고, 매매가 마르면 보증금 검증이 어려워집니다.
              행정안전부 <strong>주민등록</strong> 세대 기준이며 이 구는 {ymKo(guAsof)} 말일
              집계까지 반영되어 있습니다
            </p>
            <LineChart months={data.months} provisional={[]} height={180}
                       series={[{ name: '세대수', short: '세대수', color: 'var(--series-1)',
                                  values: hh }]}
                       format={{ tick: (v) => `${(v / 10000).toFixed(1)}만`,
                                 value: (v) => `${v.toLocaleString()}세대` }} />
          </section>
        )
      })()}
      </>}

      {/* 평단가·잠정치 설명은 전부 시세 흐름 얘기다. 확인 탭에 온 사람에게는 소음이다. */}
      {tab === 'market' && view.guList.length > 0 && <p className="note">
        <strong>읽는 법.</strong> 평단가는 <strong>전용면적</strong> 기준이라 공급면적으로 표시하는
        부동산 앱 숫자보다 20~30% 높게 나옵니다. 전세가율은 면적 구성의 차이를 걷어내려고
        평단가끼리 나눈 값입니다. 모든 통계는 중위값이며, 신고 후 해제된 거래는 제외했습니다.
        <br /><br />
        <strong>회색 구간은 잠정치입니다.</strong> 계약일로부터 30일이 신고 기한이라, 말일 기준
        신고 기한이 안 지난 달은 뒤늦게 계속 채워집니다. 그 구간의 건수 감소는 시장 변화가
        아니라 아직 안 들어온 신고입니다.
        <br /><br />
        <strong>이 수치는 참고용입니다.</strong> 구 단위 통계는 개별 물건의 위험을 말해주지 않습니다.
        계약 판단은 등기부등본·전입세대 확인서·보증보험 가입 가능 여부로 하셔야 합니다.
      </p>}

      <TabBar tab={tab} onTab={setTab} />
    </main>
  )
}
