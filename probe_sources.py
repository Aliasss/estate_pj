#!/usr/bin/env python3
"""좌표·지하철 자료원 정찰.

이 저장소를 만드는 샌드박스에서는 한국 공공데이터 호스트로 나가는 길이 전부 막혀
있다(github.com만 뚫려 있다). 그래서 어떤 자료원이 살아 있고 무엇이 활용신청을
요구하는지 여기서는 확인할 방법이 없다.

한 번의 Actions 실행으로 후보 전부를 두드려 보고, 각각이 무엇을 돌려주는지
그대로 찍는다. 왕복을 줄이려고 만든 스크립트다 — 건축물대장 때는 이걸 안 만들어서
하루를 왕복에 썼다.

읽는 법
    OK      바로 쓸 수 있다
    키필요   활용신청만 하면 된다 (같은 공공데이터포털 계정)
    없음     폐기됐거나 주소가 틀렸다
    막힘     러너에서 접속 자체가 안 된다

사용법
    MOLIT_SERVICE_KEY=... python probe_sources.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse

import requests

# 인증키가 응답 본문에 되비쳐 나오는 API가 있다. 쿼리 형태와 경로 형태를 모두 가린다.
QUERY_KEY_RE = re.compile(r"((?:serviceKey|confmKey|key)=)[^&\s'\"<]+", re.I)
PATH_KEY_RE = re.compile(r"(openapi\.seoul\.go\.kr:\d+/)[A-Za-z0-9]{16,}")

# (이름, URL, 파라미터, 키를 어디에 넣나)
#   key=None      인증 없이 되는지 보는 것
#   key='service' 공공데이터포털 표준 serviceKey 파라미터
#   key='path'    서울 열린데이터광장처럼 경로에 키가 들어가는 것
CANDIDATES = [
    (
        "법정동코드 (행안부 표준코드)",
        "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList",
        {"type": "json", "pageNo": 1, "numOfRows": 3, "flag": "Y",
         "locatadd_nm": "서울특별시"},
        "service",
    ),
    (
        "지하철역 (국토부 지하철정보)",
        "https://apis.data.go.kr/1613000/SubwayInfoService/getKwrdFndSubwaySttnList",
        {"_type": "json", "numOfRows": 3, "pageNo": 1, "subwayStationName": "서울역"},
        "service",
    ),
    (
        "지하철역 좌표 (서울 열린데이터 샘플키)",
        "http://openapi.seoul.go.kr:8088/sample/json/subwayStationMaster/1/5/",
        {},
        None,
    ),
    (
        "역간 소요시간 (서울 열린데이터 샘플키)",
        "http://openapi.seoul.go.kr:8088/sample/json/SearchSTNBySubwayLineInfo/1/5/",
        {},
        None,
    ),
    (
        "전국 도시철도 역사 정보 (odcloud)",
        "https://api.odcloud.kr/api/15099316/v1/uddi:2c0b0e17-b6ba-4b6a-8a0d-7fdca1a2b3f1",
        {"page": 1, "perPage": 3, "returnType": "json"},
        "service",
    ),
    (
        "도로명주소 좌표제공 API (juso)",
        "https://business.juso.go.kr/addrlink/addrCoordApi.do",
        {"currentPage": 1, "countPerPage": 3, "keyword": "서울특별시 중구 남창동 205-18",
         "resultType": "json"},
        "confm",
    ),
    (
        "VWorld 지오코더",
        "https://api.vworld.kr/req/address",
        {"service": "address", "request": "getcoord", "version": "2.0",
         "crs": "epsg:4326", "type": "PARCEL",
         "address": "서울특별시 중구 남창동 205-18", "format": "json"},
        "vworld",
    ),
    (
        "도로명주소 건물DB 내려받기 페이지",
        "https://business.juso.go.kr/addrlink/addressBuildDevNew.do",
        {"menu": "matchArea"},
        None,
    ),
]


def redact(text: str) -> str:
    return PATH_KEY_RE.sub(r"\1***", QUERY_KEY_RE.sub(r"\1***", text))


def verdict(status: int, body: str) -> str:
    """응답 한 덩어리를 보고 어느 칸에 넣을지 정한다."""
    low = body.lower()
    if status != 200:
        return f"HTTP {status}"
    for token, label in (
        ("service_key_is_not_registered", "키필요 (활용신청)"),
        ("service key is not registered", "키필요 (활용신청)"),
        ("no_openapi_service", "없음 (폐기/주소 오류)"),
        ("unregistered_ip", "키필요 (IP 등록)"),
        ("인증키", "키필요"),
        ("등록되지 않은", "키필요"),
        ("정상", "OK"),
    ):
        if token in low:
            return label
    if '"resultcode":"00"' in low.replace(" ", "") or "<resultcode>00<" in low:
        return "OK"
    if low.lstrip().startswith(("<!doctype", "<html")):
        return "HTML (파일 내려받기 페이지)"
    return "응답 확인 필요"


def probe(name: str, url: str, params: dict, key_kind: str | None,
          molit: str, vworld: str, confm: str) -> None:
    params = dict(params)
    if key_kind == "service":
        params["serviceKey"] = molit
    elif key_kind == "vworld":
        if not vworld:
            print(f"  {name:<38} 건너뜀 (VWORLD_KEY 없음)")
            return
        params["key"] = vworld
    elif key_kind == "confm":
        if not confm:
            print(f"  {name:<38} 건너뜀 (JUSO_CONFM_KEY 없음)")
            return
        params["confmKey"] = confm

    try:
        res = requests.get(url, params=params, timeout=20)
    except Exception as exc:
        print(f"  {name:<38} 막힘 — {type(exc).__name__}")
        return
    body = res.text
    print(f"  {name:<38} {verdict(res.status_code, body):<20} "
          f"{len(res.content):,}바이트")
    print(f"    {redact(body[:260].replace(chr(10), ' '))}")


def main() -> int:
    molit = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if "%" in molit:
        molit = urllib.parse.unquote(molit)
    if not molit:
        print("MOLIT_SERVICE_KEY가 없습니다.", file=sys.stderr)
        return 2
    vworld = os.environ.get("VWORLD_KEY", "").strip()
    confm = os.environ.get("JUSO_CONFM_KEY", "").strip()

    print("자료원 정찰 — 무엇이 바로 되고 무엇이 활용신청을 요구하는지\n")
    for name, url, params, kind in CANDIDATES:
        probe(name, url, params, kind, molit, vworld, confm)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
