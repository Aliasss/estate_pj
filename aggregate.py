#!/usr/bin/env python3
"""수집한 실거래가 원본을 월 × 자치구 × 유형 집계 패널로 변환한다.

만들어지는 테이블
  monthly_panel  60개월 × 25구 × 2유형(아파트/연립다세대) × 2거래유형(매매/전월세) = 최대 6,000행
  jeonse_ratio   60개월 × 25구 × 2유형 = 최대 3,000행. 전세가율(전세보증금 / 매매가) 패널

집계 규칙
- 해제(cdeal_type = 'O')된 거래는 제외한다. 별도로 n_cancelled에 건수만 남긴다.
- 평단가 = 금액(만원) / (전용면적 m2 / 3.305785). 전용면적 기준이라 공급면적 평단가보다 높게 나온다.
- 중위값을 쓴다. 실거래가는 초고가 거래에 평균이 크게 흔들린다.
- 전세 = 월세 0원. 전세가율은 면적 믹스를 통제하려고 평단가 기준으로도 함께 낸다.

사용법
    python aggregate.py --db seoul_rt.sqlite --csv-dir ./out
"""

from __future__ import annotations

import argparse
import csv
import os
import sqlite3
from datetime import date

PYEONG = 3.305785

# 해제 거래를 뺀 분석용 뷰. 이후 모든 집계가 이 뷰를 본다.
#
# 수집기가 이번에 겨눈 달({month_cut})도 뺀다. 2026-08-30에 수집 창을 당월까지
# 넓혔는데(collect.default_window), 진행 중인 달을 월 집계에 넣으면 차트 끝이
# 절벽으로 그려진다. 잠정 표시를 해도 "거래가 급감했다"로 오독되고, 이 앱은
# 표본 두께를 그 자체로 위험 신호로 쓰기 때문에 자기모순이 된다.
#
# 끝난 달과 진행 중인 달은 성격이 다르다. 7월은 끝났고 신고가 차오르는 중이라
# 잠정으로 그린다. 8월은 아직 계약이 일어나는 중이라 집계할 대상 자체가 없다.
# 그 선을 여기서 긋는다. 개별 거래는 build_units가 transactions를 직접 읽어
# 'P' 꼬리표를 달고 최근 거래 목록에 싣는다. 이 뷰와 무관하다.
#
# 상한은 시계가 아니라 fetch_log에서 뽑는다(month_cut 계산부 참고). 처음에는
# date.today()를 썼는데 CTO 리뷰가 반증했다. 크론이 월 21:00 UTC이고 회차가
# 최장 4시간이라(8/25 실측 4시간 0분) aggregate가 UTC 자정을 넘겨 도는 날이
# 있다. 그런 날 collect는 21시 UTC의 달을 겨누고 aggregate는 다음 날 UTC의
# 달을 자르므로, 방금 받은 당월이 패널에 새어 든다. 2026-08-31이 바로 그
# 월요일이었다. 게다가 fetch-data.mjs의 "확정월 갈림" 경고는 이 어긋남을
# 못 잡아서 조용히 틀린다.
BASE_VIEW = f"""
DROP VIEW IF EXISTS deals;
CREATE VIEW deals AS
SELECT
    substr(deal_ymd, 1, 4) || '-' || substr(deal_ymd, 5, 2) AS ym,
    lawd_cd,
    sgg_nm,
    housing_type,
    deal_type,
    exclu_use_ar,
    floor,
    build_year,
    monthly_rent,
    contract_type,
    CASE WHEN deal_type = '매매' THEN deal_amount ELSE deposit END AS amount,
    CASE
        WHEN exclu_use_ar > 0
        THEN (CASE WHEN deal_type = '매매' THEN deal_amount ELSE deposit END) / (exclu_use_ar / {PYEONG})
    END AS price_per_pyeong
FROM transactions
WHERE (cdeal_type IS NULL OR cdeal_type <> 'O')
  AND deal_ymd < '{{month_cut}}';
"""

# SQLite에는 median 집계함수가 없어서 윈도우 함수로 중앙값 두 개(짝수 개일 때)를 평균낸다.
MEDIAN_TEMPLATE = """
WITH ranked AS (
    SELECT {group_cols}, {value_expr} AS v,
           ROW_NUMBER() OVER (PARTITION BY {group_cols} ORDER BY {value_expr}) AS rn,
           COUNT(*)     OVER (PARTITION BY {group_cols})                       AS c
    FROM deals
    WHERE {value_expr} IS NOT NULL {extra_where}
)
SELECT {group_cols}, AVG(v) AS median_v
FROM ranked
WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
GROUP BY {group_cols}
"""

PANEL_GROUP = "ym, lawd_cd, sgg_nm, housing_type, deal_type"
RATIO_GROUP = "ym, lawd_cd, sgg_nm, housing_type"

