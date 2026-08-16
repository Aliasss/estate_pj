/* 계약 패키지 가짜 문 테스트. 실제 결제는 없다 — 유료화 여부를 결정하기 위해
   수요(노출·클릭·알림 신청)를 익명 숫자로만 잰다.

   프라이버시 규칙: 기기 id(cid)는 집계 고지가 같은 화면에 떠 있는 이벤트
   (CARRIES_CID)에만 싣는다. apply와 notify는 고지가 있는 준비 중 공개 화면에서,
   about_notify는 준비 중임을 먼저 밝힌 소개 섹션에서 발생한다. 그 밖의 이벤트
   (view/click/about_view)는 순수 카운트만 보낸다. 고지 없는 수집에 영속
   식별자를 붙이면 "어느 기기가 어느 물건을 봤나"라는 열람 이력이 되고, 그건
   이 서비스가 하지 않기로 약속한 일이다. 새 이벤트에 cid를 실으려면 그 화면에
   고지부터 넣어야 한다.

   퍼널 정의(집계 쿼리 기준): view -> click(상세 펼침) -> apply(신청, 가장 강한
   지불 의사). notify는 별선(출시 알림). about_view -> about_notify는 소개 탭의
   별도 퍼널. 2026-08-16 배포 이전 행은 의미가 달라 집계에서 잘라낸다.

   보내는 것: 이벤트명, 물건 id(공개 데이터), 표시 가격, (CARRIES_CID 이벤트만)
   무작위 id. 키는 쓰기 전용 정책(RLS)이라 이 클라이언트로는 읽을 수 없고, 공개
   저장소에 있어도 되는 값이다. 집계 실패는 조용히 삼킨다 — 카운터가 앱을
   방해하면 본말이 뒤집힌다. */

const FD_URL = 'https://wjjgbqlpotvyvlmxhblo.supabase.co/rest/v1/nec_fakedoor_events'
const FD_KEY = 'sb_publishable_KGhIpxAPbsi5Eck-bPn6zg_Vhjf7qjX'

// 기기별 무작위 id. 사람을 식별하지 않고 "몇 기기에서"를 셀 만큼만 구분한다.
function cid() {
  try {
    let v = localStorage.getItem('nec-cid')
    if (!v) {
      v = crypto.randomUUID()
      localStorage.setItem('nec-cid', v)
    }
    return v
  } catch {
    return null
  }
}

const CARRIES_CID = new Set(['apply', 'notify', 'about_notify']) // 고지 화면의 이벤트만
// 세션당 1회만 세는 이벤트. click도 포함한다 — 카드를 닫았다 열 때마다 세면
// cid 없는 click은 서버에서 걸러낼 수도 없어 view 대비 비율이 부풀어 오른다.
const ONCE = new Set(['view', 'about_view', 'click'])
const seen = new Set()

export function fdTrack(event, unitId, price) {
  if (ONCE.has(event)) {
    const k = `${event}:${unitId ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
  }
  try {
    fetch(FD_URL, {
      method: 'POST',
      // keepalive: 클릭 직후 화면을 떠나도 전송이 살아남는다
      keepalive: true,
      headers: {
        apikey: FD_KEY,
        authorization: `Bearer ${FD_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event,
        unit_id: unitId == null ? null : String(unitId),
        price,
        cid: CARRIES_CID.has(event) ? cid() : null,
      }),
    }).catch(() => {})
  } catch { /* 위 주석 참조 */ }
}
