import { useCallback, useEffect, useRef, useState } from 'react'
// 판정과 금액 표기는 verdict.js에 산다. 공유 카드를 내는 서버 함수도 같은 것을
// 써야 하는데, 이 파일은 React를 끌어오므로 순수한 쪽만 따로 뒀다.
export { RATIO_BROKEN, eok, pct0, ratioBroken, verdict } from './verdict.js'

/**
 * 지하철역 목록. 물건 데이터의 stn 열은 이 배열의 번호다 — 이름을 물건마다
 * 박으면 구 파일이 문자열 반복으로 불어나서, 번호를 싣고 화면에서 이름으로
 * 바꾼다. 파일이 43KB뿐이라 한 번 받아 모듈에 캐시한다.
 */
let _subwayCache = null
export function useSubway() {
  const [stations, setStations] = useState(_subwayCache ?? [])
  useEffect(() => {
    if (_subwayCache) return
    fetch(`${import.meta.env.BASE_URL}data/subway.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        // 통근 시간표는 역 목록에 얹어 함께 온다. 별도 요청을 만들지 않는다.
        _subwayCache = d.stations.map((name, i) => ({ name, lat: d.coords[i][0], lon: d.coords[i][1] }))
        _subwayCache.commute = d.commute ?? null
        setStations(_subwayCache)
      })
      .catch(() => {})          // 역 자료가 없어도 화면은 떠야 한다
  }, [])
  return stations
}

/**
 * 물건 데이터 접근. 화면 두 곳이 같은 파일을 쓰므로 여기 모아 둔다.
 *
 * finder.json  서울 전체 요약(열 단위, gzip 1MB). 검색과 조건 걸기에 쓴다.
 * {구}.json    상세 전량. 리포트를 열 때만 그 구 것을 받는다.
 */

/** 없는 열은 비어 있는 것으로 본다. 코드가 데이터보다 먼저 배포되면 그렇게 된다. */
const FILL = ['jibun', 'hike', 'elvt', 'apr', 'lat', 'lon', 'stn', 'walk', 'sale', 'nw']

/**
 * 비어 있으면 안 되는 열. 이 중 하나라도 빠지면 검색·판정이 undefined 위에서
 * 돌아간다. 조용히 이상한 화면을 그리느니 에러 화면으로 떨어뜨려 새 데이터를
 * 받게 하는 편이 낫다.
 */
const REQUIRED = ['i', 'ht', 'g', 'u', 'name', 'area', 'by', 'jeonse', 'ratio', 'stage', 'ns', 'nj']

/** "202406" -> "2024년 6월". 창을 화면에 그대로 뿌리면 여덟 자리 숫자가 보인다. */
export const ym = (s) => (s ? `${s.slice(0, 4)}년 ${+s.slice(4, 6)}월` : '-')

/** 지역 코드(법정동 앞 2자리)와 표시 이름. 토글·문구가 다 여기서 나온다. */
export const REGIONS = { 11: '서울', 41: '경기' }
// 유형 코드 -> 화면 이름. 목록 줄에 쓰는 짧은 표기다.
export const htName = (c) => (c === 'A' ? '아파트' : c === 'O' ? '오피스텔' : '연립·다세대')

/**
 * 거래 유형 필터. 물건 데이터는 최근 2년에 전세·매매·월세 중 하나라도 신고가
 * 있었던 건물을 전부 싣는다. 전세만 싣던 시절에는 임장 중에 눈앞 건물을 찾으면
 * "없는 건물"로 나왔다.
 *
 * 두 화면 모두 전체로 시작한다. 데이터에 있는 건물을 먼저 다 보여주고 좁히는
 * 것은 사용자가 고르게 한다. 전세가율을 못 내는 건물은 목록 줄에 그렇게 적히고
 * '안전한 순'에서는 뒤로 밀리므로, 감춰서 지킬 것이 없다.
 */
export const DEAL_KINDS = [['', '전체'], ['j', '전세'], ['s', '매매'], ['w', '월세']]

/** finder 열 배열에서 그 유형의 최근 2년 신고가 있는지. nw는 없을 수도 있는
    열이라(FILL) 코드가 데이터보다 먼저 배포되면 월세 필터가 0건이 된다. */
export const hasDeal = (col, i, kind) => (
  kind === 'j' ? col.nj[i] > 0
    : kind === 's' ? col.ns[i] > 0
    : kind === 'w' ? col.nw[i] > 0
    : true)

export function useFinder(region = '11') {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    setState({ status: 'loading' })
    // 서울(22.4MB)과 경기(13.9MB)는 저사양 회선에서 몇 초씩 걸린다. 그 사이
    // 지역을 두 번 바꾸면 먼저 시작한 쪽이 나중에 도착해 새 지역을 덮어쓴다.
    // 실측으로 재현했다: 라벨은 서울인데 안에는 경기 물건이 앉아 강서구
    // 한복판에서 "0개"가 나왔다. 자기 세대가 아니면 상태를 만지지 않는다.
    let alive = true
    const base = import.meta.env.BASE_URL
    // 없는 파일이 늘 404로 오지는 않는다. SPA 폴백이 있는 서버(vite preview 등)는
    // index.html을 200으로 준다. content-type까지 봐야 "파일 없음"을 제대로 읽는다.
    const missing = (r) => !r.ok || !(r.headers.get('content-type') || '').includes('json')
    fetch(`${base}data/units/finder-${region}.json`)
      .then((r) => {
        if (!missing(r)) return r.json()
        // 분할 파일이 아직 없는 배포. 서울은 통짜 finder.json으로 내려앉는다.
        // 경기 쪽 없음은 수집이 안 끝났다는 뜻이라 오류가 아니라 안내로 처리한다.
        if (region === '11') {
          return fetch(`${base}data/units/finder.json`)
            .then((r2) => (missing(r2) ? Promise.reject(new Error(`HTTP ${r2.status}`)) : r2.json()))
        }
        const e = new Error(`HTTP ${r.status}`)
        e.pending = true
        throw e
      })
      .then((d) => {
        const col = Object.fromEntries(d.cols.map((c, i) => [c, d.columns[i]]))
        const missing = REQUIRED.filter((c) => !col[c])
        if (missing.length) {
          throw new Error(`데이터에 필수 열이 없습니다: ${missing.join(', ')}`)
        }
        const blank = new Array(d.n).fill(null)
        for (const c of FILL) if (!col[c]) col[c] = blank
        // 검색은 키 입력마다 전수 스캔이다. 행마다 새 문자열을 만들면 저사양
        // 폰에서 키 하나에 100ms를 넘긴다. 물건이 32만 개가 된 뒤로는 여유가
        // 없어서, 스캔에 쓰는 두 문자열을 모두 여기서 한 번만 만든다.
        //   flat  공백 뗀 건물명
        //   addr  "법정동 + 지번"("화곡동871-8"처럼 두 값에 걸친 질의를 받는다)
        // addr를 루프 안에서 이어 붙이면 매 키 입력마다 32만 개를 새로 할당한다.
        // 실측(x86 node, 서울 204,977행): 전수 스캔 16ms -> 6.6ms, 이 두 배열을
        // 만드는 데 43ms 한 번, 힙 +13MB. 저사양 폰은 통상 5~8배로 본다.
        const flat = new Array(d.n)
        const addr = new Array(d.n)
        for (let i = 0; i < d.n; i++) {
          flat[i] = (col.name[i] || '').replace(/\s+/g, '')
          addr[i] = (d.umds[col.u[i]] || '') + (col.jibun?.[i] ?? '')
        }
        if (alive) setState({ status: 'ready', d, col, flat, addr })
      })
      .catch((e) => {
        if (alive) setState({ status: e.pending ? 'pending' : 'error', message: e.message })
      })
    return () => { alive = false }
  }, [region])
  return state
}

/**
 * 구 파일을 받아 상세 한 건을 꺼낸다. 한 번 받은 구는 다시 받지 않는다.
 * 행 번호(finder.json)로도, 식별자(공유 링크)로도 찾을 수 있어야 한다.
 */
export function useUnitLoader() {
  const cache = useRef(new Map())

  const load = useCallback(async (lawd) => {
    if (!cache.current.has(lawd)) {
      const r = await fetch(`${import.meta.env.BASE_URL}data/units/${lawd}.json`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      cache.current.set(lawd, await r.json())
    }
    return cache.current.get(lawd)
  }, [])

  const byRow = useCallback(async (lawd, row, build) => {
    const g = await load(lawd)
    // 행 번호는 빌드마다 밀린다. 서비스워커가 구버전 finder와 신버전 구 파일을 섞으면
    // 클릭한 것과 다른 물건의 상세가 뜨는데, 예외도 안 나서 아무도 모른다. 세대 표식이
    // 어긋나면 다른 물건을 보여주느니 멈추고 새로고침을 청한다.
    if (build && g.build && g.build !== build) {
      throw new Error('데이터가 갱신되었습니다. 화면을 새로고침해 주세요')
    }
    return withSiblings(g, toObject(g, g.rows[row]))
  }, [load])

  const byId = useCallback(async (lawd, id) => {
    const g = await load(lawd)
    const i = g.cols.indexOf('id')
    const row = g.rows.find((r) => r[i] === id)
    return row ? withSiblings(g, toObject(g, row)) : null
  }, [load])

  return { byRow, byId }
}

function toObject(g, row) {
  return row ? Object.fromEntries(g.cols.map((c, k) => [c, row[k]])) : null
}

/**
 * 같은 건물의 다른 평형. 물건은 면적대로 쪼개져 있어서 "이 건물 전체"가 안 보인다.
 * 옆 평형이 얼마에 나가는지는 이 집 값이 정상인지 판단하는 데 바로 쓰인다.
 */
function withSiblings(g, u) {
  if (!u) return u
  const c = Object.fromEntries(g.cols.map((x, k) => [x, k]))
  const same = (r) => r[c.umd] === u.umd && r[c.jibun] === u.jibun
    && r[c.name] === u.name && r[c.ht] === u.ht
  const sibs = g.rows.filter((r) => same(r) && r[c.id] !== u.id)
    .map((r) => ({
      id: r[c.id], area: r[c.area], jeonse: r[c.med_jeonse],
      ratio: r[c.ratio], nj: r[c.n_jeonse_24m], ns: r[c.n_sale_24m],
    }))
    .sort((a, b) => (a.area ?? 0) - (b.area ?? 0))
  return { ...u, siblings: sibs }
}

/**
 * 지역 전체에서 주소·건물명으로 찾는다.
 *
 * 검증하러 온 사람은 계약서에 적힌 주소를 통째로 들고 온다. "서울시 강서구 화곡동
 * 123-45"에서 시·도는 매칭 필드에 없으므로 떼되, 구 이름은 버리지 않고 범위를
 * 좁히는 데 쓴다. 구 이름 한 단어 때문에 검색이 통째로 죽으면 진입점이 막힌 것이다.
 *
 * 반드시 전수를 훑은 뒤에 자른다. 앞에서 끊고 정렬하면 파일 순서상 앞에 몰린
 * 무명 빌라들이 결과를 차지한다. 실측: "화곡동" 검색이 실제 상위 40개와 0개 겹쳤다.
 */
/**
 * 생활권 별칭. 신도시 이름은 법정동과 다르다 — 평촌신도시 단지 대부분은
 * 관양·비산·호계동에 있어서, "평촌" 검색에 평촌동 84건만 주면 신도시를
 * 통째로 숨기는 것이다. 별칭은 (시군구, 법정동들)로 푼다. 법정동은 생활권의
 * 근사라 신도시 밖 구역도 일부 섞인다 — 좁게 숨기는 것보다 넓게 보여주고
 * 이름·동으로 다시 좁히게 하는 쪽이 낫다. 동 목록은 실데이터로 검증했다.
 */
const AREA_ALIASES = {
  평촌: [{ lawd: '41173', umds: ['평촌동', '관양동', '비산동', '호계동'] }],
  산본: [{ lawd: '41410', umds: ['산본동', '금정동'] }],
  판교: [{ lawd: '41135', umds: ['판교동', '백현동', '삼평동', '운중동', '하산운동'] }],
  광교: [{ lawd: '41117', umds: ['이의동', '원천동', '하동'] },
         { lawd: '41465', umds: ['상현동'] }],
  위례: [{ lawd: '11710', umds: ['장지동'] },
         { lawd: '41131', umds: ['창곡동'] },
         { lawd: '41450', umds: ['학암동'] }],
}

export function search(fin, query, limit = 40, guNames = null) {
  const raw = query.trim()
  const { col, d, flat, addr } = fin

  let gset = null
  let area = null        // (구 인덱스, 동 인덱스) 합성 키의 집합
  const aliasWords = []
  const kept = []
  for (const t of raw.split(/\s+/)) {
    if (/^(서울(특별시|시)?|경기도?)$/.test(t)) continue
    if (guNames && /[구시군]$/.test(t)) {
      // 경기 시군구 이름은 "수원시 장안구"처럼 두 단어다. "장안구"는 끝 단어로,
      // "수원시"는 앞 단어로 맞춘다. "수원시"처럼 여러 구에 걸치면 그 구들 전부로
      // 좁힌다. 어느 쪽이든 매칭 문자열에서는 떼야 검색이 살아남는다.
      const ms = Object.entries(guNames).filter(([, n]) =>
        n === t || n.endsWith(' ' + t) || n.startsWith(t + ' '))
      if (ms.length) {
        gset = new Set([...(gset ?? []), ...ms.map(([lawd]) => d.gus.indexOf(lawd))])
        continue
      }
    }
    // "평촌"도 "평촌신도시"도 같은 곳이다. 다른 지역 파인더에서는 해당 구가
    // 없어 조용히 빠진다(위례는 서울 파인더에서 장지동만 잡힌다).
    const aliasKey = t.replace(/신도시$/, '')
    if (AREA_ALIASES[aliasKey]) {
      let hit = false
      for (const seg of AREA_ALIASES[aliasKey]) {
        const gi = d.gus.indexOf(seg.lawd)
        if (gi < 0) continue
        for (const name of seg.umds) {
          const ui = d.umds.indexOf(name)
          if (ui >= 0) { (area ??= new Set()).add(gi * 100000 + ui); hit = true }
        }
      }
      if (hit) { aliasWords.push(aliasKey); continue }
    }
    kept.push(t)
  }
  const q = kept.join('').replace(/\s+/g, '')
  // 구 이름만 넣은 경우("강서구")는 그 구에서 전세가 많은 순으로 보여 준다
  if (q.length < 2 && gset == null && area == null) return { idx: [], total: 0 }

  const out = []
  for (let i = 0; i < d.n; i++) {
    if (gset != null && !gset.has(col.g[i])) continue
    const inArea = area != null && area.has(col.g[i] * 100000 + col.u[i])
    if (q.length >= 2) {
      // 별칭 + 텍스트("평촌 무궁화")면 생활권 안에서 텍스트로 좁힌다.
      // 알려진 한계: 권역 밖인데 건물명이 별칭으로 시작하는 조합("판교 밸리호반",
      // 고등동)은 여기서 빠진다. 붙여 치거나 별칭만 치면 잡히므로 감수한다.
      if (area != null && !inArea) continue
      if (!flat[i].includes(q) && !addr[i].includes(q)) continue
    } else if (area != null) {
      // 별칭만("평촌")이면 생활권 전부에, 이름에 그 말이 든 인접 건물을 더한다
      if (!inArea && !aliasWords.some((w) => flat[i].includes(w))) continue
    }
    out.push(i)
  }
  // 같은 건물의 평형이 여럿이면 전세 계약이 많은 것부터. 사람들이 실제로 사는 평형이다.
  out.sort((a, b) => (col.nj[b] ?? 0) - (col.nj[a] ?? 0))
  // 생활권 확장이 일어났으면 무엇으로 넓혔는지 함께 돌려준다. "평촌을 쳤는데
  // 왜 비산동이 나오지"의 답은 결과 상단 한 줄이 내는 것이 맞다.
  const areaNote = area != null
    ? { words: aliasWords,
        umds: [...area].map((k) => d.umds[k % 100000]).filter((v, i, arr) => arr.indexOf(v) === i) }
    : null
  return { idx: out.slice(0, limit), total: out.length, areaNote }
}

/**
 * 금리 시계열(한국은행 ECOS). 파일이 없으면(키 등록 전) null로 살고, 쓰는 쪽이
 * 금리 없는 문장으로 내려앉는다. 금리 때문에 화면이 죽는 일은 없어야 한다.
 */
export function useRates() {
  const [rates, setRates] = useState(null)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/rates.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setRates)
      .catch(() => {})
  }, [])
  return rates
}

/**
 * 인구·세대 시계열(행안부 주민등록, 법정동별 원천을 시군구로 합산).
 * series[lawd][ym] = [인구, 세대]. 파일이 없으면(활용신청 전) null로 살고,
 * 세대수 카드가 통째로 빠진다. 이것 때문에 화면이 죽는 일은 없어야 한다.
 */
export function usePop() {
  const [pop, setPop] = useState(null)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/pop.json`)
      .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null))
      .then(setPop)
      .catch(() => {})
  }, [])
  return pop
}

