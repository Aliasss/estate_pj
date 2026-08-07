import { useCallback, useEffect, useMemo, useState } from 'react'
import { UnitCard } from './UnitLookup.jsx'
import { search, useFinder, useUnitLoader, ym } from './units.js'

/**
 * 계약 전 확인. 이 앱의 본체.
 *
 * 우리에겐 매물이 없다. 사진도, 평면도도, 오늘 계약 가능한 방도 없다. 그러니
 * "집을 찾는 곳"으로 서면 직방에 진다. 대신 매물을 팔지 않으므로 "이 집 위험합니다"를
 * 말할 수 있다. 중개 수수료로 먹고사는 곳은 구조적으로 못 하는 말이다.
 *
 * 그래서 진입점은 조건이 아니라 주소다. 어딘가에서 방을 보고 온 사람이 그 주소를
 * 넣으면, 실거래가 무엇을 말하는지와 그 근거가 얼마나 두꺼운지를 돌려준다.
 */

const eok = (m) => (m == null ? '—' : m >= 10000 ? `${(m / 10000).toFixed(2)}억` : `${m.toLocaleString()}만`)

/**
 * 우리가 못 보는 것들. 전세가율은 안전의 한 조각일 뿐이고, 사람을 실제로 다치게 하는
 * 대부분은 여기 있다. 못 본다고 입을 다물면 앱을 본 사람이 다 봤다고 착각한다.
 */
const CHECKLIST = [
  ['등기부등본 을구', '근저당이 얼마나 잡혀 있나. 선순위 채권 + 내 보증금이 매매가를 넘으면 경매에서 못 받는다'],
  ['등기부등본 갑구', '신탁등기가 있으면 집주인에게 계약 권한이 없을 수 있다. 압류·가압류도 여기서 본다'],
  ['전입세대 확인서', '나보다 먼저 들어온 세대가 있나. 선순위 임차인은 배당에서 나보다 앞선다'],
  ['보증보험 가입 가능 여부', 'HUG/HF에서 거절되면 그 자체가 신호다. 계약서에 특약으로 넣어 둔다'],
  ['집주인 신분과 세금 체납', '계약서상 소유자와 등기부상 소유자가 같은지. 국세 완납증명서를 요구할 수 있다'],
  ['건축물대장 위반건축물 표기', '위반건축물이면 보증보험이 안 된다'],
]

function ShareRow({ lawd, id }) {
  const [done, setDone] = useState(false)
  const url = `${location.origin}${location.pathname}?u=${lawd}.${id}`
  return (
    <div className="share">
      <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="공유 링크" />
      <button onClick={() => {
        navigator.clipboard?.writeText(url).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1800)
        })
      }}>{done ? '복사됨' : '링크 복사'}</button>
    </div>
  )
}

