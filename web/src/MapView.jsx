import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/**
 * 조건에 맞는 물건을 지도에 뿌린다.
 *
 * 어려운 건 지도를 띄우는 게 아니라 점 개수다. 조건을 느슨하게 걸면 결과가 5만 개까지
 * 나오는데, 그만큼 DOM 마커를 만들면 휴대폰에서 지도가 멈춘다. 두 가지로 막는다.
 *   - 캔버스 렌더러. 마커 하나에 DOM 노드 하나씩 만들지 않는다.
 *   - 상위 MAX_PINS개만 그린다. 정렬 순서가 이미 매겨져 있으므로 위에서 자른다.
 * 잘랐다는 사실은 화면에 적는다. 지도에 안 보이는 걸 없다고 읽으면 안 된다.
 */

// 캔버스로 그려도 이 이상은 휴대폰에서 버벅인다. 목록과 같은 순서로 위에서 자른다.
const MAX_PINS = 3000
const SEOUL = [37.5665, 126.978]

const TONE = {
  critical: '#d03b3b',
  serious: '#fab219',
  warning: '#fab219',
  good: '#0ca30c',
  muted: '#8f8e84',
}

export default function MapView({ points, stations, onPick, note }) {
  const holder = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const stnLayer = useRef(null)

  // 지도는 한 번만 만든다. 조건이 바뀔 때마다 다시 만들면 보던 위치가 튄다.
  useEffect(() => {
    if (map.current) return
    map.current = L.map(holder.current, {
      center: SEOUL, zoom: 11, preferCanvas: true, zoomControl: true,
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map.current)
    layer.current = L.layerGroup().addTo(map.current)
    stnLayer.current = L.layerGroup().addTo(map.current)
    // 컨테이너가 늦게 자리를 잡으면 타일이 반쪽만 그려진다
    setTimeout(() => map.current?.invalidateSize(), 0)
    // 조건 입력칸이 위에 길게 깔려 있어서, 지도를 켜면 화면 밖에서 열린다.
    holder.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    return () => { map.current?.remove(); map.current = null }
  }, [])

  const shown = useMemo(() => points.slice(0, MAX_PINS), [points])

  useEffect(() => {
    if (!layer.current) return
    layer.current.clearLayers()
    const bounds = []
    for (const p of shown) {
      bounds.push([p.lat, p.lon])
      L.circleMarker([p.lat, p.lon], {
        radius: 5, weight: 1, color: '#fff', opacity: 0.9,
        fillColor: TONE[p.tone] ?? TONE.muted, fillOpacity: 0.85,
      })
        .bindTooltip(p.label, { direction: 'top' })
        .on('click', () => onPick?.(p))
        .addTo(layer.current)
    }
    if (bounds.length) {
      map.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 })
    }
  }, [shown, onPick])

  // 역은 조건과 무관하게 늘 같은 자리라 따로 그린다. 통근 판단의 기준점이다.
  useEffect(() => {
    if (!stnLayer.current) return
    stnLayer.current.clearLayers()
    for (const s of stations ?? []) {
      L.circleMarker([s.lat, s.lon], {
        radius: 3, weight: 0, fillColor: '#2a78d6', fillOpacity: 0.55,
        interactive: true,
      }).bindTooltip(s.name, { direction: 'top' }).addTo(stnLayer.current)
    }
  }, [stations])

  return (
    <figure className="mapwrap">
      <div ref={holder} className="map" />
      <figcaption className="muted-line">
        {points.length > MAX_PINS
          ? `조건에 맞는 ${points.length.toLocaleString()}개 중 상위 ${MAX_PINS.toLocaleString()}개만 표시합니다. 조건을 좁히면 전부 보입니다.`
          : `${points.length.toLocaleString()}개 표시`}
        {note ? ` · ${note}` : ''}
      </figcaption>
    </figure>
  )
}