/** 시리즈의 최신 값. {ym: "202606", v: 3.5} 꼴. */
export function latestRate(rates, field) {
  const s = rates?.series?.[field]
  if (!s) return null
  const ks = Object.keys(s).sort()
  return ks.length ? { ym: ks.at(-1), v: s[ks.at(-1)] } : null
}

/**
 * 임장 비교함. 주말에 보러 갈 집 몇 개를 담아 나란히 본다. 기기에만 저장한다
 * (localStorage). 서버가 없으니 계정도 없고, 있어서도 안 되는 데이터다.
 */
const CMP_KEY = 'compare-v1'
const cmpRead = () => {
  try { return JSON.parse(localStorage.getItem(CMP_KEY)) || [] } catch { return [] }
}
export function useCompare() {
  const [items, setItems] = useState(cmpRead)
  const save = (next) => {
    setItems(next)
    try { localStorage.setItem(CMP_KEY, JSON.stringify(next)) } catch { /* 시크릿 모드 등 */ }
  }
  return {
    items,
    has: (id) => items.some((x) => x.id === id),
    toggle: (lawd, id, name) => save(items.some((x) => x.id === id)
      ? items.filter((x) => x.id !== id)
      : [...items, { lawd, id, name }].slice(-6)),   // 여섯 개면 주말 임장으로 충분하다
    clear: () => save([]),
  }
}

