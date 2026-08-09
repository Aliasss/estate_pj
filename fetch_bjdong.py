#!/usr/bin/env python3
"""행정표준코드 법정동코드(StanReginCd)에서 서울 법정동 매핑을 내려받는다.

건축물대장 조회에는 (시군구 5자리, 법정동 5자리)가 필요한데, 지금까지는 실거래
payload에 실려 온 umdCd를 주워 썼다. 전 소스로 넓혀도 "그 동에 신고가 한 건도
없으면" 여전히 빠진다. 이 스크립트는 행안부 공식 코드표를 받아 그 구멍을 없앤다.

산출: bjdong.json  {"11110": {"청운동": "10100", ...}, "41220": {"팽성읍 대사리": "25331", ...}}
동·읍·면은 이름 그대로, 경기의 리(里)는 "읍면명 리명"으로 담는다. 실거래
umd_nm이 리 수준으로 오는 지역이 실재해서다. 매일 크론에서 받아도 부담이
없고, 코드 개편(동 통폐합)도 자동으로 따라간다.

사용법
    MOLIT_SERVICE_KEY=... python fetch_bjdong.py --out bjdong.json
공공데이터포털에서 "행정표준코드관리시스템 법정동코드" 활용신청이 되어 있어야
한다(자동승인). 승인 전이면 API가 오류를 주고, 이 스크립트는 exit 1로 끝난다.
호출부(buildings.yml)는 실패해도 수집을 계속한다. payload 매핑이 대비책이다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

from lawd_codes import LAWD_CODES
from scrub import scrub

BASE = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList"


def fetch_page(key: str, region: str, page: int, rows: int = 1000) -> dict:
    qs = urllib.parse.urlencode({
        "serviceKey": key, "type": "json",
        "pageNo": page, "numOfRows": rows,
        "locatadd_nm": region,
    })
    req = urllib.request.Request(f"{BASE}?{qs}", headers={"User-Agent": "estate-pj"})
    with urllib.request.urlopen(req, timeout=30) as res:
        text = res.read().decode("utf-8")
    if not text.lstrip().startswith("{"):
        # 활용신청 전이면 XML 오류가 온다. 본문을 가려서 앞부분만 보여 준다.
        raise RuntimeError(f"JSON이 아닌 응답: {scrub(text)[:200]}")
    return json.loads(text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="bjdong.json")
    args = ap.parse_args()

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY가 없습니다.", file=sys.stderr)
        return 1
    if "%" in key:                       # 시크릿에 인코딩 키가 들어 있어도 동작하게
        key = urllib.parse.unquote(key)

    mapping: dict[str, dict[str, str]] = {}
    sgg_names: dict[str, str] = {}
    for region in ("서울특별시", "경기도"):
        try:
            _collect_region(key, region, mapping, sgg_names)
        except Exception as exc:
            print(f"법정동코드 조회 실패: {scrub(exc)}", file=sys.stderr)
            return 1

    # 수집 목록(lawd_codes.py)과 공식 코드표를 대조한다. 구 신설이 생기면 MOLIT은
    # 신설 코드로만 서빙해 옛 코드 조회가 0건 ok로 조용히 비는다. 화성시 4개 구
    # 신설(2026-02)을 반년 가까이 그렇게 놓쳤다. 이 대조가 그 침묵을 깬다.
    missing = sorted(set(sgg_names) - set(LAWD_CODES))
    if missing:
        print("경고: 공식 코드표에 있는데 수집 목록(lawd_codes.py)에 없는 시군구:")
        for c in missing:
            print(f"  {c} {sgg_names[c]}")
    retired = sorted(set(LAWD_CODES) - set(sgg_names))
    if retired:
        print(f"참고: 수집 목록에 있는데 코드표에서 빠진 코드(개편 전 옛 코드일 수 있음): "
              f"{', '.join(retired)}")

    # 지역별로 따로 검사한다. 합산 임계는 "서울 온전 + 경기 절반 유실" 같은
    # 부분 유실을 통과시킨다. 서울 460여, 경기 570여가 실측 기준이다.
    n = sum(len(v) for v in mapping.values())
    counts = {
        "서울특별시": sum(len(v) for k, v in mapping.items() if k.startswith("11")),
        "경기도": sum(len(v) for k, v in mapping.items() if k.startswith("41")),
    }
    for region, minimum in (("서울특별시", 400), ("경기도", 500)):
        if counts[region] < minimum:
            print(f"{region} 법정동이 {counts[region]}개뿐입니다(최소 {minimum}). "
                  "응답이 잘렸거나 필터가 어긋났습니다.", file=sys.stderr)
            return 1
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(mapping, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{args.out} 기록: {len(mapping)}개 시군구, 법정동 {n}개 "
          f"(서울 {counts['서울특별시']}, 경기 {counts['경기도']})")
    return 0


def _collect_region(key: str, region: str, mapping: dict, sgg_names: dict) -> None:
    page, total = 1, None
    raw: list[tuple[str, str]] = []
    while True:
        try:
            body = fetch_page(key, region, page)
        except Exception as exc:
            raise RuntimeError(f"{region} 조회 실패: {scrub(exc)}") from exc
        blocks = body.get("StanReginCd")
        if not blocks:
            # 오류 구조는 {"RESULT": {...}} 또는 nationalCode 오류 포맷으로 온다
            raise RuntimeError(f"{region} 응답에 데이터가 없습니다: "
                               f"{scrub(json.dumps(body, ensure_ascii=False))[:200]}")
        rows = []
        for b in blocks:
            if "head" in b:
                for h in b["head"]:
                    if "totalCount" in h:
                        total = int(h["totalCount"])
            rows.extend(b.get("row", []))
        for r in rows:
            cd = (r.get("region_cd") or "").strip()
            name = (r.get("locallow_nm") or "").strip()
            if len(cd) != 10 or not name:
                continue
            # 시군구 자체(읍면동 코드 000)는 매핑에는 안 담지만 이름은 챙긴다.
            # 구 신설(부천, 화성)을 수집 목록과 대조해 알리는 데 쓴다.
            if cd[5:8] == "000":
                full = (r.get("locatadd_nm") or "").strip()
                sgg_names[cd[:5]] = full.replace(region, "").strip() or name
                continue
            raw.append((cd, name))
        if total is None or page * 1000 >= total:
            break
        page += 1

    # 동·읍·면(리 코드 00)은 이름 그대로. 리(里) 행은 "읍면명 리명"으로 담는다.
    # 처음에는 리를 걷어냈는데, 경기 실거래 umd_nm이 "팽성읍 대사리"처럼 리
    # 수준으로 오는 것을 실측했다. 리를 버리면 그 동네 건축물대장 조회가 통째로
    # 빠지고, 조회에 쓰는 법정동 5자리도 리 코드까지 있어야 맞는 지번을 찾는다.
    emd = {cd[:8]: name for cd, name in raw if cd[8:10] == "00"}
    for cd, name in raw:
        if cd[8:10] == "00":
            mapping.setdefault(cd[:5], {})[name] = cd[5:10]
        else:
            parent = emd.get(cd[:8])
            full = f"{parent} {name}" if parent else name
            mapping.setdefault(cd[:5], {})[full] = cd[5:10]


if __name__ == "__main__":
    sys.exit(main())
