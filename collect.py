#!/usr/bin/env python3
"""국토교통부 실거래가 공개 API 수집기 (서울 25개 자치구).

아파트/연립다세대 × 매매/전월세 4개 소스를 자치구 × 계약년월 단위로 순회하며
SQLite에 적재한다.

설계 원칙
- <item>의 모든 자식 태그를 payload(JSON)에 그대로 저장한다. API 필드가 추가/개정돼도
  유실되지 않고, 정규화 컬럼은 그 위에 얹는 뷰 역할만 한다.
- (source, lawd_cd, deal_ymd) 단위로 fetch_log에 진행 상황을 남긴다. 중단 후 재실행하면
  이미 받은 구간은 건너뛴다.
- row_key는 내용 해시 + 배치 내 중복 일련번호라서 같은 구간을 다시 받아도 중복 적재되지 않는다.

사용법
    export MOLIT_SERVICE_KEY="공공데이터포털 일반 인증키(Decoding)"
    python collect.py --db seoul_rt.sqlite

    # 특정 구간/소스만
    python collect.py --start 202108 --end 202607 --sources apt_trade,apt_rent
    # 최근 3개월은 신고 지연 반영을 위해 강제 재수집
    python collect.py --refresh-recent 3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sqlite3
import sys
import time
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from xml.etree import ElementTree

import requests

from lawd_codes import LAWD_CODES
from scrub import describe, scrub

API_BASE = "https://apis.data.go.kr/1613000"


@dataclass(frozen=True)
class Source:
    key: str
    path: str
    housing_type: str  # 아파트 / 연립다세대
    deal_type: str  # 매매 / 전월세
    label: str


SOURCES = {
    s.key: s
    for s in [
        Source(
            "apt_trade",
            "RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
            "아파트",
            "매매",
            "아파트 매매 실거래가 상세",
        ),
        Source(
            "apt_rent",
            "RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
            "아파트",
            "전월세",
            "아파트 전월세 실거래가",
        ),
        Source(
            "rh_trade",
            "RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade",
            "연립다세대",
            "매매",
            "연립다세대 매매 실거래가",
        ),
        Source(
            "rh_rent",
            "RTMSDataSvcRHRent/getRTMSDataSvcRHRent",
            "연립다세대",
            "전월세",
            "연립다세대 전월세 실거래가",
        ),
        # 오피스텔은 fetch_log가 비어 있으므로 추가된 첫 실행이 60개월을 통째로
        # 백필한다. API 쿼터가 소스별이라 기존 수집과 한도를 나누지 않는다.
        Source(
            "offi_trade",
            "RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade",
            "오피스텔",
            "매매",
            "오피스텔 매매 실거래가",
        ),
        Source(
            "offi_rent",
            "RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent",
            "오피스텔",
            "전월세",
            "오피스텔 전월세 실거래가",
        ),
    ]
}

SUCCESS_CODES = {"00", "000"}
# 설정을 고치기 전에는 몇 번을 더 불러도 똑같은 오류. 즉시 중단한다.
FATAL_CODES = {
    "12",  # NO_OPENAPI_SERVICE_ERROR — 폐기된 엔드포인트
    "20",  # SERVICE_ACCESS_DENIED_ERROR
    "30",  # SERVICE_KEY_IS_NOT_REGISTERED_ERROR — 활용신청 안 됨
    "31",  # DEADLINE_HAS_EXPIRED_ERROR
    "32",  # UNREGISTERED_IP_ERROR
}
# 게이트웨이가 잠깐 흔들린 것. 재시도하면 된다.
# 04를 치명적으로 분류해 뒀다가, 3,271동을 실패 0으로 받던 실행이
# 이 한 건에 통째로 중단됐다. 인증 문제가 아니라 일시적 오류다.
TRANSIENT_CODES = {
    "01",  # APPLICATION_ERROR
    "02",  # DB_ERROR
    "04",  # HTTP_ERROR
    "05",  # SERVICETIME_OUT
}
# 오늘 몫을 다 썼다. 실패가 아니라 정상 종료로 다뤄야 다음 실행이 이어받는다.
QUOTA_CODE = "22"  # LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR

# 정규화 컬럼 <- API 필드 별칭. 소스마다 태그명이 달라서 순서대로 훑는다.
FIELD_ALIASES = {
    "umd_nm": ["umdNm"],
    "jibun": ["jibun"],
    "building_name": ["aptNm", "mhouseNm", "offiNm", "houseNm"],
    "exclu_use_ar": ["excluUseAr"],
    "floor": ["floor"],
    "build_year": ["buildYear"],
    "deal_amount": ["dealAmount"],
    "deposit": ["deposit"],
    "monthly_rent": ["monthlyRent"],
    "contract_type": ["contractType"],
    "contract_term": ["contractTerm"],
    "cdeal_type": ["cdealType"],
    "cdeal_day": ["cdealDay"],
    "dealing_gbn": ["dealingGbn"],
    "road_nm": ["roadNm"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    row_key       TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    housing_type  TEXT NOT NULL,
    deal_type     TEXT NOT NULL,
    lawd_cd       TEXT NOT NULL,
    sgg_nm        TEXT,
    deal_ymd      TEXT NOT NULL,   -- 계약년월 YYYYMM
    deal_date     TEXT,            -- 계약일 YYYY-MM-DD
    umd_nm        TEXT,
    jibun         TEXT,
    building_name TEXT,
    exclu_use_ar  REAL,            -- 전용면적 m2
    floor         INTEGER,
    build_year    INTEGER,
    deal_amount   INTEGER,         -- 거래금액(만원), 매매
    deposit       INTEGER,         -- 보증금(만원), 전월세
    monthly_rent  INTEGER,         -- 월세(만원)
    contract_type TEXT,            -- 신규 / 갱신
    contract_term TEXT,
    cdeal_type    TEXT,            -- 해제여부 O
    cdeal_day     TEXT,
    dealing_gbn   TEXT,            -- 중개 / 직거래
    road_nm       TEXT,
    payload       TEXT NOT NULL,   -- <item> 전체 태그 JSON
    fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_ym       ON transactions (deal_ymd);
CREATE INDEX IF NOT EXISTS idx_tx_gu_ym    ON transactions (lawd_cd, deal_ymd);
CREATE INDEX IF NOT EXISTS idx_tx_type     ON transactions (housing_type, deal_type);
CREATE INDEX IF NOT EXISTS idx_tx_building ON transactions (lawd_cd, umd_nm, building_name);

CREATE TABLE IF NOT EXISTS fetch_log (
    source      TEXT NOT NULL,
    lawd_cd     TEXT NOT NULL,
    deal_ymd    TEXT NOT NULL,
    total_count INTEGER,
    row_count   INTEGER,
    status      TEXT NOT NULL,   -- ok / error
    message     TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (source, lawd_cd, deal_ymd)
);
"""