/* ── 보증금 지킴이 ────────────────────────────────────────────────────
   계약한 뒤의 감시. 세입자는 도장을 찍는 순간 확인을 멈추지만 위험은 그 뒤
   2년에 걸쳐 자란다. 등록해 두면 앱을 열 때마다 등록 시점과 오늘 데이터를
   견줘 "그 사이에 생긴 신호"만 골라 보여준다.

   등록은 기기(localStorage)에만 남는다 — 비교함과 같은 규율이고, 소개
   페이지의 약속("개인 데이터를 서버에 두지 않습니다")이 그대로 지켜진다.
   서버 알림은 다음 단계다. 그때도 이 신호 계산이 그대로 배치로 옮겨간다. */
const GUARD_KEY = 'guard-v1'
const guardRead = () => {
  try { return JSON.parse(localStorage.getItem(GUARD_KEY)) || [] } catch { return [] }
}

/** 전세 확정(비잠정) 행의 마지막 관측월. "등록 이후에 생긴 일"의 기준선이다. */
function jeonseBaselineYm(u) {
  let max = null
  for (const r of u.deals?.j ?? []) {
    if (r.at(-1) === 'P') continue
    if (!max || r[0] > max) max = r[0]
  }
  return max
}

export function useGuard() {
  const [items, setItems] = useState(guardRead)
  // 서비스워커는 localStorage를 못 읽는다. 백그라운드 알림용으로 IndexedDB에
  // 같은 내용을 비춰 둔다. guard-sync가 이 파일을 import하므로 정적 import는
  // 순환이 된다 — 동적 import로 끊는다.
  const mirror = (list) => import('./guard-sync.js').then((m) => m.mirrorGuard(list)).catch(() => {})
  useEffect(() => { mirror(guardRead()) }, [])
  const save = (next) => {
    setItems(next)
    try { localStorage.setItem(GUARD_KEY, JSON.stringify(next)) } catch { /* 시크릿 모드 등 */ }
    mirror(next)
  }
  return {
    items,
    has: (id) => items.some((x) => x.id === id),
    add: (lawd, u, deposit, expiry) => {
      if (items.some((x) => x.id === u.id)) return true
      // 가득 찼을 때 오래된 것을 조용히 밀어내면 안 된다. 비교함의 탈락은 주말
      // 계획 하나가 빠지는 것이지만, 지킴이의 탈락은 감시받고 있다고 믿는
      // 계약이 무감시가 되는 것이다. 거부하고 그렇다고 말한다.
      if (items.length >= 4) return false
      save([...items, {
        v: 1, // 항목 스키마 버전. base 구조가 바뀔 때 마이그레이션 기준
        lawd, id: u.id, name: u.name || u.jibun, umd: u.umd, area: u.area,
        deposit, expiry, addedAt: new Date().toISOString().slice(0, 10),
        // 등록 시점의 관측을 기억해야 그 뒤에 생긴 일을 골라낼 수 있다.
        // 기준선은 전세 확정(비잠정) 행만으로 잡는다. 이번 달 월세 잠정 하나가
        // 기준선을 이번 달로 끌어올리면, 신고 지연(30일)으로 등록 뒤에 도착하는
        // 같은 달 전세 계약이 영구히 걸러진다.
        base: { ym: jeonseBaselineYm(u), renewHike: u.renew_hike ?? null,
                nSale24m: u.n_sale_24m ?? 0 },
        seen: [], // 서버 알림 단계의 확인(ack) 자리. 지금은 비워 둔다
      }])
      return true
    },
    remove: (id) => save(items.filter((x) => x.id !== id)),
  }
}

