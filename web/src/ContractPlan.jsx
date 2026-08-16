import { useEffect, useState } from 'react'

/**
 * 계약 일정 만들기. 계약일과 잔금일 두 날짜를 넣으면, 보증금을 지키는 데
 * 필요한 행동들이 날짜가 박힌 일정으로 나온다.
 *
 * 존재 이유: 판례 카드가 보여 주듯 대항력은 전입 다음 날 0시에 생기고
 * 근저당은 당일 효력이라, 이 싸움은 지식이 아니라 "그날 그 순서로 했느냐"로
 * 갈린다. 지식(알아두기 탭)을 일정(캘린더)으로 번역하는 것이 이 카드다.
 *
 * 날짜는 기기에만 저장한다. 지킴이가 계약 후 만기를 지킨다면 이 카드는
 * 계약 전, 계약일부터 대항력 발생까지의 위험 구간을 지킨다.
 */

const STORE = 'nec-plan-v1'

/** 'YYYY-MM-DD'를 로컬 자정으로. UTC 파싱이 섞이면 D-day가 아침마다 틀린다. */
const md = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const addDays = (date, n) => {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}
const fmt = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일`

function dday(d, today) {
  const n = Math.round((d - today) / 86400000)
  if (n === 0) return '오늘'
  return n > 0 ? `D-${n}` : `지남`
}

/** 계약일(c)과 잔금일(j)에서 일정을 만든다. 날짜가 이르면 앞에 온다.
 *  법정 기한이 있는 행과, 우리가 권하는 날짜일 뿐인 행을 제목에서 가른다. */
function buildPlan(c, j) {
  // 미납국세 열람 창은 계약 후부터 임대차 기간 시작일까지다. 계약과 잔금이
  // 같은 날인 극단에서도 창 밖 날짜를 만들지 않는다.
  const taxDay = addDays(c, 1) > j ? j : addDays(c, 1)
  return [
    [c, '계약일 · 도장 찍기 전에', '등기부등본을 그 자리에서 새로 떼어 확인하고, 계약금은 등기부상 소유자 명의 계좌로만 보냅니다. 특약 두 가지를 넣으세요. 잔금일 다음 날까지 근저당 등 권리 설정 금지, 보증보험 가입 불가 시 계약 해제와 계약금 반환.'],
    [taxDay, '계약 직후 (권장)', '보증금이 1천만원을 넘으면 임대인 동의 없이 세무서에서 미납국세를 열람할 수 있습니다. 계약서 사본을 들고 가면 됩니다. 열람은 임대차 기간이 시작되기 전까지만 됩니다.'],
    [j, '잔금일 아침 · 등기부 다시 열람', '계약일 이후 새로 잡힌 근저당·가압류가 없는지 확인한 뒤에 잔금을 보냅니다. 잔금도 소유자 명의 계좌로만.'],
    [j, '잔금일 · 이사하는 날 안에', '전입신고를 오늘 안에 마칩니다. 확정일자는 임대차 신고를 하면 자동으로 붙고, 신고 대상이 아니면 주민센터나 인터넷등기소에서 따로 받습니다.'],
    [addDays(j, 1), '다음 날 0시 · 대항력 발생', '여기까지가 위험 구간입니다. 전입신고 다음 날 0시부터 대항력이 생기므로, 그 전에 잡힌 권리는 나보다 앞섭니다. 어제 전입신고를 했다면 오늘부터 보호가 시작된 것입니다.'],
    [addDays(c, 30), '임대차 신고 기한', '계약일부터 30일 안에 신고해야 합니다(보증금 6천만원 초과 등 대상 계약). 신고하면 확정일자가 자동으로 부여됩니다.'],
    [addDays(j, 14), '보증보험 가입 신청 (권장: 잔금 뒤 2주 안)', '잔금과 전입을 마쳤으면 미루지 말고 신청하세요. 법정 기한은 전세 계약 기간의 절반까지이고, 절반이 지나면 가입할 수 없습니다.'],
  ].sort((a, b) => a[0] - b[0])
}

export default function ContractPlan() {
  const [dates, setDates] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORE)) ?? { c: '', j: '' } }
    catch { return { c: '', j: '' } }
  })
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(dates)) } catch { /* 표시용 */ }
  }, [dates])

  const ok = dates.c && dates.j && md(dates.j) >= md(dates.c)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const plan = ok ? buildPlan(md(dates.c), md(dates.j)) : null

  return (
    <section className="card">
      <h2>계약 일정 만들기</h2>
      <p className="sub">
        계약일과 잔금일을 넣으면, 보증금을 지키는 행동들을 날짜가 박힌 일정으로
        만들어 드립니다. 날짜는 이 기기에만 저장됩니다
      </p>
      <div className="plan-in">
        <label>
          <span>계약일</span>
          <input type="date" value={dates.c} aria-label="계약일"
                 onChange={(e) => setDates((v) => ({ ...v, c: e.target.value }))} />
        </label>
        <label>
          <span>잔금·입주일</span>
          <input type="date" value={dates.j} aria-label="잔금 및 입주일"
                 onChange={(e) => setDates((v) => ({ ...v, j: e.target.value }))} />
        </label>
      </div>
      {dates.c && dates.j && !ok && (
        <p className="muted-line">잔금일이 계약일보다 빠릅니다. 날짜를 확인해 주세요.</p>
      )}
      {plan && (
        <ol className="plan">
          {plan.map(([d, head, body], i) => (
            <li key={i} className={d < today ? 'past' : ''}>
              <span className="plan-when">
                <b>{fmt(d)}</b>
                <small>{dday(d, today)}</small>
              </span>
              <div className="plan-what">
                <b>{head}</b>
                <span>{body}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {plan && (
        <p className="muted-line">
          자세한 근거는 알아두기 탭에 있습니다. 특약과 등기부는 법·제도 1번과 2번,
          하루 차이로 갈린 실제 사건은 판례 카드에서 보실 수 있습니다.
        </p>
      )}
    </section>
  )
}
