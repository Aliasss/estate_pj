import { useCallback, useEffect, useMemo, useState } from 'react'
import MapView from './MapView.jsx'
import { meters, sigLabel } from './Finder.jsx'
import { NoJeonseSig, UnitCard, eok, pct0, ratioTone } from './UnitLookup.jsx'
import { DEAL_KINDS, hasDeal, htName, useCompare, useFinder, useGuard, useSubway, useUnitLoader } from './units.js'

/**
 * 임장 중 내 주변. 탭바에 없는 독립 화면이고, 첫 화면의 버튼으로 들어온다.
 *
 * 동네 탭이 "조건으로 후보를 추리는" 곳이라면 여기는 이미 현장에 서 있는
 * 사람을 위한 화면이다. 조건 필터를 다 걷어내고 반경과 유형만 남겼다.
 * 골목에서 한 손으로 쓰는 화면에 입력칸이 여덟 개일 이유가 없다.
 *
 * 위치는 화면 상태로만 두고 저장하지도 보내지도 않는다. 한 번 잡고 끝낸다.
 * 계속 추적하면 배터리를 먹는데, 임장은 걸어 다니며 여러 번 누르는 쪽이 낫다.
 */

const RADII = [300, 500, 1000, 2000]
const HTS = [['', '전체'], ['R', '연립·다세대'], ['A', '아파트'], ['O', '오피스텔']]
const PAGE = 40

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`)

export default function Nearby({ guNames, region = '11', onBack }) {
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
  const [view, setView] = useState('list')
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

  useEffect(() => { setLimit(PAGE); setOpen(null) }, [here, radius, ht, deal])

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

  return (
    <section className="card">
      <div className="nb-head">
        <h2>임장 중 내 주변</h2>
        {onBack && <button className="cmp-del" onClick={onBack}>닫기</button>}
      </div>
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
          <div className="nb-ctl">
            <div className="filters">
              {RADII.map((m) => (
                <button key={m} aria-pressed={radius === m} onClick={() => setRadius(m)}>
                  {m >= 1000 ? `${m / 1000}km` : `${m}m`}
                </button>
              ))}
            </div>
            <div className="filters" role="group" aria-label="물건 유형">
              {HTS.map(([v, label]) => (
                <button key={v || 'all'} aria-pressed={ht === v} onClick={() => setHt(v)}>
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
              {DEAL_KINDS.filter(([v]) => v !== 'w' || hasNw).map(([v, label]) => (
                <button key={v || 'all'} aria-pressed={deal === v} onClick={() => setDeal(v)}>
                  {v === '' ? '거래 전체' : label}
                </button>
              ))}
            </div>
          </div>
          <div className="nb-bar">
            <span>
              반경 {radius >= 1000 ? `${radius / 1000}km` : `${radius}m`} 안 <b>{hits.length}개</b>
              {here.acc > 100 && ` · 위치 오차 약 ${Math.round(here.acc)}m`}
            </span>
            <span className="nb-acts">
              <button className="cmp-del" onClick={() => setView(view === 'list' ? 'map' : 'list')}>
                {view === 'list' ? '지도' : '목록'}
              </button>
              <button className="cmp-del" onClick={ask} disabled={busy}>
                {busy ? '갱신 중' : '위치 갱신'}
              </button>
            </span>
          </div>

          {view === 'map' ? (
            <MapView points={pins} stations={stationPins} here={here}
                     selected={open?.u ? { lat: open.u.lat, lon: open.u.lon,
                       tone: ratioTone(open.u.ratio), label: open.u.name } : null}
                     onPick={(p) => toggle(p.i)}
                     note="가운데 보라색 점이 지금 계신 곳입니다" />
          ) : hits.length === 0 ? (
            <p className="muted-line">
              반경 안에 {deal ? `최근 2년 ${DEAL_KINDS.find(([v]) => v === deal)[1]} 신고가 있었던 건물이`
                : '최근 2년 실거래 신고가 있었던 건물이'} 없습니다.
              {deal ? ' 거래 유형을 전체로 바꾸거나 반경을 넓혀 보세요.'
                : ' 반경을 넓혀 보시거나, 이 동네가 아직 수집 범위(서울·경기) 밖일 수 있습니다.'}
            </p>
          ) : (
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
                    {on && open.loading && <p className="muted-line">불러오는 중…</p>}
                    {on && open.error && <p className="warnline">{open.error}</p>}
                    {on && open.u && (
                      <UnitCard u={open.u} lawd={open.lawd} compare={compare} guard={guard}
                                onClose={() => setOpen(null)} />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {view === 'list' && hits.length > limit && (
            <button className="more" onClick={() => setLimit((v) => v + PAGE)}>
              더 보기 ({hits.length - limit}개 남음)
            </button>
          )}
        </>
      )}

      <p className="muted-line">
        매물 목록이 아닙니다. 최근 2년 전세·매매·월세 신고가 있었던 건물이며, 지금
        계약할 수 있는 방인지는 알 수 없습니다. 전세 신고가 없는 건물은 전세가율을
        낼 수 없어 <b>전세 신고 없음</b>으로 적었습니다. 눈앞 건물을 눌러 판정을 확인하고
        비교함에 담아 두시면 집에 돌아가 나란히 견주실 수 있습니다.
      </p>
    </section>
  )
}
