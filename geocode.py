#!/usr/bin/env python3
"""지번 → 좌표. 도로명주소(JUSO) 지오코더.

통근 시간·인프라 거리가 전부 여기에 걸려 있다. 물건 좌표가 있어야 가장 가까운
지하철역을 찾고, 역이 정해져야 목적지까지 시간을 잴 수 있다.

앱에 뜨는 물건의 고유 지번만 받는다 — 48,226개다. 실거래가 전체 지번(98,575)을
받으면 두 배를 쓰는데, 최근 전세 계약이 없는 물건은 어차피 화면에 안 나온다.

건축물대장에서 배운 것을 그대로 적용한다.
  - 전역 속도 제한. 워커를 늘려 병렬로 때리면 429를 맞고 한동안 차단된다.
  - 시작 전에 한 건을 먼저 쏴 본다. 막혀 있으면 15초 만에 끝난다.
  - 진행분을 매번 저장한다. 하루 한도에 걸려도 다음 실행이 이어받는다.

VWorld는 쓰지 않는다. 키를 발급받아 등록까지 했는데 해외 IP를 서버가
연결 수준에서 끊는다는 것을 변형 여섯 종으로 실측했다(8월 7일, 8월 15일 재확인).
GitHub Actions 러너는 미국에 있다. JUSO는 같은 러너에서 응답을 준다.

JUSO는 두 단계다. 검색 API가 지번을 도로명 코드로 바꾸고(addrLinkApi),
좌표 API가 그 코드로 출입구 좌표를 준다(addrCoordApi). 좌표는 EPSG:5179
평면좌표라 WGS84로 변환해 저장한다. 한 지번 = HTTP 두 번이므로 --rate는
지번 기준이고 실제 요청 수는 그 두 배다.

사용법
    export JUSO_CONFM_KEY="좌표제공 API 승인키"
    export JUSO_SEARCH_KEY="검색 API 승인키 (없으면 좌표 키로 함께 시도)"
    python geocode.py --units units --db geo.sqlite --max-calls 30000
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

import requests

from collect_bldg import MAX_CONSECUTIVE_FAILURES, Throttle, results
from lawd_codes import LAWD_CODES
from scrub import describe

SEARCH_ENDPOINT = "https://business.juso.go.kr/addrlink/addrLinkApi.do"
COORD_ENDPOINT = "https://business.juso.go.kr/addrlink/addrCoordApi.do"

SCHEMA = """
CREATE TABLE IF NOT EXISTS coords (
    lawd_cd  TEXT NOT NULL,
    umd_nm   TEXT NOT NULL,
    jibun    TEXT NOT NULL,
    lon      REAL,
    lat      REAL,
    status   TEXT NOT NULL,     -- ok / notfound / error
    message  TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (lawd_cd, umd_nm, jibun)
);
"""


def targets(units_dir: str) -> list[tuple]:
    """앱에 뜨는 물건의 고유 지번. (시군구코드, 법정동, 지번) 순."""
    seen = set()
    for path in sorted(glob.glob(os.path.join(units_dir, "*.json"))):
        base = os.path.basename(path)
        # finder-11/finder-41 같은 분할 요약 파일에는 rows가 없다. 물건 파일은
        # 다섯 자리 시군구 코드 이름뿐이다.
        if not (base[:5].isdigit() and base.endswith(".json")):
            continue
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        col = {c: i for i, c in enumerate(data["cols"])}
        for row in data["rows"]:
            jibun = (row[col["jibun"]] or "").strip()
            umd = (row[col["umd"]] or "").strip()
            if jibun and umd:
                seen.add((data["lawd_cd"], umd, jibun))
    return sorted(seen)


def address_of(target: tuple) -> str:
    lawd, umd, jibun = target
    sido = "서울특별시" if lawd.startswith("11") else "경기도"
    return f"{sido} {LAWD_CODES.get(lawd, '')} {umd} {jibun}".replace("  ", " ")


def _tm_inverse(x: float, y: float) -> tuple[float, float]:
    """EPSG:5179(UTM-K, GRS80) -> WGS84 경위도. 의존성 없이 역변환한다.

    시리즈 전개 기반이고 수도권에서 오차는 밀리미터급이다. pyproj를 안 쓰는
    이유는 하나다. 이 저장소의 수집기는 표준 라이브러리 + requests로만 돈다.
    """
    import math
    a, f = 6378137.0, 1 / 298.257222101       # GRS80
    k0, lon0, lat0 = 0.9996, math.radians(127.5), math.radians(38.0)
    x0, y0 = 1000000.0, 2000000.0
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)

    def arc(phi):
        return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
                    - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * phi)
                    + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * phi)
                    - (35 * e2**3 / 3072) * math.sin(6 * phi))

    m = arc(lat0) + (y - y0) / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu)
            + (1097 * e1**4 / 512) * math.sin(8 * mu))
    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1 = ep2 * cos1**2
    t1 = tan1**2
    n1 = a / math.sqrt(1 - e2 * sin1**2)
    r1 = a * (1 - e2) / (1 - e2 * sin1**2) ** 1.5
    d = (x - x0) / (n1 * k0)
    lat = phi1 - (n1 * tan1 / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d**3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / cos1
    return math.degrees(lon), math.degrees(lat)


def _juso_get(session: requests.Session, url: str, params: dict, timeout: int) -> dict:
    res = session.get(url, params=params, timeout=timeout)
    res.raise_for_status()
    body = res.json().get("results", {})
    common = body.get("common", {})
    code = common.get("errorCode")
    if code not in ("0", 0, None):
        # E0001 미승인 키, E0012 기간 만료 같은 것은 재시도해도 소용없지만,
        # 어느 쪽이든 위에서 오류로 세고 연속 실패 차단이 잡는다.
        raise RuntimeError(f"JUSO {code}: {common.get('errorMessage', '')[:120]}")
    return body


def fetch(session: requests.Session, key: str, target: tuple, _endpoint_idx,
          throttle: Throttle | None = None, *, max_retries: int = 3,
          timeout: int = 15) -> list[dict]:
    """좌표 한 건. 주소가 없는 것과 호출이 실패한 것은 완전히 다르게 다뤄야 한다.

    없는 주소를 오류로 세면 재시도로 한도를 태우고, 오류를 '없음'으로 저장하면
    영영 다시 안 받는다. 앞의 것은 items=[]로, 뒤의 것은 예외로 낸다.

    key는 "검색키|좌표키" 꼴로 온다. 두 단계가 서로 다른 승인 키를 쓸 수 있어서다.
    """
    search_key, _, coord_key = key.partition("|")
    coord_key = coord_key or search_key
    last: Exception | None = None
    for attempt in range(max_retries):
        try:
            if throttle:
                throttle.wait()
            # 1단계: 지번 -> 도로명 코드. 첫 결과를 쓴다. 지번 하나에 도로명이
            # 여럿인 경우(모퉁이 건물)가 있지만 출입구 좌표 차이는 건물 폭 안이다.
            found = _juso_get(session, SEARCH_ENDPOINT, {
                "confmKey": search_key, "keyword": address_of(target),
                "currentPage": 1, "countPerPage": 1, "resultType": "json",
            }, timeout)
            rows = found.get("juso") or []
            if not rows:
                return []                       # 주소가 없다. 재시도할 일이 아니다.
            j = rows[0]
            # 2단계: 도로명 코드 -> 출입구 좌표(EPSG:5179)
            got = _juso_get(session, COORD_ENDPOINT, {
                "confmKey": coord_key, "admCd": j["admCd"], "rnMgtSn": j["rnMgtSn"],
                "udrtYn": j["udrtYn"], "buldMnnm": j["buldMnnm"],
                "buldSlno": j["buldSlno"], "resultType": "json",
            }, timeout)
            crows = got.get("juso") or []
            if not crows or not crows[0].get("entX"):
                return []                       # 코드에는 있는데 좌표가 없는 건물
            lon, lat = _tm_inverse(float(crows[0]["entX"]), float(crows[0]["entY"]))
            return [{"lon": lon, "lat": lat}]
        except requests.exceptions.ConnectionError as exc:
            last = exc
            if attempt >= 1:
                break
            time.sleep(1)
        except Exception as exc:
            last = exc
            time.sleep(min(1.5**attempt, 4))
    raise RuntimeError(f"{max_retries}회 실패: {describe(last)}")


def preflight(key: str, target: tuple) -> str | None:
    try:
        got = fetch(requests.Session(), key, target, None, max_retries=1, timeout=20)
        return None if got else "첫 지번이 NOT_FOUND (주소 형식을 확인하세요)"
    except Exception as exc:
        return describe(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description="지번 → 좌표 (JUSO)")
    parser.add_argument("--units", default="units", help="물건 패널 디렉터리")
    parser.add_argument("--db", default="geo.sqlite")
    parser.add_argument("--max-calls", type=int, default=0, help="0이면 무제한")
    parser.add_argument("--rate", type=float, default=8.0, help="초당 호출 수 상한")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--retry-errors", action="store_true")
    args = parser.parse_args()

    coord_key = os.environ.get("JUSO_CONFM_KEY", "").strip()
    search_key = os.environ.get("JUSO_SEARCH_KEY", "").strip() or coord_key
    if not coord_key:
        print("JUSO_CONFM_KEY가 없습니다. juso.go.kr 좌표제공 API 승인키가 필요합니다.",
              file=sys.stderr)
        return 2
    key = f"{search_key}|{coord_key}"

    conn = sqlite3.connect(args.db)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    done_q = "SELECT lawd_cd, umd_nm, jibun FROM coords"
    if not args.retry_errors:
        done_q += " WHERE status <> 'error'"
    done = {tuple(r) for r in conn.execute(done_q)}

    plan = [t for t in targets(args.units) if t not in done]
    print(f"조회 대상 {len(plan):,}건 (완료 {len(done):,}건)")
    if not plan:
        print("모두 완료된 상태입니다.")
        return 0
    if args.max_calls and len(plan) > args.max_calls:
        print(f"--max-calls({args.max_calls:,})만큼만 받습니다.")
        plan = plan[:args.max_calls]

    blocked = preflight(key, plan[0])
    if blocked:
        print(f"사전 확인 실패:\n  {blocked}", file=sys.stderr)
        conn.close()
        return 1
    print(f"사전 확인 통과 ({address_of(plan[0])})")

    throttle = Throttle(args.rate)
    now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    calls = ok = notfound = errors = streak = 0
    started = time.monotonic()
    print(f"워커 {args.workers}개 · 초당 {args.rate}건 상한으로 시작", flush=True)

    # collect_bldg.results가 fetch를 모듈 전역에서 찾으므로 갈아 끼운다
    import collect_bldg
    collect_bldg.fetch = fetch

    try:
        for target, items, exc in results(plan, key, [0], args.workers, throttle):
            calls += 1
            if exc is not None:
                errors += 1
                streak += 1
                detail = describe(exc)
                conn.execute("INSERT OR REPLACE INTO coords VALUES (?,?,?,?,?,?,?,?)",
                             (*target, None, None, "error", detail[:300], now()))
                conn.commit()
                if errors <= 5 or errors % 50 == 0:
                    print(f"  실패 {errors}: {address_of(target)} — {detail}", flush=True)
                if streak >= MAX_CONSECUTIVE_FAILURES:
                    print(f"\n{streak}건 연속 실패로 중단합니다:\n  {detail}", file=sys.stderr)
                    break
                continue
            streak = 0
            if items:
                p = items[0]
                ok += 1
                conn.execute("INSERT OR REPLACE INTO coords VALUES (?,?,?,?,?,?,?,?)",
                             (*target, round(p["lon"], 7), round(p["lat"], 7), "ok", None, now()))
            else:
                notfound += 1
                conn.execute("INSERT OR REPLACE INTO coords VALUES (?,?,?,?,?,?,?,?)",
                             (*target, None, None, "notfound", None, now()))
            if calls <= 20 or calls % 500 == 0:
                conn.commit()
                per = (time.monotonic() - started) / calls
                print(f"[{calls:,}/{len(plan):,}] {address_of(target)} | "
                      f"좌표 {ok:,} 없음 {notfound:,} 실패 {errors:,} | "
                      f"건당 {per:.2f}초", flush=True)
    except KeyboardInterrupt:
        print("\n중단됨. 재실행하면 이어서 받습니다.")
    finally:
        conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM coords WHERE status='ok'").fetchone()[0]
    print(f"\n완료. 이번 실행 {calls:,}회 — 좌표 {ok:,} / 주소없음 {notfound:,} / 실패 {errors:,}")
    print(f"DB 총 좌표 {total:,}건")
    conn.close()
    return 1 if (calls and not ok) else 0


if __name__ == "__main__":
    raise SystemExit(main())
