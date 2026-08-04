#!/usr/bin/env python3
"""물건 단위 매칭률 실측.

전세 계약을 같은 물건의 매매 사례에 붙일 수 있는지 측정한다. 이 비율이 나오지 않으면
물건 단위 전세가율(깡통 판정)을 만들 수 없으므로, 앱 설계 전에 반드시 확인해야 한다.

측정 항목
1. 건물명/지번/면적 정규화 전후로 서로 다른 물건 키가 몇 개나 되는지
2. 면적 구간 폭(0 / 0.5 / 1.0 / 2.0 m2)별 매칭률 - 좁으면 못 붙고 넓으면 다른 평형이 섞인다
3. 전세 건수 기준 매칭률 (24개월 창 / 60개월 창), 아파트 - 연립다세대 분리
4. payload의 preDeposit / useRRRight 충전율 - 갱신 증액폭 지표를 쓸 수 있는지

사용법
    python match_probe.py --db /workspace/seoul_rt.sqlite
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict

# 건물명에서 떼어낼 접미. '아파트' 표기가 붙는 쪽과 안 붙는 쪽이 섞여 들어온다.
SUFFIXES = ("아파트", "맨션", "빌라", "연립", "빌리지", "타운", "APT")
PAREN = re.compile(r"[（(\[][^）)\]]*[）)\]]")
NON_KEY = re.compile(r"[\s\-_,.·・'\"]+")


def norm_name(value: str | None) -> str:
    """건물명 정규화. 표기 흔들림을 흡수한다."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKC", value)  # 전각 -> 반각
    text = PAREN.sub("", text)                   # 괄호 안 동/차수 표기 제거
    text = NON_KEY.sub("", text)                 # 공백/구분자 제거
    text = text.upper()
    changed = True
    while changed:                                # '롯데캐슬아파트' -> '롯데캐슬'
        changed = False
        for suffix in SUFFIXES:
            if len(text) > len(suffix) and text.endswith(suffix):
                text = text[: -len(suffix)]
                changed = True
    return text


def norm_jibun(value: str | None) -> str:
    """'0123-0004' -> '123-4'."""
    if not value:
        return ""
    parts = re.split(r"[-]", unicodedata.normalize("NFKC", value).strip())
    out = []
    for part in parts:
        digits = re.sub(r"\D", "", part)
        out.append(str(int(digits)) if digits else part.strip())
    return "-".join(p for p in out if p)


def area_key(area: float | None, band: float) -> str:
    """면적 구간화. band=0이면 소수 둘째자리 그대로(정규화 없음)."""
    if area is None:
        return ""
    if band <= 0:
        return f"{area:.2f}"
    return f"{round(area / band) * band:.1f}"


def load(conn: sqlite3.Connection, deal_type: str, housing_type: str) -> list[dict]:
    """payload는 크므로 뺀다. 200만 행을 dict로 들고 있으면 메모리가 감당이 안 된다."""
    cur = conn.execute(
        """
        SELECT lawd_cd, umd_nm, jibun, building_name, exclu_use_ar, deal_ymd,
               deal_amount, deposit, monthly_rent, contract_type
        FROM transactions
        WHERE deal_type = ? AND housing_type = ?
          AND (cdeal_type IS NULL OR cdeal_type <> 'O')
        """,
        (deal_type, housing_type),
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur]


def key_of(rec: dict, band: float, *, normalize: bool) -> tuple:
    if normalize:
        return (
            rec["lawd_cd"],
            (rec["umd_nm"] or "").strip(),
            norm_jibun(rec["jibun"]),
            norm_name(rec["building_name"]),
            area_key(rec["exclu_use_ar"], band),
        )
    return (
        rec["lawd_cd"],
        rec["umd_nm"],
        rec["jibun"],
        rec["building_name"],
        area_key(rec["exclu_use_ar"], 0),
    )


