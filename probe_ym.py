#!/usr/bin/env python3
"""당월 조회가 정상 응답하는지 확인하는 일회성 정찰.

배경: 2026-08-30에 수집 창을 전월에서 당월까지 넓혔다(collect.default_window).
계획의 정확히 1/3(6소스 x 74시군구 = 444구간)이 이 파이프라인이 한 번도 해 본
적 없는 질의 모양이다. 국토부가 당월 DEAL_YMD에 오류를 주면 그 444구간이 전부
error가 되고, collect.py의 20% 오류율 가드가 회차 전체를 실패로 끝낸다. 그러면
집계·units·CSV 커밋·Vercel 훅이 통째로 안 돈다. 주간 실거래 갱신을 통째로
잃는다는 뜻이라, 병합 전에 6번만 두드려 확인한다(CTO 리뷰 지적).

읽는 법: 소스마다 당월과 전월을 나란히 찍는다. 당월이 전부 "정상"이면 넓혀도
된다. 당월만 오류 코드를 내는 소스가 있으면 그 소스를 당월에서 빼거나 창을
되돌려야 한다. 건수가 0인 것은 오류가 아니다. 그 달에 아직 신고가 없다는
뜻이고, 수집기는 빈 응답을 정상으로 처리한다.

결론이 나면 이 파일과 워크플로는 지워도 된다.

사용법 (러너에서만 접속 가능):
    MOLIT_SERVICE_KEY=... python probe_ym.py
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta

import requests

from collect import SOURCES, fetch_month
from scrub import describe

LAWD = "11110"  # 종로구. 서울에서 가장 오래 안정적으로 받아 온 시군구다.


def main() -> int:
    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY 환경 변수가 없습니다.", file=sys.stderr)
        return 1

    today = date.today()
    cur = today.strftime("%Y%m")
    prev = (today.replace(day=1) - timedelta(days=1)).strftime("%Y%m")
    print(f"러너 기준 오늘 {today} · 당월 {cur} · 전월 {prev} (비교군)\n")

    session = requests.Session()
    bad = []
    for key_name, src in SOURCES.items():
        line = [f"{src.label} ({key_name})"]
        for ym, tag in ((prev, "전월"), (cur, "당월")):
            try:
                rows = fetch_month(session, key, src, LAWD, ym)
                line.append(f"{tag} 정상 {len(rows):,}건")
            except Exception as exc:
                detail = describe(exc)
                line.append(f"{tag} 실패: {detail}")
                if tag == "당월":
                    bad.append((key_name, detail))
        print("  " + " | ".join(line))

    print()
    if bad:
        print(f"당월 조회에 실패한 소스 {len(bad)}개. 창을 넓히면 이 소스들이 "
              f"계획의 1/3을 error로 만들어 20% 가드에 걸립니다.")
        for k, d in bad:
            print(f"  {k}: {d}")
        return 1
    print("당월 조회가 전 소스 정상입니다. 창을 당월까지 넓혀도 됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