PANEL_SQL = f"""
DROP TABLE IF EXISTS monthly_panel;
CREATE TABLE monthly_panel AS
WITH counts AS (
    SELECT {PANEL_GROUP},
           COUNT(*)                                                        AS n_deals,
           SUM(CASE WHEN deal_type = '전월세' AND monthly_rent = 0 THEN 1 ELSE 0 END) AS n_jeonse,
           SUM(CASE WHEN deal_type = '전월세' AND monthly_rent > 0 THEN 1 ELSE 0 END) AS n_wolse,
           SUM(CASE WHEN contract_type = '신규' THEN 1 ELSE 0 END)          AS n_new,
           SUM(CASE WHEN contract_type = '갱신' THEN 1 ELSE 0 END)          AS n_renew,
           AVG(exclu_use_ar)                                               AS avg_area_m2,
           AVG(build_year)                                                 AS avg_build_year
    FROM deals
    GROUP BY {PANEL_GROUP}
),
med_amount AS ({MEDIAN_TEMPLATE.format(group_cols=PANEL_GROUP, value_expr="amount", extra_where="")}),
med_ppp AS ({MEDIAN_TEMPLATE.format(group_cols=PANEL_GROUP, value_expr="price_per_pyeong", extra_where="")}),
cancelled AS (
    SELECT substr(deal_ymd, 1, 4) || '-' || substr(deal_ymd, 5, 2) AS ym,
           lawd_cd, housing_type, deal_type, COUNT(*) AS n_cancelled
    FROM transactions
    WHERE cdeal_type = 'O'
    GROUP BY 1, 2, 3, 4
)
SELECT c.ym, c.lawd_cd, c.sgg_nm, c.housing_type, c.deal_type,
       c.n_deals,
       COALESCE(x.n_cancelled, 0)          AS n_cancelled,
       c.n_jeonse, c.n_wolse, c.n_new, c.n_renew,
       ROUND(a.median_v)                   AS median_amount_manwon,
       ROUND(p.median_v)                   AS median_price_per_pyeong,
       ROUND(c.avg_area_m2, 2)             AS avg_area_m2,
       ROUND(c.avg_build_year)             AS avg_build_year
FROM counts c
LEFT JOIN med_amount a USING (ym, lawd_cd, sgg_nm, housing_type, deal_type)
LEFT JOIN med_ppp    p USING (ym, lawd_cd, sgg_nm, housing_type, deal_type)
LEFT JOIN cancelled  x ON x.ym = c.ym AND x.lawd_cd = c.lawd_cd
                      AND x.housing_type = c.housing_type AND x.deal_type = c.deal_type
ORDER BY c.ym, c.lawd_cd, c.housing_type, c.deal_type;
"""

# 전세가율: 같은 (월, 구, 유형) 안에서 전세 중위값과 매매 중위값을 붙인다.
RATIO_SQL = f"""
DROP TABLE IF EXISTS jeonse_ratio;
CREATE TABLE jeonse_ratio AS
WITH sale_amt AS ({MEDIAN_TEMPLATE.format(group_cols=RATIO_GROUP, value_expr="amount", extra_where="AND deal_type = '매매'")}),
     sale_ppp AS ({MEDIAN_TEMPLATE.format(group_cols=RATIO_GROUP, value_expr="price_per_pyeong", extra_where="AND deal_type = '매매'")}),
     jeonse_amt AS ({MEDIAN_TEMPLATE.format(group_cols=RATIO_GROUP, value_expr="amount", extra_where="AND deal_type = '전월세' AND monthly_rent = 0")}),
     jeonse_ppp AS ({MEDIAN_TEMPLATE.format(group_cols=RATIO_GROUP, value_expr="price_per_pyeong", extra_where="AND deal_type = '전월세' AND monthly_rent = 0")}),
     n AS (
         SELECT {RATIO_GROUP},
                SUM(CASE WHEN deal_type = '매매' THEN 1 ELSE 0 END) AS n_sale,
                SUM(CASE WHEN deal_type = '전월세' AND monthly_rent = 0 THEN 1 ELSE 0 END) AS n_jeonse
         FROM deals
         GROUP BY {RATIO_GROUP}
     )
SELECT n.ym, n.lawd_cd, n.sgg_nm, n.housing_type,
       n.n_sale, n.n_jeonse,
       ROUND(sa.median_v)  AS median_sale_manwon,
       ROUND(ja.median_v)  AS median_jeonse_manwon,
       ROUND(sp.median_v)  AS median_sale_ppp,
       ROUND(jp.median_v)  AS median_jeonse_ppp,
       ROUND(ja.median_v / NULLIF(sa.median_v, 0), 4) AS jeonse_ratio_amount,
       ROUND(jp.median_v / NULLIF(sp.median_v, 0), 4) AS jeonse_ratio_ppp
FROM n
LEFT JOIN sale_amt   sa USING (ym, lawd_cd, sgg_nm, housing_type)
LEFT JOIN sale_ppp   sp USING (ym, lawd_cd, sgg_nm, housing_type)
LEFT JOIN jeonse_amt ja USING (ym, lawd_cd, sgg_nm, housing_type)
LEFT JOIN jeonse_ppp jp USING (ym, lawd_cd, sgg_nm, housing_type)
ORDER BY n.ym, n.lawd_cd, n.housing_type;
"""

