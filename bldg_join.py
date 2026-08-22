#!/usr/bin/env python3
"""건축물대장을 물건에 붙인다.

실거래가는 "얼마에 거래됐나"만 말한다. 집을 고를 때 실제로 보는 것 — 엘리베이터가
있나, 몇 세대짜리인가, 몇 년에 지었나, 주차가 되나 — 는 건축물대장에 있다.

좌표가 필요 없다. 지번(시군구·법정동·본번·부번)으로 그대로 붙는다.

층간소음에 대해. 처음에는 구조로 가를 생각이었는데 실측해 보니 안 된다.
공동주택 3,325동 중 90.2%가 철근콘크리트다. 대신 쓸 수 있는 것이 둘 있다.
  - 벽돌구조 9.1%. 이건 확실한 마이너스 신호다.
  - 사용승인일. 2005년 7월 표준바닥구조가 의무화됐고 표본의 28%가 그 이후다.
어느 쪽도 실측 소음이 아니라 추정이므로 화면에서 반드시 그렇게 밝혀야 한다.
"""

from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict

from collect_bldg import parse_jibun
from match_probe import norm_name

# 표준바닥구조 의무화(2005.7). 이전 준공은 층간소음 기준 자체가 없던 시절이다.
FLOOR_STANDARD_YEAR = 2005

# 구조를 그대로 내보내면 문자열이 길고 종류만 많다. 판단에 쓰는 세 갈래로 줄인다.
STRUCT_RC = "RC"        # 철근콘크리트 계열. 표본의 90%라 사실상 기준선
STRUCT_BRICK = "BR"     # 벽돌·블록조. 오래됐고 차음이 나쁘다
STRUCT_OTHER = "ET"


def struct_code(strct: str | None) -> str | None:
    if not strct:
        return None
    if "벽돌" in strct or "블록" in strct:
        return STRUCT_BRICK
    if "콘크리트" in strct:
        return STRUCT_RC
    return STRUCT_OTHER


