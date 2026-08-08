#!/usr/bin/env python3
"""한국은행 ECOS에서 금리 시계열을 받아 data/rates.json으로 굽는다. web/public/data/는 gitignore라 커밋이 안 되므로,
웹은 빌드 때 fetch-data.mjs가 이 파일을 public으로 복사해 간다.

이 앱에서 금리가 실제로 쓰이는 곳은 둘이다.
  - 리포트의 전월세 전환율 판정: "전환율 6.0%"만 주면 판단을 못 한다. 비교 대상
    (예금 금리, 전세대출 금리)을 같이 줘야 문장이 판정이 된다.
  - 시세 흐름 탭: 전세가율이 꺾인 자리에 기준금리가 겹쳐 보이면 왜 꺾였는지 읽힌다.

물가(CPI) 보정은 하지 않는다. 임차인이 돌려받을 보증금은 명목이고, 실질 보정한
시세는 위험 판단에 정보를 더하지 않으면서 착시만 얹는다.

사용법
    ECOS_API_KEY=... python collect_rates.py --out web/public/data/rates.json
    ECOS_API_KEY=... python collect_rates.py --probe 121Y002   # 통계표의 항목 코드 확인

키는 ecos.bok.or.kr 회원가입 후 무료 발급(즉시). 일 1만 건 한도인데 우리는 월 1회
시리즈 몇 개라 발끝에도 안 간다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date, timedelta

from scrub import scrub

BASE = "https://ecos.bok.or.kr/api"

# (필드명, 통계표코드, 항목코드, 사람이 읽는 이름)
# 항목 코드가 개편으로 어긋나면 그 시리즈만 빠지고 나머지는 산다. 실행 로그가
# API가 돌려준 통계명·항목명을 그대로 찍으므로, 어긋났는지는 로그에서 바로 보인다.
SERIES = [
    ("base", "722Y001", "0101000", "한국은행 기준금리"),
    ("deposit", "121Y002", "BEABAA2", "예금은행 정기예금 금리(신규취급액)"),
    ("loan", "121Y006", "BECBLA0301", "예금은행 주택담보대출 금리(신규취급액)"),
]


def fetch(key: str, stat: str, item: str, start: str, end: str) -> list[dict]:
    url = f"{BASE}/StatisticSearch/{key}/json/kr/1/1000/{stat}/M/{start}/{end}/{item}"
    req = urllib.request.Request(url, headers={"User-Agent": "estate-pj"})
    with urllib.request.urlopen(req, timeout=30) as res:
        body = json.loads(res.read().decode("utf-8"))
    if "RESULT" in body:                       # 오류는 RESULT로 온다
        raise RuntimeError(f"{body['RESULT'].get('CODE')} {body['RESULT'].get('MESSAGE')}")
    rows = body.get("StatisticSearch", {}).get("row", [])
    return rows


def probe(key: str, stat: str) -> int:
    """통계표의 항목 목록을 찍는다. 코드가 어긋났을 때 맞는 코드를 찾는 용도."""
    url = f"{BASE}/StatisticItemList/{key}/json/kr/1/100/{stat}"
    with urllib.request.urlopen(url, timeout=30) as res:
        body = json.loads(res.read().decode("utf-8"))
    for row in body.get("StatisticItemList", {}).get("row", []):
        print(f"  {row.get('ITEM_CODE')}  {row.get('ITEM_NAME')}  ({row.get('CYCLE')})")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/rates.json")
    ap.add_argument("--months", type=int, default=72, help="가져올 개월 수")
    ap.add_argument("--probe", metavar="STAT_CODE", help="항목 코드 목록만 출력")
    args = ap.parse_args()

    key = os.environ.get("ECOS_API_KEY", "").strip()
    if not key:
        print("ECOS_API_KEY가 없습니다. ecos.bok.or.kr에서 무료 발급됩니다.", file=sys.stderr)
        return 1

    if args.probe:
        return probe(key, args.probe)

    today = date.today()
    start = (today - timedelta(days=args.months * 31)).strftime("%Y%m")
    end = today.strftime("%Y%m")

    out: dict = {"series": {}, "names": {}, "asof": end}
    failed = []
    for field, stat, item, label in SERIES:
        try:
            rows = fetch(key, stat, item, start, end)
        except Exception as exc:
            print(f"  {label} 실패: {scrub(exc)}", file=sys.stderr)
            failed.append(field)
            continue
        if not rows:
            print(f"  {label}: 0건. 항목 코드가 어긋났을 수 있다. --probe {stat} 로 확인.",
                  file=sys.stderr)
            failed.append(field)
            continue
        # API가 말하는 이름을 그대로 남긴다. 코드가 다른 걸 가리키면 여기서 드러난다.
        got = f"{rows[0].get('STAT_NAME', '')} / {rows[0].get('ITEM_NAME1', '')}"
        print(f"  {field}: {got}  {len(rows)}개월")
        out["names"][field] = got
        out["series"][field] = {r["TIME"]: float(r["DATA_VALUE"]) for r in rows
                                if r.get("DATA_VALUE") not in (None, "")}

    if not out["series"]:
        print("받은 시리즈가 하나도 없습니다.", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{args.out} 기록 ({len(out['series'])}/{len(SERIES)} 시리즈)")
    # 일부 실패는 경고로 두되 성공으로 끝낸다. 기준금리 하나만 있어도 화면은 선다.
    if failed:
        print(f"빠진 시리즈: {', '.join(failed)} (로그의 --probe 안내 참고)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