def probe(conn: sqlite3.Connection, housing_type: str) -> None:
    sales = load(conn, "매매", housing_type)
    rents = load(conn, "전월세", housing_type)
    jeonse = [r for r in rents if (r["monthly_rent"] or 0) == 0]

    print(f"\n{'=' * 74}")
    print(f"  {housing_type}   매매 {len(sales):,}건 / 전월세 {len(rents):,}건 (전세 {len(jeonse):,}건)")
    print("=" * 74)

    # 1) 정규화가 실제로 키를 합치는가
    raw_keys = {key_of(r, 0, normalize=False) for r in sales + rents}
    norm_keys = {key_of(r, 0.5, normalize=True) for r in sales + rents}
    print(f"\n물건 키 개수:  정규화 전 {len(raw_keys):,}  ->  정규화 후(0.5m² 구간) {len(norm_keys):,} "
          f"({1 - len(norm_keys) / len(raw_keys):.1%} 감소)")

    # 2) 면적 구간 폭별 매칭률
    print(f"\n{'구간':>6}  {'매매키':>9}  {'전세 매칭(60개월)':>18}  {'전세 매칭(24개월)':>18}")
    recent_cut = "202408"  # 최근 24개월
    for band in (0.0, 0.5, 1.0, 2.0):
        sale_keys = defaultdict(list)
        for s in sales:
            sale_keys[key_of(s, band, normalize=True)].append(s["deal_ymd"])

        hit_all = hit_recent = 0
        for j in jeonse:
            k = key_of(j, band, normalize=True)
            ymds = sale_keys.get(k)
            if not ymds:
                continue
            hit_all += 1
            if any(y >= recent_cut for y in ymds):
                hit_recent += 1
        label = "원본" if band == 0 else f"{band}m²"
        print(f"{label:>6}  {len(sale_keys):>9,}  "
              f"{hit_all:>9,} ({hit_all / len(jeonse):>5.1%})  "
              f"{hit_recent:>9,} ({hit_recent / len(jeonse):>5.1%})")

    # 3) 폴백 단계별 커버리지 (band=0.5 고정)
    band = 0.5
    lv_a = defaultdict(list)   # 건물+면적
    lv_b = defaultdict(list)   # 법정동+면적대
    lv_c = defaultdict(list)   # 법정동
    for s in sales:
        lv_a[key_of(s, band, normalize=True)].append(s)
        lv_b[(s["lawd_cd"], (s["umd_nm"] or "").strip(), area_key(s["exclu_use_ar"], 10.0))].append(s)
        lv_c[(s["lawd_cd"], (s["umd_nm"] or "").strip())].append(s)

    stage = Counter()
    for j in jeonse:
        if key_of(j, band, normalize=True) in lv_a:
            stage["A 같은 건물·면적"] += 1
        elif (j["lawd_cd"], (j["umd_nm"] or "").strip(), area_key(j["exclu_use_ar"], 10.0)) in lv_b:
            stage["B 같은 동·유사면적"] += 1
        elif (j["lawd_cd"], (j["umd_nm"] or "").strip()) in lv_c:
            stage["C 같은 동 전체"] += 1
        else:
            stage["D 비교 불가"] += 1
    print("\n폴백 단계별 전세 커버리지:")
    for name in ("A 같은 건물·면적", "B 같은 동·유사면적", "C 같은 동 전체", "D 비교 불가"):
        n = stage[name]
        print(f"  {name:<18} {n:>9,}  {n / len(jeonse):>6.1%}")

    # 4) 매칭된 물건의 표본 두께 — 매매 몇 건에 기대는가
    sale_keys = defaultdict(int)
    for s in sales:
        sale_keys[key_of(s, band, normalize=True)] += 1
    depths = [sale_keys[key_of(j, band, normalize=True)]
              for j in jeonse if key_of(j, band, normalize=True) in sale_keys]
    if depths:
        depths.sort()
        thin = sum(1 for d in depths if d < 3)
        print(f"\nA단계 매칭 건의 매매 표본 두께: 중위 {depths[len(depths) // 2]}건, "
              f"3건 미만이 {thin:,}건 ({thin / len(depths):.1%})")

    # 5) preDeposit / useRRRight 충전율 — payload는 여기서만 스트리밍으로 읽는다
    renew_total = filled_pre = filled_rr = 0
    for (payload,) in conn.execute(
        "SELECT payload FROM transactions WHERE deal_type='전월세' AND housing_type=? "
        "AND contract_type='갱신'",
        (housing_type,),
    ):
        renew_total += 1
        p = json.loads(payload)
        if (p.get("preDeposit") or "").strip():
            filled_pre += 1
        if (p.get("useRRRight") or "").strip():
            filled_rr += 1
    print(f"\n갱신 계약 {renew_total:,}건 (전월세의 {renew_total / len(rents):.1%})")
    if renew_total:
        print(f"  preDeposit 채워짐  {filled_pre:>9,}  {filled_pre / renew_total:>6.1%}")
        print(f"  useRRRight 채워짐  {filled_rr:>9,}  {filled_rr / renew_total:>6.1%}")


def main() -> int:
    parser = argparse.ArgumentParser(description="물건 단위 매칭률 실측")
    parser.add_argument("--db", default="/workspace/seoul_rt.sqlite")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    for housing_type in ("아파트", "연립다세대"):
        probe(conn, housing_type)
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