# 신고 누락/지연 점검용. 임대차신고제 계도기간(2021.06~2023.05) 구간 건수가 뒤 구간 대비
# 얼마나 낮은지 눈으로 확인하려고 월별 총계를 따로 뽑는다.
COVERAGE_SQL = """
DROP TABLE IF EXISTS monthly_coverage;
CREATE TABLE monthly_coverage AS
SELECT ym, housing_type, deal_type,
       COUNT(*) AS n_deals,
       COUNT(DISTINCT lawd_cd) AS n_gu
FROM deals
GROUP BY ym, housing_type, deal_type
ORDER BY ym, housing_type, deal_type;
"""


def export_csv(conn: sqlite3.Connection, table: str, path: str) -> int:
    cur = conn.execute(f"SELECT * FROM {table}")
    columns = [d[0] for d in cur.description]
    count = 0
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(columns)
        for row in cur:
            writer.writerow(row)
            count += 1
    return count


def pick_month_cut(conn: sqlite3.Connection) -> str:
    """월 집계에서 제외할 첫 달. 이 달과 그 이후는 안 넣는다.

    시계를 안 쓴다. 수집기가 이번 회차에 겨눈 창의 끝을 fetch_log에서 읽는다.
    같은 잡 안에서 collect와 aggregate가 각각 date.today()를 부르면, 잡이 UTC
    자정을 넘는 날 서로 다른 달을 보고 방금 받은 당월이 패널에 새어 든다.
    데이터에서 뽑으면 몇 시에 돌든 같은 답이 나온다.

    status='ok'만 본다. 오류만 남은 달을 상한으로 삼으면 실제로 받은 달까지
    잘라 낸다. fetch_log가 없거나 비면(스냅숏만 받아 따로 돌리는 경우)
    transactions의 최신 달로 물러선다. 그것도 없으면 시계를 쓰되 그 사실을
    로그에 남긴다. 어느 쪽이든 틀리는 방향은 "한 달 덜 연다"는 안전한 쪽이다.
    """
    for sql, why in (
        ("SELECT MAX(deal_ymd) FROM fetch_log WHERE status = 'ok'", "fetch_log"),
        ("SELECT MAX(deal_ymd) FROM transactions", "transactions"),
    ):
        try:
            got = conn.execute(sql).fetchone()[0]
        except sqlite3.OperationalError:
            continue
        if got:
            if why != "fetch_log":
                print(f"  주의: fetch_log를 못 읽어 {why}의 최신 달을 상한으로 씁니다.")
            return str(got)[:6]
    fallback = date.today().strftime("%Y%m")
    print(f"  주의: 수집 이력이 없어 시계({fallback})를 상한으로 씁니다.")
    return fallback


def main() -> int:
    parser = argparse.ArgumentParser(description="실거래가 원본 -> 집계 패널")
    parser.add_argument("--db", default="seoul_rt.sqlite")
    parser.add_argument("--csv-dir", default="", help="지정하면 각 테이블을 CSV로도 내보낸다")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    total = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    if not total:
        print("transactions가 비어 있습니다. collect.py를 먼저 돌리세요.")
        return 1
    print(f"원본 {total:,}건")

    month_cut = pick_month_cut(conn)
    print(f"집계 상한: {month_cut} 직전까지 (수집기가 겨눈 달 제외)")

    for name, sql in [
        ("deals(view)", BASE_VIEW.format(month_cut=month_cut)),
        ("monthly_panel", PANEL_SQL),
        ("jeonse_ratio", RATIO_SQL),
        ("monthly_coverage", COVERAGE_SQL),
    ]:
        conn.executescript(sql)
        print(f"  {name} 생성")
    conn.commit()

    for table in ("monthly_panel", "jeonse_ratio", "monthly_coverage"):
        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table}: {n:,}행")

    if args.csv_dir:
        os.makedirs(args.csv_dir, exist_ok=True)
        for table in ("monthly_panel", "jeonse_ratio", "monthly_coverage"):
            path = os.path.join(args.csv_dir, f"{table}.csv")
            n = export_csv(conn, table, path)
            print(f"  {path} ({n:,}행)")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
