import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UnitCard, eok, pct0, ratioTone } from './UnitLookup.jsx'

/**
 * 조건 검색 — 서울 전체에서 내 조건에 맞는 집을 추린다.
 *
 * 물건 조회 탭이 "이 구에서 위험한 게 뭐냐"를 본다면 여기는 반대 방향이다.
 * 예산·면적·연식·지역을 먼저 걸고, 남은 것 중에서 순서를 매긴다.
 *
 * finder.json은 열 단위로 담겨 있다(83,895개 · gzip 0.96MB). 행 객체로 펼치면
 * 메모리가 40MB쯤 되므로 열 배열을 그대로 두고 인덱스만 걸러 정렬한다.
 */

const PYEONG = 3.305785

const YEAR_OPTS = [
  { v: 0, label: '연식 상관없음' },
  { v: 1990, label: '1990년 이후' },
  { v: 2000, label: '2000년 이후' },
  { v: 2010, label: '2010년 이후' },
  { v: 2015, label: '2015년 이후' },
  { v: 2020, label: '2020년 이후' },
]

const SORTS = [
  { key: 'safe', label: '안전한 순' },
  { key: 'new', label: '최근 준공 순' },
  { key: 'big', label: '넓은 순' },
  { key: 'cheap', label: '보증금 낮은 순' },
]

/**
 * 정렬용 보증금 안전 점수(0~100). 두 조각을 더한다.
 *  - 근거(최대 40): 그 건물 실거래로 값을 확인할 수 있느냐. 확인이 안 되면 나머지는 추정이다.
 *  - 여유(최대 60): 전세가율이 100%에서 얼마나 떨어져 있느냐.
 * 점수 자체는 화면에 숫자로 내지 않는다. 근거와 전세가율을 그대로 보여주는 편이 정직하다.
 */
function safety(ratio, stage, ns) {
  const evidence = stage === 0 ? (ns >= 3 ? 40 : 25) : stage === 1 ? 15 : stage === 2 ? 8 : 0
  if (ratio == null) return evidence
  const room = Math.max(0, Math.min(1, (1.05 - ratio) / 0.55))
  return evidence + 60 * room
}

function useFinder() {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/units/finder.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        const col = Object.fromEntries(d.cols.map((c, i) => [c, d.columns[i]]))
        setState({ status: 'ready', d, col })
      })
      .catch((e) => setState({ status: 'error', message: e.message }))
  }, [])
  return state
}

const PAGE = 60

