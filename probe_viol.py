#!/usr/bin/env python3
"""건축HUB 전 오퍼레이션에서 위반건축물 필드를 찾는 일회성 정찰.

배경: 유료 리포트가 파는 항목 중 위반건축물 표기만 수집 파이프라인에 없다
(docs/수익모델-검토-2026-08.md, todo #20). 우리가 쓰는 표제부(getBrTitleInfo)
응답 78개 필드에는 없음을 스냅숏 payload로 확정했고(2026-08-24), 남은 질문은
"건축HUB의 다른 오퍼레이션에는 있는가"다. 있으면 공짜 배치 수집이 열리고,
없으면 발급 대행 API(사업자 계약, 건당 과금)나 수동 열람이 유일한 경로다.

방법: 표제부에 실린 실물(행촌동 210-225)로 오퍼레이션 전부를 호출해
응답 아이템 키의 합집합을 찍고, viol/위반이 걸리는 키·값을 찾는다.
지번 파라미터를 요구하지 않는 오퍼레이션도 있어 동 단위 호출도 같이 본다.
data.go.kr JSON은 빈 필드도 키를 실어 보내므로 한 건이면 스키마가 보인다.

사용법 (러너에서만 접속 가능):
    MOLIT_SERVICE_KEY=... python probe_viol.py

읽는 법: 오퍼레이션마다 "키 N개" 줄과 위반 후보 줄이 찍힌다.
전부 "위반 후보 없음"이면 공짜 경로는 없다는 결론이 확정된다.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse

import requests

from scrub import describe

BASE = "https://apis.data.go.kr/1613000/BldRgstHubService"
# 활용신청 문서에 실린 오퍼레이션 전부. 표제부는 기준 비교용으로 포함한다.
OPS = [
    "getBrBasisOulnInfo",       # 기본개요
    "getBrRecapTitleInfo",      # 총괄표제부
    "getBrTitleInfo",           # 표제부 (기준: 위반 필드 없음 확정)
    "getBrFlrOulnInfo",         # 층별개요
    "getBrAtchJibunInfo",       # 부속지번
    "getBrExposPubuseAreaInfo", # 전유공유면적
    "getBrWclfInfo",            # 오수정화시설
    "getBrHsprcInfo",           # 주택가격
    "getBrExposInfo",           # 전유부
    "getBrJijiguInfo",          # 지역지구구역
]
# 표제부에 실려 있음을 확인한 실물. bldg.sqlite 실측값이다.
TARGET = {"sigunguCd": "11110", "bjdongCd": "18100",
          "platGbCd": "0", "bun": "0210", "ji": "0225"}
VIOL_KEY = re.compile(r"viol|illeg|wrong", re.I)


def items_of(payload: dict) -> list[dict]:
    # 봉투가 response 유무 두 형태로 온다(collect_schools에서 실측).
    body = payload.get("response", payload).get("body", {})
    raw = (body.get("items") or {})
    if isinstance(raw, dict):
        raw = raw.get("item") or []
    return raw if isinstance(raw, list) else [raw]


def probe(key: str, op: str, params: dict, label: str) -> None:
    try:
        res = requests.get(f"{BASE}/{op}", timeout=20, params={
            "serviceKey": key, "numOfRows": 100, "pageNo": 1,
            "_type": "json", **params,
        })
    except Exception as exc:
        print(f"  [{label}] 막힘: {describe(exc)}")
        return
    text = res.text
    try:
        rows = items_of(res.json())
    except ValueError:
        print(f"  [{label}] HTTP {res.status_code}, JSON 아님: {text[:120]!r}")
        return
    keys = sorted({k for it in rows if isinstance(it, dict) for k in it})
    hits = [k for k in keys if VIOL_KEY.search(k)]
    print(f"  [{label}] {len(rows)}건, 키 {len(keys)}개")
    if keys:
        print(f"    {keys}")
    if hits:
        print(f"    !! 위반 후보 키: {hits}")
        for it in rows[:3]:
            print(f"       값 표본: {[(k, it.get(k)) for k in hits]}")
    if "위반" in text:
        idx = text.index("위반")
        print(f"    !! 본문에 '위반' 등장: …{text[max(0, idx - 60):idx + 60]}…")
    if not hits and "위반" not in text:
        print("    위반 후보 없음")


def main() -> int:
    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY 환경 변수가 없습니다.", file=sys.stderr)
        return 1
    if "%" in key:
        key = urllib.parse.unquote(key)
    for op in OPS:
        print(f"--- {op}")
        probe(key, op, TARGET, "지번")
        # 지번 없이 동 단위로도 훑는다. 오퍼레이션에 따라 지번 파라미터가
        # 필수가 아니고, 다른 건물에서만 채워지는 필드가 있을 수 있다.
        probe(key, op, {"sigunguCd": TARGET["sigunguCd"],
                        "bjdongCd": TARGET["bjdongCd"]}, "동")
    print("끝. 전부 '위반 후보 없음'이면 공짜 경로는 없다 — todo #20은 "
          "발급 대행 API 또는 수동 열람으로 확정.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
