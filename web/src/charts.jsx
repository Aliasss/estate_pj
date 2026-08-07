import { useCallback, useMemo, useRef, useState } from 'react'

const PAD = { top: 10, right: 46, bottom: 22, left: 42 }

function niceTicks(min, max, count = 4) {
  const span = max - min || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const start = Math.ceil(min / step) * step
  const ticks = []
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

/**
 * 시계열 꺾은선. 여러 계열은 같은 단위일 때만 한 축에 올린다.
 * 축이 둘 필요한 지표는 차트를 나눈다. 이중 축은 쓰지 않는다.
 */
export function LineChart({ months, series, format, provisional = [], height = 190 }) {
  const [hover, setHover] = useState(null)
  const ref = useRef(null)
  const W = 640, H = height
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom

  const values = series.flatMap((s) => s.values.filter((v) => v != null))
  const lo = Math.min(...values), hi = Math.max(...values)
  const ticks = useMemo(() => niceTicks(lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08), [lo, hi])
  const yMin = Math.min(ticks[0], lo), yMax = Math.max(ticks.at(-1), hi)

  const x = (i) => PAD.left + (months.length < 2 ? iw / 2 : (i / (months.length - 1)) * iw)
  const y = (v) => PAD.top + ih - ((v - yMin) / (yMax - yMin || 1)) * ih

  const move = useCallback((e) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const px = ((e.clientX ?? e.touches?.[0]?.clientX) - box.left) / box.width * W
    const i = Math.max(0, Math.min(months.length - 1,
      Math.round(((px - PAD.left) / iw) * (months.length - 1))))
    setHover(i)
  }, [months.length, iw])

  const firstProv = provisional.length ? months.indexOf(provisional[0]) : -1
  const labelIdx = months.map((_, i) => i).filter((i) =>
    i === 0 || i === months.length - 1 || months[i].endsWith('-01'))

  return (
    <figure className="plot">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label={`${series.map((s) => s.name).join(', ')} 월별 추이`}
           onMouseMove={move} onMouseLeave={() => setHover(null)}
           onTouchStart={move} onTouchMove={move} onTouchEnd={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={PAD.left} x2={PAD.left + iw} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 6} y={y(t) + 3} textAnchor="end">{format.tick(t)}</text>
          </g>
        ))}

        {firstProv > 0 && (
          <g>
            <rect x={x(firstProv)} y={PAD.top} width={PAD.left + iw - x(firstProv)} height={ih}
                  fill="var(--text-muted)" opacity="0.07" />
            <text className="axis" x={x(firstProv) + 3} y={PAD.top + 9}>잠정</text>
          </g>
        )}

        {labelIdx.map((i) => (
          <text key={i} className="axis" x={x(i)} y={H - 6}
                textAnchor={i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle'}>
            {months[i].slice(2).replace('-', '.')}
          </text>
        ))}

        {series.map((s) => {
          const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean)
          if (!pts.length) return null
          const last = s.values.findLastIndex((v) => v != null)
          return (
            <g key={s.name}>
              <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ')}
                    fill="none" stroke={s.color} strokeWidth="2"
                    strokeLinejoin="round" strokeLinecap="round" />
              {/* 계열 끝에 직접 라벨을 붙여 색만으로 식별하지 않게 한다 */}
              <text x={x(last) + 6} y={y(s.values[last]) + 3} fontSize="10.5"
                    fill="var(--text-secondary)">{s.short}</text>
            </g>
          )
        })}

        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih}
                  stroke="var(--text-muted)" strokeWidth="1" opacity="0.5" />
            {series.map((s) => s.values[hover] != null && (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r="4.5"
                      fill={s.color} stroke="var(--surface-1)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>

      {hover != null && (
        <div className="tip" style={{
          left: `${Math.min(88, Math.max(0, (x(hover) / W) * 100))}%`,
          top: 4, transform: (x(hover) / W) > 0.6 ? 'translateX(-104%)' : 'none',
        }}>
          <b>{months[hover]}{provisional.includes(months[hover]) ? ' (잠정)' : ''}</b>
          {series.map((s) => (
            <div className="row" key={s.name}>
              <span><i className="swatch" style={{ background: s.color, display: 'inline-block', marginRight: 5 }} />{s.name}</span>
              <span>{s.values[hover] == null ? '—' : format.value(s.values[hover])}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  )
}

/** 25개 구 크기 비교. 순위가 아니라 크기가 일이므로 한 색 막대를 쓴다. */
export function RankBars({ items, format, selected, onSelect }) {
  const max = Math.max(...items.map((d) => d.value))
  return (
    <div className="rank">
      {items.map((d) => (
        <div key={d.key} className="rank-row" role="button" tabIndex={0}
             aria-current={d.key === selected}
             onClick={() => onSelect?.(d.key)}
             onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect?.(d.key))}>
          <span className="rank-name">{d.label}</span>
          <span className="track"><span className="fill" style={{ width: `${(d.value / max) * 100}%` }} /></span>
          <span className="rank-val">{format(d.value)}</span>
        </div>
      ))}
    </div>
  )
}