# 본 수집 전에 한 번 두드려 보는 횟수와 간격.
#
# 국토부 게이트웨이(apis.data.go.kr)가 GitHub Actions 러너 IP를 간헐적으로
# 막는다. 막힌 동안에는 429가 아니라 연결 자체가 안 맺어져 ConnectTimeout으로
# 온다. 이 상태에서 계획을 시작하면 구간마다 재시도 5회를 쓰고 연속 실패
# 가드에 걸려 15분 20초 만에 0건으로 끝난다. 실측으로 8/17 주간 크론과
# 8/18 수동 실행이 초 단위까지 같은 시간에 같은 방식으로 죽었다.
#
# 오래 기다리지 않는다. 2026-08-25 정찰이 차단의 단위를 갈랐다. 한 러너에서
# 실거래 6종과 건축물대장까지 일곱 서비스가 전부 ConnectTimeout인 그 시각에,
# 다른 러너에서 도는 대장 크론은 정상으로 수집하고 있었다. 같은 호스트, 같은
# 인증키, 같은 시각인데 러너 IP만 달랐다. 차단은 서비스나 시간대가 아니라
# IP에 걸린다.
#
# 그래서 같은 잡에서 기다리는 것은 값이 없다. 그 잡의 IP는 끝까지 그대로다.
# 실제로 8/24 크론과 8/25 수동 재시도가 15분씩 네 번을 꼬박 기다리고도 0건으로
# 죽었고, 몇 시간 뒤 새 잡(=새 IP)은 사전 확인을 첫 시도에 통과해 11분 만에
# 받아 왔다. 기다림이 아니라 새 잡이 답이다.
#
# 그러면 여기서는 빨리 접는 것이 이득이다. 짧은 간격 세 번이면 순간적인
# 혼잡은 넘기고, 진짜 IP 차단은 3분 안에 확정한다. 여기서 포기해도 받은 것이
# 0건이라 잃을 진행분은 없다.
#
# 다만 이것만으로는 반쪽이다. 빨리 접기는 새 잡을 띄우는 것과 한 쌍인데, 자동
# 재시도는 아직 없다. 지금은 사람이 Actions에서 다시 눌러야 새 IP를 뽑는다.
PREFLIGHT_TRIES = 3
PREFLIGHT_GAP = 60

