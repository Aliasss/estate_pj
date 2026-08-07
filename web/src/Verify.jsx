import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
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
  ['등기부등본 을구', '근저당이 얼마나 잡혀 있나. 선순위 채권 + 내 보증금이 매매가를 넘으면 경매에서 못 받는다',
   'https://www.iros.go.kr', '인터넷등기소 · 열람 700원'],
  ['등기부등본 갑구', '신탁등기가 있으면 집주인에게 계약 권한이 없을 수 있다. 압류·가압류도 여기서 본다',
   'https://www.iros.go.kr', '인터넷등기소'],
  ['전입세대 확인서', '나보다 먼저 들어온 세대가 있나. 선순위 임차인은 배당에서 나보다 앞선다',
   'https://www.gov.kr', '정부24 또는 주민센터'],
  ['보증보험 가입 가능 여부', 'HUG/HF에서 거절되면 그 자체가 신호다. 계약서에 특약으로 넣어 둔다',
   'https://www.khug.or.kr', 'HUG 주택도시보증공사'],
  ['집주인 신분과 세금 체납', '계약서상 소유자와 등기부상 소유자가 같은지. 국세 완납증명서를 요구할 수 있다',
   'https://www.hometax.go.kr', '홈택스 · 미납국세 열람은 세무서'],
  ['건축물대장 위반건축물 표기', '위반건축물이면 보증보험이 안 된다',
   'https://www.gov.kr', '정부24 · 무료 발급'],
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

  // 키 입력마다 8만 행을 훑으면 저사양 폰에서 입력이 끊긴다. 렌더 우선순위를 낮춰
  // 타이핑을 먼저 그리게 한다.
  const dq = useDeferredValue(q)
  const hits = useMemo(
    () => (fin.status === 'ready' ? search(fin, dq, 40, guNames) : { idx: [], total: 0 }),
    [fin, dq, guNames])

  /**
   * 같은 동·비슷한 평형에서 이 보증금이 어디쯤인지. "2.4억"만으로는 비싼지 싼지
   * 알 수 없는데, "이 동네 비슷한 평형 중 위에서 20%"면 바로 읽힌다.
   */
  const rank = useMemo(() => {
    if (fin.status !== 'ready' || !open?.u) return null
    const { col, d } = fin
    const u = open.u
    const ui = d.umds.indexOf(u.umd)
    // 같은 이름의 법정동이 두 구에 있다(신사동: 은평·강남). 이름으로만 묶으면 강남
    // 신사동 3.5억이 은평 기준으로 "비싼 축 11%"가 된다. 실제로는 싼 축 94%였다.
    const gi = d.gus.indexOf(open.lawd)
    if (ui < 0 || gi < 0 || !u.med_jeonse || !u.area) return null
    const peers = []
    for (let i = 0; i < d.n; i++) {
      if (col.g[i] !== gi) continue
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
      const u = await byRow(lawd, row, fin.d?.build)
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

  // 뒤로가기·앞으로가기가 리포트를 닫고 연다. pushState만 하고 popstate를 안 들으면
  // 모바일에서 리포트를 벗어나는 기본 동작이 무시되고, 한 번 더 누르면 앱을 나가 버린다.
  useEffect(() => {
    const onPop = () => {
      const raw = new URLSearchParams(location.search).get('u')
      if (!raw) { setOpen(null); return }
      const [lawd, id] = raw.split('.')
      if (lawd && id) byId(lawd, id).then((u) => u && setOpen({ lawd, u })).catch(() => {})
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [byId])

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
             placeholder="예: 화곡동 871-8 · 엔에스월드타워"
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
            {CHECKLIST.map(([what, why, href, where]) => (
              <li key={what}>
                <b>{what}</b><span>{why}</span>
                <a href={href} target="_blank" rel="noopener noreferrer">{where} ↗</a>
              </li>
            ))}
          </ul>
        </>
      )}

      {fin.status === 'ready' && !open && (
        q.trim().length < 2 ? (
          <p className="muted-line">
            위 기간에 전세 계약이 있었던 서울 전체 {d.n.toLocaleString()}개 건물을 담고 있습니다.
            자치구를 고르실 필요 없습니다. 신고 기한이 계약일로부터 30일이라 최근 두 달치는
            아직 절반도 안 들어와서, 그 구간은 빼고 셉니다.
          </p>
        ) : hits.idx.length ? (
          <>
          {hits.total > hits.idx.length && (
            <p className="muted-line">
              {hits.total.toLocaleString()}개가 맞습니다. 전세 계약이 많은 순으로
              {' '}{hits.idx.length}개만 보여 드립니다. 지번까지 넣으면 바로 좁혀집니다.
            </p>
          )}
          <ul className="unit-list">
            {hits.idx.map((i) => (
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
          </>
        ) : (
          <NoHit fin={fin} query={dq} />
        )
      )}
    </section>
  )
}

/**
 * 검색 0건은 조작 실수가 아니라 판정일 수 있다. 이 데이터셋은 최근 2년 전세 신고가
 * 있었던 건물만 담으므로, "여기 없다"는 그 건물에 최근 2년 전세 계약이 없었다는
 * 뜻이다. 신축이거나 내가 첫 세입자라는 얘기이고, 그건 이 앱이 최고 위험 신호로
 * 잡는 패턴(신축·매매 0건·전세만 다수)의 바로 앞 단계다. 침묵하면 안 되는 순간이다.
 */
function NoHit({ fin, query }) {
  const info = useMemo(() => {
    const { col, d } = fin
    const q = query.replace(/\s+/g, '')
    // 질의에 들어 있는 법정동을 찾는다. 있으면 그 동의 기준선을 대신 내 준다.
    let ui = -1
    for (let k = 0; k < d.umds.length; k++) {
      const u = d.umds[k]
      if (u && u.length >= 2 && q.includes(u)) { ui = k; break }
    }
    if (ui < 0) return null
    let n = 0, noSale = 0
    const deps = []
    for (let i = 0; i < d.n; i++) {
      if (col.u[i] !== ui) continue
      n++
      if (!col.ns[i]) noSale++
      if (col.jeonse[i] != null) deps.push(col.jeonse[i])
    }
    if (!n) return null
    deps.sort((a, b) => a - b)
    return { umd: d.umds[ui], n, noSale, med: deps[Math.floor(deps.length / 2)] }
  }, [fin, query])

  if (!info) {
    return (
      <p className="muted-line">
        찾지 못했습니다. 건물명 대신 <strong>법정동 + 지번</strong>으로 넣어 보세요
        (예: 화곡동 871-8). 최근 2년 전세 계약이 없던 건물은 여기에 없습니다.
      </p>
    )
  }
  return (
    <div className="nohit">
      <p>
        <strong>그 지번은 최근 2년 전세 신고 기록이 없습니다.</strong> 신축이거나,
        당신이 첫 세입자라는 뜻입니다. 시세를 확인할 실거래가 없다는 것 자체가
        확인해야 할 이유입니다.
      </p>
      <p className="muted-line">
        참고로 {info.umd}에는 물건 {info.n.toLocaleString()}개가 있고, 그중{' '}
        {Math.round((info.noSale / info.n) * 100)}%는 매매 사례가 없습니다. 동 중위
        보증금 {eok(info.med)}. 지번을 다시 확인하시려면 번지 앞부분만 넣어 보세요.
      </p>
      <p className="muted-line">
        기록이 없는 집일수록 아래를 건너뛰면 안 됩니다:{' '}
        <a href="https://www.iros.go.kr" target="_blank" rel="noopener noreferrer">등기부등본 ↗</a>{' · '}
        <a href="https://www.gov.kr" target="_blank" rel="noopener noreferrer">건축물대장 ↗</a>{' · '}
        <a href="https://www.khug.or.kr" target="_blank" rel="noopener noreferrer">HUG 보증 가입 가능 여부 ↗</a>
      </p>
    </div>
  )
}
