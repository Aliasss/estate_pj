import { useEffect, useState } from 'react'
import { CHECKLIST, eok, useSubway, useUnitLoader } from './units.js'
import { DEAL_CAPS, commuteText, hasBldgData } from './UnitLookup.jsx'

/**
 * 이 집 사실 리포트 — 유료 상품(14,900원 예정)의 문서 본체.
 *
 * 지금은 판매 전 검토용 시안이다. UI 어디에서도 링크하지 않고 ?rpt=lawd.id
 * (선택: &ask=호가억)로만 열린다. 링크를 걸면 가짜 문 실험(v3b)이 재는
 * "지불 의사"가 무료 접근으로 오염된다. 법률 검토와 내부 검수가 끝나고
 * 결제가 붙기 전까지 이 화면은 워터마크를 지운 채 나가면 안 된다.
 *
 * 담는 것과 안 담는 것.
 *  - 전망·추천은 한 줄도 없다. 실거래·대장·지형·역이라는 사실과, 사용자가
 *    입력한 호가와 실거래의 거리라는 계산만 담는다.
 *  - 전세 위험 판정은 싣지 않는다. 판정은 영원히 무료라는 원칙과, 유료
 *    문서가 판정을 파는 것처럼 보이는 오해를 동시에 지키는 선이다.
 *  - 항목은 이 물건에서 실제로 낼 수 있는 것만 싣는다. 없는 데이터의
 *    섹션은 제목째 사라진다. 가짜 문(v3b)의 조건부 항목과 같은 규칙이다.
 */

const ym = (s) => `${String(s).slice(0, 4)}.${String(s).slice(4, 6)}`
const floorText = (f) => (f == null ? '-' : f <= 0 ? '반지하' : `${f}층`)
const prov = (r) => r.at(-1) === 'P'

// bldg_join.py struct_code가 내는 세 갈래 전부. 미지 코드는 원코드 대신 붙임표.
const STRCT = { RC: '철근콘크리트 계열', BR: '벽돌·블록조', ET: '기타' }

