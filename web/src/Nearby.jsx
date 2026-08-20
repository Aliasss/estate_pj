import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView, { MapLegend } from './MapView.jsx'
import { meters, sigLabel } from './Finder.jsx'
import { NoJeonseSig, UnitCard, eok, pct0, ratioTone } from './UnitLookup.jsx'
import { DEAL_KINDS, REGIONS, hasDeal, htName, useCompare, useFinder, useGuard, useSubway, useUnitLoader } from './units.js'

/**
 * 임장 중 내 주변. 확인 탭 검색창 아래의 진입 버튼으로 들어온다.
 *
 * 동네 탭이 "조건으로 후보를 추리는" 곳이라면 여기는 이미 현장에 서 있는
 * 사람을 위한 화면이다. 조건 필터를 다 걷어내고 반경과 유형만 남겼다.
 * 골목에서 한 손으로 쓰는 화면에 입력칸이 여덟 개일 이유가 없다.
 *
 * 위치를 잡고 나면 지도가 화면을 통째로 쓰고, 결과는 아래에서 올라오는
 * 시트에 담긴다. 이 화면은 위치 감각이 전부인데 문서형 레이아웃에서는
 * 지도가 62vh 상자에 갇혀 있었다. 시트는 세 단(손잡이만·절반·거의 전체)으로
 * 서고, 손잡이를 끌거나 눌러 옮긴다.
 *
 * 위치는 화면 상태로만 두고 저장하지도 보내지도 않는다. 한 번 잡고 끝낸다.
 * 계속 추적하면 배터리를 먹는데, 임장은 걸어 다니며 여러 번 누르는 쪽이 낫다.
 */

const RADII = [300, 500, 1000, 2000]
const HTS = [['', '전체'], ['R', '연립·다세대'], ['A', '아파트'], ['O', '오피스텔']]
const PAGE = 40

/* 시트 세 단. 손잡이와 요약 줄만 남는 peek가 바닥이고, full에서도 지도를
   72px 남긴다. 지도를 0으로 만들면 여기가 그냥 목록 화면이 되어 버린다. */
const PEEK_PX = 52          // 손잡이를 재기 전의 어림값
const KEEP_MAP_PX = 72
const ORDER = ['peek', 'half', 'full']
// 버튼 이름은 지금 상태가 아니라 눌렀을 때 벌어지는 일이라야 한다.
const SNAP_LABEL = { peek: '절반으로 펴기', half: '넓게 펴기', full: '접기' }

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)
const fmtRadius = (m) => (m >= 1000 ? `${m / 1000}km` : `${m}m`)

/**
 * 스냅 지점은 화면 높이가 아니라 지도가 실제로 차지한 높이에서 뽑는다.
 * 화면 높이로 잡으면 위쪽 칩 줄과 탭바 자리를 두 번 세게 되고, full 단에서
 * 지도가 통째로 사라진다. space는 지도 영역의 실측 높이다.
 */
function snapPx(space, peek) {
  const full = Math.max(peek, space - KEEP_MAP_PX)
  return { peek, half: Math.min(full, Math.max(peek, Math.round(space * 0.5))), full }
}

