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
   별도 퍼널. guard_reg는 퍼널 밖의 계기판이다 — 지킴이 등록이 몇 건 일어나는지
   (임대차 2년권 시장의 상한). unit_id도 cid도 없는 순수 카운트만 보낸다.
   variant 열은 실려도 무시하고 합산한다 — 등록 계기판은 가짜 문 실험과
   무관한 시계열이라, variant로 쪼개면 연속성이 끊긴다.
   2026-08-16 배포 이전 행은 의미가 달라 집계에서 잘라낸다.

   VARIANT: 상품 문구가 바뀌면 같은 클릭도 다른 뜻이 된다. 문구를 고칠 때마다
   이 값을 올리고, 집계는 variant별로 나눠 본다. 값을 안 올리고 문구만 고치면
   두 실험이 한 통에 섞인다. variant가 NULL인 행은 v1(읽는 리포트로 팔던
   문구)이다. 버리지도 말고 v2에 합치지도 말 것.

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
// v3: 상품 자체를 바꾼 실험 (2026-08-24, docs/수익모델-검토-2026-08.md).
// 임차인 협상 패키지 19,900원에서 매수 검토자 대상 "이 집 사실 리포트"
// 14,900원으로. v2까지의 실측(8일, apply 기기 3대)은 문구가 아니라 상품이
// 문제라는 판단의 근거다. 이 variant의 클릭률은 상품 매력과 동시에
// "트래픽 중 매수 의도 비율"을 처음 재는 계기판이기도 하다.
const VARIANT = 'v3-fact-report'
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
        variant: VARIANT,
      }),
    }).catch(() => {})
  } catch { /* 위 주석 참조 */ }
}
