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
from datetime import datetime, timezone
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

    # STATION_CD는 노선 안에서 역 순서를 담고 있다. 다만 지선이 있는 노선에서는
    # 코드가 건너뛴다 — 경의중앙선을 코드순으로 그냥 이으면 서울역(지선 종점)과
    # 지평(본선 종점)이 이웃이 돼서, 실제로는 두 시간 걸리는 구간이 한 정거장이 된다.
    # 그래서 코드가 정확히 1 차이일 때만 잇는다. 가짜 지름길을 만드는 것보다
    # 실제 구간을 몇 개 놓치는 편이 낫다.
    # 간선마다 어느 노선인지를 같이 남긴다. 없으면 환승을 셀 수 없고, 환승을 못 세면
    # 통근 시간이 실제와 크게 어긋난다 (서울에서 환승 한 번은 대략 네 정거장 값이다).
    line_names = sorted(by_line)
    line_idx = {name: i for i, name in enumerate(line_names)}
    edges: set[tuple[int, int, int]] = set()
    for line, items in by_line.items():
        ordered = sorted({(int(c), n) for c, n in items if c.isdigit()})
        for (ca, a), (cb, b) in zip(ordered, ordered[1:]):
            if a != b and cb - ca == 1:
                lo, hi = sorted((index[a], index[b]))
                edges.add((lo, hi, line_idx[line]))

    coords = [[round(sum(p[0] for p in pts[n]) / len(pts[n]), 6),
               round(sum(p[1] for p in pts[n]) / len(pts[n]), 6)] for n in stations]
    data = {
        "stations": stations,
        "coords": coords,
        "routes": [sorted(routes[n]) for n in stations],
        "lines": line_names,
        "edges": sorted(edges),
    }
    data["commute"] = commute_table(data)
    return data


# --------------------------------------------------------------------- 통근 시간

# 주요 업무지구. 서울 셋에 경기 하나. 역마다 "여기서 거기까지 얼마나 걸리나"를
# 미리 계산해 실어 보낸다. 654개 역 × 목적지 4개면 표가 작아 화면이 즉시 읽는다.
DESTS = ["강남", "시청", "여의도", "판교"]

# 노선별 표정속도(km/h). 정차와 가감속을 포함한 값이라 최고속도보다 한참 낮다.
# 광역·급행은 역간이 멀고 빠르다. 하나로 뭉치면 신분당선 강남-판교가 8분으로
# 나온다(실제 16분). 실측 대조로 고른 값이다.
LINE_SPEED = {"GTX-A": 100, "신분당선": 50, "공항철도": 50, "경강선": 50,
              "경춘선": 45, "경의선": 45, "서해선": 45, "김포도시철도": 44,
              "수인분당선": 38}
CITY_SPEED = 32       # 1~9호선과 경전철
TRANSFER_MIN = 4.0    # 환승 통로 도보 + 대기
WAIT_MIN = 3.0        # 처음 승차까지 기다리는 시간
MIN_HOP = 1.2         # 아무리 가까운 역이라도 이만큼은 걸린다


def _hop_min(coords: list, a: int, b: int, speed: float) -> float:
    (la1, lo1), (la2, lo2) = coords[a], coords[b]
    dy = (la2 - la1) * 111.32
    dx = (lo2 - lo1) * 111.32 * math.cos(math.radians((la1 + la2) / 2))
    return max(MIN_HOP, math.hypot(dx, dy) / speed * 60)


