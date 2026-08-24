/* 계약 패키지 가짜 문 테스트. 실제 결제는 없다 — 유료화 여부를 결정하기 위해
   수요(노출·클릭·알림 신청)를 익명 숫자로만 잰다.

   프라이버시 규칙: 기기 id(cid)는 집계 고지가 같은 화면에 떠 있는 이벤트
   (CARRIES_CID)에만 싣는다. apply의 고지는 신청 버튼과 같은 상세 화면에 떠
   있다(누른 뒤에 보여주는 고지는 고지가 아니다). notify는 준비 중 공개 화면,
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

   집계할 때 알아야 하는 것 둘. 문(variant)마다 view의 분모가 다르다 —
   v3b는 물건 단위, v4는 세션 단위라 비율은 각 문 안에서만 보고 교차 비교는
   하지 않는다. v4는 click이 문 단위 1회 집계인데 apply는 매번이라 한 세션에
   등록 물건 여럿을 신청하면 apply > click이 정상 범위다(cid로 기기 단위
   중복 제거 가능).

   기록해 두는 한계: 카드가 열리면 v3b view가 unit_id를 싣고, 잠시 뒤
   guard_reg가 도착할 수 있다. 서버 타임스탬프의 인접만으로 "그 물건에 등록이
   일어났나"를 추측할 여지가 생긴다. 등록 카드에서 v3b 문을 억제해 v4와의
   상관 쌍은 끊었지만, 이 잔여 경로는 남는다. 좁히려면 guard_reg를 지연
   전송하는 방법이 있고, 새 이벤트를 붙일 때 이 경로를 넓히지 말 것.

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
// v3b: 호가 검증이 무료 기능으로 화면에 서면서, 리포트 항목을 "검증 자체"에서
// "검증 결과의 날짜 박힌 기록"으로 재정의했다(2026-08-24). 같은 클릭의 뜻이
// 달라졌으므로 통을 가른다.
const VARIANT = 'v3b-fact-report'
// v4: 두 번째 문(2026-08-24). 지킴이에 등록된 물건의 카드에서 임대차 2년권
// 9,900원을 제안한다. v3b와 화면도 상품도 다른 병렬 문이라 순차 규칙과
// 충돌하지 않는다. 집계는 variant로 가른다.
// 이 문의 이벤트는 unit_id를 싣지 않는다. 제안이 등록된 물건에서만 뜨므로
// unit_id가 실리면 "어느 건물에 계약이 있나"가 기기 밖으로 나가, 지킴이 폼의
// "이 기기에만 저장됩니다" 약속이 이벤트 경로로 샌다. guard_reg를 순수
// 카운트로 만든 것과 같은 이유다.
// 한 가지 가장자리는 의식적으로 허용했다: apply/notify는 cid를 실으므로
// "이 기기에 등록이 있다"는 기기 단위 사실이 서버에 남는다. 건물은 아니고,
// 등록자 대상 상품에 고지를 보고 능동적으로 신청한 경우라 허용선 안으로
// 판단했다(CTO 리뷰). 이 선을 넘는 확장(예: 등록 시점 자동 이벤트에 cid)은
// 하지 않는다.
export const GUARD2_VARIANT = 'v4-guard-2yr'
// 세션당 1회만 세는 이벤트. click도 포함한다 — 카드를 닫았다 열 때마다 세면
// cid 없는 click은 서버에서 걸러낼 수도 없어 view 대비 비율이 부풀어 오른다.
// 중복 키에 variant가 들어가는 것은 두 문이 한 카드에 같이 설 수 있어서다.
// 같은 물건의 v3b view와 v4 view는 다른 노출이다.
const ONCE = new Set(['view', 'about_view', 'click'])
const seen = new Set()

export function fdTrack(event, unitId, price, variant = VARIANT) {
  if (ONCE.has(event)) {
    const k = `${variant}:${event}:${unitId ?? ''}`
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
        variant,
      }),
    }).catch(() => {})
  } catch { /* 위 주석 참조 */ }
}
