import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { bgNotifyEnabled, bgNotifySupported, disableBgNotify, enableBgNotify } from './guard-sync.js'
import MapView from './MapView.jsx'
import ContractPlan from './ContractPlan.jsx'
import { NoJeonseSig, UnitCard, questionsFor, ratioBroken, ratioTone } from './UnitLookup.jsx'
import { REGIONS, guardCalendar, guardSignals, htName, search, useCompare, useFinder, useGuard, useSubway, useUnitLoader, ym } from './units.js'
import { rowComment } from './rowcomment.js'

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

const eok = (m) => (m == null ? '-' : m >= 10000 ? `${(m / 10000).toFixed(2)}억` : `${m.toLocaleString()}만`)

/**
 * 우리가 못 보는 것들. 전세가율은 안전의 한 조각일 뿐이고, 사람을 실제로 다치게 하는
 * 대부분은 여기 있다. 못 본다고 입을 다물면 앱을 본 사람이 다 봤다고 착각한다.
 */


export default function Verify({ guNames, region = '11', onNearby }) {
  const fin = useFinder(region)
  const { byRow, byId } = useUnitLoader()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)     // {lawd, u} | {error}
  const compare = useCompare()
  const guard = useGuard()
  const [showCmp, setShowCmp] = useState(false)
  // 리포트 안의 위치 지도. 물건이 바뀌면 접는다 — 이전 물건 지도가 새 리포트에 남으면 오독한다.
  const [showMap, setShowMap] = useState(false)
  const stationPins = useSubway()
  useEffect(() => { setShowMap(false) }, [open?.u?.id])

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
    const pctOf = (v) => Math.round((1 - peers.filter((x) => x < v).length / peers.length) * 100)
    return { umd: u.umd, n: peers.length, pct: pctOf(u.med_jeonse), pctOf }
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

  /**
   * 리포트로 데려다 주는 스크롤.
   *
   * 지킴이 패널과 비교함은 리포트보다 위에 있고 리포트는 그 아래에 그려진다.
   * 그래서 "물건 상세 보기"를 눌러도 화면 밖에서 열려서, 아무 일도 일어나지
   * 않은 것처럼 보인다. 데려다 주는 동작 자체는 필요하다.
   *
   * 예전에는 창 맨 위로 보냈는데(scrollTo top) 그건 리포트 자리가 아니다.
   * 지킴이를 등록한 사람에게는 앱 머리와 지킴이 패널이 맨 위라, 상세를 누르면
   * 보고 싶은 것과 반대 방향으로 끌려 올라갔다. 리포트 자리로 간다.
   *
   * 물건 id가 아니라 tick으로 도는 이유: 이미 열려 있는 물건을 패널에서 다시
   * 누르면 id가 그대로라 효과가 안 돌고, 그때도 데려다 줘야 한다.
   */
  const reportRef = useRef(null)
  const [jumpTick, setJumpTick] = useState(0)
  const jump = useCallback(() => setJumpTick((n) => n + 1), [])
  useEffect(() => {
    if (!jumpTick || !reportRef.current) return
    // 애니메이션을 끈 사람에게는 미끄러지는 화면이 멀미가 된다
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    reportRef.current.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  }, [jumpTick])

  // 지킴이 패널은 등록된 계약의 구 파일만 읽으므로 지역 토글의 로드 상태와
  // 무관하다. 경기 수집이 안 끝났다고 서울 계약의 감시가 사라지면 안 된다.
  const guardPanel = guard.items.length > 0 && (
    <GuardPanel guard={guard} byId={byId}
                onOpen={(lawd, u) => {
                  setOpen({ lawd, u })
                  history.pushState(null, '', `?u=${lawd}.${u.id}`)
                  jump()
                }} />
  )

  if (fin.status === 'pending') {
    return (
      <>
      {guardPanel}
      <section className="card">
        <h2>계약 전 확인</h2>
        <p className="sub">
          {REGIONS[region]} 실거래 데이터를 수집하고 있습니다. 수집이 끝나면 이 화면에서
          바로 검색하실 수 있습니다.
        </p>
      </section>
      </>
    )
  }
  if (fin.status === 'error') {
    return (
      <>
      {guardPanel}
      <section className="card">
        <h2>계약 전 확인</h2>
        <p className="sub">데이터를 불러오지 못했습니다 ({fin.message})</p>
      </section>
      </>
    )
  }

  const { col, d } = fin
  return (
    <>
    {guardPanel}
    <section className="card">
      <h2>계약 전 확인</h2>
      <p className="sub">
        보고 온 집의 주소나 건물명을 넣으세요. 국토교통부 실거래가로 그 건물을 확인해 드립니다
        {fin.status === 'ready' && ` · ${ym(fin.d.window[0])}~${ym(fin.d.window[1])} 신고분`}
      </p>

      <input className="search" type="search" value={q} autoComplete="off"
             placeholder="예: 화곡동 871-8 · 엔에스월드타워"
             onChange={(e) => setQ(e.target.value)} aria-label="주소 또는 건물명" />

      {/* 임장 진입. 탭바 여섯 칸을 셋으로 줄이면서 이 자리로 왔다. 주소를 아는
          사람은 위에 치고, 이미 그 골목에 서 있는 사람은 여기로 들어간다.
          둘 다 "이 건물이 위험한가"를 묻는 같은 일이다. */}
      {onNearby && !q.trim() && (
        <button className="nearby-entry" onClick={onNearby}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
               strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-6.5-5.2-6.5-10A6.5 6.5 0 0 1 12 4.5 6.5 6.5 0 0 1 18.5 11c0 4.8-6.5 10-6.5 10z M12 13a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z" />
          </svg>
          주소를 모르시면 <b>내 주변에서 찾기</b>
        </button>
      )}

      {compare.items.length > 0 && (
        <div className="cmp-bar">
          <button onClick={() => setShowCmp((v) => !v)} aria-expanded={showCmp}>
            비교함 {compare.items.length}개 {showCmp ? '접기' : '나란히 보기'}
          </button>
          <button className="cmp-clear" onClick={() => { compare.clear(); setShowCmp(false) }}>비우기</button>
        </div>
      )}
      {showCmp && compare.items.length > 0 && (
        <ComparePanel compare={compare} byId={byId}
                      onOpen={(lawd, u) => {
                        setShowCmp(false)
                        setOpen({ lawd, u })
                        history.pushState(null, '', `?u=${lawd}.${u.id}`)
                        jump()
                      }} />
      )}

      {fin.status !== 'ready' && <p className="muted-line">불러오는 중…</p>}

      {open?.error && <p className="muted-line critical">{open.error}</p>}

      {open?.u && (
        <>
          {/* 스크롤 도착점. 리포트 카드 자체에 ref를 걸면 UnitCard가 ref를
              넘겨받아야 하므로, 높이 0짜리 표식을 바로 앞에 둔다. */}
          <div ref={reportRef} aria-hidden="true" />
          <UnitCard u={open.u} lawd={open.lawd} guNames={guNames} onClose={close} rank={rank}
                    compare={compare} guard={guard} pctOf={rank?.pctOf}
                    onMap={open.u.lat != null ? () => setShowMap((v) => !v) : null}
                    onSibling={(id) => byId(open.lawd, id).then((v) => {
                      if (!v) return
                      setOpen({ lawd: open.lawd, u: v })
                      history.pushState(null, '', `?u=${open.lawd}.${id}`)
                      jump()
                    })} />
          {showMap && open.u.lat != null && (
            <MapView points={[{
                       lat: open.u.lat, lon: open.u.lon, tone: ratioTone(open.u.ratio),
                       // 전세 없는 물건에서 '-'로 두면 보증금이 0원처럼 읽힌다
                       label: `${open.u.name || '(이름 없음)'} · ${open.u.med_jeonse != null ? eok(open.u.med_jeonse) : '전세 신고 없음'}`,
                     }]}
                     stations={stationPins} note="파란 점은 지하철역입니다" />
          )}
        </>
      )}

      {fin.status === 'ready' && !open && (
        q.trim().length < 2 ? (
          <p className="muted-line">
            위 기간에 전세·매매·월세 신고가 있었던 {REGIONS[region]} 전체 {d.n.toLocaleString()}개 건물을
            담고 있습니다. 시군구를 고르실 필요 없습니다. 신고 기한이 계약일로부터 30일이라 최근
            두 달치는 아직 절반도 안 들어와서, 그 구간은 빼고 셉니다.
          </p>
        ) : hits.idx.length ? (
          <>
          {hits.areaNote && (
            <p className="muted-line">
              {hits.areaNote.words.join('·')} 생활권({hits.areaNote.umds.join('·')})
              전체의 결과입니다. 신도시는 법정동 이름과 달라서 권역으로 함께 찾아드립니다.
            </p>
          )}
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
                    {' · '}{htName(col.ht[i])} 전용 {col.area[i]}m²
                  </span>
                  <span className="u-sig">
                    {col.jeonse[i] == null ? <NoJeonseSig ns={col.ns[i]} nw={col.nw[i]} sale={col.sale[i]} /> : (
                      <>
                        <em>{eok(col.jeonse[i])}</em>
                        <small>전세 {col.nj[i]}건</small>
                      </>
                    )}
                  </span>
                  {(() => {
                    const c = rowComment({ stage: d.stages[col.stage[i]], ht: col.ht[i], ns: col.ns[i],
                      nj: col.nj[i], ratio: col.ratio[i], by: col.apr[i] ?? col.by[i], hike: col.hike[i] })
                    return c && <span className="u-note">{c}</span>
                  })()}
                </button>
              </li>
            ))}
          </ul>
          </>
        ) : (
          <NoHit fin={fin} query={dq} region={region} />
        )
      )}
    </section>

    {/* 검증을 마치고 계약을 결정한 사람의 다음 단계. 검색보다 아래가 맞다. */}
    <ContractPlan />
    </>
  )
}

