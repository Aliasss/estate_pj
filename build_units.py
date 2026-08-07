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
from collections import Counter, defaultdict

from bldg_join import Registry
from subway_join import Nearest
from match_probe import area_key, norm_jibun, norm_name

AREA_BAND = 0.5      # 실측으로 고른 값
UMD_BAND = 10.0      # B단계 면적대 폭
YEAR_BAND = 10       # B단계 준공연도 폭. 신축 전세를 구축 매매와 비교하면 전세가율이 터진다
RECENT_MONTHS = 24
LAG_MONTHS = 2       # 신고 지연으로 미완성인 최근 구간


def year_key(year: int | None) -> str:
    return str(year // YEAR_BAND * YEAR_BAND) if year else ""


def shift_ym(ym: str, months: int) -> str:
    """'202605'에서 -24개월 -> '202405'."""
    y, m = int(ym[:4]), int(ym[4:])
    total = y * 12 + (m - 1) + months
    return f"{total // 12:04d}{total % 12 + 1:02d}"


def unit_id(key: tuple) -> str:
    """물건 식별자. 실행마다 바뀌면 즐겨찾기·비교함이 깨지므로 내용 해시로 고정한다."""
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
FINDER_COLS = ["i", "ht", "g", "u", "jibun", "name", "area", "by", "jeonse", "ratio",
               "stage", "ns", "nj", "hike", "elvt", "apr", "lat", "lon", "stn", "walk"]
STAGES = ["A", "B", "B-", "C"]


def write_finder(out_dir: str, by_gu: dict, cols: list[str], window: list[str]) -> None:
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
            ])
    payload = {"window": window, "gus": gus, "stages": STAGES,
               "umds": [u for u, _ in sorted(umds.items(), key=lambda kv: kv[1])],
               "cols": FINDER_COLS, "n": len(recs),
               "columns": [list(c) for c in zip(*recs)]}
    path = os.path.join(out_dir, "finder.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    packed = len(gzip.compress(open(path, "rb").read(), 6))
    print(f"\nfinder.json  물건 {len(recs):,}개  {os.path.getsize(path) / 1e6:.1f}MB "
          f"(gzip {packed / 1e6:.2f}MB, 법정동 {len(umds)}개)")


def build(conn: sqlite3.Connection, out_dir: str, registry: Registry,
          nearest: Nearest) -> None:
    end = conn.execute("SELECT MAX(deal_ymd) FROM transactions").fetchone()[0]
    complete_end = shift_ym(end, -LAG_MONTHS)          # 마지막 완성 월
    recent_start = shift_ym(complete_end, -(RECENT_MONTHS - 1))
    prev_start = shift_ym(recent_start, -RECENT_MONTHS)
    print(f"수집 최종 {end} / 완성 구간 ~{complete_end}")
    print(f"최근 창 {recent_start}~{complete_end}, 직전 창 {prev_start}~{shift_ym(recent_start, -1)}\n")

    # 물건별 누적기. 키는 (housing_type, lawd_cd, umd, jibun_norm, name_norm, area_band)
    sale_recent: dict[tuple, list[int]] = defaultdict(list)
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
               dealing_gbn
        FROM transactions
        WHERE cdeal_type IS NULL OR cdeal_type <> 'O'
        """
    )
    seen = 0
    for (ht, dt, lawd, sgg, umd, jibun, bname, area, byear, ymd,
         amount, deposit, rent, gbn) in cur:
        seen += 1
        if seen % 500_000 == 0:
            print(f"  {seen:,}행 처리")
        if ymd > complete_end:
            continue                                   # 미완성 구간 제외
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
                umd_sale_b[b_key].append(amount)
                umd_sale_bm[bm_key].append(amount)
                if gbn and "직거래" in gbn:
                    sale_direct[key] += 1
        elif dt == "전월세" and deposit:
            if (rent or 0) == 0:
                if ymd >= recent_start:
                    jeonse_recent[key].append(deposit)
                elif ymd >= prev_start:
                    jeonse_prev[key].append(deposit)
            elif ymd >= recent_start:
                wolse_recent[key] += 1
    print(f"  {seen:,}행 처리 완료\n")

    # 갱신 계약 보증금 증액폭. payload는 갱신 건만 스트리밍으로 읽는다.
    hikes: dict[tuple, list[float]] = defaultdict(list)
    for ht, lawd, umd, jibun, bname, area, ymd, deposit, payload in conn.execute(
        """
        SELECT housing_type, lawd_cd, umd_nm, jibun, building_name, exclu_use_ar,
               deal_ymd, deposit, payload
        FROM transactions
        WHERE deal_type = '전월세' AND contract_type = '갱신'
          AND (cdeal_type IS NULL OR cdeal_type <> 'O')
        """
    ):
        if ymd < recent_start or ymd > complete_end or not deposit:
            continue
        pre = (json.loads(payload).get("preDeposit") or "").replace(",", "").strip()
        if not pre.isdigit() or int(pre) <= 0:
            continue
        key = (ht, lawd, (umd or "").strip(), norm_jibun(jibun), norm_name(bname),
               area_key(area, AREA_BAND))
        hikes[key].append(deposit / int(pre) - 1)

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
            "lat", "lon", "stn", "walk"]
    BLDG_COLS = COLS[-11:-4]
    GEO_COLS = COLS[-4:]

    by_gu: dict[str, list[list]] = defaultdict(list)
    stage_count = Counter()

    for key, info in meta.items():
        ht, lawd, umd, jibun_n, name_n, band = key
        n_j = len(jeonse_recent.get(key, ()))
        if not n_j:
            continue                                   # 최근 전세가 없으면 앱에서 볼 일이 없다
        bm_key = (ht, lawd, umd, area_key(info["area"], UMD_BAND))
        b_key = bm_key + (year_key(info["build_year"]),)

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
        stage_count[(ht, stage)] += 1

        # 직전 24개월 전세가율(같은 단계 기준)로 추세를 본다
        med_j_prev = median(jeonse_prev.get(key, []))
        ratio_prev = pct(med_j_prev, med_s) if (med_s and med_j_prev) else None

        hike = hikes.get(key)
        name = names[key].most_common(1)[0][0] if names[key] else ""
        bldg = registry.lookup(lawd, umd, info["jibun"], name)
        geo = nearest.lookup(lawd, umd, info["jibun"])
        by_gu[lawd].append([
            unit_id(key),
            "A" if ht == "아파트" else "R",
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
        ])

    os.makedirs(out_dir, exist_ok=True)
    index = []
    total_bytes = 0
    for lawd, rows in sorted(by_gu.items()):
        rows.sort(key=lambda r: (r[2], r[1]))
        path = os.path.join(out_dir, f"{lawd}.json")
        payload = {"lawd_cd": lawd, "window": [recent_start, complete_end],
                   "cols": COLS, "rows": rows}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(path)
        total_bytes += size
        index.append({"lawd_cd": lawd, "n_units": len(rows), "bytes": size})

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"window": [recent_start, complete_end], "gu": index}, fh, ensure_ascii=False)

    write_finder(out_dir, by_gu, COLS, [recent_start, complete_end])

    print(registry.report())
    print(nearest.report())
    print(f"{len(by_gu)}개 구, 물건 {sum(len(r) for r in by_gu.values()):,}개, "
          f"합계 {total_bytes / 1e6:.1f}MB (구당 평균 {total_bytes / len(by_gu) / 1e3:.0f}KB)")
    print("\n폴백 단계 분포 (최근 전세가 있는 물건 기준):")
    for ht in ("아파트", "연립다세대"):
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
    args = parser.parse_args()

    bldg = args.bldg if args.bldg and os.path.exists(args.bldg) else None
    if args.bldg and not bldg:
        print(f"건축물대장 DB가 없습니다: {args.bldg} — 해당 열 없이 생성합니다")
    geo = args.geo if args.geo and os.path.exists(args.geo) else None
    sub = args.subway if args.subway and os.path.exists(args.subway) else None
    if args.geo and not geo:
        print(f"좌표 DB가 없습니다: {args.geo} — 지도·통근 열 없이 생성합니다")
    conn = sqlite3.connect(args.db)
    build(conn, args.out, Registry(bldg), Nearest(geo, sub))
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
