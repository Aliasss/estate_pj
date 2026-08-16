#!/usr/bin/env python3
"""물건 → 표고·경사·역과의 고도차.

collect_dem.py가 geo.sqlite에 구워 둔 지형을 빌드 때 물건에 붙인다.
경사는 그 지번 주변 240m 스팬의 기울기(%)이고, 역과의 고도차는
"역까지 가는 길이 오르막인가"에 대한 근사다. 위성 지형(DSM) 기반
근사치라는 한계는 화면 문구가 "약"으로 나른다.
"""

from __future__ import annotations

import sqlite3


class Terrain:
    def __init__(self, geo_db: str | None):
        self.ready = False
        self.hit = 0
        if not geo_db:
            return
        try:
            conn = sqlite3.connect(geo_db)
            self.rows = {
                (lawd, umd, jibun): (elev, slope)
                for lawd, umd, jibun, elev, slope in conn.execute(
                    "SELECT lawd_cd, umd_nm, jibun, elev_m, slope_pct FROM terrain")
            }
            self.stn_elev = dict(conn.execute("SELECT idx, elev_m FROM station_elev"))
            conn.close()
            self.ready = bool(self.rows)
        except sqlite3.Error:
            return                       # 테이블이 아직 없다. 열은 None으로 나간다

    def lookup(self, lawd: str, umd: str, jibun: str | None, stn: int | None) -> dict:
        if not self.ready:
            return {}
        row = self.rows.get((lawd, (umd or "").strip(), (jibun or "").strip()))
        if not row:
            return {}
        elev, slope = row
        out = {}
        if slope is not None:
            out["slope"] = slope
        # 역과의 고도차. +면 집이 역보다 높다(퇴근길이 오르막이다).
        if elev is not None and stn is not None:
            se = self.stn_elev.get(stn)
            if se is not None:
                out["stn_dh"] = round(elev - se)
        if out:
            self.hit += 1
        return out

    def report(self) -> str:
        if not self.ready:
            return "지형 없이 생성 (terrain 테이블 없음)"
        return f"지형 조인: 물건 {self.hit:,}개 · 원천 지번 {len(self.rows):,}건"
