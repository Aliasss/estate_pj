import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const pct0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
export const eok = (m) => (m == null ? '—' : m >= 10000 ? `${(m / 10000).toFixed(2)}억` : `${m.toLocaleString()}만`)

export const STAGE = {
  A: { label: '이 건물 실거래 기준', exact: true },
  B: { label: '인근 유사 물건 기준', exact: false },
  'B-': { label: '인근 물건 기준 (연식 미보정)', exact: false },
  C: { label: '비교 대상 없음', exact: false },
}

/**
 * 위험 신호는 두 축으로 읽는다.
 *  - 검증 가능성: 이 건물 매매 사례가 있느냐. 없으면 담보 가치를 확인할 방법이 없다.
 *  - 전세가율 수준: 있느냐 없느냐를 통과했을 때만 의미가 있다.
 * 연립다세대에서는 첫째 축이 사실상 위험 그 자체라 화면 맨 위에 온다.
 */
function verdict(u) {
  if (!u.n_sale_24m) {
    return { tone: 'critical', head: '이 건물 최근 2년 매매 0건',
      body: u.n_sale_all ? `2021년 이후로는 ${u.n_sale_all}건 있었습니다.`
                         : '5년 내내 매매 신고가 없습니다. 담보 가치를 실거래로 확인할 방법이 없습니다.' }
  }
  if (u.n_sale_24m < 3) {
    return { tone: 'serious', head: `이 건물 최근 2년 매매 ${u.n_sale_24m}건`,
      body: '표본이 얇아 아래 전세가율은 한두 건에 좌우됩니다.' }
  }
  return { tone: 'good', head: `이 건물 최근 2년 매매 ${u.n_sale_24m}건`,
    body: '실거래로 가격을 확인할 수 있는 물건입니다.' }
}

/**
 * 기본 정렬 점수. 확신도와 위험 수준을 함께 본다.
 * 전세가율만으로 줄을 세우면 B단계 추정치(비교군이 어긋나면 200%도 나온다)가 위를 차지하고,
 * 정작 실거래로 확인된 깡통이 아래로 밀린다. 그래서 근거 단계를 먼저 본다.
 */
function riskScore(u) {
  const r = u.ratio
  const solid = u.stage === 'A' && u.n_sale_24m >= 3   // 그 건물 매매 3건 이상
  const thin = u.stage === 'A' && u.n_sale_24m < 3     // 한두 건에 좌우되는 값
  if (solid && r >= 1.0) return 700 + r        // 실거래로 확인된 깡통
  if (solid && r >= 0.9) return 600 + r
  if (thin && r >= 1.0) return 500 + r         // 단일 거래 기준. 그 한 건이 이상할 수 있다
  if (r != null && r >= 1.0) return 400 + r    // 인근 기준 추정
  if (!u.n_sale_24m) return 300 + Math.min(u.n_jeonse_24m ?? 0, 30) / 100   // 검증 불가
  if (r != null && r >= 0.8) return 200 + r
  return r ?? 0
}

/**
 * 이 값을 넘으면 전세가율이 아니라 비교 기준이 깨진 것으로 본다.
 * 실측: 매매 3건 이상인 물건 10,418개의 최대가 209%였다. 763%짜리는 보증금 2.9억에
 * 매매 1건이 붙은 경우였는데, 그 한 건은 지분 거래나 특수 거래일 가능성이 크다.
 * 이런 값을 퍼센트로 내보이면 정확히 잰 숫자처럼 읽힌다. 그게 제일 나쁘다.
 */
export const RATIO_BROKEN = 1.5
export const ratioBroken = (r) => r != null && r >= RATIO_BROKEN

export function ratioTone(ratio) {
  if (ratio == null) return 'muted'
  if (ratio >= 1) return 'critical'
  if (ratio >= 0.9) return 'serious'
  if (ratio >= 0.8) return 'warning'
  return 'good'
}

/**
 * 층간소음은 실측 데이터가 공개된 게 없다. 건축물대장에서 끌어낼 수 있는 근거는 둘뿐이다.
 * 구조로 가르려 했지만 공동주택 3,325동 중 90.2%가 철근콘크리트라 변별이 안 된다.
 * 점수를 매기지 않고 무엇을 보고 하는 말인지를 그대로 낸다.
 */
function quietNote(u) {
  if (u.strct === 'BR') return { tone: 'serious', text: '벽돌조 — 차음에 가장 불리한 구조입니다' }
  if (!u.apr) return null
  return u.apr >= 2005
    ? { tone: 'good', text: `${u.apr}년 준공 — 표준바닥구조 의무화(2005) 이후입니다` }
    : { tone: 'muted', text: `${u.apr}년 준공 — 표준바닥구조 의무화(2005) 이전입니다` }
}

