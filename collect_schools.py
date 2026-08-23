#!/usr/bin/env python3
"""학교 위치 수집 → schools.json.

임장에서 "이 집 근처에 학교가 있나"는 아이가 있는 세입자에게 지하철만큼
자주 나오는 질문이다. 학교는 위치가 거의 바뀌지 않으므로 지하철처럼 좌표만
미리 구워 두고, 물건별 개수 집계는 school_join.py가 빌드 때 한다.

자료원은 공공데이터포털 표준데이터 둘이다. 실거래가와 같은 계정 키
(MOLIT_SERVICE_KEY)를 쓰지만 활용신청은 데이터셋마다 따로다.

    전국초중등학교위치표준데이터  (초·중·고, 위경도 포함)
    전국대학및전문대학정보표준데이터  (대학·전문대)

응답 필드명은 문서를 샌드박스에서 열 수 없어 확정하지 못했다. 표준데이터
API들이 쓰는 이름 후보를 순서대로 대 보고, 하나도 안 맞으면 실제 키 목록을
찍고 죽는다 — 값이 아니라 키 이름만 찍으므로 새는 것이 없다.

사용법
    export MOLIT_SERVICE_KEY="공공데이터포털 인증키"
    python collect_schools.py --out schools.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse

import requests

from scrub import describe, scrub

ELESCH = "https://api.data.go.kr/openapi/tn_pubr_public_elesch_mskul_lc_api"
UNIV = "https://api.data.go.kr/openapi/tn_pubr_public_univ_info_api"
PAGE = 1000

# 표준데이터 API들이 같은 뜻에 조금씩 다른 이름을 쓴다. 앞에 있는 것부터 시도.
LAT_KEYS = ("latitude", "lat", "la")
LON_KEYS = ("longitude", "lot", "lon", "lo")
LEVEL_KEYS = ("schoolSe", "schulKndScNm", "schoolKnd", "schoolGubun")

# 초중등 데이터에는 특수학교·각종학교도 섞여 있을 수 있다. 셋만 세고
# 나머지는 버리되, 뭘 버렸는지 개수를 찍어 확인 가능하게 남긴다.
LEVEL_MAP = {"초등학교": "e", "중학교": "m", "고등학교": "h"}


def first_key(row: dict, cands: tuple[str, ...]) -> str | None:
    for k in cands:
        if k in row:
            return k
    return None


def fetch_all(key: str, url: str, what: str) -> list[dict]:
    """표준데이터 공통 봉투 {response:{header,body:{items,totalCount}}}를 끝까지 넘긴다."""
    rows: list[dict] = []
    page = 1
    while True:
        res = requests.get(url, params={
            "serviceKey": key, "pageNo": page, "numOfRows": PAGE, "type": "json",
        }, timeout=30)
        res.raise_for_status()
        try:
            body = res.json().get("response", {})
        except ValueError:
            # 활용신청 전이면 XML 오류문이 온다. 본문에 키가 되비칠 수 있어 가린다.
            raise RuntimeError(f"{what}: JSON이 아님 — {scrub(res.text)[:200]}")
        code = body.get("header", {}).get("resultCode")
        if code not in ("00", "0", 0):
            msg = body.get("header", {}).get("resultMsg", "")
            raise RuntimeError(f"{what}: [{code}] {scrub(msg)[:160]}")
        payload = body.get("body", {})
        batch = payload.get("items") or []
        if isinstance(batch, dict):            # 1건이면 dict로 오는 API가 있다
            batch = [batch]
        rows.extend(batch)
        total = int(payload.get("totalCount") or 0)
        if page * PAGE >= total or not batch:
            # 서버가 numOfRows를 조용히 더 낮게 캡으면 totalCount에 못 미친 채
            # 정상 종료처럼 보인다. 절단본을 진실로 저장하느니 죽는다.
            if total and len(rows) < total:
                raise RuntimeError(
                    f"{what}: {len(rows):,}/{total:,}건 — 페이징 절단, 응답 numOfRows 확인 필요")
            return rows
        page += 1
        time.sleep(0.2)


def parse_coords(row: dict) -> tuple[float, float] | None:
    lat_k, lon_k = first_key(row, LAT_KEYS), first_key(row, LON_KEYS)
    if not (lat_k and lon_k):
        return None
    try:
        lat, lon = float(row[lat_k]), float(row[lon_k])
    except (TypeError, ValueError):
        return None
    # 위경도 뒤바뀜·0값은 조인을 오염시킨다. 한반도 밖이면 버린다.
    if not (33.0 <= lat <= 39.5 and 124.0 <= lon <= 132.0):
        return None
    return round(lat, 5), round(lon, 5)


def main() -> int:
    parser = argparse.ArgumentParser(description="학교 위치 수집")
    parser.add_argument("--out", default="schools.json")
    args = parser.parse_args()

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY가 없습니다", file=sys.stderr)
        return 2
    # 시크릿에는 포털의 인코딩 키가 들어 있다. requests가 params를 다시
    # 인코딩하므로 그대로 주면 이중 인코딩이 되어 게이트웨이가 403을 준다.
    # 8/23 실측: 같은 실행에서 정찰(unquote 함)은 resultCode 00, 이 수집기
    # (안 함)는 HTTP 403이었다. collect_bldg·probe와 같은 규칙으로 푼다.
    if "%" in key:
        key = urllib.parse.unquote(key)

    coords: dict[str, list[list[float]]] = {"e": [], "m": [], "h": [], "u": []}

    rows = fetch_all(key, ELESCH, "초중등")
    if not rows:
        raise RuntimeError("초중등: 0건 — 응답 구조가 예상과 다릅니다")
    lvl_k = first_key(rows[0], LEVEL_KEYS)
    if not lvl_k or not first_key(rows[0], LAT_KEYS):
        raise RuntimeError(f"초중등: 필드명이 후보에 없음 — 키 목록: {sorted(rows[0])}")
    skipped: dict[str, int] = {}
    no_coord = 0
    for row in rows:
        level = LEVEL_MAP.get(str(row.get(lvl_k, "")).strip())
        if not level:
            k = str(row.get(lvl_k, "?")).strip()
            skipped[k] = skipped.get(k, 0) + 1
            continue
        pt = parse_coords(row)
        if not pt:
            no_coord += 1
            continue
        coords[level].append(list(pt))
    if skipped:
        print("초중등 제외:", ", ".join(f"{k} {v}" for k, v in sorted(skipped.items())))
    if no_coord:
        print(f"초중등 좌표 없음/이상 {no_coord}건 제외")

    # 대학은 별도 데이터셋. 활용신청이 안 됐어도 초중고만으로 낼 가치가 있으므로
    # 실패를 삼키되, 그 경우 "u"를 None으로 저장한다. 빈 목록으로 저장하면
    # 조인이 모든 물건에 대학 0을 세고 화면이 신촌 앞에서도 "대학 없음"을
    # 단정한다. 미수집과 0은 다르다.
    try:
        urows = fetch_all(key, UNIV, "대학")
        u_no = 0
        for row in urows:
            pt = parse_coords(row)
            if pt:
                coords["u"].append(list(pt))
            else:
                u_no += 1
        if u_no:
            print(f"대학 좌표 없음/이상 {u_no}건 제외")
        if len(coords["u"]) < 200:
            # 전국 대학·전문대는 캠퍼스까지 4백 곳 안팎이다. 그 절반도 안 되면
            # 좌표 필드 미매칭이거나 절단이다. 키 이름만 찍는다 — 값은 안 찍는다.
            print(f"대학: 좌표 확보 {len(coords['u'])}건뿐 (수신 {len(urows)}건) — "
                  f"키 목록: {sorted(urows[0]) if urows else '없음'}", file=sys.stderr)
            coords["u"] = None
    except Exception as exc:
        print(f"대학 수집 실패 (초중고만 냅니다): {describe(exc)}", file=sys.stderr)
        coords["u"] = None

    n = {k: (len(v) if v is not None else "미수집") for k, v in coords.items()}
    print(f"초 {n['e']:,} · 중 {n['m']:,} · 고 {n['h']:,} · 대학 {n['u']}")
    if n["e"] < 3000 or n["m"] < 1500 or n["h"] < 1000:
        # 전국 초등 6천·중 3천·고 2천이 상식선이다. 절반도 안 오면 절단이다.
        raise RuntimeError("초중등 개수가 상식선의 절반 미만 — 절단 의심, 저장하지 않습니다")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"schools": coords}, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{args.out}  {os.path.getsize(args.out) / 1e3:.0f}KB")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as exc:                       # 트레이스백에 키가 실려 나가는 것 방지
        print(f"실패: {describe(exc, limit=400)}", file=sys.stderr)
        raise SystemExit(1)
