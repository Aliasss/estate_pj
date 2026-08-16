import { guardMilestones } from './units.js'

/**
 * 보증금 지킴이 백그라운드 알림 (서버 없음).
 *
 * localStorage는 서비스워커가 못 읽는다. 그래서 등록 계약을 IndexedDB에
 * 비춰 두고, 설치형 PWA의 주기 동기화(periodicSync)가 워커에서 그걸 읽어
 * 로컬 알림을 띄운다. 서버로는 아무것도 나가지 않는다 — "개인 데이터는
 * 기기에만"이라는 소개 페이지의 약속이 그대로 지켜진다.
 *
 * 워커에 넘기는 것은 계산이 끝난 값(만기 알림 날짜들, 기준선)이다. 역월
 * 계산 같은 로직을 워커에 복제하면 두 벌이 반드시 어긋난다.
 *
 * 지원 범위: 안드로이드 크롬 계열의 설치형 PWA. 아이폰은 웹푸시(서버)가
 * 필요해서 다음 단계다. 실행 주기는 브라우저가 정하므로(대개 하루 안팎)
 * 보장성 있는 알림이 아니라 "앱을 안 열어도 대개는 알게 되는" 수준이다.
 */

const DB = 'necessities-guard'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('items', { keyPath: 'id' })
      req.result.createObjectStore('state', { keyPath: 'k' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 등록 목록을 통째로 다시 쓴다. 부분 갱신은 삭제 반영이 새기 쉽다. */
export async function mirrorGuard(items) {
  try {
    const db = await openDb()
    const tx = db.transaction('items', 'readwrite')
    const st = tx.objectStore('items')
    st.clear()
    for (const it of items) {
      st.put({
        id: it.id, lawd: it.lawd, name: it.name,
        deposit: it.deposit, baseYm: it.base?.ym ?? null,
        milestones: guardMilestones(it.expiry),
      })
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    db.close()
  } catch { /* 시크릿 모드 등. 화면 동작에는 영향 없다 */ }
}

export function bgNotifySupported() {
  return 'serviceWorker' in navigator && 'Notification' in window
    && 'PeriodicSyncManager' in window
}

const BG_KEY = 'guard-bg-v1'
export const bgNotifyEnabled = () => localStorage.getItem(BG_KEY) === 'on'

/** 사용자 제스처 안에서 불러야 한다(권한 팝업). true = 켜짐. */
export async function enableBgNotify() {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  try {
    // 최소 주기 12시간. 실제 주기는 브라우저가 정한다.
    await reg.periodicSync.register('guard-check', { minInterval: 12 * 60 * 60 * 1000 })
  } catch {
    return false                       // 설치형이 아니면 등록이 거부된다
  }
  localStorage.setItem(BG_KEY, 'on')
  return true
}

export async function disableBgNotify() {
  try {
    const reg = await navigator.serviceWorker.ready
    await reg.periodicSync.unregister('guard-check')
  } catch { /* 이미 없으면 그만 */ }
  localStorage.removeItem(BG_KEY)
}
