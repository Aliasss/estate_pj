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

from lawd_codes import SEOUL_LAWD_CODES

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
    ]
}

SUCCESS_CODES = {"00", "000"}
# 재시도해도 소용없는 인증/할당량 오류. 즉시 중단한다.
FATAL_CODES = {
    "04",  # HTTP ERROR
    "12",  # NO_OPENAPI_SERVICE_ERROR
    "20",  # SERVICE_ACCESS_DENIED_ERROR
    "22",  # LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR
    "30",  # SERVICE_KEY_IS_NOT_REGISTERED_ERROR
    "31",  # DEADLINE_HAS_EXPIRED_ERROR
    "32",  # UNREGISTERED_IP_ERROR
}

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


class FatalApiError(RuntimeError):
    """인증키·할당량 등 재시도가 무의미한 오류."""


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
        "sgg_nm": SEOUL_LAWD_CODES.get(lawd_cd),
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


def default_window(months: int = 60) -> tuple[str, str]:
    """전월을 끝으로 하는 N개월 창. 당월은 신고 기한(30일) 때문에 제외한다."""
    today = date.today()
    end = (today.replace(day=1) - timedelta(days=1)).strftime("%Y%m")
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
) -> tuple[list[dict[str, str]], int]:
    """한 구 × 한 달을 전 페이지 수집한다."""
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
                if code and code not in SUCCESS_CODES:
                    raise RuntimeError(f"API 오류 [{code}] {message}")
                break
            except FatalApiError:
                raise
            except Exception as exc:  # 네트워크 오류 / 일시적 5xx / 파싱 실패
                last_error = exc
                backoff = min(2**attempt, 30) + random.uniform(0, 0.5)
                print(f"      재시도 {attempt + 1}/{max_retries} ({exc}) -> {backoff:.1f}s 대기")
                time.sleep(backoff)
        else:
            raise RuntimeError(f"{max_retries}회 재시도 실패: {last_error}")

        collected.extend(items)
        if not items or len(collected) >= total or len(items) < rows_per_page:
            break
        page += 1
        time.sleep(sleep)

    return collected, total


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

    codes = [c.strip() for c in args.lawd.split(",") if c.strip()] or list(SEOUL_LAWD_CODES)
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
    inserted_total = 0
    calls = 0

    try:
        for index, (source, code, ym) in enumerate(plan, start=1):
            if args.max_calls and calls >= args.max_calls:
                print(f"--max-calls({args.max_calls}) 도달. 중단합니다. 재실행하면 이어서 받습니다.")
                break

            gu = SEOUL_LAWD_CODES.get(code, code)
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
                print(f"{prefix} 치명적 오류로 중단: {exc}", file=sys.stderr)
                return 1
            except Exception as exc:
                print(f"{prefix} 실패: {exc}", file=sys.stderr)
                conn.execute(
                    "INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?,?)",
                    (source.key, code, ym, None, 0, "error", str(exc)[:500],
                     datetime.now(timezone.utc).isoformat(timespec="seconds")),
                )
                conn.commit()
                calls += 1
                continue

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
        conn.close()

    print(f"완료. 이번 실행에서 {inserted_total:,}건 적재, API 호출 {calls}회")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