# 차단으로 접었다는 뜻의 종료 코드(EX_TEMPFAIL). 워크플로가 이 값을 보고
# "코드가 틀린 실패"와 "IP를 잘못 뽑은 실패"를 가른다. 후자는 새 잡으로
# 다시 뽑으면 되는 일이라 사람이 볼 신호가 다르다.
EXIT_BLOCKED = 75


class FatalApiError(RuntimeError):
    """설정을 고치기 전에는 재시도가 무의미한 오류 (인증키·엔드포인트·IP)."""


class QuotaExhausted(RuntimeError):
    """오늘 몫을 다 썼다. 실패가 아니라 여기까지 받았다는 뜻이다."""


# --------------------------------------------------------------------------- 파싱


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _to_int(value: str | None) -> int | None:
    """'82,500' 또는 ' 3 ' -> 82500 / 3. 숫자가 없으면 None."""
    text = _clean(value).replace(",", "")
    if not text:
        return None
    match = re.fullmatch(r"-?\d+", text)
    return int(match.group()) if match else None


def _to_float(value: str | None) -> float | None:
    text = _clean(value).replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _pick(payload: dict[str, str], aliases: list[str]) -> str | None:
    for alias in aliases:
        value = _clean(payload.get(alias))
        if value:
            return value
    return None


def _deal_date(payload: dict[str, str]) -> str | None:
    year = _to_int(payload.get("dealYear"))
    month = _to_int(payload.get("dealMonth"))
    day = _to_int(payload.get("dealDay"))
    if not (year and month and day):
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def normalize(payload: dict[str, str], source: Source, lawd_cd: str) -> dict:
    """payload(원본 태그 dict)에서 정규화 컬럼을 뽑아낸다."""
    row = {
        "source": source.key,
        "housing_type": source.housing_type,
        "deal_type": source.deal_type,
        "lawd_cd": lawd_cd,
        "sgg_nm": LAWD_CODES.get(lawd_cd),
        "deal_date": _deal_date(payload),
    }
    for column, aliases in FIELD_ALIASES.items():
        row[column] = _pick(payload, aliases)

    row["exclu_use_ar"] = _to_float(row["exclu_use_ar"])
    for column in ("floor", "build_year", "deal_amount", "deposit", "monthly_rent"):
        row[column] = _to_int(row[column])
    # 전세는 월세가 0으로 내려오지만 태그가 비어 오는 경우가 있어 보증금이 있으면 0으로 채운다.
    if source.deal_type == "전월세" and row["monthly_rent"] is None and row["deposit"] is not None:
        row["monthly_rent"] = 0
    return row


def parse_response(text: str) -> tuple[str, str, list[dict[str, str]], int]:
    """XML 응답 -> (resultCode, resultMsg, items, totalCount)."""
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        raise RuntimeError(f"XML 파싱 실패: {exc}: {text[:200]}") from exc

    # 인증 오류는 <OpenAPI_ServiceResponse> 형태로 내려온다.
    code = root.findtext(".//returnReasonCode") or root.findtext(".//resultCode") or ""
    message = root.findtext(".//returnAuthMsg") or root.findtext(".//resultMsg") or ""
    code = _clean(code)

    items = [
        {child.tag: _clean(child.text) for child in item}
        for item in root.iterfind(".//items/item")
    ]
    total = _to_int(root.findtext(".//totalCount")) or 0
    return code, _clean(message), items, total


# --------------------------------------------------------------------------- 수집


def month_range(start: str, end: str) -> list[str]:
    """'202108', '202607' -> ['202108', ..., '202607']"""
    cursor = datetime.strptime(start, "%Y%m")
    stop = datetime.strptime(end, "%Y%m")
    if cursor > stop:
        raise ValueError(f"--start({start})가 --end({end})보다 뒤입니다.")
    months = []
    while cursor <= stop:
        months.append(cursor.strftime("%Y%m"))
        cursor = (cursor.replace(day=28) + timedelta(days=7)).replace(day=1)
    return months


