#!/usr/bin/env python3
"""물건 단위 패널(티어 2) 생성.

aggregate.py가 구 단위 패널(티어 1)을 만든다면, 이 스크립트는 개별 물건 단위로
전세가율과 위험 신호를 낸다. PWA가 자치구를 선택하면 해당 구 파일만 내려받도록
구별로 쪼개 내보낸다.

매칭 규칙은 match_probe.py 실측 결과를 따른다.
- 면적 구간 0.5m². 더 넓혀도 매칭률 이득이 미미하고 다른 평형이 섞인다.
- A단계(같은 건물·면적)는 아파트에서 92.7% 붙지만 연립다세대는 48.6%에 그치고
  그중 68%가 매매 3건 미만이다. 그래서 B단계(같은 법정동·유사 면적대)를 함께 낸다.
- 어느 단계로 계산했는지(stage)와 매매 표본 두께(n_sale)를 항상 같이 내보낸다.
  연립다세대에서는 표본 두께 자체가 위험 신호라 화면에서 숨기면 안 된다.

사용법
    python build_units.py --db /workspace/seoul_rt.sqlite --out web/data/units
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import statistics as st
import time
from collections import Counter, defaultdict

from bldg_join import Registry
from school_join import Schools
from subway_join import Nearest
from terrain_join import Terrain
from match_probe import area_key, norm_jibun, norm_name

AREA_BAND = 0.5      # 실측으로 고른 값. unit_id의 재료라 바꾸면 공유 링크가 끊긴다
UMD_BAND = 10.0      # B단계 면적대 폭
YEAR_BAND = 10       # B단계 준공연도 폭. 신축 전세를 구축 매매와 비교하면 전세가율이 터진다
RECENT_MONTHS = 24
DEADLINE_GRACE_DAYS = 35   # 신고 기한 30일 + 늦은 처리 여유. 말일+35일이 지나면 완성으로 본다


def year_key(year: int | None) -> str:
    return str(year // YEAR_BAND * YEAR_BAND) if year else ""


def calendar_complete_end(today) -> str:
    """오늘 기준으로 신고 기한이 전부 지난 마지막 달.

    신고 기한이 계약일로부터 30일이므로 6월 30일 계약은 7월 30일까지 신고된다.
    즉 말일+35일(여유 5일)이 지났으면 그 달은 완성이다. 예전에는 데이터의 마지막
    달에서 기계적으로 두 달을 잘랐는데, 8월 8일에 5월까지만 보여주는 식으로
    필요 이상 보수적이었다. 달력으로 판정하면 같은 날 6월까지 열린다.
    """
    import datetime
    cand = today.replace(day=1) - datetime.timedelta(days=1)   # 지난달 말일
    while today < cand + datetime.timedelta(days=DEADLINE_GRACE_DAYS + 1):
        cand = cand.replace(day=1) - datetime.timedelta(days=1)
    return f"{cand.year:04d}{cand.month:02d}"


def shift_ym(ym: str, months: int) -> str:
    """'202605'에서 -24개월 -> '202405'."""
    y, m = int(ym[:4]), int(ym[4:])
    total = y * 12 + (m - 1) + months
    return f"{total // 12:04d}{total % 12 + 1:02d}"


def unit_id(key: tuple) -> str:
    """물건 식별자. 실행마다 바뀌면 즐겨찾기·비교함이 깨지므로 내용 해시로 고정한다.

    이 값이 공유 링크(/s/{lawd}.{id})에 그대로 들어간다. 카톡 대화방에 남은
    링크는 몇 달을 사는데, 키를 만드는 재료(norm_jibun, norm_name, AREA_BAND)를
    건드리면 이미 뿌려진 링크가 전부 조용히 일반 카드로 떨어진다. 오류가 아니라
    "그 물건을 못 찾음"으로 폴백하므로 아무도 모른다. 바꿔야 한다면 그 사실을
    알고 바꾼다.
    """
    blob = "|".join(str(part) for part in key)
    return hashlib.sha1(blob.encode()).hexdigest()[:12]


def median(values: list[int]) -> int | None:
    return round(st.median(values)) if values else None


def pct(numer: float | None, denom: float | None) -> float | None:
    if numer is None or not denom:
        return None
    return round(numer / denom, 4)


# 서울 전체를 한 화면에서 조건 검색하려면 25개 구 파일(10MB)을 다 받아야 한다.
# 그래서 조건 검색에 실제로 쓰는 열만 추린 단일 파일을 따로 낸다. 세 가지로 줄였다.
#   - 물건 해시 id 대신 구 파일 안의 행 번호를 쓴다. 해시는 gzip이 못 줄인다.
#   - 열 단위로 담는다. 같은 종류 값이 붙어 있어야 gzip이 먹는다 (1.45MB -> 1.00MB).
#   - 법정동은 사전으로 접는다. 건물명은 고유값이 38,872개라 사전이 오히려 손해였다.
# 상세는 어차피 구 파일에서 다시 읽으므로 여기에 담지 않는다.
# jibun이 들어 있어야 "화곡동 123-45"로 찾을 수 있다. 검증하러 온 사람은 주소를 들고 온다.
# sale은 매매 실거래 중위(만원). 조건 검색의 매매가 상한 필터가 쓴다. 매매
# 사례가 없는 물건은 None이고, 열 단위 저장이라 gzip이 거의 다 먹는다.
# nw는 최근 2년 월세 건수. 전세 없는 건물을 싣기 시작하면서 필요해졌다 — 목록
# 줄에서 "전세 0건"만 적으면 대신 무엇이 있는지를 말할 수가 없다.
#
# 전세 없는 건물까지 실은 값: 서울 finder가 gzip 1.81MB에서 2.77MB로,
# 물건은 91,476개에서 204,977개로(2.24배) 늘었다. 늘어난 행은 대부분 빈 값이라
# gzip이 잘 먹어서 용량은 1.53배에 그쳤다. 구 파일 최대는 0.55MB -> 0.99MB.
# 이 파일은 서비스워커 런타임 캐시(프리캐시 아님)라 첫 방문에만 드는 비용이다.
# 프런트 JSON.parse는 x86에서 289ms 걸린다(저사양 폰은 5~8배). 여기서 열을
# 하나 더 늘릴 때는 그 시간이 첫 화면을 그대로 늦춘다는 것을 함께 재야 한다.
FINDER_COLS = ["i", "ht", "g", "u", "jibun", "name", "area", "by", "jeonse", "ratio",
               "stage", "ns", "nj", "hike", "elvt", "apr", "lat", "lon", "stn", "walk",
               "sale", "nw"]
STAGES = ["A", "B", "B-", "C"]


def write_finder(out_dir: str, by_gu: dict, cols: list[str], window: list[str],
                 build_id: str, fname: str = "finder.json") -> None:
    col = {name: i for i, name in enumerate(cols)}
    gus = sorted(by_gu)
    umds: dict[str, int] = {}
    recs = []
    for gi, lawd in enumerate(gus):
        # 행 번호로 상세를 찾으므로 구 파일에 쓴 순서와 반드시 같아야 한다
        for ri, r in enumerate(by_gu[lawd]):
            ui = umds.setdefault(r[col["umd"]] or "", len(umds))
            ratio = r[col["ratio"]]
            recs.append([
                ri, r[col["ht"]], gi, ui, r[col["jibun"]], r[col["name"]],
                round(r[col["area"]], 1) if r[col["area"]] else None,
                r[col["build_year"]], r[col["med_jeonse"]],
                None if ratio is None else round(ratio, 3),
                STAGES.index(r[col["stage"]]),
                r[col["n_sale_24m"]], r[col["n_jeonse_24m"]],
                r[col["renew_hike"]],
                # 건축물대장이 아직 안 붙은 물건은 None. 열 단위라 gzip이 거의 다 먹는다.
                r[col["elvt"]], r[col["apr"]],
                r[col["lat"]], r[col["lon"]], r[col["stn"]], r[col["walk"]],
                r[col["med_sale"]], r[col["n_wolse_24m"]],
            ])
    payload = {"build": build_id, "window": window, "gus": gus, "stages": STAGES,
               "umds": [u for u, _ in sorted(umds.items(), key=lambda kv: kv[1])],
               "cols": FINDER_COLS, "n": len(recs),
               "columns": [list(c) for c in zip(*recs)]}
    path = os.path.join(out_dir, fname)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    packed = len(gzip.compress(open(path, "rb").read(), 6))
    print(f"\n{fname}  물건 {len(recs):,}개  {os.path.getsize(path) / 1e6:.1f}MB "
          f"(gzip {packed / 1e6:.2f}MB, 법정동 {len(umds)}개)")


# 물건 하나에 다 싣지 않는다. 다만 얼마나 자를지는 용량이 아니라 쓰임이 정한다.
#
# 실측(2026-08): 자르기 전 전세 96만 행 중 43만만 실렸다. 물건 기준으로는 11%만
# 잘리지만, 전세 계약자 기준으로는 72%(아파트 89%)가 잘린 건물에 산다. 회전이
# 빠른 건물일수록 계약자가 많아서다. 지킴이가 보는 과거의 길이도 여기서 정해지는데,
# 상한 10건이 덮는 기간이 세입자 가중 중앙 6.5개월이었다. 2년 계약을 감시하는 데
# 6개월치만 보고 있었다는 뜻이다.
#
# 용량은 제약이 아니었다. 사용자는 구 파일 하나만 받고(지연 로딩), 가장 큰 구가
# gzip 555KB다. 아래 값으로 올려도 그 구가 +32KB다.
# 이 값을 바꾸면 web/src/UnitLookup.jsx의 DEAL_CAPS 미러도 함께 고칠 것.
DEAL_CAPS = {"j": 15, "s": 10, "w": 12}


def trim_deals(d: dict | None) -> dict | None:
    """최신순으로 잘라 낸다. 빈 종류는 키 자체를 빼서 용량을 아낀다."""
    if not d:
        return None
    out = {}
    for kind, cap in DEAL_CAPS.items():
        # 날짜로만 정렬한다. 튜플 통째로 비교하면 층이 비어 있는 행에서 None과 문자열을
        # 견주게 되어 깨진다.
        rows = sorted(d.get(kind, ()), key=lambda r: r[0], reverse=True)[:cap]
        if rows:
            out[kind] = [list(r) for r in rows]
    return out or None


def build(conn: sqlite3.Connection, out_dir: str, registry: Registry,
          nearest: Nearest, schools: Schools, terrain: Terrain,
          complete_end_max: str = "") -> None:
    end = conn.execute("SELECT MAX(deal_ymd) FROM transactions").fetchone()[0]
    import datetime
    # 완성 여부는 달력이 정하고, 수집이 거기 못 미치면 수집된 데까지만 쓴다
    complete_end = min(calendar_complete_end(datetime.date.today()), end)
    # 대장 회차(매일)가 이걸 부를 때는 실거래 스냅샷이 주간이라, 달력이 수집을
    # 앞지르는 창이 매달 한 번 생긴다. 9월 5일이면 달력은 202607을 확정으로 넘기는데
    # 그때 스냅샷은 9월 1일 수집분이라 나흘치 신고가 빠져 있다. 그 달을 확정 통계에
    # 넣으면 중위값과 표본 두께가 실제보다 얇게 나가고, 이 앱은 표본 두께를 그 자체로
    # 위험 신호로 화면에 낸다. 부르는 쪽이 직전 확정월을 넘기면 거기서 멈추고,
    # 수집이 따라잡은 뒤 주간 배치가 연다.
    if complete_end_max and complete_end > complete_end_max:
        print(f"달력은 {complete_end}까지 열지만 실거래 수집이 거기 못 미쳐 "
              f"{complete_end_max}에서 멈춥니다 (--complete-end)")
        complete_end = complete_end_max
    recent_start = shift_ym(complete_end, -(RECENT_MONTHS - 1))
    prev_start = shift_ym(recent_start, -RECENT_MONTHS)
    print(f"수집 최종 {end} / 완성 구간 ~{complete_end}")
    print(f"최근 창 {recent_start}~{complete_end}, 직전 창 {prev_start}~{shift_ym(recent_start, -1)}\n")

    # 개별 거래 내역. "중위 2.5억"보다 "2026-03에 2.6억 3층"이 판단에 훨씬 가깝고,
    # 중위값을 믿을 근거도 된다. 층은 반지하 여부까지 알려주므로 꼭 같이 낸다.
    deals: dict[tuple, dict[str, list]] = defaultdict(lambda: {"j": [], "s": [], "w": []})

    # 물건별 누적기. 키는 (housing_type, lawd_cd, umd, jibun_norm, name_norm, area_band)
    sale_recent: dict[tuple, list[int]] = defaultdict(list)
    sale_prev: dict[tuple, list[int]] = defaultdict(list)
    sale_all: dict[tuple, list[int]] = defaultdict(list)
    sale_direct: dict[tuple, int] = Counter()
    jeonse_recent: dict[tuple, list[int]] = defaultdict(list)
    jeonse_prev: dict[tuple, list[int]] = defaultdict(list)
    wolse_recent: dict[tuple, int] = Counter()
    names: dict[tuple, Counter] = defaultdict(Counter)
    meta: dict[tuple, dict] = {}

    # B단계용. B는 연식까지 통제하고, B-는 연식을 못 맞출 때 쓰는 느슨한 비교군.
    umd_sale_b: dict[tuple, list[int]] = defaultdict(list)
    umd_sale_bm: dict[tuple, list[int]] = defaultdict(list)

    cur = conn.execute(
        """
        SELECT housing_type, deal_type, lawd_cd, sgg_nm, umd_nm, jibun, building_name,
               exclu_use_ar, build_year, deal_ymd, deal_amount, deposit, monthly_rent,
               dealing_gbn, floor, contract_type
        FROM transactions
        WHERE cdeal_type IS NULL OR cdeal_type <> 'O'
        """
    )
    seen = 0
    for (ht, dt, lawd, sgg, umd, jibun, bname, area, byear, ymd,
         amount, deposit, rent, gbn, floor, ctype) in cur:
        seen += 1
        if seen % 500_000 == 0:
            print(f"  {seen:,}행 처리")
        if ymd > complete_end:
            # 월 집계는 미완성이지만 신고된 개별 계약은 사실이다. 검증하러 온
            # 사람에게 가장 시의성 있는 게 지난달 계약이라, 통계에서는 빼고
            # 최근 거래 목록에만 'P'(잠정) 꼬리표를 달아 싣는다.
            key_p = (ht, lawd, (umd or "").strip(), norm_jibun(jibun), norm_name(bname),
                     area_key(area, AREA_BAND))
            if dt == "매매" and amount:
                deals[key_p]["s"].append((ymd, amount, floor, "P"))
            elif dt == "전월세" and deposit:
                if (rent or 0) == 0:
                    deals[key_p]["j"].append((ymd, deposit, floor, ctype, "P"))
                else:
                    deals[key_p]["w"].append((ymd, deposit, rent, floor, "P"))
            continue
        umd = (umd or "").strip()
        key = (ht, lawd, umd, norm_jibun(jibun), norm_name(bname), area_key(area, AREA_BAND))
        bm_key = (ht, lawd, umd, area_key(area, UMD_BAND))
        b_key = bm_key + (year_key(byear),)

        if key not in meta:
            meta[key] = {"sgg": sgg, "umd": umd, "jibun": (jibun or "").strip(),
                         "area": area, "build_year": byear}
        if bname:
            names[key][bname.strip()] += 1

        if dt == "매매" and amount:
            sale_all[key].append(amount)
            if ymd >= recent_start:
                sale_recent[key].append(amount)
                deals[key]["s"].append((ymd, amount, floor))
                umd_sale_b[b_key].append(amount)
                umd_sale_bm[bm_key].append(amount)
                if gbn and "직거래" in gbn:
                    sale_direct[key] += 1
            elif ymd >= prev_start:
                sale_prev[key].append(amount)
        elif dt == "전월세" and deposit:
            if (rent or 0) == 0:
                if ymd >= recent_start:
                    jeonse_recent[key].append(deposit)
                    deals[key]["j"].append((ymd, deposit, floor, ctype))
                elif ymd >= prev_start:
                    jeonse_prev[key].append(deposit)
            elif ymd >= recent_start:
                wolse_recent[key] += 1
                deals[key]["w"].append((ymd, deposit, rent, floor))
    print(f"  {seen:,}행 처리 완료\n")

    # 갱신 계약 보증금 증액폭. payload는 갱신 건만 스트리밍으로 읽는다.
    hikes: dict[tuple, list[float]] = defaultdict(list)
    for ht, lawd, umd, jibun, bname, area, ymd, deposit, payload in conn.execute(
        """
        SELECT housing_type, lawd_cd, umd_nm, jibun, building_name, exclu_use_ar,
               deal_ymd, deposit, payload
        FROM transactions
        WHERE deal_type = '전월세' AND contract_type = '갱신'
          AND (monthly_rent IS NULL OR monthly_rent = 0)
          AND (cdeal_type IS NULL OR cdeal_type <> 'O')
        """
    ):
        if ymd < recent_start or ymd > complete_end or not deposit:
            continue
        # 전세→전세 갱신만 쓴다. 직전 계약이 월세였으면(preMonthlyRent) 보증금 증감은
        # 전월세 전환이지 시세 변동이 아니다. 이게 섞이면 "역전세" 판정의 15.9%가
        # 근거 없는 값이 된다. 세입자가 전세를 월세로 바꾼 걸 집주인이 돈을 돌려주는
        # 걸로 읽는 셈이라 방향까지 반대다.
        p = json.loads(payload)
        pre_rent = str(p.get("preMonthlyRent") or "0").replace(",", "").strip()
        if pre_rent not in ("", "0"):
            continue
        pre = (p.get("preDeposit") or "").replace(",", "").strip()
        if not pre.isdigit() or int(pre) <= 0:
            continue
        h = deposit / int(pre) - 1
        # 자릿수가 깨진 preDeposit이 +9449.0 같은 값을 만든 적 있다. 갱신에서 보증금이
        # 반 토막 아래로 내리거나 두 배 넘게 오르는 건 시세가 아니라 입력 오류다.
        if not (-0.5 <= h <= 1.0):
            continue
        key = (ht, lawd, (umd or "").strip(), norm_jibun(jibun), norm_name(bname),
               area_key(area, AREA_BAND))
        hikes[key].append(h)

    # B단계 비교군 중위값. 표본 3건 미만은 비교군으로 쓰기에 너무 얇다.
    MIN_COMPS = 3
    med_b = {k: median(v) for k, v in umd_sale_b.items() if len(v) >= MIN_COMPS}
    med_bm = {k: median(v) for k, v in umd_sale_bm.items() if len(v) >= MIN_COMPS}

    COLS = ["id", "ht", "name", "umd", "jibun", "area", "build_year",
            "n_sale_24m", "n_sale_all", "med_sale", "direct_share",
            "n_jeonse_24m", "n_wolse_24m", "med_jeonse",
            "ratio", "stage", "n_comps", "ratio_prev", "renew_hike",
            # 건축물대장. 아직 안 받은 지번은 전부 None으로 나간다.
            "apr", "strct", "hhld", "flr", "elvt", "park", "n_dong",
            # 좌표·최근접역. 지오코딩이 안 된 물건은 전부 None으로 나간다.
            "lat", "lon", "stn", "walk",
            # 인근 학교 수 (초·중·고 반경 1km, 대학 2km). 좌표 없는 물건은 None.
            "sch_e", "sch_m", "sch_h", "sch_u",
            # 지형. slope는 주변 경사(%), stn_dh는 역과의 고도차(m, +면 집이 높다).
            "slope", "stn_dh",
            # 개별 거래 내역. 최신순으로 잘라서 낸다.
            "deals"]
    # 음수 슬라이스는 열을 하나만 보태도 소리 없이 어긋난다. 이름으로 못박는다.
    BLDG_COLS = ["apr", "strct", "hhld", "flr", "elvt", "park", "n_dong"]
    GEO_COLS = ["lat", "lon", "stn", "walk"]
    SCH_COLS = ["sch_e", "sch_m", "sch_h", "sch_u"]
    TER_COLS = ["slope", "stn_dh"]

    by_gu: dict[str, list[list]] = defaultdict(list)
    stage_count = Counter()

    for key, info in meta.items():
        ht, lawd, umd, jibun_n, name_n, band = key
        n_j = len(jeonse_recent.get(key, ()))
        n_w = wolse_recent.get(key, 0)
        n_s_any = len(sale_recent.get(key, ()))
        # 전세·매매·월세 중 하나라도 최근 거래가 있으면 싣는다. 예전에는 전세만
        # 실었는데, 임장 중에 눈앞 건물을 찾으면 "없는 건물"로 나왔다. 전세가
        # 없는 건물도 그 자리에 서 있다는 사실은 같다. 판정은 전세가 있을 때만
        # 하고, 없으면 없다고 말한다.
        if not (n_j or n_w or n_s_any):
            continue
        bm_key = (ht, lawd, umd, area_key(info["area"], UMD_BAND))
        b_key = bm_key + (year_key(info["build_year"]),)

        # 전세가 없으면 med_j가 None이고, 따라서 ratio도 None이다. stage는 그래도
        # 매긴다 — "이 건물 매매로 값을 확인할 수 있느냐"는 전세와 무관한 사실이고,
        # 나중에 전세가 처음 들어올 때 쓸 근거이기도 하다.
        med_j = median(jeonse_recent[key])
        n_s = len(sale_recent.get(key, ()))
        med_s = median(sale_recent.get(key, []))

        # A: 이 건물 실거래  B: 같은 동·면적대·연식  B-: 연식 통제 못 함  C: 비교 불가
        if med_s:
            ratio, stage, n_comps = pct(med_j, med_s), "A", n_s
        elif b_key in med_b:
            ratio, stage, n_comps = pct(med_j, med_b[b_key]), "B", len(umd_sale_b[b_key])
        elif bm_key in med_bm:
            ratio, stage, n_comps = pct(med_j, med_bm[bm_key]), "B-", len(umd_sale_bm[bm_key])
        else:
            ratio, stage, n_comps = None, "C", 0
        # 분포는 전세가율을 실제로 낸 물건만 센다. 전세 없는 물건까지 넣으면
        # "A단계 몇 %"가 전세가율의 근거 두께가 아니라 다른 것을 세게 된다.
        if n_j:
            stage_count[(ht, stage)] += 1

        # 직전 24개월 전세가율. 분자와 분모 모두 직전 창 값이어야 한다. 현재 창 매매가로
        # 나누면 집값이 오른 구간에서 "전세가율이 올랐다"가 과다 발생한다. 화면 문턱이
        # 3%p인데 그 왜곡만 10%p쯤 됐다. 직전 창에 매매가 없으면 억지로 만들지 않는다.
        med_j_prev = median(jeonse_prev.get(key, []))
        med_s_prev = median(sale_prev.get(key, []))
        ratio_prev = pct(med_j_prev, med_s_prev) if (med_s_prev and med_j_prev) else None

        hike = hikes.get(key)
        name = names[key].most_common(1)[0][0] if names[key] else ""
        bldg = registry.lookup(lawd, umd, info["jibun"], name)
        geo = nearest.lookup(lawd, umd, info["jibun"])
        sch = schools.counts(geo.get("lat"), geo.get("lon"))
        ter = terrain.lookup(lawd, umd, info["jibun"], geo.get("stn"))
        by_gu[lawd].append([
            unit_id(key),
            {"아파트": "A", "오피스텔": "O"}.get(ht, "R"),
            name,
            umd, info["jibun"],
            round(info["area"], 2) if info["area"] else None,
            info["build_year"],
            n_s, len(sale_all.get(key, ())), med_s,
            pct(sale_direct.get(key, 0), n_s) if n_s else None,
            n_j, wolse_recent.get(key, 0), med_j,
            ratio, stage, n_comps, ratio_prev,
            round(st.median(hike), 4) if hike else None,
            *(bldg.get(c) for c in BLDG_COLS),
            *(geo.get(c) for c in GEO_COLS),
            *(sch.get(c) for c in SCH_COLS),
            *(ter.get(c) for c in TER_COLS),
            trim_deals(deals.get(key)),
        ])

    os.makedirs(out_dir, exist_ok=True)
    # 같은 실행에서 나온 파일들끼리만 섞이도록 세대 표식을 박는다. finder.json의 행 번호는
    # 빌드마다 밀리므로, 서비스워커가 구버전 finder와 신버전 구 파일을 섞으면 클릭한 것과
    # 다른 물건의 상세가 뜬다.
    #
    # 표식이 어긋날 때 프런트가 하는 일은 "다시 받는다"가 아니라 "멈추고 새로고침을
    # 청한다"이다(web/src/units.js와 web/src/Finder.jsx). 이 주석이 오래 반대로
    # 적혀 있었다. 매일 재조인이 들어오면서 이 값이 매일 바뀌므로, 대장이 매일 느는
    # 동안에는 그 안내가 매일 뜬다. 경기 73,213지번이 남아 있어 두 달 넘게 그렇다.
    # 자동 재요청으로 바꾸는 것은 프런트와 서비스워커 캐시 정책을 손대야 해서
    # 별건으로 뺐다. 이슈 #1.
    build_id = f"{complete_end}-{int(time.time())}"
    index = []
    total_bytes = 0
    for lawd, rows in sorted(by_gu.items()):
        rows.sort(key=lambda r: (r[2], r[1]))
        path = os.path.join(out_dir, f"{lawd}.json")
        payload = {"build": build_id, "lawd_cd": lawd,
                   "window": [recent_start, complete_end], "cols": COLS, "rows": rows}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(path)
        total_bytes += size
        index.append({"lawd_cd": lawd, "n_units": len(rows), "bytes": size})

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        # bldg_at / bldg_remaining은 화면이 대장 갱신일과 지연을 말하는 근거다.
        # bldg_rows와 달리 재조인 판단에는 안 쓴다(bldg_join.state 주석 참고).
        #
        # geo_at / subway_at / sch_at도 같은 목적이다. 이 셋이 없던 동안 화면의
        # 시의성 표는 좌표와 지하철 행의 "어디까지" 칸을 영구히 비워 뒀고 학교는
        # 행 자체가 없었다. 그래서 8/23부터 9/1까지 좌표 수집이 멈춰 있어도
        # 화면은 그 사실을 말할 수단이 없었다.
        #
        # 잔여는 안 싣는다. 초안이 nearest.miss를 좌표 잔여로 썼는데 리뷰가
        # 반증했다. miss는 두 곳에서 오른다. 좌표가 없을 때와, 좌표는 멀쩡한데
        # ring 안에 역이 없을 때다. 실측하면 2,095 중 1,347(64%)이 후자라
        # 가평·연천처럼 역 없는 지역이 "좌표 미수집"으로 계상된다. 게다가
        # notfound는 geocode의 done 질의에서 영원히 빠지므로 이 값은 구조적으로
        # 0이 안 된다. 0을 못 만드는 잔여는 "다 받았다"를 영영 말하지 못해,
        # 지연 경고를 끄는 가드가 죽은 코드가 된다.
        #
        # 진짜 잔여는 geocode.py가 bldg_meta처럼 남겨야 한다. 그 전까지 좌표는
        # 날짜만 낸다. 날짜는 그 자체로 값이 있고, 못 재는 판정을 지어내는 것이
        # 이 저장소에서 제일 비싼 실수다.
        json.dump({"window": [recent_start, complete_end], "gu": index,
                   "bldg_rows": registry.n, "sch_hit": schools.hit,
                   # 미수집 레벨은 아예 키가 없다. 화면이 "대" 없이 적는다.
                   "sch_src": schools.src,
                   "bldg_at": registry.at, "bldg_remaining": registry.remaining,
                   "geo_at": nearest.at,
                   "subway_at": nearest.sub_at, "sch_at": schools.at},
                  fh, ensure_ascii=False)

    prefixes = sorted({lawd[:2] for lawd in by_gu})
    for pref in prefixes:
        sub = {k: v for k, v in by_gu.items() if k.startswith(pref)}
        write_finder(out_dir, sub, COLS, [recent_start, complete_end], build_id,
                     fname=f"finder-{pref}.json")
    if "11" in prefixes:
        import shutil
        shutil.copyfile(os.path.join(out_dir, "finder-11.json"),
                        os.path.join(out_dir, "finder.json"))

    print(registry.report())
    print(nearest.report())
    print(schools.report())
    print(terrain.report())
    print(f"{len(by_gu)}개 구, 물건 {sum(len(r) for r in by_gu.values()):,}개, "
          f"합계 {total_bytes / 1e6:.1f}MB (구당 평균 {total_bytes / len(by_gu) / 1e3:.0f}KB)")
    print("\n폴백 단계 분포 (전세가율을 낸 물건 기준. 전세 없는 물건은 제외):")
    for ht in ("아파트", "연립다세대", "오피스텔"):
        tot = sum(v for (h, _), v in stage_count.items() if h == ht)
        if tot:
            parts = "  ".join(f"{s}={stage_count[(ht, s)]:,}({stage_count[(ht, s)] / tot:.0%})"
                              for s in ("A", "B", "B-", "C"))
            print(f"  {ht:<6} {tot:>8,}개   {parts}")


def main() -> int:
    parser = argparse.ArgumentParser(description="물건 단위 패널 생성")
    parser.add_argument("--db", default="/workspace/seoul_rt.sqlite")
    parser.add_argument("--out", default="web/data/units")
    parser.add_argument("--bldg", default="", help="건축물대장 DB. 없으면 해당 열은 비워 둔다")
    parser.add_argument("--geo", default="", help="좌표 DB (geocode.py 결과)")
    parser.add_argument("--subway", default="", help="지하철 subway.json")
    parser.add_argument("--schools", default="", help="학교 schools.json")
    parser.add_argument("--complete-end", default="", metavar="YYYYMM",
                        help="확정 구간 상한. 달력이 실거래 수집을 앞설 때 쓴다")
    args = parser.parse_args()

    bldg = args.bldg if args.bldg and os.path.exists(args.bldg) else None
    if args.bldg and not bldg:
        print(f"건축물대장 DB가 없습니다: {args.bldg} — 해당 열 없이 생성합니다")
    geo = args.geo if args.geo and os.path.exists(args.geo) else None
    sub = args.subway if args.subway and os.path.exists(args.subway) else None
    sch = args.schools if args.schools and os.path.exists(args.schools) else None
    if args.geo and not geo:
        print(f"좌표 DB가 없습니다: {args.geo} — 지도·통근 열 없이 생성합니다")
    if args.schools and not sch:
        print(f"학교 자료가 없습니다: {args.schools} — 학교 열 없이 생성합니다")
    conn = sqlite3.connect(args.db)
    build(conn, args.out, Registry(bldg), Nearest(geo, sub), Schools(sch), Terrain(geo),
          complete_end_max=args.complete_end)
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