const gEok = (m) => (m == null ? '-' : m >= 10000 ? `${(m / 10000).toFixed(1)}억` : `${m.toLocaleString()}만`)
const gYm = (s) => `${s.slice(2, 4)}.${s.slice(4, 6)}`

/**
 * 등록된 계약 하나에 대한 위험 신호. 화면과 (다음 단계의) 배치 알림이 같은
 * 함수를 쓰도록 순수 함수로 둔다. u는 오늘의 물건 데이터, item은 등록 기록.
 */
export function guardSignals(u, item) {
  const sigs = []
  const dep = item.deposit
  const base = item.base ?? {}
  const after = (v) => !base.ym || v > base.ym

  // 1. 등록 이후 신규 전세가 내 보증금 아래로. 다음 세입자의 보증금이 내 반환
  //    재원인 구조에서 가장 직접적인 경보다. critical 단정은 '신규'로 신고된
  //    행만으로 한다. 구분 미기재 행(실측 1.8%)은 갱신(기존 계약 감액)일 수
  //    있고, 갱신은 옛 가격이라 낮은 게 정상이므로 단정하면 거짓 경보가 된다.
  //    반지하는 이 앱이 다른 시장으로 취급하므로 그것만으로는 단정하지 않는다.
  const lowRows = (u.deals?.j ?? []).filter((r) => after(r[0]) && r[1] < dep)
  const fmtRow = (r) => `${gYm(r[0])}${r.at(-1) === 'P' ? '(잠정)' : ''} ${gEok(r[1])}`
    + `${r[2] == null ? '' : r[2] <= 0 ? ' 반지하' : ` ${r[2]}층`}`
  const newLow = lowRows.filter((r) => r[3] === '신규')
  const ground = newLow.filter((r) => r[2] == null || r[2] > 0)
  if (newLow.length) {
    const pick = (rows) => rows.reduce((x, y) => (y[1] < x[1] ? y : x))
    const worst = pick(ground.length ? ground : newLow)
    sigs.push({
      tone: ground.length ? 'critical' : 'serious',
      head: ground.length ? '신규 전세가 내 보증금보다 낮게 계약됐습니다'
                          : '반지하 신규 전세가 내 보증금보다 낮게 계약됐습니다',
      body: `${fmtRow(worst)}에 신규 전세가 나갔습니다 (내 보증금 ${gEok(dep)}). `
        + (ground.length
            ? '다음 세입자의 보증금으로 내 보증금을 채우기 어렵다는 신호입니다. '
              + '만기 전 반환 계획을 집주인에게 지금 확인하세요.'
            : '반지하는 지상층과 시세가 달라 단정할 수는 없지만, 이 건물의 전세 '
              + '수요를 살피는 참고 신호입니다.') })
  } else {
    const unk = lowRows.filter((r) => r[3] !== '신규' && r[3] !== '갱신')
    if (unk.length) {
      const worst = unk.reduce((x, y) => (y[1] < x[1] ? y : x))
      sigs.push({ tone: 'serious', head: '내 보증금보다 낮은 전세 계약이 신고됐습니다',
        body: `${fmtRow(worst)} 계약인데 신규·갱신 구분이 신고되지 않았습니다. `
          + '갱신(기존 계약 감액)이면 오히려 협상 근거이고, 신규면 반환 재원이 '
          + '줄고 있다는 신호입니다. 다음 갱신 데이터에서 다시 확인합니다.' })
    }
  }

  // 2. 등록 이후 갱신에서 보증금 인하가 나타남. 역전세가 이 건물에 도착했다.
  const newRenew = (u.deals?.j ?? []).some((r) => after(r[0]) && r[3] === '갱신')
  const wasCut = base.renewHike != null && base.renewHike <= -0.05
  if (newRenew && u.renew_hike != null && u.renew_hike <= -0.05 && !wasCut) {
    sigs.push({ tone: 'serious', head: '갱신 계약에서 보증금이 내려가고 있습니다',
      body: `이 건물 갱신 보증금이 직전 계약 대비 중위 ${Math.round(u.renew_hike * 100)}%입니다. `
        + '집주인이 보증금 일부를 돌려주고 있다는 뜻이고, 내 만기 때 같은 협상이 '
        + '가능하다는 근거이기도 합니다.' })
  }

  // 3. 내 보증금 기준 전세가율. 시장 중위가 아니라 "내 계약"의 위험이다.
  //    이 건물 매매 표본이 충분할 때만 말한다. 추정으로 경보를 울리면 양치기가 된다.
  if (u.med_sale && u.n_sale_24m >= 3) {
    const r = dep / u.med_sale
    if (r >= 1.0) {
      sigs.push({ tone: 'critical', head: '내 보증금이 이 건물 매매가를 넘습니다',
        body: `최근 2년 매매 ${u.n_sale_24m}건 기준 중위 ${gEok(u.med_sale)}. 경매로 가면 `
          + '전액 회수가 어려운 구간입니다. 보증보험 미가입이라면 지금 가입 가능 여부를 확인하세요.' })
    } else if (r >= 0.9) {
      sigs.push({ tone: 'serious', head: `내 보증금이 이 건물 매매가의 ${Math.round(r * 100)}%입니다`,
        body: `최근 2년 매매 ${u.n_sale_24m}건 기준입니다. 집값이 조금만 내려도 보증금이 `
          + '매매가를 넘습니다. 만기 6개월 전부터는 반환 계획을 미리 확인해 두세요.' })
    }
  }

  // 4. 검증 가능하던 건물이 검증 불능으로. 위험해졌다가 아니라 눈이 감겼다는 뜻.
  if ((base.nSale24m ?? 0) > 0 && !u.n_sale_24m) {
    sigs.push({ tone: 'serious', head: '매매 거래가 끊겨 시세 검증이 안 되는 상태가 됐습니다',
      body: '등록할 때는 최근 2년 매매가 있었는데 지금은 0건입니다. 담보 가치를 실거래로 '
        + '확인할 수 없게 됐다는 뜻입니다.' })
  }
  return sigs
}

