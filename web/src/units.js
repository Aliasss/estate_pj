import { useCallback, useEffect, useRef, useState } from 'react'

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
        _subwayCache = d.stations.map((name, i) => ({ name, lat: d.coords[i][0], lon: d.coords[i][1] }))
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
const FILL = ['jibun', 'hike', 'elvt', 'apr', 'lat', 'lon', 'stn', 'walk', 'sale']

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

export function useFinder(region = '11') {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    setState({ status: 'loading' })
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
        // 검색은 키 입력마다 전수 스캔이다. 행마다 replace로 새 문자열을 만들면
        // 저사양 폰에서 키 하나에 100ms를 넘긴다. 공백 뗀 이름을 한 번만 만들어 둔다.
        const flat = new Array(d.n)
        for (let i = 0; i < d.n; i++) flat[i] = (col.name[i] || '').replace(/\s+/g, '')
        setState({ status: 'ready', d, col, flat })
      })
      .catch((e) => setState({ status: e.pending ? 'pending' : 'error', message: e.message }))
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
  const { col, d, flat } = fin

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
      const umd = d.umds[col.u[i]] || ''
      if (!flat[i].includes(q) && !(umd + (col.jibun?.[i] ?? '')).includes(q)) continue
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