/**
 * 보증금 지킴이 패널. 등록된 계약이 있을 때만, 검색창보다 먼저 보인다.
 * 계약한 사람에게는 "새로 확인할 것"이 검색보다 앞선 관심사다.
 */
/**
 * 백그라운드 알림 토글. 서버 없이 설치형 PWA의 주기 동기화로 동작하므로
 * "기기에만 저장" 약속이 그대로 유지된다. 안드로이드 크롬 설치형에서만
 * 켜지고, 아이폰은 웹푸시(서버)가 필요해 다음 단계다.
 */
function GuardNotifyToggle() {
  const [state, setState] = useState(() =>
    !bgNotifySupported() ? 'unsupported' : bgNotifyEnabled() ? 'on' : 'off')
  if (state === 'unsupported') {
    return (
      <p className="muted-line">
        앱을 열지 않아도 만기·위험 신호를 알려드리는 백그라운드 알림은
        안드로이드 크롬에서 홈 화면에 설치하면 켤 수 있습니다. 아이폰 알림은 준비 중입니다.
      </p>
    )
  }
  if (state === 'on') {
    return (
      <p className="muted-line">
        백그라운드 알림이 켜져 있습니다. 앱을 열지 않아도 만기 일정과 위험 신호를 알려드립니다.{' '}
        <button className="about-link" onClick={() => disableBgNotify().then(() => setState('off'))}>끄기</button>
      </p>
    )
  }
  return (
    <>
      <button className="cmp-btn" onClick={() =>
        enableBgNotify().then((ok) => setState(ok ? 'on' : 'failed'))}>
        + 백그라운드 알림 켜기
      </button>
      {state === 'failed' && (
        <p className="muted-line">
          알림을 켜지 못했습니다. 홈 화면에 설치된 상태에서 알림 권한을 허용해야 켜집니다.
        </p>
      )}
    </>
  )
}

