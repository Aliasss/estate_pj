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
        name: '내 집 내놔',
        short_name: '내 집 내놔',
        description: '보고 온 집의 주소를 넣으면 국토교통부 실거래가로 보증금 위험을 확인해 준다',
        lang: 'ko',
        start_url: '/',
        display: 'standalone',
        background_color: '#fcfcfb',
        theme_color: '#2a78d6',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
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
        ],
      },
    }),
  ],
})