function DealBlock({ label, rows, cap, fmt }) {
  if (!rows?.length) return null
  const capped = rows.length >= cap
  return (
    <div className="rpt-deals">
      <h3>{label} <small>{capped ? `실린 최근 ${rows.length}건` : `${rows.length}건`}</small></h3>
      <table>
        <tbody>
          {rows.map((r, i) => {
            const [amount, floor, tag] = fmt(r)
            return (
              <tr key={i}>
                <td>{ym(r[0])}</td>
                <td className="rpt-amt">{amount}</td>
                <td>{floor}</td>
                <td>{tag}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 호가 검증 기록. 화면의 무료 검증과 같은 계산을 날짜와 함께 지면에 남긴다.
 *  계산 로직은 AskingSale과 같은 데이터(최고·중위·최근)를 쓰되, 문서는
 *  결과 문장이 아니라 숫자의 표로 남긴다 — 협상 자리에서 내미는 것은
 *  해석이 아니라 근거다. */
function AskRecord({ u, askEok }) {
  const amt = Math.round(Number(askEok) * 10000)
  // 상한 1e7만원(1,000억)은 오타 방어. Infinity나 지수 표기가 지면에 인쇄되면 안 된다.
  if (!Number.isFinite(amt) || !(amt > 0) || amt >= 1e7) return null
  const rows = u.deals?.s ?? []
  const max = rows.length ? Math.max(...rows.map((r) => r[1])) : null
  if (max == null && !u.med_sale) return null
  return (
    <section>
      <h2>보고 온 호가와 실거래의 거리</h2>
      <table className="rpt-kv">
        <tbody>
          <tr><th>확인한 호가</th><td>{eok(amt)}</td></tr>
          {u.med_sale != null && (
            <tr><th>이 건물 매매 중위 (최근 2년)</th>
              <td>{eok(u.med_sale)} <small>호가가 {u.med_sale ? `${amt >= u.med_sale ? '+' : ''}${Math.round((amt / u.med_sale - 1) * 100)}%` : '-'}</small></td></tr>
          )}
          {max != null && (
            <tr><th>실린 계약 중 최고</th>
              <td>{eok(max)} <small>호가가 {`${amt >= max ? '+' : ''}${Math.round((amt / max - 1) * 100)}%`}</small></td></tr>
          )}
          {rows[0] && (
            <tr><th>가장 최근 매매</th>
              <td>{ym(rows[0][0])} · {eok(rows[0][1])} {floorText(rows[0][2])}{prov(rows[0]) ? ' (잠정)' : ''}</td></tr>
          )}
        </tbody>
      </table>
      <p className="rpt-fn">호가는 문서를 만든 사람이 직접 입력한 값이며, 실거래는
        국토교통부 신고 기록입니다. 값이 오를지 내릴지는 이 문서가 말할 수 없는
        영역이라 적지 않습니다.</p>
    </section>
  )
}

export default function ReportDoc({ raw, ask }) {
  const { byId } = useUnitLoader()
  const stations = useSubway()
  const [state, setState] = useState({ loading: true })
  const [lawd, id] = String(raw ?? '').split('.')

  useEffect(() => {
    if (!lawd || !id) { setState({ error: '주소가 올바르지 않습니다' }); return }
    byId(lawd, id)
      .then((u) => setState(u ? { u } : { error: '그 물건을 찾지 못했습니다' }))
      // 미지의 lawd면 SPA 폴백이 index.html을 200으로 줘서 JSON 파서의 영문
      // 에러가 나온다. 원문을 화면에 세우지 않고 고정 문장으로 접는다.
      .catch(() => setState({ error: '리포트를 불러오지 못했습니다' }))
  }, [lawd, id, byId])

  // 인쇄와 PDF 저장의 파일명·머리글이 앱 기본 제목으로 나가지 않게 한다.
  useEffect(() => {
    if (state.u) document.title = `이 집 사실 리포트 · ${state.u.name || state.u.umd}`
  }, [state.u])

  if (state.loading) return <div className="report"><p className="muted-line">불러오는 중…</p></div>
  if (state.error) return <div className="report"><p className="notfound">{state.error}</p></div>

  const u = state.u
  const fmtDate = (d) => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
  const dateStr = fmtDate(new Date())
  // 세대 표식 "확정월-수집시각"에서 수집일을 꺼낸다. 문서 생성일(열람 시각)과
  // 데이터 기준일은 다른 날일 수 있어 둘을 따로 밝힌다.
  const buildTs = Number(String(u._build ?? '').split('-')[1])
  const dataDateStr = buildTs ? fmtDate(new Date(buildTs * 1000)) : null
  const commute = commuteText(stations, u)
  const stn = stations[u.stn]
  const dealGroups = [
    ['매매', u.deals?.s, DEAL_CAPS.s, (r) => [eok(r[1]), floorText(r[2]), prov(r) ? '잠정' : '']],
    ['전세', u.deals?.j, DEAL_CAPS.j, (r) => [eok(r[1]), floorText(r[2]),
      [r[3] === '갱신' ? '갱신' : '', prov(r) ? '잠정' : ''].filter(Boolean).join('·')]],
    ['월세', u.deals?.w, DEAL_CAPS.w, (r) => [`${eok(r[1])} / ${r[2]}만`, floorText(r[3]), prov(r) ? '잠정' : '']],
  ]
  const hasProv = dealGroups.some(([, rows]) => rows?.some(prov))

  return (
    <div className="report">
      {/* 법적 성격의 고지라 스크린리더에도 읽혀야 한다. aria-hidden 금지. */}
      <div className="rpt-watermark">검토용 시안 · 판매 전</div>

      <header className="rpt-head">
        <p className="rpt-brand">necessities · 이 집 사실 리포트</p>
        <h1>{u.name || '(이름 없음)'}</h1>
        <p className="rpt-addr">{u.umd} {u.jibun ?? '-'} · 전용 {u.area != null
          ? `${u.area}m²(${(u.area / 3.305785).toFixed(1)}평)` : '-'}
          {u.build_year ? ` · ${u.build_year}년` : ''}</p>
        <p className="rpt-meta">문서 생성일 {dateStr}
          {dataDateStr ? ` · 데이터 기준 ${dataDateStr} 수집분` : ''} · 국토교통부
          실거래가 공개시스템 최근 2년 신고분</p>
      </header>

      {u.n_sale_24m != null && u.med_sale != null && (
        <section>
          <h2>매매 가격대 (최근 2년 확정 집계)</h2>
          <table className="rpt-kv">
            <tbody>
              <tr><th>확정 매매 신고</th><td>{u.n_sale_24m}건</td></tr>
              <tr><th>중위 가격</th><td>{eok(u.med_sale)}</td></tr>
            </tbody>
          </table>
          {u.n_sale_24m < 3 && (
            <p className="rpt-fn">확정 신고가 {u.n_sale_24m}건뿐입니다. 표본이 얇은
              중위값은 계약 한 건에 크게 흔들립니다.</p>
          )}
        </section>
      )}

      {ask != null && <AskRecord u={u} askEok={ask} />}

      <section>
        <h2>실거래 이력</h2>
        {dealGroups.map(([label, rows, cap, fmt]) => (
          <DealBlock key={label} label={label} rows={rows} cap={cap} fmt={fmt} />
        ))}
        {hasProv && (
          <p className="rpt-fn">잠정: 신고 기한(계약 후 30일)이 아직 지나지 않은 달의
            계약입니다. 개별 계약은 사실이나 월 통계에는 들어가지 않습니다.</p>
        )}
      </section>

      {hasBldgData(u) && (
        <section>
          <h2>건축물대장 사실</h2>
          <table className="rpt-kv">
            <tbody>
              {u.apr != null && <tr><th>사용승인(준공)</th><td>{u.apr}년</td></tr>}
              {u.strct && <tr><th>주구조</th><td>{STRCT[u.strct] ?? '-'}</td></tr>}
              {u.hhld != null && <tr><th>세대수</th><td>{u.hhld}세대</td></tr>}
              {u.flr != null && <tr><th>지상 층수</th><td>{u.flr}층</td></tr>}
              {u.elvt != null && <tr><th>승강기</th><td>{u.elvt ? `${u.elvt}대` : '없음'}</td></tr>}
              {u.park != null && <tr><th>주차</th>
                <td>{u.park ? `${u.park}대${u.hhld ? ` (세대당 ${(Math.floor(u.park / u.hhld * 10) / 10).toFixed(1)}대)` : ''}` : '없음'}</td></tr>}
              {u.n_dong != null && <tr><th>단지 규모</th><td>{u.n_dong}개 동</td></tr>}
            </tbody>
          </table>
          <p className="rpt-fn">위반건축물 표기 여부는 건축물대장 원문(표제부)에서
            확인해야 합니다. 정부24에서 무료로 열람하실 수 있습니다.</p>
        </section>
      )}

      {(u.slope != null || u.walk != null || u.sch_e != null) && (
        <section>
          <h2>입지 사실</h2>
          <table className="rpt-kv">
            <tbody>
              {u.slope != null && <tr><th>지형</th>
                <td>{u.slope < 5 ? '평지에 가깝습니다' : u.slope < 8
                  ? `완만한 오르막 (경사 약 ${u.slope}%)` : `언덕 (경사 약 ${u.slope}%)`}</td></tr>}
              {u.walk != null && <tr><th>가까운 역</th>
                <td>{stn ? `${stn.name}역 ` : ''}도보 약 {u.walk}분</td></tr>}
              {commute && <tr><th>통근 (약, 도보 포함)</th><td>{commute}</td></tr>}
              {u.sch_e != null && <tr><th>학교 (반경 1km)</th>
                <td>초 {u.sch_e} · 중 {u.sch_m} · 고 {u.sch_h}</td></tr>}
              {u.sch_u != null && <tr><th>대학 (반경 2km)</th>
                <td>{u.sch_u ? `${u.sch_u}곳` : '없음'}</td></tr>}
            </tbody>
          </table>
          <p className="rpt-fn">지형은 위성 관측(NASA SRTM) 기반 근사치이고, 도보와
            통근은 직선거리 환산이라 실제 경로와 다를 수 있습니다. 반경은
            직선거리입니다.</p>
        </section>
      )}

      <section>
        <h2>계약 전 직접 확인할 것</h2>
        <ol className="rpt-check">
          {CHECKLIST.map(([title, why, , where]) => (
            <li key={title}><b>{title}</b> {why}. <small>{where}</small></li>
          ))}
        </ol>
      </section>

      <footer className="rpt-foot">
        <p>이 문서는 법률 자문이 아닙니다. 계약 관련 법률 상담은 대한법률구조공단
          132(무료)에서 받으실 수 있습니다.</p>
        <p>출처: 국토교통부 실거래가 공개시스템, 건축물대장(건축HUB), NASA SRTM,
          서울 열린데이터광장(지하철), 전국 초중등학교·대학 위치 표준데이터.
          이 문서는 생성일 시점의 신고·공부 기록이며, 이후의 계약과 변동은 담지
          못합니다.</p>
      </footer>

      <button className="more rpt-print" onClick={() => window.print()}>인쇄 또는 PDF로 저장</button>
    </div>
  )
}
