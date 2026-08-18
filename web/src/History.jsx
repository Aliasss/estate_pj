import { useMemo, useState } from 'react'
import MapView from './MapView.jsx'
import {
  guardCalendar, historyStats, htName, isHome, meters, monthsBetween, monthsText,
  search, useFinder, useGuard, useHistory, wonText,
} from './units.js'

/**
 * 살아온 집. 지킴이가 "감시 중인 계약"이라면 이쪽은 "살아온 기록"이다.
 *
 * 이 화면이 지키는 것 하나. **우리 데이터에 없는 집도 담긴다.** 재건축으로
 * 사라진 건물, 수집 시작(2021년 8월) 이전 거주지, 단독·다가구가 전부 여기
 * 걸린다. 그래서 검색으로 찾으면 좌표와 유형을 붙이고, 못 찾으면 동 이름으로
 * 대략의 위치를 잡는다. 그것도 안 되면 좌표 없이 기록만 남긴다. 어느 쪽이든
 * 이름은 사용자가 기억하는 대로 적는다.
 *
 * 하지 않는 것도 분명하다. 그때와 지금의 시세를 나란히 놓지 않는다. 지나간
 * 집에 위험 판정을 소급하지 않는다. 둘 다 후회를 파는 일이고, 이 서비스가
 * 팔지 않기로 한 것이다.
 */

const KINDS = [['j', '전세'], ['w', '월세'], ['o', '자가'], ['e', '기타']]
const kindName = (k) => (KINDS.find((x) => x[0] === k) || [])[1] || null

// toISOString은 UTC라, KST 기준 매월 1일 새벽에는 지난달이 나온다. 그 시간대에
// 이번 달 입주를 못 고르게 된다. 달력은 사용자의 시계로 읽는다.
const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const ymText = (s) => (s ? `${s.slice(0, 4)}.${s.slice(5, 7)}` : '-')

/**
 * 동 이름으로 대략의 위치를 잡는다.
 *
 * 세 가지를 조심한다.
 *   - 같은 동 이름이 여러 시군구에 있다. 서울 5개, 경기 37개다. 구 이름을 함께
 *     적었으면 그 구로 좁히고, 못 좁혔으면 그렇다고 알린다. 초안은 첫 번째를
 *     조용히 집어서 강남구 신사동을 은평구 좌표로(13km) 저장했다.
 *   - 경기 법정동은 "팽성읍 안정리"처럼 공백을 품는다(1,030개 중 543개).
 *     공백으로 잘라 한 토큰만 보면 이 이름들이 통째로 안 잡힌다.
 *   - 위도·경도 중앙값을 따로 뽑아 짝지은 점은 실제 물건이 아니다. 동이 오목하면
 *     동 밖으로 나갈 수 있다. 그 점에 가장 가까운 실제 물건 자리로 옮겨서,
 *     적어도 그 동에 있는 집 한 곳의 위치가 되게 한다.
 */
function umdCenter(fin, text, guNames) {
  if (fin.status !== 'ready') return { err: 'loading' }
  const t = (text || '').trim()
  if (!t) return { err: 'empty' }
  const { d, col } = fin

  // 입력 문자열에 통째로 들어 있는 법정동 이름 중 가장 긴 것을 쓴다.
  let name = null
  for (const nm of d.umds) {
    if (nm && t.includes(nm) && (!name || nm.length > name.length)) name = nm
  }
  if (!name) return { err: 'noumd' }
  const ui = d.umds.indexOf(name)

  // 구·시 이름이 함께 적혀 있으면 그쪽으로 좁힌다.
  let gset = null
  for (const [lawd, full] of Object.entries(guNames || {})) {
    const last = full.split(' ').at(-1)
    if (!t.includes(full) && !t.includes(last)) continue
    const k = d.gus.indexOf(lawd)
    if (k >= 0) (gset ??= new Set()).add(k)
  }

  const pts = []
  for (let i = 0; i < d.n; i++) {
    if (col.u[i] !== ui || col.lat[i] == null) continue
    if (gset && !gset.has(col.g[i])) continue
    pts.push([col.lat[i], col.lon[i], col.g[i]])
  }
  if (!pts.length) return { err: 'nogeo' }

  const mid = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
  const ml = mid(pts.map((p) => p[0])), mo = mid(pts.map((p) => p[1]))
  let best = pts[0], bd = Infinity
  for (const p of pts) {
    const dd = meters(ml, mo, p[0], p[1])
    if (dd < bd) { bd = dd; best = p }
  }
  const gus = [...new Set(pts.map((p) => p[2]))]
  return {
    lat: best[0], lon: best[1], umd: name,
    gu: guNames?.[d.gus[best[2]]] || null,
    // 좁히지 못한 채 여러 구에 걸쳐 있으면 고른 좌표가 다른 구일 수 있다.
    ambiguous: gus.length > 1,
  }
}