function GuardPanel({ guard, byId, onOpen }) {
  const [details, setDetails] = useState({})
  useEffect(() => {
    for (const it of guard.items) {
      if (details[it.id] !== undefined) continue
      byId(it.lawd, it.id)
        .then((u) => setDetails((prev) => ({ ...prev, [it.id]: u ?? { missing: true } })))
        // 네트워크 실패를 missing으로 오진하면 "데이터 개편" 안내가 거짓말이 된다
        .catch(() => setDetails((prev) => ({ ...prev, [it.id]: { offline: true } })))
    }
    // details는 의도적으로 의존성에서 뺀다. effect가 재렌더 뒤에 실행되어 최신
    // 값을 닫아 오므로 중복 요청은 없고, 넣으면 setDetails마다 재실행된다.
  }, [guard.items])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <h2>보증금 지킴이</h2>
      <p className="sub">
        등록하신 계약의 건물을 데이터가 갱신될 때마다 다시 봅니다
      </p>
      <ul className="guard-list">
        {guard.items.map((it) => (
          <GuardItem key={it.id} it={it} u={details[it.id]} onOpen={onOpen}
                     onRemove={() => guard.remove(it.id)} />
        ))}
      </ul>
      <GuardNotifyToggle />
    </section>
  )
}

/**
 * 감시할 재료가 있는 물건인가. guardSignals의 네 신호는 전세 거래 내역이나
 * 매매 중위값 중 하나는 있어야 돌아간다. 둘 다 없으면 신호 0건이 나오는데,
 * 그건 "재 봤더니 괜찮다"가 아니라 "잴 것이 없었다"이다.
 *
 * 데이터셋이 매매·월세만 신고된 건물까지 담게 되면서 처음 도달 가능해진
 * 상태다. 예전에는 상세를 열 수 있는 건물이 전부 전세를 가지고 있었다.
 * 지킴이는 계약한 사람이 2년을 믿고 맡기는 화면이라 여기서의 거짓 초록이
 * 이 앱에서 가장 비싼 거짓말이다.
 */