export default function Nearby({ guNames, region = '11', onRegion }) {
  const fin = useFinder(region)
  const stationPins = useSubway()
  const { byRow } = useUnitLoader()
  const compare = useCompare()
  const guard = useGuard()
  const [here, setHere] = useState(null)      // {lat, lon, acc}
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [radius, setRadius] = useState(500)
  const [ht, setHt] = useState('')
  // 임장은 눈앞 건물을 찾는 일이라 전부에서 시작한다. 전세만 걸어 두면 매매나
  // 월세만 신고된 건물이 "없는 건물"로 나오는데, 그게 이 화면을 고친 이유다.
  const [deal, setDeal] = useState('')
  const [view, setView] = useState('map')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState(null)
  // 월세 건수 열이 실려 오기 전 배포에서는 월세 칩을 내지 않는다. 눌러도 0건인
  // 칩을 두면 "이 근처에 월세가 없다"로 읽힌다.
  const hasNw = fin.status === 'ready' && fin.d.cols.includes('nw')

  const ask = useCallback(() => {
    if (!navigator.geolocation) { setErr('이 브라우저에서는 위치를 쓸 수 없습니다'); return }
    setErr(''); setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setHere({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy })
        setBusy(false)
      },
      (e) => {
        setErr(e.code === 1
          ? '위치 권한이 꺼져 있습니다. 브라우저 설정에서 허용해 주세요'
          : '위치를 찾지 못했습니다. 잠시 뒤 다시 눌러 보세요')
        setBusy(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 })
  }, [])

  /**
   * 좌표가 아직 없는 건물의 몫. 이 화면은 좌표 있는 건물만 보여줄 수 있는데,
   * 그 사실을 숨기면 "눈앞 건물이 데이터에 없다"로 읽힌다. 실제로는 있는데
   * 좌표 수집이 안 끝난 것이다(오피스텔 백필 직후가 특히 그렇다). 사용자가
   * 그 건물 앞에 서 있을 때 가장 아픈 침묵이라, 몫이 2%를 넘으면 밝힌다.
   */
  const geoMiss = useMemo(() => {
    // 빈 finder(수집 초기 지역)에서 0/0은 NaN이고, NaN은 아래 게이트를 지나
    // "건물 NaN%"로 화면에 나간다.
    if (fin.status !== 'ready' || !fin.d.n) return null
    const { col, d } = fin
    let miss = 0, missO = 0
    for (let i = 0; i < d.n; i++) {
      if (col.lat[i] == null) { miss++; if (col.ht[i] === 'O') missO++ }
    }
    if (miss / d.n <= 0.02) return null
    return { share: miss / d.n, mostlyO: missO / miss >= 0.5 }
  }, [fin])

  // 반경 안의 물건을 가까운 순으로. 거리를 함께 담아 두 번 재지 않는다.
  const hits = useMemo(() => {
    if (fin.status !== 'ready' || !here) return []
    const { col, d } = fin
    const out = []
    for (let i = 0; i < d.n; i++) {
      if (col.lat[i] == null) continue
      if (ht && col.ht[i] !== ht) continue
      if (deal && !hasDeal(col, i, deal)) continue
      const m = meters(here.lat, here.lon, col.lat[i], col.lon[i])
      if (m > radius) continue
      out.push({ i, m })
    }
    out.sort((a, b) => a.m - b.m)
    return out
  }, [fin, here, radius, ht, deal])

  // region이 빠져 있으면 서울에서 연 건물이 경기 지도에 영구 툴팁을 단 채
  // 남는다. 지금 데이터셋에 없는 점이라 '지도에 300개' 계산 밖에도 있다.
  useEffect(() => { setLimit(PAGE); setOpen(null) }, [here, radius, ht, deal, region])

  const pins = useMemo(() => {
    if (fin.status !== 'ready') return []
    const { col } = fin
    return hits.slice(0, 300).map(({ i }) => ({
      i, lat: col.lat[i], lon: col.lon[i], tone: ratioTone(col.ratio[i]),
      label: `${col.name[i] || col.jibun?.[i] || ''} · ${sigLabel(col, i)}`,
    }))
  }, [fin, hits])

  const toggle = useCallback(async (i) => {
    if (open?.i === i) { setOpen(null); return }
    setOpen({ i, loading: true })
    try {
      const { col, d } = fin
      const u = await byRow(d.gus[col.g[i]], col.i[i], d.build)
      setOpen({ i, u, lawd: d.gus[col.g[i]] })
    } catch (e) {
      setOpen({ i, error: e.message })
    }
  }, [fin, byRow, open])

  const mapMode = !!here && view === 'map'

  /* 매 렌더 새 객체를 넘기면 MapView의 [selected] 이펙트가 매번 돌아, 손잡이를
     한 번 끄는 동안 지도가 128px 움직이고 툴팁이 52개 새로 생긴다. 사용자가
     지도를 옆으로 끌어 둔 것도 손잡이 한 번에 되돌아간다. */
  const selected = useMemo(() => (open?.u
    ? { lat: open.u.lat, lon: open.u.lon, tone: ratioTone(open.u.ratio), label: open.u.name }
    : null), [open?.u])

  /* ── 하단 시트 ───────────────────────────────────────────────────────────
     높이를 직접 옮긴다. transform으로 밀면 안쪽 스크롤 영역의 높이가 그대로라
     full에서 목록 끝이 화면 밖에 남는다. */
  const [snap, setSnap] = useState('half')
  const [dragH, setDragH] = useState(null)     // 끄는 동안만 px, 놓으면 null
  const drag = useRef(null)
  const swallow = useRef(false)
  const bodyRef = useRef(null)
  const canvasRef = useRef(null)
  const gripRef = useRef(null)
  // 재기 전의 어림값. 주소창이 접혔다 펴지며 화면 높이가 바뀌므로 실측이 곧 덮는다.
  const [space, setSpace] = useState(() => (typeof window === 'undefined' ? 520 : Math.round(window.innerHeight * 0.66)))
  // peek는 손잡이 높이에 정확히 맞춘다. 어림잡으면 유형 칩 한 줄이 탭바에
  // 반쯤 걸려 잘린 채로 남는다.
  const [peek, setPeek] = useState(PEEK_PX)

  useEffect(() => {
    const el = canvasRef.current
    const grip = gripRef.current
    if (!mapMode || !el || !grip) return
    const read = () => { setSpace(el.clientHeight); setPeek(grip.offsetHeight) }
    read()
    // 시트는 지도 위에 겹쳐 뜨므로 지도 높이를 되먹이지 않는다. 되먹이면
    // 시트를 끌 때마다 스냅 지점이 따라 움직여 손가락을 못 따라간다.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    ro.observe(grip)
    return () => ro.disconnect()
  }, [mapMode])

  const stops = useMemo(() => snapPx(space, peek), [space, peek])
  const sheetH = dragH ?? stops[snap]

  // 전면 모드에서는 뒤 화면이 따라 움직이면 안 된다. 시트를 끌 때 페이지가
  // 같이 스크롤되면 지도가 화면 밖으로 밀려난다.
  useEffect(() => {
    if (!mapMode) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [mapMode])

  const onGripDown = useCallback((e) => {
    // 손잡이를 잡는 순간 안쪽 스크롤과 경쟁하지 않도록 포인터를 가둔다.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { y: e.clientY, h: stops[snap], moved: false }
    setDragH(stops[snap])
  }, [snap, stops])

  const onGripMove = useCallback((e) => {
    if (!drag.current) return
    const dy = drag.current.y - e.clientY
    if (Math.abs(dy) > 4) drag.current.moved = true
    const at = Math.min(stops.full, Math.max(stops.peek, drag.current.h + dy))
    drag.current.at = at
    setDragH(at)
  }, [stops])

  const bumpSnap = useCallback(() => {
    setSnap((s) => ORDER[(ORDER.indexOf(s) + 1) % ORDER.length])
  }, [])

  /**
   * 포인터로 누르고 뗀 것은 여기서 끝낸다. pointerdown에서 포인터를 가둬 두면
   * 이어지는 click이 손잡이 버튼이 아니라 가둔 요소에서 나기 때문에, 버튼의
   * onClick만 믿으면 손가락으로는 단이 한 칸도 안 움직인다.
   */
  const onGripUp = useCallback(() => {
    const d = drag.current
    drag.current = null
    if (!d) return
    // 포인터가 처리한 몫을 뒤따라오는 click이 한 번 더 하지 않게 막는다.
    // 가두기를 지원하지 않는 브라우저에서는 click이 버튼까지 올라온다.
    swallow.current = true
    setTimeout(() => { swallow.current = false }, 0)
    if (!d.moved) { setDragH(null); bumpSnap(); return }
    // 업데이터는 순수해야 한다. 안에서 setSnap을 부르면 React가 업데이터를
    // 두 번 부르는 경로에서 스냅이 두 번 걸린다.
    const at = d.at ?? stops[snap]
    let best = 'peek', gap = Infinity
    for (const k of ORDER) {
      const g = Math.abs(stops[k] - at)
      if (g < gap) { gap = g; best = k }
    }
    setSnap(best)
    setDragH(null)
  }, [snap, stops, bumpSnap])

  // 키보드(엔터·스페이스)로 누른 경우. 포인터 쪽은 위에서 이미 끝냈다.
  const onGripClick = useCallback(() => { if (!swallow.current) bumpSnap() }, [bumpSnap])

  /**
   * 상세를 열면 시트가 올라와야 한다. 손잡이만 남은 상태에서 마커를 누르면
   * 카드가 시트 안에서 열리고도 화면에 한 줄도 안 보인다.
   *
   * 카드는 본문 맨 위 슬롯에 서므로 열 때 맨 위로 데려간다. 그러면 목록을
   * 한참 내려와 있던 사람은 보던 자리를 잃으므로, 닫을 때 그 자리로 돌려준다.
   */
  const backTo = useRef(0)
  useEffect(() => {
    if (!mapMode) return
    const el = bodyRef.current
    if (open) {
      if (backTo.current === 0 && el) backTo.current = el.scrollTop
      setSnap((s) => (s === 'peek' ? 'half' : s))
      el?.scrollTo?.({ top: 0 })
    } else if (backTo.current) {
      el?.scrollTo?.({ top: backTo.current })
      backTo.current = 0
    }
  }, [mapMode, open?.i, !open])

  /**
   * 전면 모드는 화면을 통째로 덮는데 뒤 화면은 여전히 탭 순서에 있다.
   * 히어로의 지역 세그가 시트 상단 세그와 똑같이 생긴 채 DOM에 둘 있어서,
   * 키보드 사용자는 보이지 않는 쪽으로 지역을 바꾸게 된다. 탭바만 남기고 재운다.
   */
  const fullRef = useRef(null)
  useEffect(() => {
    const el = fullRef.current
    if (!mapMode || !el?.parentElement) return
    const sibs = [...el.parentElement.children]
      .filter((n) => n !== el && !n.classList.contains('tabbar'))
    sibs.forEach((n) => n.setAttribute('inert', ''))
    return () => sibs.forEach((n) => n.removeAttribute('inert'))
  }, [mapMode])

  /**
   * 전면 모달을 얹었으면 뒤로 가기는 그것을 닫아야 한다. 탭 상태가 전부
   * useState라 히스토리에 아무것도 안 쌓이고, 그대로 두면 안드로이드 뒤로
   * 가기 한 번에 앱을 나간다(실측: about:blank).
   */
  useEffect(() => {
    if (!mapMode) return
    window.history.pushState({ nbMap: true }, '')
    const onPop = () => setView('list')
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 목록 단추로 닫은 경우. 우리가 밀어 넣은 항목을 걷어내지 않으면
      // 뒤로 가기가 한 번 헛돈다. 리스너를 먼저 떼서 되돌아오지 않게 한다.
      if (window.history.state?.nbMap) window.history.back()
    }
  }, [mapMode])

  // 위치 갱신 실패는 시트 안에 적는데, peek에서는 본문 보이는 높이가 0이라
  // 한 글자도 안 보인다. 버튼은 원래 글씨로 돌아오고 지도에는 예전 자리 점이
  // 그대로 있어서 성공한 것처럼 읽힌다.
  useEffect(() => {
    if (mapMode && err) setSnap((s) => (s === 'peek' ? 'half' : s))
  }, [mapMode, err])

  /* ── 조각들 ──────────────────────────────────────────────────────────── */

  const radiusChips = (
    <div className="filters" role="group" aria-label="반경">
      {RADII.map((m) => (
        <button key={m} className="chip" aria-pressed={radius === m} onClick={() => setRadius(m)}>
          {fmtRadius(m)}
        </button>
      ))}
    </div>
  )

  /* 유형과 거래는 전면 모드에서 시트 안에 산다. 셋을 다 위에 세우면 상단이
     184px를 먹어(실측) 지도가 화면의 절반도 못 쓴다. 걸어 다니며 계속 바꾸는
     것은 반경뿐이라 그것만 지도 옆에 남긴다. */
  const kindChips = (
    <>
      <div className="filters" role="group" aria-label="물건 유형">
        {HTS.map(([v, label]) => (
          <button key={v || 'all'} className="chip" aria-pressed={ht === v} onClick={() => setHt(v)}>
            {v === '' ? '유형 전체' : label}
          </button>
        ))}
      </div>
      {/* 거래 유형. 전세를 구하러 나온 사람은 전세만, 매매를 보러 나온
          사람은 매매만 남길 수 있어야 한다. 월세 열이 아직 안 실린
          배포에서는 월세 칩을 내지 않는다.
          '전체'가 두 줄에 나란히 놓이면 어느 쪽 전체인지 알 수 없다.
          줄마다 무엇의 전체인지를 칩 자체에 적는다. */}
      <div className="filters" role="group" aria-label="거래 유형">
        {/* 고른 칩은 로딩 중에도 남긴다. hasNw가 잠깐 false로 떨어지면 월세를
            고른 채 지역을 바꾼 사람은 눌린 칩 없이 필터만 살아 있는 화면을 본다. */}
        {DEAL_KINDS.filter(([v]) => v !== 'w' || hasNw || deal === 'w').map(([v, label]) => (
          <button key={v || 'all'} className="chip" aria-pressed={deal === v} onClick={() => setDeal(v)}>
            {v === '' ? '거래 전체' : label}
          </button>
        ))}
      </div>
    </>
  )

  /**
   * hits는 데이터가 안 왔을 때도 빈 배열이다. 그것을 "0개"로 적으면 아직
   * 세지도 않은 것을 없다고 단정하는 것이 된다. 지역을 잘못 고른 경우도
   * 같은 자리로 떨어지는데, 그때 "수집 범위 밖"이라고 적으면 거짓말이다.
   * 화곡동에 서서 경기를 고르면 실제로는 반경 500m에 1,511개가 있다.
   */
  const notReady = fin.status !== 'ready' && (
    fin.status === 'pending' ? (
      <p className="muted-line">
        {REGIONS[region]} 실거래 데이터를 아직 수집하고 있습니다. 수집이 끝나면 이 화면에
        나타납니다.
      </p>
    ) : fin.status === 'error' ? (
      <p className="warnline">
        {REGIONS[region]} 물건을 불러오지 못했습니다 ({fin.message})
      </p>
    ) : (
      <p className="muted-line">{REGIONS[region]} 물건을 불러오는 중…</p>
    )
  )

  const emptyLine = (
    <p className="muted-line">
      반경 안에 {deal ? `최근 2년 ${DEAL_KINDS.find(([v]) => v === deal)[1]} 신고가 있었던 건물이`
        : '최근 2년 실거래 신고가 있었던 건물이'} 없습니다.
      {deal ? ' 거래 유형을 전체로 바꾸거나 반경을 넓혀 보세요.' : ' 반경을 넓혀 보세요.'}
      {' '}지금은 <b>{REGIONS[region]}</b> 물건만 보고 있습니다. 다른 지역에 서 계시면 위에서
      지역을 바꿔 주세요.
    </p>
  )

  const results = notReady || (hits.length === 0 ? emptyLine : null)

  /**
   * 전면 모드는 카드를 목록 밖 고정 슬롯에 그린다(inline=false).
   * 목록 안에서만 그리면 지도에 찍힌 300개 중 목록에 실린 40개를 뺀 260개는
   * 눌러도 카드를 그릴 자리가 없어 아무 일도 안 일어난다. 상세는 받아 놓고
   * 시트만 올라와서, 맨 위에 있는 남의 건물이 누른 것처럼 읽힌다.
   */
  const listOf = (inline) => (
    <ul className="unit-list nb-list">
      {hits.slice(0, limit).map(({ i, m }) => {
        const { col, d } = fin
        const on = open?.i === i
        return (
          <li key={i}>
            <button onClick={() => toggle(i)} aria-expanded={on}>
              <span className="u-name">
                <span className="nb-dist">{fmtDist(m)}</span>
                {col.name[i] || '(이름 없음)'}
              </span>
              <span className="u-meta">
                {d.umds[col.u[i]]} {col.jibun?.[i] ?? ''} · {htName(col.ht[i])}
                {' · '}전용 {col.area[i]}m²
              </span>
              <span className="u-sig">
                {col.jeonse[i] == null ? <NoJeonseSig ns={col.ns[i]} nw={col.nw[i]} sale={col.sale[i]} /> : (
                  <>
                    <em>{eok(col.jeonse[i])}</em>
                    <small>{col.ratio[i] != null ? `전세가율 ${pct0(col.ratio[i])}` : '판정 보류'}</small>
                  </>
                )}
              </span>
            </button>
            {inline && on && open.loading && <p className="muted-line">불러오는 중…</p>}
            {inline && on && open.error && <p className="warnline">{open.error}</p>}
            {inline && on && open.u && (
              <UnitCard u={open.u} lawd={open.lawd} compare={compare} guard={guard}
                        onClose={() => setOpen(null)} />
            )}
          </li>
        )
      })}
    </ul>
  )

  const pickCard = open && (
    <div className="nb-pick">
      {open.u ? (
        <UnitCard u={open.u} lawd={open.lawd} compare={compare} guard={guard}
                  onClose={() => setOpen(null)} />
      ) : open.error ? (
        <p className="warnline">상세를 불러오지 못했습니다 ({open.error})</p>
      ) : (
        <p className="muted-line">불러오는 중…</p>
      )}
    </div>
  )

  const more = hits.length > limit && (
    <button className="more" onClick={() => setLimit((v) => v + PAGE)}>
      더 보기 ({hits.length - limit}개 남음)
    </button>
  )

  const footnote = (
    <p className="muted-line">
      매물 목록이 아닙니다. 최근 2년 전세·매매·월세 신고가 있었던 건물이며, 지금
      계약할 수 있는 방인지는 알 수 없습니다. 전세 신고가 없는 건물은 전세가율을
      낼 수 없어 <b>전세 신고 없음</b>으로 적었습니다. 눈앞 건물을 눌러 판정을 확인하고
      비교함에 담아 두시면 집에 돌아가 나란히 견주실 수 있습니다.
    </p>
  )

  const geoMissLine = geoMiss && (
    <p className="muted-line">
      건물 {Math.round(geoMiss.share * 100)}%는 좌표 수집이 안 끝나 아직 이
      화면에 나오지 않습니다{geoMiss.mostlyO ? ' (대부분 오피스텔입니다)' : ''}.
      수집되는 대로 나타나고, 확인 탭에서는 지금도 주소로 찾으실 수 있습니다.
    </p>
  )

  /* ── 전면 지도 ───────────────────────────────────────────────────────── */

  if (mapMode) {
    return (
      <div className="nb-full" ref={fullRef}>
        <div className="nb-top">
          <div className="nb-top-row">
            {onRegion && (
              <div className="seg" role="group" aria-label="지역">
                {Object.entries(REGIONS).map(([code, label]) => (
                  <button key={code} aria-pressed={region === code}
                          onClick={() => onRegion(code)}>{label}</button>
                ))}
              </div>
            )}
            <button className="chip" onClick={() => setView('list')}>목록으로</button>
          </div>
          <div className="nb-chips">{radiusChips}</div>
        </div>

        <div className="nb-canvas" ref={canvasRef}>
          <MapView fill padBottom={sheetH} points={pins} stations={stationPins} here={here}
                   selected={selected} onPick={(p) => toggle(p.i)} />
          <button className="nb-locate" onClick={ask} disabled={busy}
                  style={{ bottom: `${sheetH + 12}px` }}>
            {busy ? '위치 갱신 중…' : '내 위치로'}
          </button>
        </div>
        {/* 탭바가 뜰 자리. 지도가 이 아래로 흐르면 떠 있는 알약 탭바 뒤에서
            타일이 비쳐 글자가 안 읽힌다. */}
        <div className="nb-dock" aria-hidden="true" />

        <section className="nb-sheet" style={{ height: `${sheetH}px` }}
                 data-dragging={dragH != null ? 'true' : undefined}>
          <div className="nb-grip" ref={gripRef}
               onPointerDown={onGripDown} onPointerMove={onGripMove}
               onPointerUp={onGripUp} onPointerCancel={onGripUp}>
            {/* 손잡이는 진짜 버튼이라야 키보드와 화면 낭독기에 잡힌다. 요약
                문장을 같은 요소에 넣으면 그 문장이 버튼 이름을 가로챈다. */}
            <button type="button" className="nb-grip-bar" onClick={onGripClick}
                    aria-label={`결과 목록 ${SNAP_LABEL[snap]}`} aria-expanded={snap !== 'peek'}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                      e.preventDefault()
                      const at = ORDER.indexOf(snap) + (e.key === 'ArrowUp' ? 1 : -1)
                      setSnap(ORDER[Math.min(ORDER.length - 1, Math.max(0, at))])
                    }}>
              <i />
            </button>
            {/* 어느 단에서도 보이는 유일한 줄이다. 지도가 300개로 자른 사실을
                여기 세우지 않으면, 목록의 1,504개와 지도의 300개가 어긋난 채로
                220m 바깥이 빈 지도로 그려진다. */}
            <p className="nb-sum">
              {fin.status !== 'ready' ? '불러오는 중…' : (
                <>
                  반경 {fmtRadius(radius)} 안 <b>{hits.length.toLocaleString()}개</b>
                  {hits.length > pins.length && <> · 지도에 가까운 <b>{pins.length}개</b></>}
                  {here.acc > 100 && ` · 위치 오차 약 ${Math.round(here.acc)}m`}
                </>
              )}
            </p>
          </div>
          <div className="nb-sheet-body" ref={bodyRef}>
            <div className="nb-sheet-filters">{kindChips}</div>
            {/* 위치 갱신이 실패하면 지도 위에는 아무 표시도 없다. 예전 자리에
                점이 그대로 찍혀 있어 성공한 것처럼 보이므로 여기에 적는다. */}
            {err && <p className="warnline">{err}</p>}
            {pickCard}
            {geoMissLine}
            {results ?? listOf(false)}
            {!results && more}
            {!results && <MapLegend />}
            {/* 지도에는 가까운 순 300개만 찍는다. 그 사실을 안 적으면 목록의
                748개와 지도의 300개가 어긋나 보이고, 지도에 없는 것을 없는
                건물로 읽게 된다. */}
            <p className="muted-line">
              {!results && hits.length > pins.length
                && `가까운 ${pins.length}개만 지도에 찍었습니다. 목록에는 ${hits.length.toLocaleString()}개가 다 있습니다. `}
              가운데 보라색 점이 지금 계신 곳입니다.
            </p>
            {footnote}
          </div>
        </section>
      </div>
    )
  }

  /* ── 문서형(위치를 잡기 전, 그리고 목록 모드) ────────────────────────── */

  return (
    <section className="card">
      <h2>임장 중 내 주변</h2>
      <p className="sub">
        지금 서 계신 곳 주변에서 최근 2년 실거래 신고가 있었던 건물을 가까운 순으로
        보여 드립니다. 전세·매매·월세를 모두 담았습니다. 위치는 이 기기에서만 쓰고
        어디로도 보내지 않습니다
      </p>

      {!here ? (
        <>
          <button className="nb-cta" onClick={ask} disabled={busy}>
            {busy ? '위치를 찾는 중…' : '내 위치로 찾기'}
          </button>
          {err && <p className="warnline">{err}</p>}
        </>
      ) : (
        <>
          <div className="nb-ctl">{radiusChips}{kindChips}</div>
          {geoMissLine}
          <div className="nb-bar">
            <span>
              {fin.status !== 'ready' ? '불러오는 중…' : (
                <>
                  반경 {fmtRadius(radius)} 안 <b>{hits.length.toLocaleString()}개</b>
                  {here.acc > 100 && ` · 위치 오차 약 ${Math.round(here.acc)}m`}
                </>
              )}
            </span>
            <span className="nb-acts">
              <button className="cmp-del" onClick={() => setView('map')}>지도</button>
              <button className="cmp-del" onClick={ask} disabled={busy}>
                {busy ? '갱신 중' : '위치 갱신'}
              </button>
            </span>
          </div>
          {results ?? listOf(true)}
          {!results && more}
        </>
      )}

      {footnote}
    </section>
  )
}