export default function Verify({ guNames }) {
  const fin = useFinder()
  const { byRow, byId } = useUnitLoader()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)     // {lawd, u} | {error}

  const hits = useMemo(
    () => (fin.status === 'ready' ? search(fin, q) : []), [fin, q])

  /**
   * 같은 동·비슷한 평형에서 이 보증금이 어디쯤인지. "2.4억"만으로는 비싼지 싼지
   * 알 수 없는데, "이 동네 비슷한 평형 중 위에서 20%"면 바로 읽힌다.
   */
  const rank = useMemo(() => {
    if (fin.status !== 'ready' || !open?.u) return null
    const { col, d } = fin
    const u = open.u
    const ui = d.umds.indexOf(u.umd)
    if (ui < 0 || !u.med_jeonse || !u.area) return null
    const peers = []
    for (let i = 0; i < d.n; i++) {
      if (col.u[i] !== ui || col.ht[i] !== u.ht || col.jeonse[i] == null) continue
      if (Math.abs((col.area[i] ?? 0) - u.area) > u.area * 0.2) continue
      peers.push(col.jeonse[i])
    }
    if (peers.length < 5) return null       // 표본이 얇으면 백분위가 의미 없다
    const below = peers.filter((v) => v < u.med_jeonse).length
    return { umd: u.umd, n: peers.length, pct: Math.round((1 - below / peers.length) * 100) }
  }, [fin, open])

  const show = useCallback(async (lawd, row) => {
    try {
      const u = await byRow(lawd, row)
      setOpen({ lawd, u })
      // 뒤로가기로 검색 결과에 돌아올 수 있어야 한다
      history.pushState(null, '', `?u=${lawd}.${u.id}`)
    } catch (e) {
      setOpen({ error: e.message })
    }
  }, [byRow])

  // 공유 링크로 들어온 경우. 검색 없이 바로 그 물건을 편다.
  useEffect(() => {
    if (fin.status !== 'ready') return
    const raw = new URLSearchParams(location.search).get('u')
    if (!raw) return
    const [lawd, id] = raw.split('.')
    if (!lawd || !id) return
    byId(lawd, id)
      .then((u) => setOpen(u ? { lawd, u } : { error: '그 물건을 찾지 못했습니다' }))
      .catch((e) => setOpen({ error: e.message }))
  }, [fin.status, byId])

  const close = () => {
    setOpen(null)
    history.pushState(null, '', location.pathname)
  }

  if (fin.status === 'error') {
    return (
      <section className="card">
        <h2>계약 전 확인</h2>
        <p className="sub">데이터를 불러오지 못했습니다 ({fin.message})</p>
      </section>
    )
  }

  const { col, d } = fin
  return (
    <section className="card">
      <h2>계약 전 확인</h2>
      <p className="sub">
        보고 온 집의 주소나 건물명을 넣으세요. 국토교통부 실거래가로 그 건물을 확인해 드립니다
        {fin.status === 'ready' && ` · ${ym(fin.d.window[0])}~${ym(fin.d.window[1])} 신고분`}
      </p>

      <input className="search" type="search" value={q} autoComplete="off"
             placeholder="예: 화곡동 123-45 · 우성테마빌"
             onChange={(e) => setQ(e.target.value)} aria-label="주소 또는 건물명" />

      {fin.status !== 'ready' && <p className="muted-line">불러오는 중…</p>}

      {open?.error && <p className="muted-line critical">{open.error}</p>}

      {open?.u && (
        <>
          <UnitCard u={open.u} onClose={close} rank={rank}
                    onSibling={(id) => byId(open.lawd, id).then((v) => {
                      if (!v) return
                      setOpen({ lawd: open.lawd, u: v })
                      history.pushState(null, '', `?u=${open.lawd}.${id}`)
                      scrollTo({ top: 0, behavior: 'smooth' })
                    })} />
          <ShareRow lawd={open.lawd} id={open.u.id} />

          <h3 className="facts-h">이 앱이 답하지 못하는 것</h3>
          <p className="muted-line">
            위 숫자는 <strong>실거래 신고 기록</strong>일 뿐입니다. 보증금을 실제로 돌려받을 수
            있는지는 아래를 직접 확인해야 알 수 있고, 여기서는 볼 수 없습니다.
          </p>
          <ul className="checklist">
            {CHECKLIST.map(([what, why]) => (
              <li key={what}><b>{what}</b><span>{why}</span></li>
            ))}
          </ul>
        </>
      )}

      {fin.status === 'ready' && !open && (
        q.trim().length < 2 ? (
          <p className="muted-line">
            서울 전체 {d.n.toLocaleString()}개 물건 · {ym(d.window[0])}~{ym(d.window[1])}에 전세 계약이
            있었던 건물입니다. 자치구를 고르실 필요 없습니다.
            <br />
            신고 기한이 계약일로부터 30일이라 최근 두 달치는 아직 절반도 안 들어옵니다. 그 구간을
            빼고 24개월을 셉니다.
          </p>
        ) : hits.length ? (
          <ul className="unit-list">
            {hits.map((i) => (
              <li key={`${col.g[i]}-${col.i[i]}`}>
                <button onClick={() => show(d.gus[col.g[i]], col.i[i])}>
                  <span className="u-name">{col.name[i] || '(이름 없음)'}</span>
                  <span className="u-meta">
                    {guNames[d.gus[col.g[i]]] ?? ''} {d.umds[col.u[i]]} {col.jibun?.[i] ?? ''}
                    {' · '}{col.ht[i] === 'A' ? '아파트' : '연립·다세대'} 전용 {col.area[i]}m²
                  </span>
                  <span className="u-sig">
                    <em>{eok(col.jeonse[i])}</em>
                    <small>전세 {col.nj[i]}건</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-line">
            찾지 못했습니다. 건물명 대신 <strong>법정동 + 지번</strong>으로 넣어 보세요
            (예: 화곡동 123-45). 최근 2년 전세 계약이 없던 건물은 여기에 없습니다.
          </p>
        )
      )}
    </section>
  )
}