/** 로컬 자정. 'YYYY-MM-DD'를 new Date()로 파싱하면 UTC 자정 = KST 오전 9시가
    되어 매일 오전 9시에 D-day가 하루 미리 넘어간다. "지났습니다"류 단정문은
    사실이어야 하므로 두 날짜 모두 로컬 자정으로 맞춘다. */
function localMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 만기 n개월 전의 실제 날짜. 법정 기한은 역월이지 n*30일이 아니다. 60일로
    근사하면 2월이 낀 만기에서 살아 있는 갱신요구권을 소멸했다고 알리는 날이
    생긴다. 응당일이 없는 달(4/30의 2개월 전 등)은 말일로 당긴다. */
function monthsBefore(date, n) {
  const y = date.getFullYear(), m = date.getMonth() - n, d = date.getDate()
  const last = new Date(y, m + 1, 0).getDate()
  return new Date(y, m, Math.min(d, last))
}

/**
 * 만기 캘린더. 주택임대차보호법의 기한은 데이터와 무관하게 확정적이다.
 * 갱신요구권 행사와 갱신거절 통지는 만기 6개월~2개월 전(§6, §6-3). 그 창이
 * 지나도록 집주인과 나 모두 아무 통지가 없었을 때에만 묵시적 갱신이다(§6①).
 * 신호가 없는 주에도 이 줄은 항상 나온다 — 조용한 감시가 일하고 있다는
 * 표시이기도 하다.
 */
