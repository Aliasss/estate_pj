// 빌드 산출물 검증: tier1.json이 정말 프리캐시 목록에 들어갔는가.
//
// workbox는 maximumFileSizeToCacheInBytes를 넘는 파일을 빌드 실패가 아니라
// "프리캐시에서 제외"로 처리한다. 오프라인 티어1은 이 앱의 존재 이유 중
// 하나인데, 데이터가 자라 한도를 넘는 순간 소리 없이 죽는다. 그래서 빌드
// 끝에 sw.js를 열어 목록을 직접 확인하고, 빠졌으면 빌드를 깨뜨린다.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const sw = await readFile(path.join(dist, 'sw.js'), 'utf8')

if (!sw.includes('data/tier1.json')) {
  console.error('sw.js 프리캐시 목록에 data/tier1.json이 없습니다. ' +
    'tier1이 maximumFileSizeToCacheInBytes를 넘었을 가능성이 큽니다 (vite.config.js).')
  process.exit(1)
}
console.log('프리캐시 검증 통과: tier1.json 포함')