def default_window(months: int = 61) -> tuple[str, str]:
    """당월을 끝으로 하는 N개월 창.

    오래 전월까지만 받았다. 이유는 "당월은 신고 기한(30일) 때문에 불완전하다"
    였는데, 그건 월 집계에 넣지 말아야 할 이유이지 받지 말아야 할 이유가
    아니었다. 신고된 개별 계약은 그 자체로 사실이고, 계약을 앞둔 사람에게
    가장 시의성 있는 것이 바로 이번 달 계약이다.

    받아 놓으면 build_units가 알아서 가른다. complete_end를 넘는 달은 월
    집계에서 빠지고 최근 거래 목록에만 'P'(잠정) 꼬리표로 실린다. 그 경로가
    이미 있는데 당월만 수집을 안 해서 놀고 있었다.

    실측으로 확인한 손실(2026-08-30): 크론이 월요일이라 8/31 회차의 창이
    202607에서 끝나고, 8월 거래가 화면에 처음 나타나는 것은 9/7 회차 뒤인
    9/8이었다. 8월 내내 8월 거래가 0건이었다는 뜻이다.

    창을 60에서 61로 늘렸다. 이미 받은 달이 사라지는 것을 막으려는 것은
    아니다. 수집기는 행을 지우지 않고 집계 뷰에도 하한이 없어서, 창 밖으로
    밀려난 달은 다시 안 받을 뿐 DB에 그대로 남는다(CTO 지적). 61이 이득인
    것은 백지에서 백필할 때다. 60으로 두면 끝을 한 달 미룬 만큼 시작도 밀려
    59개월치만 받게 된다.
    """
    today = date.today()
    end = today.strftime("%Y%m")
    cursor = datetime.strptime(end, "%Y%m")
    for _ in range(months - 1):
        cursor = (cursor.replace(day=1) - timedelta(days=1)).replace(day=1)
    return cursor.strftime("%Y%m"), end


def fetch_month(
    session: requests.Session,
    service_key: str,
    source: Source,
    lawd_cd: str,
    deal_ymd: str,
    *,
    rows_per_page: int = 1000,
    max_retries: int = 5,
    timeout: int = 30,
    sleep: float = 0.1,
    max_pages: int | None = None,
) -> tuple[list[dict[str, str]], int]:
    """한 구 × 한 달을 전 페이지 수집한다.

    max_pages를 주면 그만큼만 받고 멈춘다. 접속 확인처럼 내용이 필요 없는
    호출에 쓴다. rows_per_page를 줄이는 것으로는 안 된다. 종료 조건이
    "받은 누계가 total에 닿을 때까지"라서, 1로 주면 한 페이지가 아니라
    1행씩 total번을 부른다. 정확히 반대로 가장 비싼 조합이 된다.
    """
    url = f"{API_BASE}/{source.path}"
    collected: list[dict[str, str]] = []
    total = 0
    page = 1

    while True:
        params = {
            "serviceKey": service_key,
            "LAWD_CD": lawd_cd,
            "DEAL_YMD": deal_ymd,
            "pageNo": page,
            "numOfRows": rows_per_page,
        }
        last_error: Exception | None = None
        for attempt in range(max_retries):
            try:
                response = session.get(url, params=params, timeout=timeout)
                response.raise_for_status()
                code, message, items, total = parse_response(response.text)
                if code in FATAL_CODES:
                    raise FatalApiError(f"[{code}] {message}")
                # 한도 소진은 몇 번을 다시 불러도 같은 답이다. 재시도로 태우지 않고 올린다.
                if code == QUOTA_CODE:
                    raise QuotaExhausted(f"[{code}] {message}")
                if code and code not in SUCCESS_CODES:
                    raise RuntimeError(f"API 오류 [{code}] {message}")
                break
            except (FatalApiError, QuotaExhausted):
                raise
            except Exception as exc:  # 네트워크 오류 / 일시적 5xx / 파싱 실패
                last_error = exc
                # 마지막 시도면 다시 부를 것이 없다. 자지도, 잔다고 적지도 않는다.
                if attempt == max_retries - 1:
                    continue
                backoff = min(2**attempt, 30) + random.uniform(0, 0.5)
                # requests 예외 메시지는 실패한 URL(인증키 포함)을 통째로 담는다. 가리고 찍는다.
                print(f"      재시도 {attempt + 1}/{max_retries} ({scrub(exc)}) -> {backoff:.1f}s 대기")
                time.sleep(backoff)
        else:
            raise RuntimeError(f"{max_retries}회 재시도 실패: {scrub(last_error)}")

        collected.extend(items)
        if not items or len(collected) >= total or len(items) < rows_per_page:
            break
        if max_pages and page >= max_pages:
            break
        page += 1
        time.sleep(sleep)

    return collected, total