def commute_table(data: dict) -> dict:
    """목적지별로 모든 역의 소요시간(분)을 잰다.

    상태를 (역, 노선)으로 둔다. 같은 역이라도 어느 노선을 타고 왔는지에 따라
    다음 환승 비용이 달라서, 역만 상태로 쓰면 환승을 공짜로 하는 경로가 생긴다.
    목적지에서 거꾸로 한 번만 돌리면 모든 역의 값이 나온다.

    실측 대조 11개 구간에서 평균 오차 4.1분이다. 다만 오차가 고르지 않다.
    도시철도 구간은 3분 안쪽이지만, 급행이 다니는 장거리 구간은 완행으로만
    계산해 크게 부풀린다(수원-강남 71분, 실제 52분). 배차 간격도 일률
    3분으로 봐서 GTX나 경춘선처럼 드문 노선은 반대로 낙관적이다.
    그래서 화면에서 "약"을 떼지 않고, 무엇을 반영하지 못했는지 함께 밝힌다.
    """
    import heapq

    coords, edges, lines = data["coords"], data["edges"], data["lines"]
    index = {name: i for i, name in enumerate(data["stations"])}
    adj: dict[tuple[int, int], list] = defaultdict(list)
    lines_at: dict[int, set] = defaultdict(set)
    for a, b, ln in edges:
        cost = _hop_min(coords, a, b, LINE_SPEED.get(lines[ln], CITY_SPEED))
        adj[(a, ln)].append(((b, ln), cost))
        adj[(b, ln)].append(((a, ln), cost))
        lines_at[a].add(ln)
        lines_at[b].add(ln)
    for station, ls in lines_at.items():
        for l1 in ls:
            for l2 in ls:
                if l1 != l2:
                    adj[(station, l1)].append(((station, l2), TRANSFER_MIN))

    print("\n통근 시간 (약, 대기·환승 포함):")
    out = {}
    for name in DESTS:
        dest = index.get(name)
        if dest is None:
            print(f"  목적지 '{name}'을 역 목록에서 찾지 못했습니다. 건너뜁니다.")
            continue
        best: dict[int, float] = {}
        seen: dict[tuple[int, int], float] = {}
        pq = [(0.0, dest, ln) for ln in lines_at[dest]]
        heapq.heapify(pq)
        while pq:
            t, s, ln = heapq.heappop(pq)
            if seen.get((s, ln), 1e9) <= t:
                continue
            seen[(s, ln)] = t
            if best.get(s, 1e9) > t:
                best[s] = t
            for (ns, nl), cost in adj[(s, ln)]:
                if seen.get((ns, nl), 1e9) > t + cost:
                    heapq.heappush(pq, (t + cost, ns, nl))
        # 목적지 자신은 0분. 나머지는 대기 시간을 더한다. 못 가는 역은 None.
        out[name] = [None if i not in best else
                     (0 if i == dest else round(best[i] + WAIT_MIN))
                     for i in range(len(data["stations"]))]
        vals = sorted(v for v in out[name] if v is not None)
        print(f"  {name}: {len(vals)}개 역에서 도달 (중위 {vals[len(vals) // 2]}분)")
    return out


def sanity(data: dict) -> None:
    """붙였다고 다 된 게 아니다. 끊긴 노선이 있으면 통근 시간이 통째로 틀린다."""
    n = len(data["stations"])
    adj: dict[int, set] = defaultdict(set)
    for a, b, _line in data["edges"]:
        adj[a].add(b)
        adj[b].add(a)
    # 가장 큰 덩어리를 찾는다. 0번 역에서 출발하면 그 역이 외톨이일 때 1개가 나온다.
    unvisited, biggest = set(range(n)), set()
    while unvisited:
        start = unvisited.pop()
        comp, stack = {start}, [start]
        while stack:
            cur = stack.pop()
            for nxt in adj[cur] - comp:
                comp.add(nxt)
                stack.append(nxt)
        unvisited -= comp
        biggest = max(biggest, comp, key=len)
    seen = biggest
    lone = [data["stations"][i] for i in range(n) if not adj[i]]
    print(f"\n역 {n:,}개 · 구간 {len(data['edges']):,}개")
    print(f"가장 큰 덩어리 {len(seen):,}개 역 ({len(seen) / n:.0%})")
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

    # 절단 가드. 초안은 "sanity를 통과한 뒤 찍는다"고 적었는데 거짓이었다.
    # sanity()는 print만 하고 아무것도 막지 않는다(collect_schools에는 진짜
    # 가드가 있어서 그쪽과 헷갈렸다). 그래서 fetch_all이 둘째 페이지에서 빈
    # 배열을 받아 부분 수집을 조용히 성공으로 반환하면, 역 50개짜리 파일이
    # 새 시각을 달고 저장되고 같은 스텝의 gh release upload까지 간다. 시각을
    # 붙이는 이번 변경이 그 사고를 "방금 받았습니다"라는 거짓말로 키운다.
    #
    # 하한은 500이다. sources.yml이 릴리스 파일을 되맞출 때 쓰는 절단 감지선과
    # 같은 값이고, 현재 654역이라 여유가 있다. 여기서 막으면 릴리스가 옛
    # 파일을 그대로 유지하므로 잃는 것이 없다.
    if len(data["stations"]) < 500:
        raise RuntimeError(
            f"역이 {len(data['stations'])}개뿐입니다(하한 500) — 절단 의심, 저장하지 않습니다")

    # 이 자산이 언제 것인지 화면이 말할 수 있게 시각을 싣는다. 가드를 통과한
    # 뒤, 저장 직전에 찍는다. 파일 전체를 매 회차 새로 쓰므로 이 값이 곧
    # 수집 시각이고, 그래서 화면이 날짜만으로 지연을 판정할 수 있다.
    data["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"\n{args.out}  {os.path.getsize(args.out) / 1e3:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