export default function Finder({ guNames }) {
  const fin = useFinder()
  const [budget, setBudget] = useState('')       // 억
  const [minPy, setMinPy] = useState('')         // 평
  const [minYear, setMinYear] = useState(0)
  const [ht, setHt] = useState('')               // '' 전체 / 'A' / 'R'
  const [gus, setGus] = useState([])             // 선택한 lawd_cd, 비면 전체
  const [needSale, setNeedSale] = useState(false)
  const [sort, setSort] = useState('safe')
  const [limit, setLimit] = useState(PAGE)
  // 펼친 줄 하나만 들고 있는다. {key, u} | {key, loading} | {key, error}
  const [open, setOpen] = useState(null)

  const cap = budget === '' ? null : Math.round(Number(budget) * 10000)
  const minArea = minPy === '' ? null : Number(minPy) * PYEONG

  const hits = useMemo(() => {
    if (fin.status !== 'ready') return []
    const { col, d } = fin
    const guSet = gus.length ? new Set(gus.map((g) => d.gus.indexOf(g))) : null
    const out = []
    for (let i = 0; i < d.n; i++) {
      if (ht && col.ht[i] !== ht) continue
      if (guSet && !guSet.has(col.g[i])) continue
      if (cap != null && !(col.jeonse[i] <= cap)) continue
      if (minArea != null && !(col.area[i] >= minArea)) continue
      if (minYear && !(col.by[i] >= minYear)) continue
      if (needSale && !col.ns[i]) continue
      out.push(i)
    }
    const key = {
      safe: (i) => safety(col.ratio[i], col.stage[i], col.ns[i]),
      new: (i) => col.by[i] ?? -1,
      big: (i) => col.area[i] ?? -1,
      cheap: (i) => -(col.jeonse[i] ?? Infinity),
    }[sort]
    out.sort((a, b) => key(b) - key(a))
    return out
  }, [fin, cap, minArea, minYear, ht, gus, needSale, sort])

  useEffect(() => { setLimit(PAGE) }, [cap, minArea, minYear, ht, gus, needSale, sort])

  // 목록 끝이 보이면 이어 붙인다. 전량이 이미 메모리에 있어 네트워크는 타지 않는다.
  const sentinel = useRef(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || limit >= hits.length) return
    const io = new IntersectionObserver(
      (e) => e[0].isIntersecting && setLimit((n) => n + PAGE), { rootMargin: '400px' })
    io.observe(node)
    return () => io.disconnect()
  }, [limit, hits.length])

  // 상세는 구 파일에서 행 번호로 꺼낸다. 한 번 받은 구는 다시 받지 않는다.
  const cache = useRef(new Map())
  const toggle = useCallback(async (idx, key) => {
    if (open?.key === key) return setOpen(null)      // 다시 누르면 접는다
    const { col, d } = fin
    const lawd = d.gus[col.g[idx]]
    setOpen({ key, loading: true })
    try {
      if (!cache.current.has(lawd)) {
        const r = await fetch(`${import.meta.env.BASE_URL}data/units/${lawd}.json`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        cache.current.set(lawd, await r.json())
      }
      const g = cache.current.get(lawd)
      const row = g.rows[col.i[idx]]
      const u = Object.fromEntries(g.cols.map((c, k) => [c, row[k]]))
      // 그 사이 다른 줄을 눌렀으면 늦게 온 응답으로 덮어쓰지 않는다
      setOpen((cur) => (cur?.key === key ? { key, u } : cur))
    } catch (e) {
      setOpen((cur) => (cur?.key === key ? { key, error: e.message } : cur))
    }
  }, [fin, open])

  const toggleGu = (lawd) =>
    setGus((cur) => (cur.includes(lawd) ? cur.filter((g) => g !== lawd) : [...cur, lawd]))

  if (fin.status === 'error') {
    return (
      <section className="card">
        <h2>조건 검색</h2>
        <p className="sub">
          {fin.message === 'HTTP 404'
            ? '조건 검색 데이터가 아직 배포에 포함되지 않았습니다. 수집 워크플로가 한 번 더 돌면 붙습니다.'
            : `불러오지 못했습니다 (${fin.message})`}
        </p>
      </section>
    )
  }
  if (fin.status !== 'ready') {
    return <section className="card"><h2>조건 검색</h2><p className="sub">서울 전체 물건을 불러오는 중…</p></section>
  }

  const { col, d } = fin
  return (
    <section className="card">
      <h2>조건 검색</h2>
      <p className="sub">
        서울 전체 {d.n.toLocaleString()}개 · {d.window[0]}~{d.window[1]} 전세 계약이 있던 물건
      </p>

      <div className="cond">
        <label>
          <span>보증금 상한</span>
          <input type="number" inputMode="decimal" step="0.5" min="0" placeholder="예: 3"
                 value={budget} onChange={(e) => setBudget(e.target.value)} />
          <em>억</em>
        </label>
        <label>
          <span>최소 전용면적</span>
          <input type="number" inputMode="decimal" step="1" min="0" placeholder="예: 15"
                 value={minPy} onChange={(e) => setMinPy(e.target.value)} />
          <em>평</em>
        </label>
        <label>
          <span>준공</span>
          <select value={minYear} onChange={(e) => setMinYear(Number(e.target.value))}>
            {YEAR_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>유형</span>
          <select value={ht} onChange={(e) => setHt(e.target.value)}>
            <option value="">전체</option>
            <option value="R">연립·다세대</option>
            <option value="A">아파트</option>
          </select>
        </label>
      </div>

      {/* 칩 25개를 펼쳐 두면 390px 화면에서 결과가 여섯 줄 아래로 밀린다 */}
      <details className="gu-picker">
        <summary>
          지역 — {gus.length === 0 ? '서울 전체'
            : gus.length <= 3 ? gus.map((g) => guNames[g] ?? g).join(', ')
            : `${guNames[gus[0]] ?? gus[0]} 외 ${gus.length - 1}곳`}
        </summary>
        <div className="filters" role="group" aria-label="자치구">
          {d.gus.map((lawd) => (
            <button key={lawd} className="chip" aria-pressed={gus.includes(lawd)}
                    onClick={() => toggleGu(lawd)}>{guNames[lawd] ?? lawd}</button>
          ))}
          {gus.length > 0 && (
            <button className="chip clear" onClick={() => setGus([])}>서울 전체</button>
          )}
        </div>
      </details>

      <div className="filters">
        <button className="chip" aria-pressed={needSale} onClick={() => setNeedSale((v) => !v)}
                title="이 건물의 최근 2년 매매 신고가 있어 담보 가치를 실거래로 확인할 수 있는 물건만">
          매매 사례 있는 것만
        </button>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="정렬">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <p className="muted-line">
        조건에 맞는 물건 <strong>{hits.length.toLocaleString()}개</strong>
        {sort === 'safe' && ' · 그 건물 실거래로 값을 확인할 수 있는 물건이 먼저, 그다음이 전세가율 여유 순입니다'}
      </p>

      <ul className="unit-list">
        {hits.slice(0, limit).map((i) => {
          const key = `${col.g[i]}-${col.i[i]}`
          return (
          <li key={key}>
            <button aria-expanded={open?.key === key} onClick={() => toggle(i, key)}>
              <span className="u-name">{col.name[i] || '(이름 없음)'}</span>
              <span className="u-meta">
                {guNames[d.gus[col.g[i]]] ?? ''} {d.umds[col.u[i]]} · {col.ht[i] === 'A' ? '아파트' : '연립·다세대'}
                {' · '}전용 {col.area[i]}m²({(col.area[i] / PYEONG).toFixed(1)}평)
                {col.by[i] ? ` · ${col.by[i]}년` : ''}
              </span>
              <span className="u-sig">
                <em>{eok(col.jeonse[i])}</em>
                <small className={ratioTone(col.ratio[i])}>
                  {col.ratio[i] == null ? '전세가율 비교 불가'
                    : `${d.stages[col.stage[i]] === 'A' ? '' : '약 '}${pct0(col.ratio[i])}`}
                  {col.ns[i] ? ` · 매매 ${col.ns[i]}건` : ' · 매매 0건'}
                </small>
              </span>
            </button>
            {open?.key === key && (
              open.u ? <UnitCard u={open.u} onClose={() => setOpen(null)} />
              : open.error ? <p className="muted-line critical">상세를 불러오지 못했습니다 ({open.error})</p>
              : <p className="muted-line">불러오는 중…</p>
            )}
          </li>
          )
        })}
      </ul>

      {!hits.length && <p className="muted-line">조건에 맞는 물건이 없습니다. 예산이나 면적을 넓혀 보세요.</p>}
      {limit < hits.length && (
        <>
          <div ref={sentinel} aria-hidden="true" />
          <button className="more" onClick={() => setLimit((n) => n + PAGE)}>
            더 보기 ({(hits.length - limit).toLocaleString()}개 남음)
          </button>
        </>
      )}

      <p className="warnline">
        <strong>아직 못 넣은 조건이 있습니다.</strong> 통근 시간과 조용함은 지금 데이터로는 답이 안 됩니다.
        통근은 물건 좌표가 있어야 하고(지오코딩 키 필요), 층간소음은 건축물대장의 구조·사용승인일로
        추정할 참인데 지금 수집 중입니다. 붙는 대로 조건에 추가하겠습니다.
      </p>
    </section>
  )
}