def preflight(session_factory, service_key: str, source: Source, code: str, ym: str) -> str | None:
    """계획의 첫 구간으로 접속만 확인한다. 통과하면 None, 끝내 막히면 사유.

    무엇을 보는 함수인지 좁게 잡는다. **연결이 되는가만 본다.** 쿼터가 남았는지,
    그 서비스 활용신청이 됐는지는 여기서 판정하지 않는다. 소스마다 일일 쿼터가
    독립이고 본 루프가 소스별로 접고 가는데(아래 exhausted 참고), 계획 첫 구간
    하나로 그 판단을 대신하면 apt_trade 하나가 소진됐다는 이유로 나머지 다섯
    소스의 남은 쿼터를 통째로 버리게 된다. 그래서 한도 응답이든 인증 오류든
    **응답이 왔다는 것은 연결이 됐다는 뜻이므로 통과**시키고, 그 뒤는 본 루프에
    맡긴다.

    나머지는 종류를 가리지 않고 기다린다. 원래는 4xx를 즉시 포기시키려 했는데,
    fetch_month가 마지막 예외를 RuntimeError로 감싸 버려서 이 자리에서는 상태
    코드가 보이지 않는다(실측으로 403이 "RuntimeError: 1회 재시도 실패"로 왔다).
    구분이 닿지 않는 자리에서 억지로 가르지 않고, 세 번 안에 안 되면 포기한다.
    (여기서 "기다리면 풀린다"고 적어 두었던 옛 근거는 2026-08-25 정찰이 반증했다.
    차단은 시간이 아니라 IP에 걸린다. 위 PREFLIGHT_* 주석을 볼 것.)
    fetch_month가 예외 종류를 보존하도록 고치는 것은 본 수집 경로도 함께 바꾸는
    일이라 따로 다룬다.

    한 페이지만 받는다(max_pages=1). 시도마다 세션을 새로 만드는 이유는 잠깐
    자고 난 뒤의 keep-alive 커넥션이 서버나 NAT 어느 쪽에서든 이미 끊겨 있을 수
    있어서다. 접속 가능 여부를 재는 코드가 죽은 커넥션을 물고 재면 안 된다.
    """
    last = None
    for i in range(PREFLIGHT_TRIES):
        try:
            fetch_month(session_factory(), service_key, source, code, ym,
                        rows_per_page=1000, max_pages=1, max_retries=1, timeout=20)
            if i:
                print(f"사전 확인 {i + 1}번째에 통과했습니다. 수집을 시작합니다.")
            return None
        except (FatalApiError, QuotaExhausted) as exc:
            # 응답이 왔다 = 연결은 된다. 판정은 본 루프가 소스별로 한다.
            print(f"사전 확인에서 응답을 받았습니다({describe(exc)}). 연결은 되므로 계속합니다.")
            return None
        except Exception as exc:
            last = exc
        if i < PREFLIGHT_TRIES - 1:
            print(f"사전 확인 {i + 1}회 실패: {describe(last)}")
            print(f"{PREFLIGHT_GAP // 60}분 뒤 다시 확인합니다")
            time.sleep(PREFLIGHT_GAP)
    return describe(last)


def build_rows(items: list[dict[str, str]], source: Source, lawd_cd: str, deal_ymd: str) -> list[tuple]:
    """정규화 + row_key 부여. 내용이 완전히 같은 거래는 배치 내 일련번호로 구분한다."""
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    seen: dict[str, int] = {}
    rows = []

    for payload in items:
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha1(f"{source.key}|{lawd_cd}|{blob}".encode()).hexdigest()
        seq = seen.get(digest, 0)
        seen[digest] = seq + 1
        row = normalize(payload, source, lawd_cd)
        rows.append(
            (
                f"{digest}#{seq}",
                row["source"],
                row["housing_type"],
                row["deal_type"],
                row["lawd_cd"],
                row["sgg_nm"],
                deal_ymd,
                row["deal_date"],
                row["umd_nm"],
                row["jibun"],
                row["building_name"],
                row["exclu_use_ar"],
                row["floor"],
                row["build_year"],
                row["deal_amount"],
                row["deposit"],
                row["monthly_rent"],
                row["contract_type"],
                row["contract_term"],
                row["cdeal_type"],
                row["cdeal_day"],
                row["dealing_gbn"],
                row["road_nm"],
                blob,
                fetched_at,
            )
        )
    return rows