const guardWatchable = (u) => !!(u?.deals?.j?.length || u?.n_sale_24m)

/** 접힌 줄에 띄울 상태 하나. 위험한 것부터 잡는다. */
function guardStatus(u, sigs, cal) {
  if (u === undefined) return { tone: 'muted', label: '확인 중' }
  // 오프라인은 위험이 아니라 연결 문제다. 경고색을 쓰면 톤이 거짓말을 한다.
  if (u.offline) return { tone: 'muted', label: '연결 없음' }
  if (u.missing) return { tone: 'serious', label: '확인 필요' }
  if (sigs.length) {
    // 만기 지남(critical 캘린더)이 신호와 겹치면 칩도 최악값을 따른다
    const critical = sigs.some((s) => s.tone === 'critical') || cal?.tone === 'critical'
    return { tone: critical ? 'critical' : 'serious', label: `신호 ${sigs.length}건` }
  }
  if (cal && cal.tone !== 'muted') {
    return { tone: cal.tone, label: cal.d < 0 ? '만기 지남' : `만기 D-${cal.d}` }
  }
  if (!guardWatchable(u)) return { tone: 'muted', label: '잴 자료 없음' }
  return { tone: 'good', label: '이상 없음' }
}

/**
 * 지킴이 한 물건. 항상 한 줄 요약으로 접혀서 시작한다. 위험은 상태 칩의 색과
 * 글로 접힌 줄에서도 보이므로, 설명 전문이 화면을 점령할 이유가 없다.
 */
