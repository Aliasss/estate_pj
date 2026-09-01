#!/usr/bin/env python3
"""물건 → 가장 가까운 지하철역과 도보 시간.

통근 시간은 사람마다 목적지가 달라서 앱에서 계산해야 한다. 그런데 매번 654개 역과의
거리를 재게 할 수는 없으니, 바뀌지 않는 절반 — "이 집에서 가장 가까운 역이 어디고
걸어서 몇 분인가" — 만 여기서 미리 굽는다.

    통근 시간 ≈ 도보(여기서 계산) + 역에서 역까지(앱에서 계산)

도보 속도는 분당 67m(시속 4km)로 잡고, 직선거리에 1.3을 곱한다. 실제로는 길을
돌아가야 하므로 직선거리를 그대로 쓰면 항상 낙관적으로 나온다.
"""

from __future__ import annotations

import json
import math
import sqlite3

# 도보 속도(m/분)와 우회 계수. 직선거리 × 1.3이 도시 보행의 통상 근사다.
WALK_SPEED = 67.0
DETOUR = 1.3
# 이보다 멀면 걸어갈 역이 아니다. 25분이면 버스를 타지 지하철역까지 걷지 않는다.
MAX_WALK_MIN = 25


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 점 사이 미터. 서울 규모에서는 이 정도 근사로 충분하다."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class Stations:
    """역 좌표를 격자로 나눠 둔다. 물건 4만 8천 개 × 역 654개를 그냥 다 재면
    3천만 번인데, 격자로 자르면 주변 몇 개만 보면 된다."""

    CELL = 0.02          # 위경도 0.02도 ≈ 2km

    def __init__(self, subway_path: str):
        with open(subway_path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.names = data["stations"]
        # 옛 자산에는 없다. 그때 None이고 화면은 아무 말도 하지 않는다.
        self.at = data.get("at")
        self.coords = data["coords"]
        self.grid: dict[tuple[int, int], list[int]] = {}
        for i, (lat, lon) in enumerate(self.coords):
            self.grid.setdefault((int(lat / self.CELL), int(lon / self.CELL)), []).append(i)

    def nearest(self, lat: float, lon: float) -> tuple[int, float] | None:
        """(역 번호, 미터). 반경을 넓혀 가며 찾는다."""
        cy, cx = int(lat / self.CELL), int(lon / self.CELL)
        for ring in (1, 2, 3, 6):
            cands = [i for dy in range(-ring, ring + 1) for dx in range(-ring, ring + 1)
                     for i in self.grid.get((cy + dy, cx + dx), ())]
            if cands:
                best = min(cands, key=lambda i: haversine(lat, lon, *self.coords[i]))
                return best, haversine(lat, lon, *self.coords[best])
        return None


def walk_minutes(meters: float) -> int:
    return max(1, round(meters * DETOUR / WALK_SPEED))


def coords_at(db_path: str) -> str | None:
    """좌표를 마지막으로 받은 시각. bldg_join.state와 같은 규율이다.

    error 행은 뺀다. 키가 죽었거나 망이 막혀 전부 실패한 회차도 coords에 행을
    남기는데, 그 시각을 집으면 한 건도 못 받은 상태에서 화면이 "9월 1일까지
    받았습니다"라고 단언한다. notfound는 남긴다. 그건 정말 받아서 "이 주소에는
    좌표가 없다"를 확인한 것이고, 다음 회차 계획에서 그 지번을 빼는 근거이기도
    하다(geocode.py의 done 질의가 같은 기준을 쓴다).

    잡는 예외는 OperationalError가 아니라 sqlite3.Error다. connect는 파일이
    DB가 아니어도 성공하고 첫 질의에서 DatabaseError가 나는데, 그건
    OperationalError의 상위라 좁게 잡으면 안 걸린다.

    다만 이 catch가 막는 것은 "coords 표가 아직 없는 DB"까지다. 손상된 파일은
    바로 아래 Nearest.__init__의 본 질의가 감싸지 않은 채 다시 읽으므로 거기서
    그대로 죽는다. 초안 주석이 "재조인 전체를 죽이는 것을 막는다"고 썼는데
    과장이었다. 그 방어를 정말 하려면 본 질의도 Terrain처럼 감싸야 하고, 그건
    "좌표 0개인 units를 발행 가드에 맡긴다"는 다른 판단이라 여기서 같이 하지
    않는다.
    """
    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.Error:
        return None
    try:
        return conn.execute(
            "SELECT MAX(fetched_at) FROM coords WHERE status <> 'error'").fetchone()[0]
    except sqlite3.Error:
        return None
    finally:
        conn.close()


class Nearest:
    """지번으로 (역 번호, 도보 분)을 꺼낸다. 좌표가 없으면 빈 값."""

    def __init__(self, geo_db: str | None, subway_path: str | None):
        self.ready = bool(geo_db and subway_path)
        self.hit = self.miss = self.far = 0
        # 좌표 수집 시각은 지하철 자료와 무관하다. ready 뒤에 두면, subway.json을
        # 못 구해 파일을 지운 회차에 화면의 좌표 기준일이 통째로 사라진다. 그
        # 경로는 sources.yml에 실재한다("맞추지 못하면 파일을 지워 역 표고
        # 계산을 건너뛴다"). 좌표는 그때도 멀쩡히 받은 것이므로 먼저 잰다.
        self.at = coords_at(geo_db) if geo_db else None
        self.sub_at = None
        if not self.ready:
            return
        self.stations = Stations(subway_path)
        self.sub_at = self.stations.at
        conn = sqlite3.connect(geo_db)
        self.coords = {
            (lawd, umd, jibun): (lat, lon)
            for lawd, umd, jibun, lat, lon in conn.execute(
                "SELECT lawd_cd, umd_nm, jibun, lat, lon FROM coords "
                "WHERE status='ok' AND lat IS NOT NULL")
        }
        conn.close()

    def lookup(self, lawd: str, umd: str, jibun: str | None) -> dict:
        """좌표와 최근접역. 지도는 좌표만 있으면 그릴 수 있으므로 둘을 따로 낸다 —
        역이 멀어 통근 계산을 못 하는 물건도 지도에는 찍혀야 한다."""
        if not self.ready:
            return {}
        point = self.coords.get((lawd, (umd or "").strip(), (jibun or "").strip()))
        if not point:
            self.miss += 1
            return {}
        here = {"lat": round(point[0], 5), "lon": round(point[1], 5)}
        found = self.stations.nearest(*point)
        if not found:
            self.miss += 1
            return here
        idx, meters = found
        minutes = walk_minutes(meters)
        if minutes > MAX_WALK_MIN:
            # 역이 너무 멀다. 역 번호를 남기면 앱이 통근 시간을 계산해 버리는데
            # 걸어서 40분 걸리는 역을 기준으로 낸 값은 답이 아니라 잡음이다.
            self.far += 1
            return here
        self.hit += 1
        return {**here, "stn": idx, "walk": minutes}

    def report(self) -> str:
        if not self.ready:
            return "지하철 없이 생성 (좌표 또는 역 자료 없음)"
        tot = self.hit + self.miss + self.far
        if not tot:
            return "지하철 조인 대상 없음"
        return (f"최근접역 {self.hit:,}/{tot:,} ({self.hit / tot:.1%}) · "
                f"좌표 없음 {self.miss:,} · 도보 {MAX_WALK_MIN}분 초과 {self.far:,}")