INSERT_SQL = """
INSERT INTO transactions (
    row_key, source, housing_type, deal_type, lawd_cd, sgg_nm, deal_ymd, deal_date,
    umd_nm, jibun, building_name, exclu_use_ar, floor, build_year,
    deal_amount, deposit, monthly_rent, contract_type, contract_term,
    cdeal_type, cdeal_day, dealing_gbn, road_nm, payload, fetched_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(row_key) DO UPDATE SET
    cdeal_type = excluded.cdeal_type,
    cdeal_day  = excluded.cdeal_day,
    payload    = excluded.payload,
    fetched_at = excluded.fetched_at
"""


def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def done_keys(conn: sqlite3.Connection) -> set[tuple[str, str, str]]:
    cur = conn.execute("SELECT source, lawd_cd, deal_ymd FROM fetch_log WHERE status = 'ok'")
    return {tuple(row) for row in cur}


def main() -> int:
    default_start, default_end = default_window()

    parser = argparse.ArgumentParser(description="서울 부동산 실거래가 수집기")
    parser.add_argument("--db", default="seoul_rt.sqlite", help="SQLite 파일 경로")
    parser.add_argument("--start", default=default_start, help=f"시작 계약년월 YYYYMM (기본 {default_start})")
    parser.add_argument("--end", default=default_end, help=f"종료 계약년월 YYYYMM (기본 {default_end})")
    parser.add_argument("--sources", default=",".join(SOURCES), help="수집 소스 (쉼표 구분)")
    parser.add_argument("--lawd", default="", help="자치구 코드 제한 (쉼표 구분, 기본 전체 25개)")
    parser.add_argument("--sleep", type=float, default=0.1, help="호출 간 대기(초)")
    parser.add_argument("--rows-per-page", type=int, default=1000)
    parser.add_argument("--max-calls", type=int, default=0, help="0이면 무제한. 일일 트래픽 보호용")
    parser.add_argument("--abort-after", type=int, default=5,
                        help="연속 N개 구간이 전부 실패하면 접속 문제로 보고 중단. "
                             "구간마다 재시도 5회를 이미 품고 있어 5면 약 15분이다")
    parser.add_argument("--refresh-recent", type=int, default=0, help="최근 N개월은 이미 받았어도 재수집")
    parser.add_argument("--force", action="store_true", help="fetch_log 무시하고 전 구간 재수집")
    args = parser.parse_args()

    service_key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not service_key:
        print("MOLIT_SERVICE_KEY 환경 변수가 없습니다. 공공데이터포털 인증키를 설정하세요.", file=sys.stderr)
        return 2
    # Encoding 키를 그대로 넣은 경우 requests가 이중 인코딩하지 않도록 되돌린다.
    if "%" in service_key:
        service_key = urllib.parse.unquote(service_key)

    sources = []
    for key in [s.strip() for s in args.sources.split(",") if s.strip()]:
        if key not in SOURCES:
            print(f"알 수 없는 소스: {key} (가능: {', '.join(SOURCES)})", file=sys.stderr)
            return 2
        sources.append(SOURCES[key])

    codes = [c.strip() for c in args.lawd.split(",") if c.strip()] or list(LAWD_CODES)
    months = month_range(args.start, args.end)
    refresh = set(months[-args.refresh_recent :]) if args.refresh_recent else set()

    conn = open_db(args.db)
    already = set() if args.force else done_keys(conn)

    plan = [
        (source, code, ym)
        for source in sources
        for code in codes
        for ym in months
        if ym in refresh or (source.key, code, ym) not in already
    ]
    total_calls = len(sources) * len(codes) * len(months)
    print(
        f"대상 {total_calls}개 구간 중 {len(plan)}개 수집 예정 "
        f"({args.start}~{args.end}, 소스 {len(sources)}종, 자치구 {len(codes)}개)"
    )
    if not plan:
        print("모두 수집 완료된 상태입니다.")
        return 0

    session = requests.Session()

    # 막혀 있으면 여기서 기다린다. 계획을 시작해 놓고 구간마다 재시도를 태우는
    # 것보다, 한 구간으로 상태를 보고 회복을 기다리는 쪽이 요청도 적고 빠르다.
    blocked = preflight(requests.Session, service_key, *plan[0])
    if blocked:
        print(f"\n{PREFLIGHT_TRIES}번 확인하는 동안 계속 막혀 있었습니다: {blocked}",
              file=sys.stderr)
        print("이 러너의 IP가 막혀 있습니다. 기다려도 같은 IP라 풀리지 않습니다.",
              file=sys.stderr)
        print("다시 실행하면 새 러너에서 다른 IP를 뽑습니다. 이번 실행에서 "
              "받은 것은 없습니다.", file=sys.stderr)
        return EXIT_BLOCKED

    inserted_total = 0
    calls = 0
    errors = 0
    # 절단 가드가 "이번 실행" 범위를 알 수 있게 시작 시각을 박아 둔다
    run_started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # 소스(서비스)마다 일일 쿼터가 독립이다. 한 소스의 소진으로 전체를 멈추면
    # 나머지 세 소스의 남은 쿼터를 버리고, 순회가 늘 서울 먼저라 경기 뒤쪽
    # 시군구부터 매번 굶는다. 소진된 소스만 접고 나머지는 계속 간다.
    exhausted: set[str] = set()
    starved = 0
    consecutive = 0   # 연속으로 실패한 구간 수. 성공 하나면 0으로 돌아간다
    aborted = False   # 접속 문제로 계획을 포기했는가

    try:
        for index, (source, code, ym) in enumerate(plan, start=1):
            if source.key in exhausted:
                starved += 1
                continue
            if args.max_calls and calls >= args.max_calls:
                print(f"--max-calls({args.max_calls}) 도달. 중단합니다. 재실행하면 이어서 받습니다.")
                break

            gu = LAWD_CODES.get(code, code)
            prefix = f"[{index}/{len(plan)}] {source.key} {gu} {ym}"
            try:
                items, total = fetch_month(
                    session,
                    service_key,
                    source,
                    code,
                    ym,
                    rows_per_page=args.rows_per_page,
                    sleep=args.sleep,
                )
            except FatalApiError as exc:
                # 여기서 return하면 finally가 커밋한다. close는 생략해도 커밋된 데이터는 안전하다.
                print(f"{prefix} 치명적 오류로 중단: {scrub(exc)}", file=sys.stderr)
                return 1
            except QuotaExhausted as exc:
                # 이 소스의 오늘 몫을 다 썼다. 실패가 아니라 여기까지 받았다는 뜻이다.
                # 받은 구간은 fetch_log에 ok로 남았으므로 다음 실행이 이어받는다.
                print(f"\n{prefix} 일일 한도 소진 ({scrub(exc)}). 이 소스만 접고 계속합니다.",
                      flush=True)
                exhausted.add(source.key)
                # 쿼터 응답은 왕복과 파싱이 성공했다는 뜻이라 호스트 생존의
                # 증거다. 성공과 똑같이 카운터를 푼다. 안 그러면 소스 경계를
                # 사이에 두고 "실패 4 + 쿼터 + 실패 1"이 연속 5로 잘못 세어져
                # 실효 임계가 1까지 내려간다.
                consecutive = 0
                continue
            except Exception as exc:
                print(f"{prefix} 실패: {scrub(exc)}", file=sys.stderr)
                # fetch_log는 공개 릴리스로 올라가는 seoul_rt.sqlite 안의 테이블이다.
                # 여기서 키가 새면 로그가 아니라 배포물에 박제된다.
                conn.execute(
                    "INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?,?)",
                    (source.key, code, ym, None, 0, "error", scrub(exc)[:500],
                     datetime.now(timezone.utc).isoformat(timespec="seconds")),
                )
                conn.commit()
                calls += 1
                errors += 1
                consecutive += 1
                # 아래 20% 오류율 가드는 순회를 다 끝낸 뒤에야 검사한다. 그래서
                # 호스트가 통째로 죽은 날에는 아무도 멈추지 않는다. 실제로 한 번
                # 그랬다. 1,800구간 계획에서 114구간을 100% 실패하며 5시간 49분을
                # 태우고 러너 한도에 잘렸고 적재는 0건이었다. 구간 하나가 이미
                # 재시도 5회를 품고 있으니, 그게 연속으로 무너지면 개별 구간
                # 문제가 아니라 접속 문제다. 인구 수집기와 같은 규율이다.
                if args.abort_after and consecutive >= args.abort_after:
                    print(f"\n연속 {consecutive}개 구간이 모두 실패했습니다"
                          f"(구간마다 재시도 5회 포함). 개별 구간이 아니라 접속"
                          f" 문제로 보고 중단합니다. 받은 구간은 다음 실행이"
                          f" 건너뜁니다.", file=sys.stderr)
                    aborted = True
                    break
                continue

            consecutive = 0
            rows = build_rows(items, source, code, ym)
            conn.executemany(INSERT_SQL, rows)
            conn.execute(
                "INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?,?)",
                (source.key, code, ym, total, len(rows), "ok", None,
                 datetime.now(timezone.utc).isoformat(timespec="seconds")),
            )
            conn.commit()

            inserted_total += len(rows)
            calls += 1
            print(f"{prefix} {len(rows):>5}건 (누적 {inserted_total:,})")
            time.sleep(args.sleep)
    except KeyboardInterrupt:
        print("\n중단됨. 재실행하면 받은 구간은 건너뜁니다.")
    finally:
        conn.commit()

    # 절단 탐지: API가 말한 totalCount와 실제 적재 행 수가 다른데 ok로 남았다면
    # 조용히 덜 받은 것이다. 이번 실행에서 새로 생긴 것만 실패 사유로 삼되,
    # 과거 이력까지 포함해 전부 error로 강등해 다음 실행이 자동 재수집하게 한다.
    # 전체 이력을 실패 사유로 삼으면 과거 절단 1건이 수동 --force 전까지
    # 매주 헛 빨간불을 만든다.
    truncated_now = conn.execute(
        "SELECT COUNT(*) FROM fetch_log "
        "WHERE status='ok' AND total_count <> row_count AND fetched_at >= ?",
        (run_started,),
    ).fetchone()[0]
    degraded = conn.execute(
        "UPDATE fetch_log SET status='error', "
        "message='절단 의심: totalCount와 적재 행 수 불일치' "
        "WHERE status='ok' AND total_count <> row_count"
    ).rowcount
    conn.commit()
    conn.close()

    print(f"완료. 이번 실행에서 {inserted_total:,}건 적재, API 호출 {calls}회 (오류 구간 {errors}개)")

    # 성공/실패 회계. collect_bldg.py 끝의 규율과 같다:
    # 틀린 초록불은 없느니만 못하다.
    if degraded:
        print(f"절단 의심 {degraded}개 구간을 error로 강등했습니다. 다음 실행이 재수집합니다.")
    if truncated_now:
        print(f"경고: 이번 실행에서 totalCount와 적재 행 수가 다른 구간이 {truncated_now}개 "
              "생겼습니다. 조용한 절단이므로 실패로 종료합니다.", file=sys.stderr)
        return 1
    # 접속 중단은 오류율과 무관하게 그 자체로 실패다. 20% 가드에 판정을 맡기면
    # errors가 abort_after로 고정되므로 성공 20구간만 넘겨도 비율이 20% 아래로
    # 떨어져 초록불이 된다. 주간 계획이 888구간이니 사실상 모든 장애가 초록불로
    # 새고, 그 초록불이 집계·릴리스·배포 체인을 통째로 연다. 남은 구간의 성패를
    # 모른다는 것이 곧 실패의 정의다.
    if aborted:
        # 사전 확인은 통과했는데 도중에 막힌 경우다. 창을 3분으로 줄인 뒤로는
        # 이 경로가 오히려 흔해진다. 여기서도 차단 코드를 내야 워크플로가 같은
        # 안내(새 잡을 띄우면 IP가 바뀐다)를 할 수 있다.
        left = len(plan) - index
        print(f"::error::접속 문제로 {index}/{len(plan)} 구간에서 중단했습니다. "
              f"{left}구간을 받지 못했습니다. 이 러너의 IP가 막힌 것이라 다시 "
              f"실행하면 새 러너에서 다른 IP를 뽑습니다.")
        return EXIT_BLOCKED
    # 오류 회계가 쿼터의 정상 종료보다 먼저다. 쿼터 소진과 40% 오류가 같이
    # 있었던 실행을 초록불로 끝내면 안 된다.
    if calls and errors > calls * 0.20:
        print(f"오류 구간이 {errors}/{calls}개 ({errors / calls:.0%})로 20%를 넘습니다. "
              "결과를 신뢰할 수 없어 실패로 종료합니다.", file=sys.stderr)
        return 1
    if exhausted:
        print(f"일일 한도 소진 소스: {', '.join(sorted(exhausted))} "
              f"(건너뛴 구간 {starved:,}개). 받은 만큼은 저장됐고, 다음 실행이 이어받습니다.")
        return 0
    if calls and not inserted_total:
        print("호출은 있었는데 한 건도 적재하지 못했습니다.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