export function guardCalendar(expiry, now = new Date()) {
  if (!expiry) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const exp = localMidnight(expiry)
  const d = Math.round((exp - today) / 86400000)
  if (d < 0) return { d, tone: 'critical', head: '만기가 지났습니다',
    body: '보증금을 못 받았다면 이사하기 전에 임차권등기명령부터 신청하세요. 등기 전에 '
      + '이사하면 우선변제권이 사라집니다. 절차는 알아두기 탭에 있습니다.' }
  // 법정 통보 창: 만기 6개월 전 ~ 2개월 전. 역월로 계산한다.
  const window2 = monthsBefore(exp, 2)   // 이 날까지 통보해야 한다
  const window6 = monthsBefore(exp, 6)
  if (today > window2) {
    if (d <= 30) return { d, tone: 'serious', head: `만기 D-${d}`,
      body: '반환 확답이 없다면 내용증명으로 보증금 반환을 청구해 두세요. 이사 갈 집 계약은 '
        + '반환 일정을 확정한 뒤에 하셔야 합니다.' }
    return { d, tone: 'serious', head: `만기 D-${d} · 통보 기한이 지났습니다`,
      body: '갱신요구·갱신거절 통지 기한(만기 2개월 전)이 지났습니다. 집주인과 나 모두 '
        + '통보하지 않았다면 같은 조건으로 묵시적 갱신됩니다. 묵시적 갱신이면 나는 언제든 '
        + '해지를 통보할 수 있고 3개월 뒤 효력이 생깁니다. 이미 통보된 계약이면 반환 '
        + '일정을 확정하세요.' }
  }
  if (today >= window6) return { d, tone: 'warning', head: `만기 D-${d} · 결정할 시간입니다`,
    body: '갱신요구권 행사 또는 퇴거 통보는 만기 2개월 전'
      + `(${window2.getMonth() + 1}월 ${window2.getDate()}일)까지입니다. 더 살 생각이면 `
      + '갱신요구권(5% 상한)을, 나갈 생각이면 통보와 함께 반환 일정을 잡으세요.' }
  return { d, tone: 'muted', head: `만기 D-${d}`,
    body: '다음 확인 지점은 만기 6개월 전입니다. 그때 갱신·퇴거를 결정하시면 됩니다.' }
}

/**
 * 만기에서 파생되는 알림 지점들. 백그라운드 알림(서비스워커)이 쓸 날짜를
 * 여기서 미리 계산해 둔다 — 워커에는 날짜 비교만 남기고 역월 계산 같은
 * 법리성 로직은 이 파일 밖으로 복제하지 않는다. 복제된 로직은 반드시 어긋난다.
 */
