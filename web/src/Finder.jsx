import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from './MapView.jsx'
import { RATIO_BROKEN, UnitCard, eok, pct0, ratioTone } from './UnitLookup.jsx'
import { htName, REGIONS, useCompare, useFinder, useGuard, useSubway, ym } from './units.js'

/**
 * 조건 검색. 선택한 지역(서울·경기) 전체에서 내 조건에 맞는 집을 추린다.
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

/**
 * 위험 신호로 좁히기. "우리 동네에서 매매 사례가 없는 빌라"처럼 목록을 훑는 것보다
 * 조건으로 자르는 게 실제 쓰임에 가깝다. 판단 보류(비교 기준이 깨진 값)는 위험이
 * 아니라 모름이므로 어느 쪽에도 넣지 않는다.
 */
const RISKS = [
  { key: 'confirmed', label: '확인된 깡통',
    hint: '그 건물 매매 3건 이상을 기준으로 보증금이 매매가를 넘습니다',
    test: (c, i) => c.stage[i] === 0 && c.ns[i] >= 3 && c.ratio[i] >= 1 && c.ratio[i] < RATIO_BROKEN },
  { key: 'high', label: '전세가율 90%↑',
    hint: '근거 단계와 무관하게 전세가율이 90% 이상입니다',
    test: (c, i) => c.ratio[i] >= 0.9 && c.ratio[i] < RATIO_BROKEN },
  { key: 'newvilla', label: '신축 빌라 · 매매 0건',
    hint: '2018년 이후 준공인데 매매가 한 건도 없고 전세만 5건 이상입니다. 빌라 중 1%뿐이고, 전세사기 물건에서 반복된 패턴입니다',
    test: (c, i) => c.ht[i] === 'R' && !c.ns[i] && (c.apr[i] ?? c.by[i]) >= 2018 && c.nj[i] >= 5 },
  { key: 'nosale', label: '매매 0건',
    hint: '최근 2년 매매 신고가 없습니다. 빌라에서는 열에 일곱이라 기준선에 가깝고, 아파트에서는 열에 셋뿐입니다',
    test: (c, i) => !c.ns[i] },
  { key: 'reverse', label: '역전세',
    hint: '갱신 계약에서 보증금이 5% 이상 내려갔습니다. 집주인이 보증금을 돌려주고 있다는 뜻입니다',
    test: (c, i) => c.hike[i] != null && c.hike[i] <= -0.05 },
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
  // 비교 기준이 깨진 값은 "가장 위험함"이 아니라 "모름"이다. 안전 순 맨 뒤에 두면
  // 정작 실거래로 확인된 깡통이 그 아래로 밀린다.
  if (ratio == null || ratio >= RATIO_BROKEN) return evidence
  const room = Math.max(0, Math.min(1, (1.05 - ratio) / 0.55))
  return evidence + 60 * room
}

/** 지하철역. 지도에서 통근 판단의 기준점이라 조건과 무관하게 늘 그린다. */
const PAGE = 60