/** 건축물대장. 수집이 끝나기 전까지는 없는 물건이 더 많아서 상태를 분명히 밝힌다. */
function BuildingFacts({ u }) {
  const has = u.apr != null || u.hhld != null || u.elvt != null
  if (!has) {
    return <p className="muted-line">건축물대장 자료가 아직 없는 물건입니다. 수집이 진행 중입니다.</p>
  }
  const note = quietNote(u)
  const items = [
    u.apr && ['준공', `${u.apr}년`],
    u.hhld && ['세대수', `${u.hhld}세대`],
    u.flr && ['지상 층수', `${u.flr}층`],
    u.elvt != null && ['승강기', u.elvt ? `${u.elvt}대` : '없음'],
    u.park != null && ['주차', u.park ? `${u.park}대` : '없음'],
    u.n_dong && ['단지 규모', `${u.n_dong}개 동`],
  ].filter(Boolean)
  return (
    <>
      <h3 className="facts-h">건물</h3>
      <ul className="facts">
        {items.map(([k, v]) => (
          <li key={k}><span>{k}</span><b>{v}</b></li>
        ))}
      </ul>
      {note && (
        <p className="warnline">
          <strong className={note.tone}>층간소음 추정</strong> — {note.text}.{' '}
          실측 소음 자료가 아니라 구조와 준공연도로 미루어 본 것입니다.
        </p>
      )}
    </>
  )
}

export function UnitCard({ u, onClose, onMap }) {
  const v = verdict(u)
  const st = STAGE[u.stage] ?? STAGE.C
  return (
    <div className="card unit-detail">
      <button className="close" onClick={onClose} aria-label="닫기">✕</button>
      <h2>{u.name || '(이름 없음)'}</h2>
      <p className="sub">
        {u.umd} {u.jibun} · 전용 {u.area}m² ({(u.area / 3.305785).toFixed(1)}평)
        {u.build_year ? ` · ${u.build_year}년 준공` : ''}
      </p>

      <div className={`verdict ${v.tone}`}>
        <strong>{v.head}</strong>
        <span>{v.body}</span>
      </div>

      <dl className="metrics">
        <div>
          <dt>전세가율</dt>
          <dd className={`big ${ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}`}>
            {u.ratio == null ? '—'
              : ratioBroken(u.ratio) ? '판단 보류'
              : st.exact ? pct0(u.ratio) : `약 ${pct0(u.ratio)}`}
          </dd>
          <small>{st.label}{u.n_comps ? ` · 매매 ${u.n_comps}건` : ''}</small>
        </div>
        <div>
          <dt>중위 전세보증금</dt>
          <dd>{eok(u.med_jeonse)}</dd>
          <small>최근 2년 {u.n_jeonse_24m}건</small>
        </div>
        <div>
          <dt>중위 매매가</dt>
          <dd>{eok(u.med_sale)}</dd>
          <small>{u.n_sale_24m ? `최근 2년 ${u.n_sale_24m}건` : '사례 없음'}</small>
        </div>
        <div>
          <dt>갱신 시 보증금</dt>
          <dd className={u.renew_hike != null && u.renew_hike < -0.05 ? 'serious' : ''}>
            {signed(u.renew_hike)}
          </dd>
          <small>{u.renew_hike == null ? '갱신 신고 없음' : '직전 계약 대비 중위'}</small>
        </div>
      </dl>

      {ratioBroken(u.ratio) && (
        <p className="warnline">
          <strong className="serious">비교 기준이 정상이 아닙니다.</strong> 계산하면
          {' '}{pct0(u.ratio)}가 나오는데, 이런 값은 전세가율이 높다기보다 비교에 쓴 매매가가
          이 집의 시세가 아니라는 뜻입니다{u.n_sale_24m === 1 ? ' (매매 단 1건 기준)' : ''}.
          지분 거래나 특수관계인 거래가 섞였을 수 있습니다. 등기부등본으로 직접 확인하세요.
        </p>
      )}
      {!ratioBroken(u.ratio) && !st.exact && u.ratio != null && (
        <p className="warnline">
          이 건물의 매매 사례가 없어 <strong>같은 동의 비슷한 물건{u.stage === 'B' ? '·연식' : ''}</strong>과
          비교한 참고치입니다. 개별 물건의 실제 담보 가치와 다를 수 있습니다.
        </p>
      )}
      {u.direct_share > 0 && (
        <p className="warnline">
          최근 매매 중 <strong>직거래 {pct0(u.direct_share)}</strong>. 특수관계인 간 거래가 섞이면
          시세가 실제보다 낮거나 높게 잡힙니다.
        </p>
      )}
      {u.n_wolse_24m > 0 && (
        <p className="muted-line">최근 2년 월세 계약 {u.n_wolse_24m}건 (전세 {u.n_jeonse_24m}건)</p>
      )}

      <BuildingFacts u={u} />

      {/* 좌표가 있는 물건에서만 낸다. 눌렀는데 아무 데도 안 가면 안 만든 것만 못하다. */}
      {onMap && <button className="more" onClick={onMap}>지도에서 위치 보기</button>}
    </div>
  )
}