function GuardItem({ it, u, onOpen, onRemove }) {
  const cal = guardCalendar(it.expiry)
  const sigs = u && !u.missing && !u.offline ? guardSignals(u, it) : []
  const st = guardStatus(u, sigs, cal)
  const [open, setOpen] = useState(false)
  return (
    <li className="guard-item">
      <button className="guard-sum" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`guard-chip ${st.tone}`}>{st.label}</span>
        <span className="guard-name">
          {it.name}
          {/* '보증금' 라벨을 뗐다. 카드 이름이 보증금 지킴이이고 줄에 금액이
              하나뿐이라 중복인데, 그 세 글자 때문에 부제가 두 줄로 밀렸다.
              '전용'은 남긴다 - 전용면적과 공급면적을 뭉개면 안 된다. */}
          <small>{it.umd} · 전용 {it.area}m² · {it.deposit >= 10000
            ? `${(it.deposit / 10000).toFixed(1)}억` : `${it.deposit.toLocaleString()}만`}</small>
        </span>
        <span className="guard-arrow" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="guard-body">
          {u?.missing && (
            <div className="verdict serious">
              <strong>이 물건을 데이터에서 찾지 못했습니다</strong>
              <span>데이터 개편으로 식별자가 바뀌었을 수 있습니다. 해제 후 다시 검색해 등록해 주세요.</span>
            </div>
          )}
          {u?.offline && (
            <div className="verdict muted">
              <strong>데이터를 불러오지 못했습니다</strong>
              <span>네트워크 연결을 확인하고 새로고침해 주세요. 등록은 그대로 유지됩니다.</span>
            </div>
          )}
          {u && !u.missing && !u.offline && sigs.length === 0 && (
            guardWatchable(u) ? (
              <div className="verdict good">
                <strong>등록 이후 새 위험 신호가 없습니다</strong>
                <span>실거래 데이터는 매주 화요일 갱신됩니다. 갱신될 때마다 이 화면이 다시 확인합니다.</span>
              </div>
            ) : (
              <div className="verdict muted">
                <strong>이 건물은 최근 2년 전세·매매 신고가 없습니다</strong>
                <span>
                  신규 전세가 내 보증금 아래로 내려가는지, 매매가가 보증금에 못 미치는지를
                  볼 자료가 아직 없습니다. 신고가 들어오면 그때부터 확인해 드립니다.
                  만기 일정은 아래에서 계속 챙겨 드립니다.
                </span>
              </div>
            )
          )}
          {sigs.map((sg) => (
            <div key={sg.head} className={`verdict ${sg.tone}`}>
              <strong>{sg.head}</strong><span>{sg.body}</span>
            </div>
          ))}
          {cal && (
            <div className={`verdict ${cal.tone}`}>
              <strong>{cal.head}</strong><span>{cal.body}</span>
            </div>
          )}
          <div className="guard-actions">
            {u && !u.missing && !u.offline && (
              <button className="cmp-btn" onClick={() => onOpen(it.lawd, u)}>물건 상세 보기</button>
            )}
            <button className="cmp-del" onClick={onRemove}>등록 해제</button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * 임장 비교함. 주말에 보러 갈 집들을 나란히 놓고, 집마다 무엇을 물어봐야 하는지까지
 * 준비해 준다. 매물 앱은 찜 목록까지만 해 주고 "보러 가서 뭘 확인하나"는 안 해 준다.
 */
const cmpEok = (m) => (m == null ? '-' : m >= 10000 ? `${(m / 10000).toFixed(1)}억` : `${m.toLocaleString()}만`)

function ComparePanel({ compare, byId, onOpen }) {
  const [units, setUnits] = useState(null)
  useEffect(() => {
    let live = true
    Promise.all(compare.items.map((it) =>
      byId(it.lawd, it.id).then((u) => u && { lawd: it.lawd, u }).catch(() => null)))
      .then((xs) => live && setUnits(xs.filter(Boolean)))
    return () => { live = false }
  }, [compare.items, byId])

  if (!units) return <p className="muted-line">비교함 불러오는 중…</p>
  if (!units.length) return <p className="muted-line">담긴 물건을 찾지 못했습니다.</p>

  const TONE = { critical: '위험', serious: '주의', muted: '검증 불가', good: '확인됨' }
  const row = (label, render) => (
    <tr key={label}><th>{label}</th>{units.map(({ lawd, u }) => <td key={u.id}>{render(u, lawd)}</td>)}</tr>
  )
  return (
    <div className="cmp-panel">
      <div className="scroll-x">
        <table className="data cmp-table">
          <tbody>
            {row('물건', (u, lawd) => (
              <button className="cmp-open" onClick={() => onOpen(lawd, u)}>
                {u.name || u.jibun}<small>{u.umd} · {u.area}m²</small>
              </button>
            ))}
            {/* 나란히 놓인 표에서 '-'는 옆 칸의 '89%'와 견줘 "싸고 무난한 후보"로
                읽힌다. 전세가 없는 건물은 그 사실을 칸 안에 적는다. stage는 전세와
                무관하게 매겨지므로 근거 행도 함께 막아야 한다. 추정한 적이 없다. */}
            {row('전세가율', (u) => !u.n_jeonse_24m ? '전세 0건'
              : u.ratio == null ? '-'
              : ratioBroken(u.ratio) ? '판단 보류' : `${Math.round(u.ratio * 100)}%`)}
            {row('근거', (u) => !u.n_jeonse_24m ? '전세 신고 없음'
              : u.stage === 'A' ? `이 건물 매매 ${u.n_sale_24m}건` : '인근 추정')}
            {row('중위 전세', (u) => !u.n_jeonse_24m ? '전세 0건' : cmpEok(u.med_jeonse))}
            {row('최근 전세', (u) => {
              const r = u.deals?.j?.[0]
              return r ? `${String(r[0]).slice(2, 4)}.${String(r[0]).slice(4, 6)} ${cmpEok(r[1])}` : '-'
            })}
            {row('갱신 변화', (u) => u.renew_hike == null ? '-'
              : `${u.renew_hike > 0 ? '+' : ''}${(u.renew_hike * 100).toFixed(1)}%`)}
            {row('', (u, lawd) => (
              <button className="cmp-del" onClick={() => compare.toggle(lawd, u.id, u.name)}>빼기</button>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="facts-h">집마다 물어볼 것</h3>
      {units.map(({ u }) => (
        <div key={u.id} className="cmp-q">
          <b>{u.name || u.jibun}</b>
          <ol>{questionsFor(u).map((q, i) => <li key={i}>{q}</li>)}</ol>
        </div>
      ))}
    </div>
  )
}

/**
 * 검색 0건은 조작 실수가 아니라 판정일 수 있다. 이 데이터셋은 최근 2년에 전세·매매·월세
 * 중 하나라도 신고가 있었던 건물을 담으므로, "여기 없다"는 그 건물에 최근 2년 실거래
 * 신고가 한 건도 없었다는 뜻이다. 신축이거나 거래가 멈춘 건물이라는 얘기이고, 그건 이
 * 앱이 최고 위험 신호로 잡는 패턴(신축·매매 0건·전세만 다수)의 바로 앞 단계다.
 * 침묵하면 안 되는 순간이다.
 */
function NoHit({ fin, query, region }) {
  // 질의에 들어 있는 법정동을 찾는다. 있으면 그 동의 기준선을 대신 내 준다.
  // 동 찾기는 1천 개짜리 목록이고 통계는 32만 행 전수라, 둘을 한 메모에 묶으면
  // 오타를 치는 동안 같은 동을 매번 다시 센다. 통계는 동이 바뀔 때만 돈다.
  const ui = useMemo(() => {
    const q = query.replace(/\s+/g, '')
    for (let k = 0; k < fin.d.umds.length; k++) {
      const u = fin.d.umds[k]
      if (u && u.length >= 2 && q.includes(u)) return k
    }
    return -1
  }, [fin, query])

  const info = useMemo(() => {
    const { col, d } = fin
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
    // 중위 보증금은 전세가 있는 물건만으로 낸다. 전세 없는 건물이 섞인 뒤로는
    // 분모가 다르므로 표본 수를 함께 밝힌다.
    return { umd: d.umds[ui], n, noSale, nJeonse: deps.length,
             med: deps.length ? deps[Math.floor(deps.length / 2)] : null }
  }, [fin, ui])

  /**
   * 동을 못 찾은 경우다. 전에는 "최근 2년 실거래 신고가 한 건도 없던 건물은
   * 여기에 없습니다"라고 적었는데, 이 앱에서 신고 0건은 위험 신호의 앞 단계라
   * 지역을 잘못 고른 사람에게 그 문장을 내는 것은 틀린 경보였다.
   *
   * 그다음엔 ui < 0으로 원인을 갈라 보려 했는데 그것도 틀렸다. ui < 0은
   * "질의에 이 지역 법정동 이름이 안 들어 있다"는 뜻이지 "이 지역에 그 동이
   * 없다"가 아니고, 동 꼴 토큰을 정규식으로 잡으면 법정동을 안 품은 건물명
   * 115,255개 중 11.6%가 걸린다(도시빌리지·글로리아파크처럼 이름 안쪽이 걸린다).
   * 경계를 붙여 6.2%로 줄이면 이번엔 신문로2가·명륜3가 같은 숫자 낀 법정동
   * 35개를 놓친다. 어느 쪽으로 잘라도 누군가에게 틀린 길을 가리킨다.
   *
   * 그래서 가르지 않는다. 두 원인을 다 적고 사용자가 고르게 한다.
   */
  if (!info) {
    return (
      <p className="muted-line">
        찾지 못했습니다. 지금 <strong>{REGIONS[region]}</strong> 물건만 보고 있으니,
        다른 지역이시면 위 지역 단추를 바꿔 주세요. 지역이 맞다면 건물명 대신{' '}
        <strong>법정동 + 지번</strong>으로 넣어 보세요 (예: 화곡동 871-8).
      </p>
    )
  }

  return (
    <div className="nohit">
      <p>
        <strong>이 데이터에서 그 지번을 찾지 못했습니다.</strong> 최근 2년 전세·매매·월세
        신고가 모두 없거나, 단독·다가구주택이라 수집 범위 밖일 수 있습니다. 어느
        쪽이든 시세를 견줄 실거래가 없다는 뜻이라, 아래를 직접 확인하셔야 합니다.
      </p>
      <p className="muted-line">
        참고로 {info.umd}에는 실거래 신고가 있는 물건 {info.n.toLocaleString()}개가 있고,
        그중 {Math.round((info.noSale / info.n) * 100)}%는 매매 사례가 없습니다.
        {info.med != null && ` 그중 전세가 있는 ${info.nJeonse.toLocaleString()}개 기준으로 동 중위 보증금은 ${eok(info.med)}입니다.`}
        {' '}지번을 다시 확인하시려면 번지 앞부분만 넣어 보세요.
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