export function guardMilestones(expiry) {
  if (!expiry) return []
  const exp = localMidnight(expiry)
  const w2 = monthsBefore(exp, 2)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return [
    { key: 'w6', date: fmt(monthsBefore(exp, 6)),
      title: '만기 6개월 전입니다',
      body: '갱신할지 나갈지 결정할 구간이 시작됐습니다. 통보 기한은 만기 2개월 전입니다.' },
    { key: 'w2-14', date: fmt(new Date(w2.getFullYear(), w2.getMonth(), w2.getDate() - 14)),
      title: '통보 기한까지 2주 남았습니다',
      body: '갱신요구 또는 퇴거 통보는 만기 2개월 전까지입니다. 아직이라면 지금 하세요.' },
    { key: 'w2', date: fmt(w2),
      title: '오늘이 통보 기한입니다 (만기 2개월 전)',
      body: '집주인과 나 모두 오늘까지 통보하지 않았다면 같은 조건으로 묵시적 갱신됩니다. 앱에서 일정을 확인하세요.' },
    { key: 'd30', date: fmt(new Date(exp.getFullYear(), exp.getMonth(), exp.getDate() - 30)),
      title: '만기 30일 전입니다',
      body: '반환 확답이 없다면 내용증명으로 보증금 반환을 청구해 두세요.' },
    { key: 'd0', date: fmt(exp),
      title: '오늘이 만기일입니다',
      body: '보증금을 못 받았다면 이사 전에 임차권등기명령부터 신청하세요.' },
  ]
}

/* ── 주거 히스토리 ────────────────────────────────────────────────────
   살아온 집의 기록. 지킴이와 역할이 다르다. 지킴이는 "감시 중인 계약"이고
   여기는 "살아온 기록"이다. 지킴이는 우리 데이터에 있는 물건만 담을 수 있고
   넉 대까지인데, 살아온 집은 데이터에 없는 경우가 오히려 흔하다.

   재건축으로 사라진 건물, 2021년 8월 이전(수집 시작 전) 거주지, 단독·다가구,
   건축물대장이 아직 안 닿은 지역이 전부 여기 걸린다. 실제로 둔촌주공은 이름으로도
   지번으로도 찾을 수 없다. 2020년에 이주·철거가 끝나 수집 범위 안에 거래가
   한 건도 없기 때문이다. 같은 자리에는 2024년 준공한 다른 이름의 단지가 있다.

   그래서 이 기록은 우리 데이터에 기대지 않는다. 좌표가 그 집의 정체성이고,
   이름은 사용자가 기억하는 대로 적는다. 지번이 합쳐지든 이름이 바뀌든 그 땅의
   위치는 안 변한다. 우리가 아는 것이 있으면 붙이고, 없으면 비운다.

   기기에만 저장한다(localStorage). 비교함·지킴이와 같은 규율이다. */
/** 두 좌표 사이 미터. 평면 근사이고 수도권 규모에서 오차는 무시할 수준이다. */
export function meters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111320
  const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  return Math.hypot(dx, dy)
}

/**
 * 사용자가 적은 보증금. 실거래 금액과 달리 본인이 아는 정확한 숫자라 반올림하지
 * 않는다. 9,999만원을 "1억"으로 적는 것은 없는 숫자를 만드는 일이다.
 * (지킴이의 gEok은 실거래 표시용이라 그쪽 규칙을 따로 둔다.)
 */
export function wonText(m) {
  if (m == null || m === '') return null
  const n = Number(m)
  if (!Number.isFinite(n) || n < 0) return null
  const e = Math.floor(n / 10000), man = Math.round(n % 10000)
  if (!e) return `${man.toLocaleString()}만원`
  return man ? `${e}억 ${man.toLocaleString()}만원` : `${e}억원`
}

const HIST_KEY = 'home-history-v1'
const histRead = () => {
  try {
    const v = JSON.parse(localStorage.getItem(HIST_KEY))
    // 배열이 아닌 값이 들어와 있으면(손상·수동 편집) 아래 전개에서 화면이 죽는다.
    return Array.isArray(v) ? v.filter(isHome) : []
  } catch { return [] }
}

/** 저장·가져오기로 들어오는 한 건이 화면에서 다룰 수 있는 모양인지 본다. */
export function isHome(x) {
  if (!x || typeof x !== 'object') return false
  const str = (v) => v == null || typeof v === 'string'
  const num = (v) => v == null || (typeof v === 'number' && Number.isFinite(v))
  return typeof x.id === 'string' && typeof x.name === 'string' && x.name.trim() !== ''
    && isYm(x.from) && (x.to === '' || x.to == null || isYm(x.to))
    && str(x.addr) && str(x.memo) && str(x.kind) && str(x.ht) && str(x.expiry)
    && num(x.lat) && num(x.lon) && num(x.deposit) && num(x.rent)
}

const isYm = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)

/** 'YYYY-MM' 두 개 사이의 개월 수. to가 없으면 오늘까지 센다. */
export function monthsBetween(from, to, now = new Date()) {
  if (!isYm(from)) return null
  if (to && !isYm(to)) return null
  const [fy, fm] = from.split('-').map(Number)
  const end = to
    ? to.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1]
  const n = (end[0] - fy) * 12 + (end[1] - fm)
  // 거꾸로 적힌 기간(나온 때가 들어간 때보다 빠름)과 미래 입주는 셀 수 없다.
  // 여기서 0으로 흘리면 합계와 평균에 조용히 섞인다.
  return n >= 0 ? n : null
}

export const monthsText = (n) => {
  if (n == null) return '-'
  const y = Math.floor(n / 12), m = n % 12
  if (!y) return `${m}개월`
  return m ? `${y}년 ${m}개월` : `${y}년`
}

