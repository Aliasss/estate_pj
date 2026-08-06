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
        name: '서울 전월세 고르기',
        short_name: '집 고르기',
        description: '국토교통부 실거래가로 예산·면적·연식·보증금 안전을 함께 보고 집을 고른다',
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
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
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
