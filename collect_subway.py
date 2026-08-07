#!/usr/bin/env python3
"""지하철역 좌표와 노선 정보 수집 → subway.json.

통근 시간은 이 앱에서 사용자마다 다른 유일한 조건이다. 그래서 목적지를 앱에서
고르게 하고, 계산에 필요한 것만 미리 구워 둔다.

  물건 → 가장 가까운 역   서버에서 미리 계산 (좌표가 있어야 한다)
  역 → 역 소요시간        여기서 만드는 인접 그래프로 앱이 계산
  목적지 역               사용자가 고른다

목적지를 주소가 아니라 역으로 받는 게 핵심이다. 주소를 받으면 지오코딩 API가
사용자 손에 필요해지는데, "직장 근처 역"은 누구나 알고 있다.

자료원은 서울 열린데이터광장이다. 인증키는 무료·즉시 발급이고, 샘플키(sample)로
형식을 먼저 확인했다 — 역 784개에 위경도가 그대로 들어 있다.

사용법
    export SEOUL_OPENAPI_KEY="열린데이터광장 인증키"
    python collect_subway.py --out web/data/subway.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict

import requests

BASE = "http://openapi.seoul.go.kr:8088"
# 역 좌표. BLDN_ID(역사 ID) 기준이라 환승역은 노선 수만큼 행이 나온다.
MASTER = "subwayStationMaster"
# 노선별 역 목록. STATION_CD가 역 순서를 담고 있어 인접 관계를 여기서 만든다.
LINES = "SearchSTNBySubwayLineInfo"
PAGE = 1000

# 응답에 인증키가 되비쳐 나오는 경우가 있다
KEY_RE = re.compile(r"(openapi\.seoul\.go\.kr:\d+/)[A-Za-z0-9]{16,}")


def fetch_all(key: str, service: str) -> list[dict]:
    """열린데이터광장은 1회 1,000행이 상한이라 끝까지 넘긴다."""
    rows: list[dict] = []
    start = 1
    while True:
        url = f"{BASE}/{key}/json/{service}/{start}/{start + PAGE - 1}/"
        res = requests.get(url, timeout=30)
        res.raise_for_status()
        body = res.json().get(service)
        if not body:
            safe = KEY_RE.sub(r"\1***", res.text[:200])
            raise RuntimeError(f"{service}: 예상 밖 응답 — {safe}")
        result = body.get("RESULT", {})
        if result.get("CODE") not in ("INFO-000", None):
            raise RuntimeError(f"{service}: [{result.get('CODE')}] {result.get('MESSAGE')}")
        batch = body.get("row") or []
        rows.extend(batch)
        total = body.get("list_total_count", 0)
        print(f"  {service} {len(rows):,}/{total:,}", flush=True)
        if len(rows) >= total or not batch:
            return rows
        start += PAGE


def norm_line(name: str) -> str:
    """'01호선' 과 '1호선' 이 자료마다 섞여 나온다."""
    text = (name or "").strip()
    m = re.match(r"0*(\d+)호선", text)
    return f"{m.group(1)}호선" if m else text


def norm_station(name: str) -> str:
    """'서울역(1)' 같은 괄호 표기와 공백을 걷어낸다."""
    return re.sub(r"\s+", "", re.sub(r"\([^)]*\)", "", name or ""))


def build(master: list[dict], lines: list[dict]) -> dict:
    """역 목록과 인접 그래프를 만든다.

    환승은 같은 이름의 역을 하나로 묶어 처리한다. 역사 ID로는 환승이 안 붙는데,
    사용자에게는 '시청역'이 하나이지 1호선 시청과 2호선 시청이 따로가 아니다.
    """
    # 이름 -> 좌표(여러 노선이면 평균). 위경도가 비어 있는 행이 섞여 있다.
    pts: dict[str, list[tuple[float, float]]] = defaultdict(list)
    routes: dict[str, set] = defaultdict(set)
    for r in master:
        name = norm_station(r.get("BLDN_NM"))
        try:
            lat, lot = float(r.get("LAT")), float(r.get("LOT"))
        except (TypeError, ValueError):
            continue
        if not name or not (33 < lat < 39 and 124 < lot < 132):
            continue
        pts[name].append((lat, lot))
        routes[name].add(norm_line(r.get("ROUTE")))

    stations = sorted(pts)
    index = {name: i for i, name in enumerate(stations)}

    # 노선별로 STATION_CD 순서대로 늘어놓고 이웃끼리 잇는다.
    by_line: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for r in lines:
        name = norm_station(r.get("STATION_NM"))
        code = (r.get("STATION_CD") or "").strip()
        if name in index and code:
            by_line[norm_line(r.get("LINE_NUM"))].append((code, name))

    edges: set[tuple[int, int]] = set()
    for line, items in by_line.items():
        ordered = [n for _, n in sorted(set(items))]
        for a, b in zip(ordered, ordered[1:]):
            if a != b:
                edges.add(tuple(sorted((index[a], index[b]))))

    coords = [[round(sum(p[0] for p in pts[n]) / len(pts[n]), 6),
               round(sum(p[1] for p in pts[n]) / len(pts[n]), 6)] for n in stations]
    return {
        "stations": stations,
        "coords": coords,
        "routes": [sorted(routes[n]) for n in stations],
        "edges": sorted(edges),
    }


def sanity(data: dict) -> None:
    """붙였다고 다 된 게 아니다. 끊긴 노선이 있으면 통근 시간이 통째로 틀린다."""
    n = len(data["stations"])
    adj: dict[int, set] = defaultdict(set)
    for a, b in data["edges"]:
        adj[a].add(b)
        adj[b].add(a)
    seen, stack = {0}, [0]
    while stack:
        cur = stack.pop()
        for nxt in adj[cur] - seen:
            seen.add(nxt)
            stack.append(nxt)
    lone = [data["stations"][i] for i in range(n) if not adj[i]]
    print(f"\n역 {n:,}개 · 구간 {len(data['edges']):,}개")
    print(f"한 덩어리로 이어진 역 {len(seen):,}개 ({len(seen) / n:.0%})")
    if lone:
        print(f"이웃이 없는 역 {len(lone)}개: {', '.join(lone[:8])}")
    # 눈으로 확인할 표본
    for name in ("서울역", "강남", "홍대입구", "여의도"):
        if name in data["stations"]:
            i = data["stations"].index(name)
            nb = [data["stations"][j] for j in sorted(adj[i])]
            print(f"  {name}: {'/'.join(data['routes'][i])} · 좌표 {data['coords'][i]} · 이웃 {nb}")


def main() -> int:
    parser = argparse.ArgumentParser(description="지하철역 좌표·노선 수집")
    parser.add_argument("--out", default="web/public/data/subway.json")
    args = parser.parse_args()

    key = os.environ.get("SEOUL_OPENAPI_KEY", "").strip()
    if not key:
        print("SEOUL_OPENAPI_KEY가 없습니다. data.seoul.go.kr에서 무료로 발급됩니다.",
              file=sys.stderr)
        return 2

    data = build(fetch_all(key, MASTER), fetch_all(key, LINES))
    sanity(data)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"\n{args.out}  {os.path.getsize(args.out) / 1e3:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
