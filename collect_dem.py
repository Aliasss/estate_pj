#!/usr/bin/env python3
"""좌표 → 표고·경사. 언덕 위 집인지 미리 알려주는 데이터.

임장에서 "지도로는 몰랐는데 가 보니 가파른 언덕"이라는 낭패가 반복된다.
NASA SRTM 지형 자료(30m 격자, 키 불요)로 지번마다 표고와 주변 경사를
계산해 geo.sqlite에 붙인다. 좌표 수집이 끝난 지번만 대상이므로
지오코딩 뒤에 돈다.

한계를 알고 쓴다: SRTM은 지표가 아니라 지표+건물(DSM)을 잰 것이라
고층 건물 옆에서 표고가 튄다. 두 가지로 누른다.
  - 표본마다 중앙값 필터(표고 3x3, 경사 표본 5x5)로 화소 튐을 걸러낸다
  - 경사는 ±4셀(약 240m 스팬) 기울기로 잰다. 고층 단지 하나보다 넓고
    동네 언덕보다는 좁은 크기다. 실측으로 고른 값이다.
그래도 근사치다. 화면 문구도 "약"을 떼지 않는다.

사용법
    python collect_dem.py --db geo.sqlite --subway subway.json
    python collect_dem.py --probe 37.5512 126.9882   # 남산 자락 확인
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sqlite3
import struct
import sys

import requests

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/skadi/{ns}/{ns}{ew}.hgt.gz"
N = 3601                     # 1아크초 타일 한 변 표본 수
VOID = -32768


class Dem:
    """타일을 통째로 메모리에 올린다. 타일 하나 25MB, 수도권은 6장이면 된다."""

    def __init__(self, cache_dir: str = "dem_tiles"):
        self.cache = cache_dir
        self.tiles: dict[tuple[int, int], bytes] = {}
        os.makedirs(cache_dir, exist_ok=True)

    def _tile(self, lat_i: int, lon_i: int) -> bytes | None:
        key = (lat_i, lon_i)
        if key in self.tiles:
            return self.tiles[key]
        ns = f"N{lat_i:02d}" if lat_i >= 0 else f"S{-lat_i:02d}"
        ew = f"E{lon_i:03d}" if lon_i >= 0 else f"W{-lon_i:03d}"
        path = os.path.join(self.cache, f"{ns}{ew}.hgt")
        if not os.path.exists(path):
            url = TILE_URL.format(ns=ns, ew=ew)
            res = requests.get(url, timeout=120)
            if res.status_code == 404:          # 바다 타일 등
                self.tiles[key] = None
                return None
            res.raise_for_status()
            with open(path, "wb") as fh:
                fh.write(gzip.decompress(res.content))
            print(f"  타일 {ns}{ew} 내려받음 ({os.path.getsize(path) / 1e6:.0f}MB)")
        with open(path, "rb") as fh:
            self.tiles[key] = fh.read()
        return self.tiles[key]

    def _raw(self, lat: float, lon: float) -> int | None:
        """가장 가까운 격자점의 원시 표고. 없는 값(VOID)은 None."""
        lat_i, lon_i = math.floor(lat), math.floor(lon)
        tile = self._tile(lat_i, lon_i)
        if tile is None:
            return None
        row = round((lat_i + 1 - lat) * (N - 1))
        col = round((lon - lon_i) * (N - 1))
        row = min(max(row, 0), N - 1)
        col = min(max(col, 0), N - 1)
        (v,) = struct.unpack_from(">h", tile, (row * N + col) * 2)
        return None if v == VOID else v

    def elev(self, lat: float, lon: float, k: int = 1) -> float | None:
        """(2k+1)² 중앙값. DSM의 화소 튐(고층 건물)을 누른다."""
        c = 1.0 / (N - 1)
        vals = [self._raw(lat + dy * c, lon + dx * c)
                for dy in range(-k, k + 1) for dx in range(-k, k + 1)]
        vals = sorted(v for v in vals if v is not None)
        return float(vals[len(vals) // 2]) if vals else None

    def slope_pct(self, lat: float, lon: float) -> float | None:
        """±4셀 중앙차분 기울기(%), 표본은 5x5 중앙값. 스팬 약 240m.

        실측 조정 결과다: ±2셀·3x3에서는 여의도·목동 같은 고층 평지가
        11~15%로 나왔다(건물 잡음). ±4셀·5x5는 같은 곳을 0.4~4.6%로
        누르면서 부암동(20%) 같은 실제 언덕은 그대로 남긴다."""
        c = 4.0 / (N - 1)
        e_n, e_s = self.elev(lat + c, lon, 2), self.elev(lat - c, lon, 2)
        e_e, e_w = self.elev(lat, lon + c, 2), self.elev(lat, lon - c, 2)
        if None in (e_n, e_s, e_e, e_w):
            return None
        dy_m = 2 * c * 111_320.0
        dx_m = 2 * c * 111_320.0 * math.cos(math.radians(lat))
        gy = (e_n - e_s) / dy_m
        gx = (e_e - e_w) / dx_m
        return round(math.hypot(gx, gy) * 100, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description="표고·경사 계산")
    parser.add_argument("--db", default="geo.sqlite")
    parser.add_argument("--subway", default="subway.json")
    parser.add_argument("--cache", default="dem_tiles")
    parser.add_argument("--probe", nargs=2, type=float, metavar=("LAT", "LON"))
    args = parser.parse_args()

    dem = Dem(args.cache)
    if args.probe:
        lat, lon = args.probe
        print(f"표고 {dem.elev(lat, lon)}m · 경사 {dem.slope_pct(lat, lon)}%")
        return 0

    conn = sqlite3.connect(args.db)
    conn.execute("""CREATE TABLE IF NOT EXISTS terrain (
        lawd_cd TEXT, umd_nm TEXT, jibun TEXT,
        elev_m REAL, slope_pct REAL,
        PRIMARY KEY (lawd_cd, umd_nm, jibun))""")
    conn.execute("CREATE TABLE IF NOT EXISTS station_elev (idx INTEGER PRIMARY KEY, elev_m REAL)")

    # 이미 계산한 지번은 건너뛴다. 지형은 변하지 않는다.
    done = {(r[0], r[1], r[2]) for r in conn.execute(
        "SELECT lawd_cd, umd_nm, jibun FROM terrain")}
    rows = conn.execute(
        "SELECT lawd_cd, umd_nm, jibun, lat, lon FROM coords "
        "WHERE status='ok' AND lat IS NOT NULL").fetchall()
    todo = [r for r in rows if (r[0], r[1], r[2]) not in done]
    print(f"좌표 {len(rows):,}건 중 계산 대상 {len(todo):,}건 (완료 {len(done):,}건)")

    n_void = 0
    for i, (lawd, umd, jibun, lat, lon) in enumerate(todo, 1):
        e = dem.elev(lat, lon)
        s = dem.slope_pct(lat, lon) if e is not None else None
        if e is None:
            n_void += 1
        conn.execute("INSERT OR REPLACE INTO terrain VALUES (?,?,?,?,?)",
                     (lawd, umd, jibun, e, s))
        if i % 10000 == 0:
            conn.commit()
            print(f"  [{i:,}/{len(todo):,}]")
    conn.commit()

    # 역 표고. 역까지 가는 길이 오르막인지 내리막인지 빌드에서 견주게 된다.
    if os.path.exists(args.subway):
        with open(args.subway, encoding="utf-8") as fh:
            coords = json.load(fh)["coords"]
        for idx, (lat, lon) in enumerate(coords):
            conn.execute("INSERT OR REPLACE INTO station_elev VALUES (?,?)",
                         (idx, dem.elev(lat, lon)))
        conn.commit()
        print(f"역 표고 {len(coords)}건 기록")
    else:
        print(f"{args.subway} 없음 — 역 표고 생략 (역 고도차 열이 비게 된다)")

    total = conn.execute("SELECT COUNT(*), AVG(slope_pct) FROM terrain WHERE elev_m IS NOT NULL").fetchone()
    avg = f"{total[1]:.1f}%" if total[1] is not None else "—"
    print(f"terrain {total[0]:,}건 (표고 없음 {n_void}건) · 평균 경사 {avg}")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
