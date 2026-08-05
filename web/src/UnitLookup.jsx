import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const pct0 = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
const eok = (m) => (m == null ? '—' : m >= 10000 ? `${(m / 10000).toFixed(2)}억` : `${m.toLocaleString()}만`)

const STAGE = {
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

function ratioTone(ratio) {
  if (ratio == null) return 'muted'
  if (ratio >= 1) return 'critical'
  if (ratio >= 0.9) return 'serious'
  if (ratio >= 0.8) return 'warning'
  return 'good'
}

function UnitCard({ u, onClose }) {
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
          <dd className={`big ${ratioTone(u.ratio)}`}>
            {u.ratio == null ? '—' : st.exact ? pct0(u.ratio) : `약 ${pct0(u.ratio)}`}
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

      {!st.exact && u.ratio != null && (
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
    </div>
  )
}

const PAGE = 80

export default function UnitLookup({ lawdCd, guName, housing }) {
  const [state, setState] = useState({ status: 'idle' })
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => {
    setSel(null)
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
    const rows = needle
      ? typed.filter((r) => r.name?.includes(needle) || r.umd?.includes(needle) || r.jibun?.includes(needle))
      : typed
    // 검색 전에는 위험한 것부터. 매매 사례가 없는 쪽이 먼저 온다.
    const out = [...rows].sort((a, b) => (needle
      ? (b.n_jeonse_24m ?? 0) - (a.n_jeonse_24m ?? 0)
      : riskScore(b) - riskScore(a)))
    return Object.assign(out, { total: typed.length })
  }, [state, q, housing])

  // 조건이 바뀌면 다시 처음부터 보여준다
  useEffect(() => { setLimit(PAGE) }, [q, housing, lawdCd])

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

      {state.status === 'loading' && <p className="muted-line">불러오는 중…</p>}

      {sel && <UnitCard u={sel} onClose={() => setSel(null)} />}

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
                <button onClick={() => setSel(u)}>
                  <span className="u-name">{u.name || '(이름 없음)'}</span>
                  <span className="u-meta">{u.umd} · 전용 {u.area}m²{u.build_year ? ` · ${u.build_year}년` : ''}</span>
                  <span className="u-sig">
                    <em className={ratioTone(u.ratio)}>
                      {u.ratio == null ? '비교 불가' : `${STAGE[u.stage]?.exact ? '' : '약 '}${pct0(u.ratio)}`}
                    </em>
                    <small className={!u.n_sale_24m ? 'critical' : u.n_sale_24m < 3 ? 'serious' : ''}>
                      {u.stage === 'A' ? `이 건물 매매 ${u.n_sale_24m}건` : `매매 ${u.n_sale_24m}건`}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!list.length && <p className="muted-line">검색 결과가 없습니다.</p>}
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
