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
  critical: '#bd3a2b',
  serious: '#a06e0e',
  warning: '#a06e0e',
  good: '#3e7d46',
  muted: '#8f8e84',
}
const STATION_COLOR = '#34689b'
// 내 위치. 물건 판정색(TONE)과 겹치지 않는 색이라야 헷갈리지 않는다.
const HERE_COLOR = '#7b4fd0'

/* 색만으로는 무슨 뜻인지 알 수 없다. 판정 화면과 같은 기준(전세가율)을 그대로 적는다. */
const LEGEND = [
  [TONE.critical, '전세가율 100% 이상'],
  [TONE.serious, '80~100%'],
  [TONE.good, '80% 미만'],
  // 회색은 두 가지다. 전세는 있는데 매매가 없어 못 낸 것과, 전세 자체가 없는 것.
  // 임장 화면은 거래 유형 기본값이 전체라 뒤쪽이 다수다.
  [TONE.muted, '비교 불가 · 전세 신고 없음'],
  [STATION_COLOR, '지하철역'],
]

export default function MapView({ points, stations, selected, here, onPick, note }) {
  const holder = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const stnLayer = useRef(null)
  const pickLayer = useRef(null)
  const hereLayer = useRef(null)
  // onPick은 부모가 렌더마다 새로 만든다. 이걸 이펙트 의존성에 넣으면 마커를
  // 누를 때마다(카드가 열려 재렌더) 마커 전체를 다시 그리고 fitBounds까지 다시
  // 돌아, 방금 확대해 둔 지도가 전체 보기로 튕긴다. 최신 핸들러는 ref로 나른다.
  const onPickRef = useRef(onPick)
  useEffect(() => { onPickRef.current = onPick })

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
    // 고른 물건은 맨 위 레이어에 따로 그린다. 3,000개 점 사이에 섞이면 못 찾는다.
    pickLayer.current = L.layerGroup().addTo(map.current)
    hereLayer.current = L.layerGroup().addTo(map.current)
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
        radius: 6, weight: 1.5, color: '#fff', opacity: 0.95,
        fillColor: TONE[p.tone] ?? TONE.muted, fillOpacity: 0.9,
      })
        .bindTooltip(p.label, { direction: 'top' })
        .on('click', () => onPickRef.current?.(p))
        .addTo(layer.current)
    }
    if (bounds.length) {
      map.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 })
    }
  }, [shown])


  // 목록에서 고른 물건을 지도에서 짚어 준다. 색만 바꾸면 작은 점 사이에서 안 보여서
  // 테두리 원을 하나 더 두르고 지도를 그쪽으로 옮긴다.
  useEffect(() => {
    if (!pickLayer.current) return
    pickLayer.current.clearLayers()
    if (!selected) return
    L.circleMarker([selected.lat, selected.lon], {
      radius: 11, weight: 3, color: '#0b0b0b', opacity: 0.9, fill: false,
    }).addTo(pickLayer.current)
    L.circleMarker([selected.lat, selected.lon], {
      radius: 6, weight: 2, color: '#fff', fillColor: TONE[selected.tone] ?? TONE.muted,
      fillOpacity: 1,
    }).bindTooltip(selected.label, { direction: 'top', permanent: true })
      .addTo(pickLayer.current)
    map.current.panTo([selected.lat, selected.lon], { animate: true })
  }, [selected])

  // 내가 지금 서 있는 곳. 임장 중에는 이 점이 기준이라 물건 위에 그린다.
  // GPS 오차만큼 원을 함께 그려서 "이 안 어딘가"임을 숨기지 않는다.
  useEffect(() => {
    if (!hereLayer.current) return
    hereLayer.current.clearLayers()
    if (!here) return
    if (here.acc > 30) {
      L.circle([here.lat, here.lon], {
        radius: here.acc, weight: 1, color: HERE_COLOR, opacity: 0.5,
        fillColor: HERE_COLOR, fillOpacity: 0.1,
      }).addTo(hereLayer.current)
    }
    L.circleMarker([here.lat, here.lon], {
      radius: 7, weight: 3, color: '#fff', fillColor: HERE_COLOR, fillOpacity: 1,
    }).bindTooltip('지금 계신 곳', { direction: 'top' }).addTo(hereLayer.current)
    map.current.setView([here.lat, here.lon], Math.max(map.current.getZoom(), 15))
  }, [here])

  // 역은 조건과 무관하게 늘 같은 자리라 따로 그린다. 통근 판단의 기준점이다.
  useEffect(() => {
    if (!stnLayer.current) return
    stnLayer.current.clearLayers()
    for (const s of stations ?? []) {
      L.circleMarker([s.lat, s.lon], {
        radius: 3.5, weight: 0, fillColor: STATION_COLOR, fillOpacity: 0.7,
        interactive: true,
      }).bindTooltip(s.name, { direction: 'top' }).addTo(stnLayer.current)
    }
  }, [stations])

  return (
    <figure className="mapwrap">
      <div ref={holder} className="map" />
      <p className="map-legend">
        {LEGEND.map(([color, label]) => (
          <span key={label}><i style={{ background: color }} />{label}</span>
        ))}
      </p>
      <figcaption className="muted-line">
        {points.length > MAX_PINS
          ? `조건에 맞는 ${points.length.toLocaleString()}개 중 상위 ${MAX_PINS.toLocaleString()}개만 표시합니다. 조건을 좁히면 전부 보입니다.`
          : `${points.length.toLocaleString()}개 표시`}
        {note ? ` · ${note}` : ''}
      </figcaption>
    </figure>
  )
}
