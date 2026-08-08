// 빌드 시점에 데이터를 public/data로 굽는다.
//
// 티어 1: 리포지토리에 커밋된 data/*.csv -> tier1.json (앱 번들에 실려 오프라인 동작)
// 티어 2: data-latest 릴리스의 units.tar.gz -> public/data/units/ (구 선택 시 지연 로딩)
//
// 티어 2를 릴리스에서 받는 이유는 10MB급 파일을 매달 커밋하면 리포지토리가 그만큼씩
// 불어나기 때문이다. 로컬 개발 중이라면 build_units.py가 만든 ../units를 그냥 복사한다.

import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const outDir = path.resolve(here, '../public/data')

const RELEASE = 'https://github.com/Aliasss/estate_pj/releases/download/data-latest'
const UNITS_URL = `${RELEASE}/units.tar.gz`

// 프로덕션에서 데이터 없이 빌드가 통과하면 빈 사이트가 진짜 배포를 덮는다.
// 로컬·프리뷰는 데이터 없이도 돌아가야 하니 경고로 남긴다.
const isProduction = process.env.VERCEL_ENV === 'production'

/** 쉼표를 품은 따옴표 필드까지 처리하는 최소 CSV 파서. */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v !== ''))
}

const num = (v) => (v === '' || v == null ? null : Number(v))

async function loadCsv(name, numeric) {
  const raw = await readFile(path.join(repo, 'data', name), 'utf8')
  const [head, ...rows] = parseCsv(raw.replace(/^﻿/, ''))
  return rows.map((r) =>
    Object.fromEntries(head.map((h, i) => [h, numeric.has(h) ? num(r[i]) : r[i]]))
  )
}

async function buildTier1() {
  const panel = await loadCsv('monthly_panel.csv', new Set([
    'n_deals', 'n_cancelled', 'n_jeonse', 'n_wolse', 'n_new', 'n_renew',
    'median_amount_manwon', 'median_price_per_pyeong', 'avg_area_m2', 'avg_build_year',
  ]))
  const ratio = await loadCsv('jeonse_ratio.csv', new Set([
    'n_sale', 'n_jeonse', 'median_sale_manwon', 'median_jeonse_manwon',
    'median_sale_ppp', 'median_jeonse_ppp', 'jeonse_ratio_amount', 'jeonse_ratio_ppp',
  ]))
  const coverage = await loadCsv('monthly_coverage.csv', new Set(['n_deals', 'n_gu']))

  const months = [...new Set(panel.map((r) => r.ym))].sort()
  // 마지막 2개월은 30일 신고 기한 때문에 계속 채워진다. 잠정 구간으로 표시한다.
  // 잠정 구간도 달력으로 판정한다. 말일+35일(신고 기한 30일+여유)이 지난 달은
  // 완성이다. 뒤에서 두 달을 기계적으로 자르면 8월 8일에 6월까지 회색이 된다.
  const now = new Date()
  const isComplete = (ym) => {
    const [y, m] = ym.split('-').map(Number)
    const lastDay = new Date(y, m, 0)                    // 그 달 말일
    return now - lastDay > 35 * 86400_000
  }
  const provisional = months.filter((mo) => !isComplete(mo))

  const gu = [...new Map(panel.map((r) => [r.lawd_cd, r.sgg_nm])).entries()]
    .map(([lawd_cd, sgg_nm]) => ({ lawd_cd, sgg_nm }))
    .sort((a, b) => a.sgg_nm.localeCompare(b.sgg_nm, 'ko'))

  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, 'tier1.json'),
    JSON.stringify({ months, provisional, gu, panel, ratio, coverage })
  )
  const bytes = (await readFile(path.join(outDir, 'tier1.json'))).length
  console.log(`tier1.json  ${months.length}개월 · ${gu.length}개 구 · ${(bytes / 1e6).toFixed(2)}MB`)
}

async function buildTier2() {
  const dest = path.join(outDir, 'units')
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  const local = path.join(repo, 'units')
  if (existsSync(path.join(local, 'index.json'))) {
    await cp(local, dest, { recursive: true })
    console.log('units/     로컬 ../units 사용')
    return
  }

  const res = await fetch(UNITS_URL)
  if (!res.ok) {
    if (isProduction) {
      throw new Error(`units.tar.gz 릴리스를 받지 못했습니다 (HTTP ${res.status}). ` +
        '프로덕션은 빈 사이트를 내보내지 않습니다. 재배포로 다시 시도하세요.')
    }
    // 로컬·프리뷰는 데이터 없이도 빌드를 통과시키되, 앱이 티어 2 화면을 감추도록 빈 인덱스를 남긴다.
    console.warn(`units/     릴리스를 받지 못했습니다 (HTTP ${res.status}). 티어 2 없이 빌드합니다.`)
    await writeFile(path.join(dest, 'index.json'), JSON.stringify({ gu: [] }))
    return
  }
  const tgz = path.join(outDir, 'units.tar.gz')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz))
  await run('tar', ['-xzf', tgz, '-C', dest])
  await rm(tgz)
  console.log('units/     릴리스에서 내려받음')
}

/** 지하철역·노선. 41KB라 프리캐시에 넣어도 부담이 없다. */
async function buildSubway() {
  const local = path.join(repo, 'subway.json')
  const dest = path.join(outDir, 'subway.json')
  if (existsSync(local)) {
    await cp(local, dest)
    console.log('subway.json 로컬 사용')
    return
  }
  const res = await fetch(`${RELEASE}/subway.json`)
  if (!res.ok) {
    if (isProduction) {
      throw new Error(`subway.json 릴리스를 받지 못했습니다 (HTTP ${res.status}). ` +
        '프로덕션은 역 없는 지도를 내보내지 않습니다.')
    }
    console.warn(`subway.json  릴리스에 없습니다 (HTTP ${res.status}). 지도에 역 없이 빌드합니다.`)
    return
  }
  const text = await res.text()
  await writeFile(dest, text)
  console.log(`subway.json  역 ${JSON.parse(text).stations.length}개`)
}

/**
 * 금리(rates.json)와 인구·세대(pop.json)는 KB급이라 릴리스가 아니라
 * 리포지토리(data/)에 커밋된다. web/public/data/는 gitignore라 빌드 때
 * 여기로 복사해 온다. 없으면(키·활용신청 전) 조용히 건너뛴다. 화면이 해당
 * 지표 없는 문장으로 내려앉는 건 프런트가 처리한다.
 */
async function copySmall(name, offMessage) {
  const src = path.join(repo, 'data', name)
  if (!existsSync(src)) {
    console.log(`${name} 없음. ${offMessage}`)
    return
  }
  await cp(src, path.join(outDir, name))
  console.log(`${name} 복사`)
}

await buildTier1()
await buildTier2()
await buildSubway()
await copySmall('rates.json', '금리 표시는 꺼진 채 빌드합니다.')
await copySmall('pop.json', '세대수 추이는 꺼진 채 빌드합니다.')