/**
 * 살아온 기록의 집계.
 *
 * 네 숫자의 분모를 하나로 맞춘다. 초안은 "기록한 집"은 전부를 세고 "이사"와
 * "평균"은 기간이 적힌 것만 세서, 5곳을 적었는데 이사가 3번으로 나왔다. 셈이
 * 틀렸다고 읽힌다. 그리고 기간이 거꾸로 적힌 집은 monthsBetween이 null을 내는데
 * 그것을 0개월로 흘려서 평균을 조용히 낮췄다. 못 센 것은 못 셌다고 하고 몇 곳을
 * 뺐는지 함께 낸다.
 *
 * "사신 기간 합계"는 각 집에 사신 기간을 더한 값이다. 이사가 겹치면 겹친 달을
 * 두 번 센다. 합집합으로 바꾸는 방법도 있지만, 겹침은 실제로 두 집에 보증금이
 * 걸려 있던 기간이라 두 번 세는 쪽이 기록의 뜻에 가깝다. 대신 화면에 그렇게
 * 적는다.
 */
export function historyStats(items, dist) {
  const ok = [], skipped = []
  for (const it of items) {
    const n = monthsBetween(it.from, it.to)
    if (n == null) skipped.push(it)
    else ok.push({ ...it, n })
  }
  ok.sort((a, b) => a.from.localeCompare(b.from))
  const months = ok.reduce((s, x) => s + x.n, 0)
  const withGeo = ok.filter((x) => x.lat != null && x.lon != null)
  let moved = 0
  for (let i = 1; i < withGeo.length; i++) {
    moved += dist(withGeo[i - 1].lat, withGeo[i - 1].lon, withGeo[i].lat, withGeo[i].lon)
  }
  return {
    n: ok.length,
    skipped: skipped.length,
    months,
    // 이사 횟수는 집 수에서 하나를 뺀 값이다. 첫 집은 이사가 아니다.
    moves: Math.max(0, ok.length - 1),
    avg: ok.length ? Math.round(months / ok.length) : 0,
    // 겹친 달이 있으면 합계가 실제 살아온 햇수보다 길다. 화면이 그렇게 밝힌다.
    overlap: ok.some((x, i) => i > 0 && ok[i - 1].to && x.from < ok[i - 1].to),
    moved, geoN: withGeo.length,
  }
}

export function useHistory() {
  const [items, setItems] = useState(histRead)
  const save = (next) => {
    setItems(next)
    try { localStorage.setItem(HIST_KEY, JSON.stringify(next)) } catch { /* 시크릿 모드 등 */ }
  }
  return {
    items,
    add: (rec) => save([...items, { ...rec, v: 1, id: `h${Date.now()}` }]),
    update: (id, patch) => save(items.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    remove: (id) => save(items.filter((x) => x.id !== id)),
    // 기기에만 있는 기록이라 폰을 바꾸면 사라진다. 몇 년치가 한 번에 없어지는
    // 것은 비교함이 비워지는 것과 무게가 다르므로 내보내기를 함께 둔다.
    replaceAll: (next) => save(next),
  }
}


/**
 * 계약 전에 사람이 직접 확인해야 하는 것. 이 앱이 답하지 못하는 부분이다.
 * 리포트 카드(판정 바로 아래)와 소개가 같은 목록을 써야 한다. 전에는 카드
 * 안에 3항목짜리 짧은 판이 있고 4,371px 아래에 7항목짜리 긴 판이 따로
 * 있었는데, 짧은 판이 긴 판의 부분집합이라 짧은 쪽만 본 사람은 갑구·전입세대
 * 확인서·세금 체납을 영영 안 봤다.
 */
export const CHECKLIST = [
  ['등기부등본 을구', '근저당이 얼마나 잡혀 있는지 봅니다. 선순위 채권과 내 보증금의 합이 매매가를 넘으면 경매에서 못 받습니다',
   'https://www.iros.go.kr', '인터넷등기소 · 열람 700원'],
  ['등기부등본 갑구', '신탁등기가 있으면 집주인에게 계약 권한이 없을 수 있습니다. 압류·가압류도 여기서 봅니다',
   'https://www.iros.go.kr', '인터넷등기소'],
  ['전입세대 확인서', '나보다 먼저 들어온 세대가 있는지 봅니다. 선순위 임차인은 배당에서 나보다 앞섭니다',
   'https://www.gov.kr', '정부24 또는 주민센터'],
  ['보증보험 가입 가능 여부', 'HUG/HF에서 거절되면 그 자체가 신호입니다. 가입이 안 되면 해제한다는 특약을 넣어 두세요',
   'https://www.khug.or.kr', 'HUG 주택도시보증공사'],
  ['집주인 신분과 세금 체납', '계약서상 소유자와 등기부상 소유자가 같은지 봅니다. 국세 완납증명서를 요구할 수 있습니다',
   'https://www.hometax.go.kr', '홈택스 · 미납국세 열람은 세무서'],
  ['건축물대장 위반건축물 표기', '위반건축물이면 보증보험이 안 됩니다',
   'https://www.gov.kr', '정부24 · 무료 발급'],
  // 치안은 이 앱이 판정하지 않는다. 경찰서 관할 단위 통계를 동네에 얹으면
  // 다른 경계의 숫자를 우리 동네 숫자로 읽게 만든다. 판단은 국가 지도에 넘긴다.
  ['동네 치안 정보', '이 앱은 치안을 판정하지 않습니다. 범죄주의구간과 안전시설 위치는 국가가 운영하는 지도에서 직접 보실 수 있습니다',
   'https://www.safemap.go.kr', '행정안전부 생활안전지도'],
]
