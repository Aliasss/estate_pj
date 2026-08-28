import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'necessities',
        short_name: 'necessities',
        description: '계약 전에 꼭 필요한 것들. 실거래가로 보증금 위험을 확인해 드립니다',
        lang: 'ko',
        start_url: '/',
        display: 'standalone',
        background_color: '#f7f2e4',
        theme_color: '#71502f',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 지킴이 백그라운드 점검. workbox 생성 워커에 스크립트로 붙는다.
        importScripts: ['guard-sw.js'],
        // /s/는 공유 카드를 내는 서버 함수다. workbox의 NavigationRoute는 기본이
        // allowlist [/./]라 navigate 요청을 전부 index.html로 돌려보내는데, 그러면
        // 함수가 호출조차 안 되고 앱이 /s/... 경로에서 부팅한다. ?u=가 없으니
        // 사용자는 판정 대신 빈 검색 화면을 본다. 에러도 404도 안 난다.
        // 이 앱을 한 번이라도 연 브라우저와 설치형 PWA 전부가 그렇게 된다.
        navigateFallbackDenylist: [/^\/s\//],
        // 티어 1은 프리캐시(오프라인 필수). 티어 2는 구를 열어봤을 때만 캐시에 남긴다.
        globPatterns: ['**/*.{js,css,html,svg,png}', 'data/tier1.json'],
        // tier1.json이 한도를 넘으면 workbox는 빌드를 실패시키는 게 아니라
        // 프리캐시에서 조용히 빼 버리고, 그 순간 check-precache.mjs가 빌드를
        // 깨뜨린다. 그러니 이 값은 여유분이 아니라 의도된 예산이다. 지금 7MB인
        // tier1이 12MB에 닿으면 "조용히 모든 설치 기기에 실리는" 게 아니라
        // 빌드 실패로 드러나고, 그때 지역 분할이나 절식을 결정한다.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/data\/units\/.*\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'units',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 45 },
            },
          },
          {
            // 자료 갱신 시점과 지연 고지가 여기서 나온다. 캐시가 없으면 오프라인
            // 사용자에게서 그 고지가 통째로 사라지는데, 가장 낡은 자료를 보고
            // 있을 사람에게서 없어지는 것이라 방향이 반대다. 실거래 쪽은 캐시된
            // 옛 날짜가 지연 일수를 더 크게 만들 뿐이라 거짓 안심을 안 만든다.
            //
            // 대장 쪽은 그 논리가 그대로 안 간다. 판정에 at과 remaining 두 값이
            // 필요해서, 그 쌍이 없던 시절의 응답이 캐시에 있으면 일수가 커지는
            // 게 아니라 고지가 통째로 침묵한다. 온라인으로 한 번 열면 낫고,
            // 없는 근거로 경고를 내는 것보다는 조용한 쪽이 맞다고 보아 그대로
            // 둔다. 다음에 이 판정에 값을 하나 더 얹을 때는 이 성질을 볼 것.
            urlPattern: /\/data\/insights\.json$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'insights',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
})
