#!/usr/bin/env python3
"""당월 조회가 정상 응답하는지 확인하는 일회성 정찰.

배경: 2026-08-30에 수집 창을 전월에서 당월까지 넓혔다(collect.default_window).
계획의 정확히 1/3(6소스 x 74시군구 = 444구간)이 이 파이프라인이 한 번도 해 본
적 없는 질의 모양이다. 국토부가 당월 DEAL_YMD에 오류를 주면 그 444구간이 전부
error가 되고, collect.py의 20% 오류율 가드가 회차 전체를 실패로 끝낸다. 그러면
집계·units·CSV 커밋·Vercel 훅이 통째로 안 돈다. 주간 실거래 갱신을 통째로
잃는다는 뜻이라, 병합 전에 6번만 두드려 확인한다(CTO 리뷰 지적).

읽는 법: 소스마다 전월(대조군)과 당월을 나란히 찍고, 종료 코드로 셋을 가른다.
0이면 둘 다 정상이라 넓혀도 된다. 1이면 전월은 되는데 당월만 막힌 것이라 창을
되돌려야 한다. 2면 전월까지 실패해 이 러너가 국토부에 아예 못 닿은 것이고,
당월에 대해서는 아무것도 말할 수 없다. 그때는 새 잡으로 다시 건다(차단은 IP
단위). 건수가 0인 것은 오류가 아니다. 그 달에 아직 신고가 없다는 뜻이고,
수집기는 빈 응답을 정상으로 처리한다.

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
    bad, control_bad = [], []
    for key_name, src in SOURCES.items():
        line = [f"{src.label} ({key_name})"]
        for ym, tag in ((prev, "전월"), (cur, "당월")):
            try:
                # 한 건만 받는다. 묻는 것은 "게이트웨이가 이 달을 받아 주는가"이지
                # 몇 건이 있는가가 아니다. 처음엔 기본값으로 불렀다가 10분
                # 타임아웃에 잘렸다. fetch_month는 그 달의 전 페이지를 다 받아서,
                # 6소스 x 2달이 12회 전체 수집이 됐다.
                rows = fetch_month(session, key, src, LAWD, ym,
                                   rows_per_page=1, max_pages=1,
                                   max_retries=1, timeout=20)
                line.append(f"{tag} 정상(표본 {len(rows)}건)")
            except Exception as exc:
                detail = describe(exc)
                line.append(f"{tag} 실패: {detail}")
                (bad if tag == "당월" else control_bad).append((key_name, detail))
        print("  " + " | ".join(line))

    print()
    # 대조군을 판정에 실제로 쓴다. 처음에는 전월을 찍기만 하고 당월 실패만
    # 세어서, 러너가 통째로 막힌 회차에도 "당월이 문제"라고 결론지었다.
    # 2026-08-30 1회차가 정확히 그랬다. 전월도 전 소스 403이었는데 스크립트는
    # 당월 탓을 했다. 대조군이 같이 죽으면 이 회차는 아무것도 못 말한다.
    if control_bad:
        print(f"대조군인 전월({prev})도 소스 {len(control_bad)}개에서 실패했습니다. "
              f"이 러너가 국토부에 닿지 못한 것이라 당월에 대해서는 아무것도 "
              f"말할 수 없습니다. 차단은 IP 단위라 새 잡으로 다시 거세요.")
        for k, d in control_bad:
            print(f"  {k}: {d}")
        return 2
    if bad:
        print(f"전월은 되는데 당월만 소스 {len(bad)}개에서 실패했습니다. 창을 "
              f"넓히면 이 소스들이 계획의 1/3을 error로 만들어 20% 가드에 걸립니다.")
        for k, d in bad:
            print(f"  {k}: {d}")
        return 1
    print("전월과 당월 모두 전 소스 정상입니다. 창을 당월까지 넓혀도 됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