const UMD_ERR = {
  loading: '자료를 아직 불러오는 중입니다. 잠시 뒤에 다시 눌러 주세요.',
  empty: '동 이름을 먼저 적어 주세요.',
  noumd: '적으신 곳에서 법정동 이름을 찾지 못했습니다. "둔촌동"처럼 동·읍·면 이름을 넣어 주세요.',
  nogeo: '그 동에서 위치를 아는 물건이 아직 없습니다. 좌표 없이 기록만 남기셔도 됩니다.',
}

/** 등록·수정 폼. 검색으로 고르거나, 못 찾으면 직접 적는다. */
function HomeForm({ region, guNames, init, onSave, onCancel }) {
  // finder는 3MB대다. 기록만 보러 온 사람이 받지 않도록 폼에서만 연다.
  const fin = useFinder(region)
  const [f, setF] = useState(init)
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }))

  const hits = useMemo(() => {
    if (fin.status !== 'ready' || q.trim().length < 2) return []
    const { idx } = search(fin, q, 24)
    const { col, d } = fin
    const seen = new Set()
    const out = []
    // 같은 건물의 평형이 여럿이면 목록이 같은 줄로 채워진다. 실측으로 여덟 칸
    // 중 여섯을 한 건물이 먹었다. 건물 단위로 접고 면적을 함께 적는다.
    for (const i of idx) {
      const key = `${col.g[i]}/${col.u[i]}/${col.jibun[i]}/${col.name[i]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        i, name: col.name[i] || `(${col.jibun[i]})`,
        umd: d.umds[col.u[i]] || '', jibun: col.jibun[i] || '',
        ht: col.ht[i], area: col.area[i],
        lat: col.lat[i], lon: col.lon[i], lawd: d.gus[col.g[i]],
      })
      if (out.length >= 8) break
    }
    return out
  }, [fin, q])

  const pick = (h) => {
    setF((p) => ({
      ...p,
      name: p.name || h.name,
      addr: `${h.umd} ${h.jibun}`.trim(),
      ht: h.ht, lat: h.lat ?? null, lon: h.lon ?? null,
      // 나중에 우리 데이터를 붙일 때 좌표로 되짚지 않아도 되게 남긴다.
      lawd: h.lawd, unitId: String(h.i),
      approx: false,
    }))
    setQ('')
    setNote(h.lat == null ? '이 건물은 아직 좌표가 없어 지도에는 안 나옵니다.' : '')
  }

  const useUmd = () => {
    const c = umdCenter(fin, q || f.addr, guNames)
    if (c.err) { setNote(UMD_ERR[c.err]); return }
    setF((p) => ({
      ...p, addr: p.addr || (c.gu ? `${c.gu} ${c.umd}` : c.umd),
      lat: c.lat, lon: c.lon, lawd: null, unitId: null, approx: true,
    }))
    setQ('')
    setNote(c.ambiguous
      ? `${c.umd}은 여러 시군구에 있습니다. ${c.gu || '한 곳'} 기준으로 잡았으니, 다른 곳이면 주소에 구 이름을 함께 적고 다시 눌러 주세요.`
      : '')
  }

  const badRange = !!(f.from && f.to && f.to < f.from)
  const ok = !!(f.name.trim() && f.from && !badRange)
  const living = !f.to

  return (
    <div className="card hist-form">
      <h3>{init.id ? '기록 고치기' : '살던 집 추가'}</h3>

      <label className="hist-field">
        <span>집을 찾아보기</span>
        <input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="건물명 또는 주소 (예: 둔촌동 633)" />
      </label>
      {q.trim().length >= 2 && (
        <div className="hist-hits">
          {fin.status === 'loading' && <p className="muted-line">자료를 불러오는 중입니다.</p>}
          {fin.status === 'pending' && (
            <p className="muted-line">이 지역은 아직 수집 중이라 검색되지 않습니다. 이름과 기간만 적으셔도 됩니다.</p>
          )}
          {fin.status === 'error' && <p className="muted-line">자료를 불러오지 못했습니다.</p>}
          {fin.status === 'ready' && !hits.length && (
            <p className="muted-line">
              찾지 못했습니다. 위 지역 단추가 {region === '11' ? '서울' : '경기'}로 되어 있으니,
              다른 지역이면 바꾸고 다시 찾아 주세요.
            </p>
          )}
          {hits.map((h) => (
            <button key={h.i} onClick={() => pick(h)}>
              <b>{h.name}</b>
              <small>
                {[h.umd, h.jibun].filter(Boolean).join(' ')} · {htName(h.ht)}
                {h.area ? ` · 전용 ${h.area}m²` : ''}
              </small>
            </button>
          ))}
          {/* 재건축으로 사라졌거나 수집 시작 전에 살던 집은 여기서 안 나온다.
              그때 동 이름만으로라도 지도에 올릴 수 있게 둔다. */}
          <button className="hist-approx" onClick={useUmd}>
            찾는 집이 없으신가요. <b>동 이름으로 대략 위치만</b> 잡습니다
          </button>
        </div>
      )}

      <label className="hist-field">
        <span>이름 (기억하시는 대로)</span>
        <input value={f.name} onChange={(e) => set('name', e.target.value)}
               placeholder="예: 둔촌주공 3단지" />
      </label>
      <label className="hist-field">
        <span>주소</span>
        <input value={f.addr} onChange={(e) => set('addr', e.target.value)}
               placeholder="예: 강동구 둔촌동" />
      </label>

      <div className="hist-row">
        <label className="hist-field">
          <span>살기 시작한 때</span>
          <input type="month" value={f.from} max={thisMonth()}
                 onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="hist-field">
          <span>나온 때 (지금 살면 비움)</span>
          <input type="month" value={f.to || ''} max={thisMonth()}
                 onChange={(e) => set('to', e.target.value)} />
        </label>
      </div>

      <div className="hist-row">
        <label className="hist-field">
          <span>계약 형태</span>
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </label>
        <label className="hist-field">
          <span>보증금 (만원, 안 적으셔도 됩니다)</span>
          <input inputMode="numeric" value={f.deposit ?? ''}
                 onChange={(e) => set('deposit', e.target.value.replace(/[^\d]/g, ''))} />
        </label>
      </div>

      {f.kind === 'w' && (
        <label className="hist-field">
          <span>월세 (만원)</span>
          <input inputMode="numeric" value={f.rent ?? ''}
                 onChange={(e) => set('rent', e.target.value.replace(/[^\d]/g, ''))} />
        </label>
      )}

      {living && (
        <label className="hist-field">
          <span>계약 만기 (적으시면 남은 기간을 알려 드립니다)</span>
          <input type="date" value={f.expiry || ''}
                 onChange={(e) => set('expiry', e.target.value)} />
        </label>
      )}

      <label className="hist-field">
        <span>기억해 둘 것</span>
        <textarea rows={2} value={f.memo} onChange={(e) => set('memo', e.target.value)}
                  placeholder="좋았던 것, 힘들었던 것. 다음 집을 고를 때 이 줄이 기준이 됩니다" />
      </label>

      {note && <p className="muted-line" role="status">{note}</p>}
      {f.lat != null && (
        <p className="muted-line">
          위치를 {f.approx ? '동 단위로 대략' : '지번까지'} 잡았습니다.
          {f.approx && ' 그 동에 있는 집 한 곳의 자리라, 정확한 위치는 아닙니다.'}
        </p>
      )}
      {badRange && <p className="warnline">나온 때가 살기 시작한 때보다 빠릅니다.</p>}

      <div className="hist-acts">
        <button className="hist-save" disabled={!ok} onClick={() => onSave(f)}>저장</button>
        <button className="cmp-del" onClick={onCancel}>취소</button>
      </div>
      {!ok && !badRange && <p className="muted-line">이름과 살기 시작한 때는 적어 주셔야 합니다.</p>}
    </div>
  )
}

const EMPTY = {
  name: '', addr: '', from: '', to: '', kind: 'j', deposit: '', rent: '',
  ht: null, lat: null, lon: null, lawd: null, unitId: null, approx: false,
  expiry: '', memo: '',
}

export default function History({ region = '11', guNames, onBack }) {
  const hist = useHistory()
  const guard = useGuard()
  const [form, setForm] = useState(null)
  const [view, setView] = useState('list')
  const [msg, setMsg] = useState('')

  // 최근에 산 집이 위로. 연표는 지금에서 과거로 읽는 것이 자연스럽다.
  const rows = useMemo(
    () => [...hist.items].sort((a, b) => (b.from || '').localeCompare(a.from || '')),
    [hist.items],
  )
  const stats = useMemo(() => historyStats(hist.items, meters), [hist.items])

  // 지도는 시간순이라야 궤적이 된다. 목록과 순서가 반대다.
  const points = useMemo(() => [...rows].reverse().filter((x) => x.lat != null)
    .map((x, k) => ({
      lat: x.lat, lon: x.lon, i: k,
      tone: x.to ? 'muted' : 'good',
      label: `${x.name} · ${ymText(x.from)}${x.to ? ` ~ ${ymText(x.to)}` : ' 지금'}`,
    })), [rows])

  const save = (f) => {
    const num = (v) => (v === '' || v == null ? null : Number(v))
    const rec = { ...f, deposit: num(f.deposit), rent: num(f.rent) }
    if (f.id) hist.update(f.id, rec)
    else hist.add(rec)
    setForm(null)
    setMsg('')
  }

  const del = (it) => {
    // 몇 년치 기록이 오탭 한 번에 사라지면 되돌릴 길이 없다.
    if (!confirm(`"${it.name}" 기록을 지울까요. 되돌릴 수 없습니다.`)) return
    hist.remove(it.id)
    setMsg('')
  }

  /**
   * 가져오기. 남이 만든 파일도, 손상된 파일도 들어올 수 있다. 초안은 id와 이름만
   * 보고 통과시켰는데, from이 숫자면 정렬에서 TypeError가 나면서 화면 전체가
   * 흰 페이지가 됐다. 게다가 저장이 먼저라 새로고침해도 그대로였다. 필드를
   * 하나씩 검사해 통과한 것만 받고, 버린 개수를 말한다.
   */
  const importJson = (file) => {
    const r = new FileReader()
    const fail = () => setMsg('이 파일에서는 기록을 읽지 못했습니다.')
    r.onload = () => {
      let got
      try { got = JSON.parse(r.result) } catch { fail(); return }
      if (!Array.isArray(got)) { fail(); return }
      const have = new Set(hist.items.map((x) => x.id))
      const good = got.filter(isHome)
      const add = good.filter((x) => !have.has(x.id))
      hist.replaceAll([...hist.items, ...add])
      const bad = got.length - good.length
      setMsg([
        add.length ? `${add.length}곳을 불러왔습니다.` : '새로 불러올 기록이 없습니다.',
        bad ? `${bad}건은 형식이 맞지 않아 넣지 않았습니다.` : '',
      ].filter(Boolean).join(' '))
    }
    r.onerror = fail
    r.readAsText(file)
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(hist.items, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `살아온집-${thisMonth()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setMsg('내려받은 파일에는 주소와 보증금이 그대로 들어 있습니다. 보관에 유의해 주세요.')
  }

  return (
    <section className="card">
      <div className="nb-head">
        <h2>살아온 집</h2>
        <button className="cmp-del" onClick={onBack}>닫기</button>
      </div>
      <p className="sub">
        살아오신 집들을 기록해 두는 곳입니다. 이 기기에만 저장되고 어디로도 보내지
        않습니다. 재건축으로 사라진 건물이나 오래전에 사시던 집처럼 저희 자료에 없는
        곳도 적으실 수 있습니다.
      </p>

      {guard.items.length > 0 && (
        <p className="muted-line">
          보증금 지킴이가 지켜보는 계약이 {guard.items.length}건 있습니다. 여기와 따로
          저장되니, 같은 집을 양쪽에 적으시면 보증금도 각각 관리됩니다. 계약 뒤의
          위험 신호는 지킴이 쪽에서만 알려 드립니다.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <ul className="facts hist-stats">
            <li><span>기록한 집</span><b>{stats.n}곳</b></li>
            <li><span>사신 기간 합계</span><b>{monthsText(stats.months)}</b></li>
            <li><span>이사</span><b>{stats.moves}번</b></li>
            <li><span>한 집에 평균</span><b>{monthsText(stats.avg)}</b></li>
          </ul>
          <p className="muted-line">
            각 집에 사신 기간을 더한 값입니다.
            {stats.overlap && ' 이사가 겹친 달은 두 번 셉니다.'}
            {stats.skipped > 0 && ` 기간이 없거나 거꾸로 적힌 ${stats.skipped}곳은 셈에서 뺐습니다.`}
            {stats.geoN >= 2 && ` 위치를 아는 ${stats.geoN}곳을 이은 이동 거리는 약 ${(stats.moved / 1000).toFixed(1)}km입니다(직선 거리 합계).`}
          </p>
          <div className="nb-bar">
            <span>{view === 'list' ? '시간순' : '이사 궤적'}</span>
            <span className="nb-acts">
              <button className="cmp-del" onClick={() => setView(view === 'list' ? 'map' : 'list')}>
                {view === 'list' ? '지도' : '목록'}
              </button>
              <button className="cmp-del" onClick={exportJson}>내려받기</button>
              <label className="cmp-del hist-import">
                불러오기
                <input type="file" accept="application/json,.json"
                       onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = '' }} />
              </label>
            </span>
          </div>
        </>
      )}

      <p className="muted-line" role="status" aria-live="polite">{msg}</p>

      {view === 'map' && points.length > 0 && (
        <MapView points={points} stations={[]} path={points}
                 legend={[['#3e7d46', '지금 사는 곳'], ['#8f8e84', '살았던 곳']]}
                 note={points.length < rows.length
                   ? `${rows.length - points.length}곳은 위치를 몰라 빠졌습니다` : null} />
      )}

      {view === 'list' && (
        <ul className="hist-list">
          {rows.map((it) => {
            const n = monthsBetween(it.from, it.to)
            const cal = !it.to && it.expiry ? guardCalendar(it.expiry) : null
            return (
              <li key={it.id}>
                <div className="hist-when">
                  <b>{ymText(it.from)}</b>
                  <span>{it.to ? ymText(it.to) : '지금'}</span>
                </div>
                <div className="hist-body">
                  <b>{it.name}</b>
                  <small>
                    {[it.addr, it.ht ? htName(it.ht) : null, kindName(it.kind),
                      wonText(it.deposit), it.rent ? `월 ${wonText(it.rent)}` : null,
                      n == null ? null : monthsText(n)].filter(Boolean).join(' · ')}
                  </small>
                  {it.approx && <small className="muted">위치는 동 단위 근사입니다</small>}
                  {cal && <small className={cal.tone}>{cal.head}</small>}
                  {it.memo && <p>{it.memo}</p>}
                </div>
                <div className="hist-edit">
                  <button className="cmp-del" onClick={() => setForm(it)}
                          aria-label={`${it.name} 기록 고치기`}>고치기</button>
                  <button className="cmp-del" onClick={() => del(it)}
                          aria-label={`${it.name} 기록 지우기`}>지우기</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {form
        ? <HomeForm region={region} guNames={guNames} init={form}
                    onSave={save} onCancel={() => setForm(null)} />
        : <button className="hist-add" onClick={() => setForm({ ...EMPTY })}>살던 집 추가</button>}

      {rows.length === 0 && !form && (
        <p className="muted-line">
          아직 기록이 없습니다. 지금 사시는 집부터 적어 두시면, 다음에 집을 구하실 때
          무엇이 좋았고 무엇이 힘들었는지가 기준이 됩니다.
        </p>
      )}

      <p className="muted-line">
        기록은 이 기기에만 있습니다. 휴대폰을 바꾸시면 사라지니, 오래 모으실 생각이면
        가끔 내려받아 두시길 권합니다.
      </p>
    </section>
  )
}
