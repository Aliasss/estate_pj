#!/usr/bin/env python3
"""물건 → 인근 학교 개수.

"근처에 초등학교가 있나"는 통학 거리 문제라 반경으로 센다. 초·중·고는
도보 통학권으로 1km, 대학은 통학보다 상권·소음·임대 수요의 문제라 2km.
화면에는 "반경 1km"로 표기한다 — 반경은 그 자체로 직선거리 개념이라
하천·간선도로로 실제 통학로가 더 멀 수 있다는 한계까지 함께 전달된다.

subway_join과 같은 격자 방식이다. 학교 1만 2천 × 물건 수만 개를 다 재지
않고, 물건이 속한 격자 주변만 본다.
"""

from __future__ import annotations

import json
import math

from subway_join import haversine

RADIUS_M = {"e": 1000.0, "m": 1000.0, "h": 1000.0, "u": 2000.0}
LEVELS = ("e", "m", "h", "u")


class Schools:
    """학교 좌표를 레벨별 격자에 담아 두고, 좌표 하나에 대해 레벨별 개수를 센다."""

    CELL = 0.02          # 위경도 0.02도. 경도 쪽은 위도 37도에서 약 1.77km다.

    def __init__(self, schools_path: str | None):
        self.ready = bool(schools_path)
        self.hit = 0
        if not self.ready:
            return
        with open(schools_path, encoding="utf-8") as fh:
            data = json.load(fh)["schools"]
        # None인 레벨은 "미수집"이다. 빈 격자로 만들면 모든 물건에 0을 세어
        # "없음"으로 단정하게 되므로, 레벨 자체를 빼서 그 열이 None으로 나가게 한다.
        self.levels = tuple(lv for lv in LEVELS if data.get(lv) is not None)
        self.grid: dict[str, dict[tuple[int, int], list[tuple[float, float]]]] = {}
        for level in self.levels:
            g: dict[tuple[int, int], list[tuple[float, float]]] = {}
            for lat, lon in data[level]:
                g.setdefault((int(lat / self.CELL), int(lon / self.CELL)), []).append((lat, lon))
            self.grid[level] = g

    def counts(self, lat: float | None, lon: float | None) -> dict:
        """{'sch_e': n, ...}. 좌표가 없으면 빈 dict — 0과 '모름'은 다르다."""
        if not self.ready or lat is None or lon is None:
            return {}
        cy, cx = int(lat / self.CELL), int(lon / self.CELL)
        out = {}
        for level in self.levels:
            radius = RADIUS_M[level]
            # 봐야 하는 이웃 칸 수는 반경이 정한다. 경도 1도는 위도 37도에서
            # 약 88km라 0.02도 칸이 1.77km밖에 안 되고, 물건이 칸 가장자리에
            # 있으면 반경 2km가 두 칸째까지 걸친다. 3x3 고정이면 그 학교를 놓친다.
            ring = math.ceil(radius / 88000.0 / self.CELL)
            n = 0
            for dy in range(-ring, ring + 1):
                for dx in range(-ring, ring + 1):
                    for slat, slon in self.grid[level].get((cy + dy, cx + dx), ()):
                        if haversine(lat, lon, slat, slon) <= radius:
                            n += 1
            out[f"sch_{level}"] = n
        self.hit += 1
        return out

    def report(self) -> str:
        if not self.ready:
            return "학교 없이 생성 (schools.json 없음)"
        total = {lv: (sum(len(v) for v in self.grid[lv].values())
                      if lv in self.levels else "미수집") for lv in LEVELS}
        return (f"학교 조인: 물건 {self.hit:,}개 · 원천 초 {total['e']} 중 {total['m']} "
                f"고 {total['h']} 대 {total['u']}")
