import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 물건 데이터 접근. 화면 두 곳이 같은 파일을 쓰므로 여기 모아 둔다.
 *
 * finder.json  서울 전체 요약(열 단위, gzip 1MB). 검색과 조건 걸기에 쓴다.
 * {구}.json    상세 전량. 리포트를 열 때만 그 구 것을 받는다.
 */

/** 없는 열은 비어 있는 것으로 본다. 코드가 데이터보다 먼저 배포되면 그렇게 된다. */
const FILL = ['jibun', 'hike', 'elvt', 'apr', 'lat', 'lon', 'stn', 'walk']

/** "202406" -> "2024년 6월". 창을 화면에 그대로 뿌리면 여덟 자리 숫자가 보인다. */
export const ym = (s) => (s ? `${s.slice(0, 4)}년 ${+s.slice(4, 6)}월` : '—')

export function useFinder() {
  const [state, setState] = useState({ status: 'loading' })
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/units/finder.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        const col = Object.fromEntries(d.cols.map((c, i) => [c, d.columns[i]]))
        const blank = new Array(d.n).fill(null)
        for (const c of FILL) if (!col[c]) col[c] = blank
        setState({ status: 'ready', d, col })
      })
      .catch((e) => setState({ status: 'error', message: e.message }))
  }, [])
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

  const byRow = useCallback(async (lawd, row) => {
    const g = await load(lawd)
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
 * 서울 전체에서 주소·건물명으로 찾는다.
 *
 * 검증하러 온 사람은 주소를 들고 온다. 자치구를 먼저 고르라고 하면 "성북구가
 * 맞나 강북구가 맞나"부터 막힌다. 8만 3천 건 전수 훑기는 5ms 안쪽이라 그냥 다 본다.
 */
export function search(fin, query, limit = 40) {
  const q = query.trim().replace(/\s+/g, '')
  if (q.length < 2) return []
  const { col, d } = fin
  const out = []
  for (let i = 0; i < d.n && out.length < limit * 4; i++) {
    const name = col.name[i] || ''
    const umd = d.umds[col.u[i]] || ''
    if (name.replace(/\s+/g, '').includes(q) || (umd + (col.jibun?.[i] ?? '')).includes(q)) {
      out.push(i)
    }
  }
  // 같은 건물의 평형이 여럿이면 전세 계약이 많은 것부터. 사람들이 실제로 사는 평형이다.
  out.sort((a, b) => (col.nj[b] ?? 0) - (col.nj[a] ?? 0))
  return out.slice(0, limit)
}
