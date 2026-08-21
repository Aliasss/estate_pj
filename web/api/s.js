/**
 * 공유 링크의 카드. `?u=` 링크를 카톡에 붙이면 어느 집이든 같은 정적 카드가
 * 떴다. 판정을 보여 주려고 복사한 링크에 판정이 없었다.
 *
 * 크롤러는 자바스크립트를 안 돌리므로 SPA가 채우는 메타는 못 읽는다. 이 함수가
 * 물건을 찾아 메타를 박은 최소 HTML을 내고, 사람 브라우저는 곧바로 앱으로 보낸다.
 *
 * 실패해도 앱은 멀쩡해야 한다. 무슨 일이 나든 마지막에는 `/?u=`로 보낸다.
 */
import { verdict, eok, pct0, ratioBroken } from '../src/verdict.js'

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// 키는 우리가 만든 것만 받는다. 경로 조작으로 다른 파일을 읽게 두지 않는다.
const KEY = /^([0-9]{5})\.([A-Za-z0-9_-]{1,64})$/

const SITE = 'necessities'
const FALLBACK_DESC = '계약하고 나서야 알게 되는 것들을 계약하기 전에. 주소를 넣으면 실거래가로 보증금 위험을 확인해 드립니다'

/**
 * 링크와 메타에 쓰는 주소는 못박는다. req.headers.host는 클라이언트가 정하는
 * 값이라, 그것으로 링크를 만들면 카드에 남의 주소가 박히고 그것으로 fetch를
 * 하면 함수가 임의 호스트로 나간다(SSRF). 프로덕션 도메인은 하나뿐이다.
 */
const SITE_ORIGIN = 'https://necessities.site'
/**
 * 데이터는 지금 돌고 있는 배포에서 읽는다. 미리보기 배포가 프로덕션 데이터를
 * 읽으면 그 배포로 확인한 카드가 실제와 달라진다. VERCEL_URL은 배포마다 다른
 * 주소라 그 배포의 정적 파일을 가리킨다.
 *
 * UNITS_ORIGIN은 그 둘이 다 안 맞는 자리(로컬 검증, 자체 호스팅)를 위한 것이다.
 * 프로덕션에서는 세팅하지 않는다.
 */
const dataOrigin = () => process.env.UNITS_ORIGIN
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : SITE_ORIGIN)

function page({ key, title, desc }) {
  const self = `${SITE_ORIGIN}/s/${encodeURIComponent(key)}`
  const app = `${SITE_ORIGIN}/?u=${encodeURIComponent(key)}`
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(app)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="${SITE}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<!-- 공유된 주소는 /s/다. 여기에 /?u=를 적으면 다시 긁을 때 그쪽 정적 메타
     (모든 집이 같은 첫 화면 카드)로 되돌아간다. 자기 자신을 가리킨다. -->
<meta property="og:url" content="${esc(self)}" />
<meta property="og:image" content="${esc(SITE_ORIGIN)}/icon-512.png" />
<meta name="twitter:card" content="summary" />
<!-- 메타 리프레시는 안 쓴다. 그걸 따라가는 크롤러는 첫 요청에서 곧바로
     /?u=의 일반 카드를 보게 된다. 사람만 넘어가면 된다. -->
<script>location.replace(${JSON.stringify(app).replace(/</g, '\\u003c')})</script>
</head>
<body><p><a href="${esc(app)}">${esc(title)}</a></p></body>
</html>`
}

export default async function handler(req, res) {
  const key = String(req.query?.key ?? '')
  const m = KEY.exec(key)

  // 키가 이상하면 첫 화면으로. 링크를 잘못 복사한 사람도 앱에는 닿아야 한다.
  if (!m) {
    res.setHeader('Location', `${SITE_ORIGIN}/`)
    res.status(302).end()
    return
  }

  let title = `${SITE} · 계약 전 확인`
  let desc = FALLBACK_DESC
  try {
    // 타임아웃이 없으면 응답을 안 주는 오리진 앞에서 함수가 매달린다. try/catch가
    // 못 잡고 플랫폼 타임아웃 페이지가 나가서, "무슨 일이 나든 마지막에는 /?u=로
    // 보낸다"는 이 파일의 약속이 깨진다. 국토부 게이트웨이가 429가 아니라
    // ConnectTimeout으로 오는 것을 이미 겪었다. 카드 한 장 못 채우는 것이
    // 링크가 죽는 것보다 낫다.
    const r = await fetch(`${dataOrigin()}/data/units/${m[1]}.json`,
                          { signal: AbortSignal.timeout(2500) })
    if (r.ok) {
      const g = await r.json()
      const idx = g.cols.indexOf('id')
      const row = g.rows.find((x) => x[idx] === m[2])
      if (row) {
        const u = Object.fromEntries(g.cols.map((c, k) => [c, row[k]]))
        const v = verdict(u)
        const where = [u.umd, u.jibun].filter(Boolean).join(' ')
        const name = u.name || where || '(이름 없음)'
        // 제목은 결론이다. 목록에서 이 카드만 보고도 무엇을 말하는지 알아야 한다.
        title = `${name} · ${v.head}`
        const facts = [
          where && `${where}`,
          u.area && `전용 ${u.area}m²`,
          u.ratio != null && !ratioBroken(u.ratio) && `전세가율 ${pct0(u.ratio)}`,
          u.med_jeonse != null && `중위 전세 ${eok(u.med_jeonse)}`,
          // 카톡에 남은 카드는 카카오가 캐시하고 우리가 만료시킬 수 없다. 몇 달 뒤
          // 전세가율이 바뀌어도 그 카드는 계속 옛 숫자를 말한다. 언제 기준인지를
          // 카드 자신이 적어야 한다.
          g.window?.[1] && `${g.window[1].slice(0, 4)}-${g.window[1].slice(4)} 기준`,
        ].filter(Boolean).join(' · ')
        desc = `${v.body} ${facts}`.trim()
      }
    }
  } catch {
    // 데이터를 못 읽어도 링크는 살아야 한다. 기본 문구로 내보낸다.
  }
  // 판정은 데이터가 갱신되면 바뀐다. 오래 물고 있지 않는다.
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600')
  res.status(200).send(page({ key, title, desc }))
}