const PAGE = 80

/**
 * 필터. 목록을 훑는 것보다 조건으로 좁히는 게 실제 쓰임에 가깝다
 * ("우리 동네에서 매매 사례 없는 빌라").
 */
const FILTERS = [
  { key: 'confirmed', label: '확인된 깡통',
    hint: '그 건물 매매 3건 이상 기준으로 보증금이 매매가를 넘음',
    test: (u) => u.stage === 'A' && u.n_sale_24m >= 3 && u.ratio >= 1 },
  { key: 'high', label: '전세가율 90%↑',
    hint: '근거 단계와 무관하게 90% 이상',
    test: (u) => u.ratio >= 0.9 },
  { key: 'nosale', label: '매매 0건',
    hint: '최근 2년 이 건물 매매 신고가 없어 담보 가치 검증 불가',
    test: (u) => !u.n_sale_24m },
  { key: 'reverse', label: '역전세',
    hint: '갱신 계약에서 보증금이 5% 이상 내려감',
    test: (u) => u.renew_hike != null && u.renew_hike <= -0.05 },
]

export default function UnitLookup({ lawdCd, guName, housing }) {
  const [state, setState] = useState({ status: 'idle' })
  const [q, setQ] = useState('')
  // 펼친 물건의 id만 들고 있는다. 상세를 목록 위에 띄우면 아래쪽 물건을 눌렀을 때
  // 화면 밖에서 열려서 스크롤을 되감아야 한다. 누른 줄 바로 아래에 펼친다.
  const [selId, setSelId] = useState(null)
  const [limit, setLimit] = useState(PAGE)
  const [active, setActive] = useState([])   // 켜진 필터 키
  const [umd, setUmd] = useState('')         // 법정동

  useEffect(() => {
    setSelId(null)
    setState({ status: 'loading' })
    fetch(`${import.meta.env.BASE_URL}data/units/${lawdCd}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        const idx = Object.fromEntries(d.cols.map((c, i) => [c, i]))
        const rows = d.rows.map((r) => Object.fromEntries(d.cols.map((c, i) => [c, r[i]])))
        setState({ status: 'ready', rows, window: d.window, hasHt: d.cols.includes('ht') })
      })
      .catch((e) => setState({ status: 'error', message: e.message }))
  }, [lawdCd])

  const list = useMemo(() => {
    if (state.status !== 'ready') return Object.assign([], { total: 0 })
    const needle = q.trim()
    // ht 없이 만들어진 예전 스냅샷이 배포에 실려도 빈 목록이 되지 않게 한다
    const wantHt = housing === '아파트' ? 'A' : 'R'
    const typed = state.hasHt ? state.rows.filter((r) => r.ht === wantHt) : state.rows
    const tests = FILTERS.filter((f) => active.includes(f.key)).map((f) => f.test)
    const rows = typed.filter((r) =>
      (!umd || r.umd === umd) &&
      tests.every((t) => t(r)) &&
      (!needle || r.name?.includes(needle) || r.umd?.includes(needle) || r.jibun?.includes(needle)))
    // 검색 전에는 위험한 것부터. 매매 사례가 없는 쪽이 먼저 온다.
    const out = [...rows].sort((a, b) => (needle
      ? (b.n_jeonse_24m ?? 0) - (a.n_jeonse_24m ?? 0)
      : riskScore(b) - riskScore(a)))
    return Object.assign(out, { total: typed.length })
  }, [state, q, housing, active, umd])

  // 조건이 바뀌면 다시 처음부터 보여준다
  useEffect(() => { setLimit(PAGE) }, [q, housing, lawdCd, active, umd])
  useEffect(() => { setActive([]); setUmd('') }, [lawdCd])

  // 목록 끝이 보이면 다음 묶음을 이어 붙인다. 전량은 이미 메모리에 있으므로
  // 네트워크 요청 없이 DOM 노드만 늘어난다.
  const sentinel = useRef(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || limit >= list.length) return
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && setLimit((n) => n + PAGE),
      { rootMargin: '400px' }
    )
    io.observe(node)
    return () => io.disconnect()
  }, [limit, list.length])

  const facets = useMemo(() => {
    if (state.status !== 'ready') return { umds: [], counts: {} }
    const wantHt = housing === '아파트' ? 'A' : 'R'
    const typed = state.hasHt ? state.rows.filter((r) => r.ht === wantHt) : state.rows
    const scoped = umd ? typed.filter((r) => r.umd === umd) : typed
    return {
      umds: [...new Set(typed.map((r) => r.umd))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko')),
      counts: Object.fromEntries(FILTERS.map((f) => [f.key, scoped.filter(f.test).length])),
    }
  }, [state, housing, umd])

  const toggle = useCallback((key) => {
    setActive((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
  }, [])

  if (state.status === 'error') {
    return (
      <section className="card">
        <h2>물건 조회</h2>
        <p className="sub">
          {state.message === '404'
            ? '물건 단위 데이터가 아직 배포에 포함되지 않았습니다. 수집 워크플로가 한 번 더 돌면 붙습니다.'
            : `불러오지 못했습니다 (${state.message})`}
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>{guName} 물건 조회</h2>
      <p className="sub">
        {housing} · 건물명·법정동·지번으로 검색. 최근 2년 전세 계약이 있는 물건만 있습니다
        {state.status === 'ready' ? ` (${list.total.toLocaleString()}개)` : ''}
      </p>
      <input className="search" type="search" value={q} placeholder="예: 화곡동, 우성테마빌"
             onChange={(e) => setQ(e.target.value)} aria-label="물건 검색" />

      {state.status === 'ready' && (
        <div className="filters">
          <select value={umd} onChange={(e) => setUmd(e.target.value)} aria-label="법정동">
            <option value="">법정동 전체</option>
            {facets.umds.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {FILTERS.map((f) => (
            <button key={f.key} className="chip" title={f.hint}
                    aria-pressed={active.includes(f.key)}
                    disabled={!facets.counts[f.key] && !active.includes(f.key)}
                    onClick={() => toggle(f.key)}>
              {f.label}<span className="n">{facets.counts[f.key]?.toLocaleString() ?? 0}</span>
            </button>
          ))}
          {(active.length > 0 || umd) && (
            <button className="chip clear" onClick={() => { setActive([]); setUmd('') }}>초기화</button>
          )}
        </div>
      )}

      {state.status === 'loading' && <p className="muted-line">불러오는 중…</p>}

      {state.status === 'ready' && (
        <>
          {!q && (
            <p className="muted-line">
              검색어가 없으면 위험 신호 순으로 보여줍니다. 그 건물 실거래로 확인된 건이 먼저,
              인근 기준 추정치가 다음, 매매 사례가 없어 검증이 불가한 건이 그다음입니다.
            </p>
          )}
          <ul className="unit-list">
            {list.slice(0, limit).map((u) => (
              <li key={u.id}>
                <button aria-expanded={selId === u.id}
                        onClick={() => setSelId((id) => (id === u.id ? null : u.id))}>
                  <span className="u-name">{u.name || '(이름 없음)'}</span>
                  <span className="u-meta">{u.umd} · 전용 {u.area}m²{u.build_year ? ` · ${u.build_year}년` : ''}</span>
                  <span className="u-sig">
                    <em className={ratioBroken(u.ratio) ? 'muted' : ratioTone(u.ratio)}>
                      {u.ratio == null ? '비교 불가'
                        : ratioBroken(u.ratio) ? '판단 보류'
                        : `${STAGE[u.stage]?.exact ? '' : '약 '}${pct0(u.ratio)}`}
                    </em>
                    <small className={!u.n_sale_24m ? 'critical' : u.n_sale_24m < 3 ? 'serious' : ''}>
                      {u.stage === 'A' ? `이 건물 매매 ${u.n_sale_24m}건` : `매매 ${u.n_sale_24m}건`}
                    </small>
                  </span>
                </button>
                {selId === u.id && <UnitCard u={u} onClose={() => setSelId(null)} />}
              </li>
            ))}
          </ul>
          {!list.length && (
            <p className="muted-line">
              조건에 맞는 물건이 없습니다.
              {(active.length > 0 || umd) && ' 필터를 줄여 보세요.'}
            </p>
          )}
          {limit < list.length && (
            <>
              <div ref={sentinel} aria-hidden="true" />
              <button className="more" onClick={() => setLimit((n) => n + PAGE)}>
                더 보기 ({list.length - limit}개 남음)
              </button>
            </>
          )}
          {list.length > 0 && (
            <p className="muted-line">
              {list.length.toLocaleString()}개 중 {Math.min(limit, list.length).toLocaleString()}개 표시
            </p>
          )}
        </>
      )}
    </section>
  )
}
