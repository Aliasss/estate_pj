/* 보증금 지킴이 백그라운드 점검. workbox가 생성한 서비스워커에
   importScripts로 붙는 평범한 스크립트다.

   여기에는 판단 로직이 없다. 앱이 IndexedDB에 계산해 둔 값(만기 알림
   날짜, 등록 시점 기준선)과 오늘 데이터를 비교해 두 가지만 알린다:
     1. 미리 계산된 만기 알림 날짜에 도달했다
     2. 등록 이후, 내 보증금보다 낮은 신규 전세(비잠정)가 신고됐다
   전체 위험 판정은 앱을 열었을 때 지킴이 패널이 한다.

   구 파일의 거래 내역은 최근 10건으로 잘려 있어(전송량), 그 사이 거래가
   아주 많았던 건물에서는 신호를 놓칠 수 있다. 원천 DB로 전량을 보는 것은
   서버 알림 단계의 몫이다. */

const GUARD_DB = 'necessities-guard'

function guardOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GUARD_DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('items', { keyPath: 'id' })
      req.result.createObjectStore('state', { keyPath: 'k' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const guardTx = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(store, mode)
  const req = fn(tx.objectStore(store))
  // get이 못 찾으면 result가 undefined다. 그때 요청 객체를 돌려주면(항상 참)
  // "이미 알렸음"으로 오판해 모든 알림이 침묵한다. result만 내보낸다.
  tx.oncomplete = () => resolve(req && typeof req === 'object' && 'result' in req ? req.result : undefined)
  tx.onerror = () => reject(tx.error)
})

async function guardNotified(db, key) {
  const row = await guardTx(db, 'state', 'readonly', (st) => st.get(key))
  return !!row
}

async function guardNotify(db, key, title, body) {
  await self.registration.showNotification(title, {
    body, tag: key, icon: './icon-192.png', badge: './icon-192.png',
  })
  await guardTx(db, 'state', 'readwrite', (st) => st.put({ k: key, at: Date.now() }))
}

const guardEok = (m) => (m >= 10000 ? (m / 10000).toFixed(1) + '억' : m.toLocaleString() + '만')

async function guardCheck() {
  const db = await guardOpenDb()
  const items = await guardTx(db, 'items', 'readonly', (st) => st.getAll())
  if (!items || !items.length) return
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  for (const it of items) {
    // 1. 만기 알림 날짜 도달. 사흘 넘게 지난 것은 알리지 않는다 — 늦은 알림은 소음이다.
    for (const m of it.milestones || []) {
      const gap = (today - new Date(m.date + 'T00:00:00')) / 86400000
      if (gap >= 0 && gap <= 3 && !(await guardNotified(db, it.id + ':' + m.key))) {
        await guardNotify(db, it.id + ':' + m.key, it.name + ' · ' + m.title, m.body)
      }
    }
    // 2. 등록 이후의 신규 전세가 내 보증금보다 낮다
    try {
      const res = await fetch(new URL('data/units/' + it.lawd + '.json', self.registration.scope),
        { cache: 'no-store' })
      if (!res.ok) continue
      const g = await res.json()
      const ci = {}
      g.cols.forEach((c, i) => { ci[c] = i })
      const row = g.rows.find((r) => r[ci.id] === it.id)
      const deals = row && row[ci.deals]
      for (const r of (deals && deals.j) || []) {
        if (r[r.length - 1] === 'P') continue          // 잠정은 확정되면 그때 알린다
        // 앱의 critical 조건과 동치로만 알린다. 구분 미기재(갱신 감액일 수 있음)와
        // 반지하(지상층 시세로 못 읽음)는 앱이 유보하는 케이스라 여기서 단정하면
        // 알림과 앱이 다른 말을 한다. 그런 행은 앱을 열었을 때 패널이 다룬다.
        if (r[3] !== '신규') continue
        if (!(r[2] == null || r[2] > 0)) continue       // 반지하 제외
        if (it.baseYm && r[0] <= it.baseYm) continue    // 등록 전 계약
        if (typeof r[1] !== 'number' || r[1] >= it.deposit) continue
        const key = it.id + ':low:' + r[0] + ':' + r[1]
        if (!(await guardNotified(db, key))) {
          await guardNotify(db, key,
            it.name + ' · 새 전세가 내 보증금보다 낮습니다',
            '신규 전세 ' + guardEok(r[1]) + '이 신고되었습니다 (내 보증금 '
            + guardEok(it.deposit) + '). 앱에서 위험 신호를 확인해 보세요.')
        }
      }
    } catch { /* 오프라인 등. 다음 주기에 다시 본다 */ }
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'guard-check') event.waitUntil(guardCheck())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus() }
    return self.clients.openWindow('./')
  }))
})