def load(db_path: str) -> dict[tuple, list[dict]]:
    """(시군구, 법정동, 본번, 부번) -> 그 지번의 동들.

    한 지번에 여러 동이 있을 수 있어서 리스트로 둔다. 고르는 건 pick()이 한다.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    idx: dict[tuple, list[dict]] = defaultdict(list)
    for r in conn.execute(
        """
        SELECT lawd_cd, umd_nm, bun, ji, bld_nm, main_purps, strct, use_apr_day,
               grnd_flr, hhld_cnt, tot_area, elvt_cnt, park_cnt
        FROM buildings
        """
    ):
        idx[(r["lawd_cd"], (r["umd_nm"] or "").strip(), r["bun"], r["ji"])].append(dict(r))
    conn.close()
    return idx


def pick(cands: list[dict], name: str | None) -> dict | None:
    """한 지번의 표제부들을 단지 하나로 합친다.

    아파트 단지는 표제부가 동마다 따로 나온다. 평창동 롯데캐슬 로잔은 16행 —
    101~106동에 지하주차장 셋, 경비실, 동별 지하층까지 각각 한 행이다.
    이 중 하나만 집으면 "37세대 단지에 주차 375대"처럼 읽힌다. 37은 101동 세대수고
    375는 단지 공용 주차대수라 애초에 분모와 분자가 다른 값이었다.

    그래서 합치되, 항목마다 합치는 방식이 다르다.
      세대수·승강기·연면적  더한다 (동별 값)
      주차                최댓값 (단지 공용값이 모든 행에 반복된다. 더하면 16배가 된다)
                          단, 세대가 있는 동에서만 고른다. 예전에는 지번의 모든
                          행에서 골랐는데, 같은 지번에 근생·업무시설이 섞이면
                          그쪽 주차가 공동주택 값으로 나갔다. 전농SK(1,830세대)는
                          공동주택 행의 주차가 전부 자료 없음인데 옆 건물 97대가
                          잡혀 "세대당 0.1대"로 나갔다. 이렇게 남의 값이 실리던
                          지번이 19개였고 그중 10개는 경고까지 떴다. 대신 부속
                          주차장 동에만 기재된 131개 지번은 자료 없음이 된다.
                          틀린 숫자보다 빈칸이 낫다.
      사용승인일           가장 이른 것 (단지 준공)
      층수                가장 높은 것

    다세대는 대개 한 지번에 한 동이라 이 처리가 그대로 항등이 된다.
    """
    if not cands:
        return None
    homes = [b for b in cands if b["main_purps"] == "공동주택"] or cands
    if name:
        want = norm_name(name)
        named = [b for b in homes if b["bld_nm"] and norm_name(b["bld_nm"]) == want]
        if named:
            homes = named
    # 세대가 있는 동만 본다. 지하주차장·경비실이 섞이면 연면적과 층수가 망가진다.
    resid = [b for b in homes if (b["hhld_cnt"] or 0) > 0] or homes

    def total(rows, field):
        # 0을 버리면 안 된다. "승강기 0대"(실제 없음)와 "값 없음"(자료 없음)은 다른 말이고,
        # 그걸 뭉개면 경희궁자이 21층이 "승강기 없음"으로 나간다.
        vals = [r[field] for r in rows if r[field] is not None]
        return sum(vals) if vals else None

    def best(rows, field, fn):
        vals = [r[field] for r in rows if r[field]]
        return fn(vals) if vals else None

    apr = sorted(r["use_apr_day"] for r in resid if r["use_apr_day"])
    strcts = Counter(r["strct"] for r in resid if r["strct"])
    return {
        "use_apr_day": apr[0] if apr else None,
        "strct": strcts.most_common(1)[0][0] if strcts else None,
        "hhld_cnt": total(resid, "hhld_cnt"),
        "grnd_flr": best(resid, "grnd_flr", max),
        "elvt_cnt": total(resid, "elvt_cnt"),
        "park_cnt": best(resid, "park_cnt", max),
        "tot_area": total(resid, "tot_area"),
        "n_dong": len(resid),
    }


def _sane_park(park: int | None, hhld: int | None) -> int | None:
    """주차는 표제부에서 동마다 공용값이 반복되거나 한 동에만 실리는 식으로 들쭉날쭉하다.
    세대수 대비 터무니없는 값(919세대에 11대, 54세대에 세대당 3대 초과)은 자료 오류로
    보고 내보내지 않는다. 틀린 숫자보다 빈칸이 낫다."""
    if park is None:
        return None
    if hhld and (park < hhld * 0.05 or park > hhld * 3):
        return None
    return park


def features(b: dict | None) -> dict:
    """화면에서 쓰는 값만 추린다. 없는 건 None으로 두고 앱에서 '자료 없음'으로 낸다."""
    if not b:
        return {}
    apr = (b["use_apr_day"] or "")[:4]
    apr_year = int(apr) if apr.isdigit() and 1900 < int(apr) < 2100 else None
    return {
        "apr": apr_year,
        "strct": struct_code(b["strct"]),
        "hhld": b["hhld_cnt"] or None,
        "flr": b["grnd_flr"] or None,
        # None은 자료 없음이고 0은 실제 없음이다. 화면은 None이면 항목을 아예 뺀다.
        "elvt": b["elvt_cnt"],
        "park": _sane_park(b["park_cnt"], b["hhld_cnt"]),
        # 세대당 연면적은 공용면적이 섞여 전용면적과 어긋난다. 단지 규모를 대신 낸다.
        "n_dong": b["n_dong"] if b.get("n_dong", 1) > 1 else None,
    }


class Registry:
    """물건 키로 건축물대장 값을 꺼내는 얇은 래퍼."""

    def __init__(self, db_path: str | None):
        self.idx = load(db_path) if db_path else {}
        self.hit = self.miss = 0
        # 이 units가 어느 세대의 대장으로 구워졌는지를 index.json에 남기기 위한 값.
        # 매일 도는 재조인이 "붙일 것이 새로 생겼나"를 자산 시각이 아니라 이 수로
        # 판단한다. 시각으로 보면 빈 응답만 있던 날에도 자산이 움직여 매일 헛돈다.
        self.n = sum(len(v) for v in self.idx.values())

    def lookup(self, lawd: str, umd: str, jibun: str | None, name: str | None) -> dict:
        parsed = parse_jibun(jibun)
        if not parsed:
            self.miss += 1
            return {}
        cands = self.idx.get((lawd, (umd or "").strip(), parsed[1], parsed[2]))
        if not cands:
            self.miss += 1
            return {}
        self.hit += 1
        return features(pick(cands, name))

    def report(self) -> str:
        tot = self.hit + self.miss
        if not tot:
            return "건축물대장 없이 생성"
        return f"건축물대장 매칭 {self.hit:,}/{tot:,} ({self.hit / tot:.1%})"