export default function Finder({ guNames, region = '11' }) {
  const fin = useFinder(region)
  const stationPins = useSubway()
  const [budget, setBudget] = useState('')       // 억
  const [saleCapIn, setSaleCapIn] = useState('') // 억. 매매가 상한
  const [maxWalk, setMaxWalk] = useState(0)      // 분. 0이면 무관
  const [minPy, setMinPy] = useState('')         // 평
  const [minYear, setMinYear] = useState(0)
  const [ht, setHt] = useState('')               // '' 전체 / 'A' / 'R'
  const [gus, setGus] = useState([])             // 선택한 lawd_cd, 비면 전체
  const [needSale, setNeedSale] = useState(false)
  const [needElvt, setNeedElvt] = useState(false)
  const [risk, setRisk] = useState([])       // 켜진 위험 필터
  const [sort, setSort] = useState('safe')
  const [view, setView] = useState('list')   // list | map
  const [limit, setLimit] = useState(PAGE)
  // 펼친 줄 하나만 들고 있는다. {key, u} | {key, loading} | {key, error}
  const [open, setOpen] = useState(null)
  const compare = useCompare()
  const guard = useGuard()

  // 지역을 바꾸면 선택한 시군구와 펼친 줄은 이전 지역 것이라 의미가 없다
  useEffect(() => { setGus([]); setOpen(null) }, [region])

  const cap = budget === '' ? null : Math.round(Number(budget) * 10000)
  const saleCap = saleCapIn === '' ? null : Math.round(Number(saleCapIn) * 10000)
  const minArea = minPy === '' ? null : Number(minPy) * PYEONG
  // 새 열은 데이터보다 코드가 먼저 배포될 수 있다. 열이 정말 실려 왔는지는
  // FILL로 채워진 col이 아니라 원본 cols 목록이 말해 준다.
  const hasSale = fin.status === 'ready' && fin.d.cols.includes('sale')

  // 건축물대장이 얼마나 붙었는지는 숨기면 안 된다. 필터가 왜 이렇게 적게 남는지의 답이다.
  // 렌더마다 8만 행을 두 번 훑지 않도록 데이터가 바뀔 때만 센다.
  const { coverage, geoCoverage, walkCoverage } = useMemo(() => {
    if (fin.status !== 'ready') return { coverage: 0, geoCoverage: 0, walkCoverage: 0 }
    const { col, d } = fin
    let e = 0, g = 0, w = 0
    for (let i = 0; i < d.n; i++) {
      if (col.elvt[i] != null) e++
      if (col.lat[i] != null) g++
      if (col.walk[i] != null) w++
    }
    return { coverage: e / d.n, geoCoverage: g / d.n, walkCoverage: w / d.n }
  }, [fin])

  // 예산 역산. "내 보증금이면 어느 동네에 안전한 선택지가 많은가"는 전 물건의
  // 위험 판정이 있어야 답할 수 있고, 매물 앱은 못 하는 방향이다. 확인된 안전 =
  // 그 건물 매매 3건 이상이고 전세가율 90% 미만.
  const byBudget = useMemo(() => {
    if (fin.status !== 'ready' || cap == null || gus.length) return null
    const { col, d } = fin
    const acc = d.gus.map(() => ({ n: 0, safe: 0 }))
    for (let i = 0; i < d.n; i++) {
      if (!(col.jeonse[i] <= cap)) continue
      if (ht && col.ht[i] !== ht) continue
      const a = acc[col.g[i]]
      a.n++
      if (col.stage[i] === 0 && col.ns[i] >= 3 && col.ratio[i] < 0.9) a.safe++
    }
    return d.gus.map((lawd, gi) => ({ lawd, ...acc[gi] }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.safe - a.safe)
  }, [fin, cap, ht, gus.length])

  const hits = useMemo(() => {
    if (fin.status !== 'ready') return []
    const { col, d } = fin
    const guSet = gus.length ? new Set(gus.map((g) => d.gus.indexOf(g))) : null
    const tests = RISKS.filter((r) => risk.includes(r.key)).map((r) => r.test)
    const out = []
    for (let i = 0; i < d.n; i++) {
      if (ht && col.ht[i] !== ht) continue
      if (guSet && !guSet.has(col.g[i])) continue
      if (cap != null && !(col.jeonse[i] <= cap)) continue
      // 매매가 필터는 매매 사례가 있는 물건만 통과시킨다. "3억 이하"를 물은
      // 사람에게 값을 모르는 물건을 끼워 주면 필터가 거짓말이 된다.
      if (saleCap != null && !(col.sale[i] != null && col.sale[i] <= saleCap)) continue
      if (maxWalk && !(col.walk[i] != null && col.walk[i] <= maxWalk)) continue
      if (minArea != null && !(col.area[i] >= minArea)) continue
      if (minYear && !(col.by[i] >= minYear)) continue
      if (needSale && !col.ns[i]) continue
      if (needElvt && !col.elvt[i]) continue
      if (tests.length && !tests.every((t) => t(col, i))) continue
      out.push(i)
    }
    const key = {
      // 안전 점수는 상위 3천여 개가 100점 동점이라, 2차 키(매매 표본 두께)가 없으면
      // 첫 페이지가 파일 순서(구 -> 가나다)로 나온다. 표본 많은 순이 설명과 맞는 순서다.
      safe: (i) => safety(col.ratio[i], col.stage[i], col.ns[i]) * 1e4 + Math.min(col.ns[i] ?? 0, 999) * 10 + Math.min(col.nj[i] ?? 0, 9) ,
      new: (i) => col.by[i] ?? -1,
      big: (i) => col.area[i] ?? -1,
      cheap: (i) => -(col.jeonse[i] ?? Infinity),
    }[sort]
    out.sort((a, b) => key(b) - key(a))
    return out
  }, [fin, cap, saleCap, maxWalk, minArea, minYear, ht, gus, needSale, needElvt, risk, sort])

  useEffect(() => { setLimit(PAGE) }, [cap, saleCap, maxWalk, minArea, minYear, ht, gus, needSale, needElvt, risk, sort])

  // 지도에 찍을 점. 좌표가 없는 물건은 뺀다. 지오코딩이 끝나기 전까지는 대부분이 그렇다.
  const pins = useMemo(() => {
    if (view !== 'map' || fin.status !== 'ready') return []
    const { col } = fin
    const out = []
    for (const i of hits) {
      if (col.lat[i] == null) continue
      out.push({
        i, lat: col.lat[i], lon: col.lon[i],
        tone: ratioTone(col.ratio[i]),
        label: `${col.name[i] || '(이름 없음)'} · ${eok(col.jeonse[i])}`,
      })
    }
    return out
  }, [view, fin, hits])

  // 지도에서 짚어 줄 물건. 목록에서 펼친 것과 같은 물건이다.
  const picked = useMemo(() => {
    if (fin.status !== 'ready' || !open?.key) return null
    const { col } = fin
    const idx = hits.find((i) => `${col.g[i]}-${col.i[i]}` === open.key)
    if (idx == null || col.lat[idx] == null) return null
    return {
      lat: col.lat[idx], lon: col.lon[idx], tone: ratioTone(col.ratio[idx]),
      label: `${col.name[idx] || '(이름 없음)'} · ${eok(col.jeonse[idx])}`,
    }
  }, [fin, open, hits])

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
      // 행 번호는 빌드마다 밀린다. 세대가 어긋난 파일 조합이면 다른 물건이 뜬다.
      if (d.build && g.build && g.build !== d.build) {
        throw new Error('데이터가 갱신되었습니다. 화면을 새로고침해 주세요')
      }
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

  if (fin.status === 'pending') {
    return (
      <section className="card">
        <h2>동네 살펴보기</h2>
        <p className="sub">
          {REGIONS[region]} 실거래 데이터를 수집하고 있습니다. 수집이 끝나면 이 화면에서
          조건으로 걸러 보실 수 있습니다.
        </p>
      </section>
    )
  }
  if (fin.status === 'error') {
    return (
      <section className="card">
        <h2>동네 살펴보기</h2>
        <p className="sub">
          {fin.message === 'HTTP 404'
            ? '데이터가 아직 배포에 포함되지 않았습니다. 수집 워크플로가 한 번 더 돌면 붙습니다.'
            : `불러오지 못했습니다 (${fin.message})`}
        </p>
      </section>
    )
  }
  if (fin.status !== 'ready') {
    return <section className="card"><h2>동네 살펴보기</h2><p className="sub">{REGIONS[region]} 전체 물건을 불러오는 중…</p></section>
  }

  const { col, d } = fin
  return (
    <section className="card">
      <h2>동네 살펴보기</h2>
      <p className="sub">
        <strong>매물 목록이 아닙니다.</strong> {ym(d.window[0])}~{ym(d.window[1])}에 전세 계약이 있었던
        건물 {d.n.toLocaleString()}개입니다. 지금 계약 가능한 방인지는 알 수 없습니다.
        시세와 분포를 보는 용도입니다.
      </p>

      <div className="cond">
        <label>
          <span>보증금 상한</span>
          <input type="number" inputMode="decimal" step="0.5" min="0" placeholder="예: 3"
                 value={budget} onChange={(e) => setBudget(e.target.value)} />
          <em>억</em>
        </label>
        <label>
          <span>매매가 상한{hasSale ? '' : ' · 다음 데이터 갱신 후'}</span>
          <input type="number" inputMode="decimal" step="0.5" min="0" placeholder="예: 3"
                 disabled={!hasSale} value={saleCapIn}
                 onChange={(e) => setSaleCapIn(e.target.value)} />
          <em>억</em>
        </label>
        <label>
          {/* 좌표가 일부만 수집된 동안에는 이 필터가 좌표 없는 건물을 걸러낸다는
              사실을 숨기지 않는다. 수집이 끝나면 백분율 표기는 저절로 사라진다. */}
          <span>역까지 도보{walkCoverage <= 0 ? ' · 좌표 수집 후'
            : walkCoverage < 0.95 ? ` · 좌표 있는 ${Math.round(walkCoverage * 100)}%만 검색됨` : ''}</span>
          <select disabled={walkCoverage <= 0} value={maxWalk}
                  onChange={(e) => setMaxWalk(Number(e.target.value))}>
            <option value={0}>무관</option>
            <option value={5}>5분 이내</option>
            <option value={10}>10분 이내</option>
            <option value={15}>15분 이내</option>
          </select>
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

      {byBudget && (
        <div className="budget-rank">
          <p className="muted-line">
            보증금 {budget}억이면 어느 동네에 안전한 선택지가 많은지부터 보세요.
            <strong> 확인된 안전</strong>은 그 건물 매매 3건 이상에 전세가율 90% 미만이라는
            뜻입니다. 구를 누르면 그 구만 걸러집니다.
          </p>
          <ul>
            {byBudget.slice(0, 8).map((r) => (
              <li key={r.lawd}>
                <button onClick={() => setGus([r.lawd])}>
                  <span>{guNames[r.lawd] ?? r.lawd}</span>
                  <em>확인된 안전 {r.safe.toLocaleString()}개</em>
                  <small>예산 안 {r.n.toLocaleString()}개 중 {Math.round((r.safe / r.n) * 100)}%</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 칩 25개를 펼쳐 두면 390px 화면에서 결과가 여섯 줄 아래로 밀린다 */}
      <details className="gu-picker">
        <summary>
          지역 · {gus.length === 0 ? `${REGIONS[region]} 전체`
            : gus.length <= 3 ? gus.map((g) => guNames[g] ?? g).join(', ')
            : `${guNames[gus[0]] ?? gus[0]} 외 ${gus.length - 1}곳`}
        </summary>
        <div className="filters" role="group" aria-label="시군구">
          {d.gus.map((lawd) => (
            <button key={lawd} className="chip" aria-pressed={gus.includes(lawd)}
                    onClick={() => toggleGu(lawd)}>{guNames[lawd] ?? lawd}</button>
          ))}
          {gus.length > 0 && (
            <button className="chip clear" onClick={() => setGus([])}>{REGIONS[region]} 전체</button>
          )}
        </div>
      </details>

      <div className="filters">
        <button className="chip" aria-pressed={needSale} onClick={() => setNeedSale((v) => !v)}
                title="이 건물의 최근 2년 매매 신고가 있어 담보 가치를 실거래로 확인할 수 있는 물건만">
          매매 사례 있는 것만
        </button>
        {/* 대장이 2%뿐일 때 이 칩을 켜면 83,895개가 792개로 줄어든다. 승강기가 없어서가
            아니라 대장을 안 받아서다. 데이터가 차기 전에는 눌러서 실망할 버튼을 안 보여 준다. */}
        {coverage >= 0.3 && (
          <button className="chip" aria-pressed={needElvt} onClick={() => setNeedElvt((v) => !v)}
                  title="건축물대장에 승강기가 등록된 물건만. 대장을 아직 안 받은 물건은 함께 걸러집니다">
            엘리베이터
          </button>
        )}
        {RISKS.map((r) => (
          <button key={r.key} className="chip" title={r.hint}
                  aria-pressed={risk.includes(r.key)}
                  onClick={() => setRisk((cur) => cur.includes(r.key)
                    ? cur.filter((k) => k !== r.key) : [...cur, r.key])}>
            {r.label}
          </button>
        ))}
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="정렬">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <p className="muted-line">
        조건에 맞는 물건이 <strong>{hits.length.toLocaleString()}개</strong> 있습니다.
        {sort === 'safe' && ' 그 건물 실거래로 값을 확인할 수 있는 물건이 먼저 오고, 그다음이 전세가율 여유 순입니다'}
      </p>

      {/* 좌표 0%에서 지도 탭은 "물건 핀 0개"만 보여 준다. 만든 것만 못한 화면이라
          좌표가 붙기 시작하면 자동으로 나타나게 한다. MapView 코드는 그대로 산다. */}
      {geoCoverage >= 0.3 && (
        <div className="seg" role="group" aria-label="보기" style={{ marginBottom: 10 }}>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>목록</button>
          <button aria-pressed={view === 'map'} onClick={() => setView('map')}>지도</button>
        </div>
      )}

      {view === 'map' && (
        <>
          {/* 마커를 누르면 지도에 머문 채 아래에 카드를 편다. 목록으로 튕기면
              방금 보던 자리를 잃는다 — 지도는 위치 감각이 전부인 화면이다. */}
          <MapView points={pins} stations={stationPins} selected={picked}
                   onPick={(p) => toggle(p.i, `${col.g[p.i]}-${col.i[p.i]}`)}
                   note={pins.length ? `좌표를 ${pct0(geoCoverage)} 확보했습니다` : '파란 점은 지하철역입니다'} />
          {!pins.length && (
            <p className="warnline">
              <strong>물건은 아직 지도에 없습니다.</strong> 주소를 좌표로 바꾸는 작업이
              남았습니다 ({d.n.toLocaleString()}건). 파란 점은 지하철역이고, 좌표가 붙으면
              조건에 맞는 물건이 그 위에 뜹니다.
            </p>
          )}
          {open && (
            open.u ? (
              // open.key 앞자리가 구 인덱스다. 목록과 같은 카드를 지도 아래에 편다.
              <UnitCard u={open.u} lawd={d.gus[+open.key.split('-')[0]]} compare={compare}
                        guard={guard} onClose={() => setOpen(null)} />
            )
            : open.error ? <p className="muted-line critical">상세를 불러오지 못했습니다 ({open.error})</p>
            : <p className="muted-line">불러오는 중…</p>
          )}
        </>
      )}

      {view === 'list' && <ul className="unit-list">
        {hits.slice(0, limit).map((i) => {
          const key = `${col.g[i]}-${col.i[i]}`
          return (
          <li key={key}>
            <button aria-expanded={open?.key === key} onClick={() => toggle(i, key)}>
              <span className="u-name">{col.name[i] || '(이름 없음)'}</span>
              <span className="u-meta">
                {guNames[d.gus[col.g[i]]] ?? ''} {d.umds[col.u[i]]} · {htName(col.ht[i])}
                {' · '}전용 {col.area[i]}m²({(col.area[i] / PYEONG).toFixed(1)}평)
                {col.by[i] ? ` · ${col.by[i]}년` : ''}
                {/* stn은 역 번호다. 이름이 아직 안 왔으면 역 이름 없이 도보만 적는다. */}
                {col.walk[i] != null ? ` · ${stationPins[col.stn[i]] ? `${stationPins[col.stn[i]].name}역 ` : ''}도보 ${col.walk[i]}분` : ''}
              </span>
              <span className="u-sig">
                <em>{eok(col.jeonse[i])}</em>
                <small className={col.ratio[i] >= RATIO_BROKEN ? 'muted' : ratioTone(col.ratio[i])}>
                  {col.ratio[i] == null ? '전세가율 비교 불가'
                    : col.ratio[i] >= RATIO_BROKEN ? '전세가율 판단 보류'
                    : `${d.stages[col.stage[i]] === 'A' ? '' : '약 '}${pct0(col.ratio[i])}`}
                  {col.ns[i] ? ` · 매매 ${col.ns[i]}건` : ' · 매매 0건'}
                </small>
              </span>
            </button>
            {open?.key === key && (
              open.u ? (
                <UnitCard u={open.u} lawd={d.gus[col.g[i]]} compare={compare} guard={guard}
                          onClose={() => setOpen(null)}
                          onMap={col.lat[i] != null ? () => setView('map') : null} />
              )
              : open.error ? <p className="muted-line critical">상세를 불러오지 못했습니다 ({open.error})</p>
              : <p className="muted-line">불러오는 중…</p>
            )}
          </li>
          )
        })}
      </ul>}

      {!hits.length && <p className="muted-line">조건에 맞는 물건이 없습니다. 예산이나 면적을 넓혀 보세요.</p>}
      {view === 'list' && limit < hits.length && (
        <>
          <div ref={sentinel} aria-hidden="true" />
          <button className="more" onClick={() => setLimit((n) => n + PAGE)}>
            더 보기 ({(hits.length - limit).toLocaleString()}개 남음)
          </button>
        </>
      )}

      <p className="warnline">
        <strong>건축물대장은 {pct0(coverage)} 받았습니다.</strong> 승강기·세대수·준공연도·층간소음 추정은
        대장이 붙은 물건에서만 보입니다. 하루 1만 건 한도로 매일 이어받는 중이라 전체를
        채우는 데 시간이 걸립니다.
        <br /><br />
        <strong>통근 시간은 아직 없습니다.</strong> 물건 좌표와 지하철역 자료를 붙이는 중이고,
        붙으면 목적지 역을 골라 통근 시간으로 거를 수 있게 할 참입니다.
      </p>
    </section>
  )
}
