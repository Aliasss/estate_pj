#!/usr/bin/env python3
"""차단이 서비스 단위인가 IP 단위인가를 한 잡에서 가른다 (일회성 진단).

배경: 실거래 수집이 2026-08-24 크론과 08-25 수동 재시도에서 연달아 사전 확인
전부 ConnectTimeout으로 0건 실패했다. 같은 무렵 건축물대장 수집은 같은 호스트
(apis.data.go.kr)에서 정상 동작했는데, 두 워크플로는 concurrency 그룹이 같아
겹쳐 돌 수 없고 러너도 달라서 이그레스 IP가 다르다. 그래서 "서비스 단위 차단"과
"IP 단위 차단"이 아직 갈리지 않았다. 둘은 처방이 완전히 다르다.
  - 서비스 단위: 사전 확인이 소스를 돌아가며 두드리면 살아난다.
  - IP 단위: 위 수정은 무력하고, 크론 시각 이동이나 국내 IP가 답이다.

방법: 한 잡, 한 IP, 한 순간에 실거래 6종과 건축물대장과 법정동코드를 각각
최소 요청으로 두드려 응답 여부와 소요를 찍는다. 수집기의 fetch 경로를 그대로
빌려 쓴다. 판정을 위해 다른 코드로 재현하면 그 차이가 결과를 흐린다.

읽는 법
    응답     연결됨. 한도·인증 오류도 여기 든다(왕복이 성립했다는 뜻)
    막힘     ConnectTimeout 계열. 이것만 차단의 증거다

사용법 (러너에서만 접속 가능)
    MOLIT_SERVICE_KEY=... python probe_block.py
"""

from __future__ import annotations

import os
import sys
import time
import urllib.parse

import requests

import collect
import collect_bldg
from scrub import describe

ROUNDS = 2
GAP = 90
# 행촌동 210-225. 대장 표제부에 실려 있음이 확인된 실물이다.
BLDG_TARGET = ("11110", "18100", "0", "0210", "0225", "")


def egress_ip() -> str:
    for url in ("https://api.ipify.org", "https://checkip.amazonaws.com"):
        try:
            return requests.get(url, timeout=10).text.strip()
        except Exception:
            continue
    return "(확인 못 함)"


def probe(name: str, call) -> bool:
    t0 = time.monotonic()
    try:
        call()
        print(f"  응답  {name:28s} {time.monotonic() - t0:5.1f}초")
        return True
    except (collect.FatalApiError, collect.QuotaExhausted) as exc:
        # 왕복이 성립했다. 한도든 인증이든 연결은 된 것이다.
        print(f"  응답  {name:28s} {time.monotonic() - t0:5.1f}초  ({describe(exc)})")
        return True
    except Exception as exc:
        print(f"  막힘  {name:28s} {time.monotonic() - t0:5.1f}초  ({describe(exc)})")
        return False


def main() -> int:
    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY 환경 변수가 없습니다.", file=sys.stderr)
        return 1
    if "%" in key:
        key = urllib.parse.unquote(key)

    print(f"이그레스 IP: {egress_ip()}")
    ym = "202607"
    for r in range(ROUNDS):
        print(f"\n--- {r + 1}회차")
        alive, dead = [], []
        for src in collect.SOURCES.values():
            ok = probe(f"실거래 {src.label}", lambda s=src: collect.fetch_month(
                requests.Session(), key, s, "11110", ym,
                rows_per_page=1, max_pages=1, max_retries=1, timeout=20))
            (alive if ok else dead).append(src.label)
        ok = probe("건축물대장 표제부", lambda: collect_bldg.fetch(
            requests.Session(), key, BLDG_TARGET, [0], max_retries=1, timeout=20))
        (alive if ok else dead).append("건축물대장")
        print(f"  => 응답 {len(alive)} / 막힘 {len(dead)}")
        if dead and alive:
            print(f"  => 갈렸다. 막힌 것: {', '.join(dead)}  살아 있는 것: {', '.join(alive)}")
            print("  => 서비스 단위 차단이다. 사전 확인이 소스를 돌아가며 두드리면 산다.")
        elif dead:
            print("  => 전부 막혔다. IP 단위 차단이 유력하다. 소스 순회로는 못 산다.")
        else:
            print("  => 전부 응답. 지금은 창이 열려 있다.")
        if r < ROUNDS - 1:
            time.sleep(GAP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
