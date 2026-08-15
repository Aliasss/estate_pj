#!/usr/bin/env python3
"""지번 → 좌표. VWorld 지오코더.

통근 시간·인프라 거리가 전부 여기에 걸려 있다. 물건 좌표가 있어야 가장 가까운
지하철역을 찾고, 역이 정해져야 목적지까지 시간을 잴 수 있다.

앱에 뜨는 물건의 고유 지번만 받는다 — 48,226개다. 실거래가 전체 지번(98,575)을
받으면 두 배를 쓰는데, 최근 전세 계약이 없는 물건은 어차피 화면에 안 나온다.

건축물대장에서 배운 것을 그대로 적용한다.
  - 전역 속도 제한. 워커를 늘려 병렬로 때리면 429를 맞고 한동안 차단된다.
  - 시작 전에 한 건을 먼저 쏴 본다. 막혀 있으면 15초 만에 끝난다.
  - 진행분을 매번 저장한다. 하루 한도에 걸려도 다음 실행이 이어받는다.

사용법
    export VWORLD_KEY="vworld.kr 인증키"
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
from lawd_codes import SEOUL_LAWD_CODES
from scrub import describe

ENDPOINT = "https://api.vworld.kr/req/address"

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
    return f"서울특별시 {SEOUL_LAWD_CODES.get(lawd, '')} {umd} {jibun}".replace("  ", " ")


def fetch(session: requests.Session, key: str, target: tuple, _endpoint_idx,
          throttle: Throttle | None = None, *, max_retries: int = 3,
          timeout: int = 15) -> list[dict]:
    """좌표 한 건. 주소가 없는 것과 호출이 실패한 것은 완전히 다르게 다뤄야 한다.

    없는 주소를 오류로 세면 재시도로 한도를 태우고, 오류를 '없음'으로 저장하면
    영영 다시 안 받는다. 앞의 것은 items=[]로, 뒤의 것은 예외로 낸다.
    """
    params = {
        "service": "address", "request": "getcoord", "version": "2.0",
        "crs": "epsg:4326", "type": "PARCEL", "format": "json",
        "address": address_of(target), "key": key,
    }
    last: Exception | None = None
    for attempt in range(max_retries):
        try:
            if throttle:
                throttle.wait()
            res = session.get(ENDPOINT, params=params, timeout=timeout)
            if res.status_code == 429 and throttle:
                throttle.penalize()
                raise RuntimeError("429 Too Many Requests")
            res.raise_for_status()
            body = res.json().get("response", {})
            status = body.get("status")
            if status == "NOT_FOUND":
                return []                       # 주소가 없다. 재시도할 일이 아니다.
            if status != "OK":
                err = (body.get("error") or {}).get("text") or status
                raise RuntimeError(f"VWorld {status}: {err}")
            point = body.get("result", {}).get("point", {})
            return [{"lon": float(point["x"]), "lat": float(point["y"])}]
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
    parser = argparse.ArgumentParser(description="지번 → 좌표 (VWorld)")
    parser.add_argument("--units", default="units", help="물건 패널 디렉터리")
    parser.add_argument("--db", default="geo.sqlite")
    parser.add_argument("--max-calls", type=int, default=0, help="0이면 무제한")
    parser.add_argument("--rate", type=float, default=8.0, help="초당 호출 수 상한")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--retry-errors", action="store_true")
    args = parser.parse_args()

    key = os.environ.get("VWORLD_KEY", "").strip()
    if not key:
        print("VWORLD_KEY가 없습니다. vworld.kr에서 무료로 발급됩니다.", file=sys.stderr)
        return 2

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
