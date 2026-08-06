#!/usr/bin/env python3
"""건축물대장 표제부 수집.

실거래가만으로는 "이 집이 나에게 맞나"를 답할 수 없다. 건축물대장에는 구조·세대수·
층수·사용승인일·주차·승강기가 들어 있고, 이것들이 집을 고를 때 실제로 보는 항목이다.

좌표가 필요 없다는 점이 중요하다. 실거래가 payload에 이미 sggCd/umdCd/bonbun/bubun이
있어서 지번만으로 조인된다. 지오코딩 없이 바로 붙는다.

층간소음에 대해: 건물 단위 실측 데이터는 공개된 것이 없다. 대신 구조(벽식이 취약,
라멘조가 유리)와 사용승인일(2005년 표준바닥구조 의무화)이 가장 가까운 프록시다.
추정이라는 사실은 화면에서 반드시 밝혀야 한다.

사용법
    export MOLIT_SERVICE_KEY="공공데이터포털 인증키"
    python collect_bldg.py --rt-db seoul_rt.sqlite --db bldg.sqlite --lawd 11140
    python collect_bldg.py --rt-db seoul_rt.sqlite --db bldg.sqlite --max-calls 9500
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from xml.etree import ElementTree

import requests

from collect import FATAL_CODES, SUCCESS_CODES, FatalApiError, _clean, _to_float, _to_int
from lawd_codes import SEOUL_LAWD_CODES

# 구버전(BldRgstService_v2)은 폐기됐다 — NO_OPENAPI_SERVICE_ERROR(12)를 돌려준다.
# 건축HUB만 살아 있다.
ENDPOINTS = [
    "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS buildings (
    lawd_cd     TEXT NOT NULL,        -- 시군구 5자리
    bjdong_cd   TEXT NOT NULL,        -- 법정동 5자리
    plat_gb     TEXT NOT NULL,        -- 0 대지 / 1 산
    bun         TEXT NOT NULL,
    ji          TEXT NOT NULL,
    mgm_key     TEXT NOT NULL,        -- 관리건축물대장PK. 한 지번에 여러 동이 있을 수 있다
    umd_nm      TEXT,
    plat_plc    TEXT,                 -- 대지위치
    road_addr   TEXT,                 -- 도로명주소
    bld_nm      TEXT,
    dong_nm     TEXT,
    main_purps  TEXT,                 -- 주용도
    strct       TEXT,                 -- 구조. 층간소음 프록시의 핵심
    use_apr_day TEXT,                 -- 사용승인일 YYYYMMDD
    grnd_flr    INTEGER,              -- 지상 층수
    ugrnd_flr   INTEGER,
    hhld_cnt    INTEGER,              -- 세대수
    fmly_cnt    INTEGER,              -- 가구수
    ho_cnt      INTEGER,              -- 호수
    tot_area    REAL,                 -- 연면적
    plat_area   REAL,                 -- 대지면적
    elvt_cnt    INTEGER,              -- 승용 승강기
    park_cnt    INTEGER,              -- 주차 총계
    heat_nm     TEXT,                 -- 난방방식
    eqk_yn      TEXT,                 -- 내진설계 적용 여부
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (lawd_cd, bjdong_cd, plat_gb, bun, ji, mgm_key)
);
CREATE INDEX IF NOT EXISTS idx_bldg_addr ON buildings (lawd_cd, umd_nm, bun, ji);

CREATE TABLE IF NOT EXISTS bldg_log (
    lawd_cd    TEXT NOT NULL,
    bjdong_cd  TEXT NOT NULL,
    plat_gb    TEXT NOT NULL,
    bun        TEXT NOT NULL,
    ji         TEXT NOT NULL,
    n_rows     INTEGER,
    status     TEXT NOT NULL,     -- ok / empty / error
    message    TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (lawd_cd, bjdong_cd, plat_gb, bun, ji)
);
"""

INSERT_SQL = """
INSERT INTO buildings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
"""


def parse_jibun(jibun: str | None) -> tuple[str, str, str] | None:
    """'123-4' -> ('0', '0123', '0004'). '산 12' -> ('1', '0012', '0000')."""
    text = _clean(jibun)
    if not text:
        return None
    plat_gb = "0"
    if text.startswith("산"):
        plat_gb, text = "1", text[1:].strip()
    parts = text.split("-")
    nums = [re.sub(r"\D", "", p) for p in parts[:2]]
    if not nums or not nums[0]:
        return None
    bun = nums[0].zfill(4)
    ji = (nums[1] if len(nums) > 1 and nums[1] else "0").zfill(4)
    return plat_gb, bun, ji


def targets(rt_db: str, lawd_filter: list[str]) -> list[tuple]:
    """실거래가 DB에서 조회 대상 지번을 뽑고, 법정동코드를 붙인다.

    법정동코드는 아파트 매매 payload의 umdCd에서 얻는다. 아파트가 한 번도 거래되지
    않은 동(종로구 옛 동네 등)은 매핑이 없어 건너뛴다. 전체의 0.7% 수준이다.
    """
    conn = sqlite3.connect(rt_db)
    umd_cd: dict[tuple[str, str], str] = {}
    for (payload,) in conn.execute("SELECT payload FROM transactions WHERE source = 'apt_trade'"):
        d = json.loads(payload)
        sgg, umd, cd = d.get("sggCd"), _clean(d.get("umdNm")), d.get("umdCd")
        if sgg and umd and cd:
            umd_cd[(sgg, umd)] = cd

    rows, skipped = [], 0
    query = """
        SELECT DISTINCT lawd_cd, umd_nm, jibun FROM transactions
        WHERE (cdeal_type IS NULL OR cdeal_type <> 'O') AND jibun IS NOT NULL
    """
    params: list = []
    if lawd_filter:
        query += f" AND lawd_cd IN ({','.join('?' * len(lawd_filter))})"
        params = lawd_filter
    for lawd, umd, jibun in conn.execute(query, params):
        umd = _clean(umd)
        cd = umd_cd.get((lawd, umd))
        parsed = parse_jibun(jibun)
        if not cd or not parsed:
            skipped += 1
            continue
        rows.append((lawd, cd, *parsed, umd))
    conn.close()
    if skipped:
        print(f"법정동코드 미매핑 또는 지번 파싱 실패로 제외: {skipped:,}건")
    return sorted(set(rows))


# 인증키는 쿼리스트링에 실려 나가고, requests/urllib3 예외 메시지는 URL을 통째로
# 담는다. 그대로 로그에 찍으면 키가 샌다 (첫 실행에서 실제로 13자가 노출됐다).
SECRET_RE = re.compile(r"(serviceKey=)[^&\s'\")]*")

# 연속 실패가 이만큼 쌓이면 접속 자체가 막힌 것으로 보고 중단한다. 없으면 100%
# 실패 상태로 5시간을 돌다 타임아웃한다 — 실제로 한 시간을 그렇게 버렸다.
MAX_CONSECUTIVE_FAILURES = 25


class Throttle:
    """전역 호출 간격. 워커 수와 무관하게 초당 호출 수를 묶는다.

    이 API는 초당 한도가 있고 넘기면 429를 돌려준다. 워커 6개로 풀어 놨더니
    1.1초에 25건이 나가서 26번째부터 전부 429였다. 병렬로 빨리 받는 게 아니라
    일정한 속도로 오래 받아야 하는 API다.

    한도가 문서에 없어서 실측으로 찾아간다. 429를 맞으면 간격을 두 배로 늘리고,
    성공이 쌓이면 조금씩 되돌린다.
    """

    def __init__(self, rate: float, ceil: float = 8.0):
        self.interval = 1.0 / rate
        self.floor = self.interval        # 처음 지정한 속도보다 빨라지지는 않는다
        self.ceil = ceil
        self.lock = threading.Lock()
        self.next_at = 0.0
        self.ok_streak = 0

    def wait(self) -> None:
        with self.lock:
            start = max(time.monotonic(), self.next_at)
            self.next_at = start + self.interval
        delay = start - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    def penalize(self, retry_after: float | None = None) -> float:
        """429를 맞았다. 간격을 늘리고, 큐에 밀린 호출까지 한동안 멈춘다."""
        with self.lock:
            self.interval = min(self.ceil, self.interval * 2)
            self.next_at = time.monotonic() + (retry_after or self.interval * 5)
            self.ok_streak = 0
            return self.interval

    def reward(self) -> float | None:
        """오래 조용하면 조금 조여 본다. 되돌린 값을 반환(변화 없으면 None)."""
        with self.lock:
            self.ok_streak += 1
            if self.ok_streak < 300 or self.interval <= self.floor:
                return None
            self.interval = max(self.floor, self.interval * 0.8)
            self.ok_streak = 0
            return self.interval


def describe(exc: BaseException, limit: int = 240) -> str:
    """예외 한 줄 요약.

    urllib3 메시지는 URL이 앞에 오고 진짜 원인('Caused by ConnectTimeoutError…')이
    맨 끝에 온다. 앞만 잘라 쓰면 원인을 영영 못 본다. 양끝을 남긴다.
    """
    text = SECRET_RE.sub(r"\1***", str(exc)).replace("\n", " ")
    if len(text) > limit:
        text = f"{text[:70]} … {text[-(limit - 73):]}"
    return f"{type(exc).__name__}: {text}"


def read_response(text: str) -> tuple[str, str, list[dict]]:
    """(코드, 메시지, items). 게이트웨이 오류는 JSON으로도 오므로 둘 다 읽는다.

    JSON 오류를 XML 파서로만 처리하면 파싱 실패가 되고, 그러면 즉시 중단해야 할
    인증 오류(30)가 재시도 대상으로 잘못 분류된다.
    """
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            head = json.loads(stripped).get("OpenAPI_ServiceResponse", {}).get("cmmMsgHeader", {})
        except json.JSONDecodeError:
            raise RuntimeError(f"응답을 해석할 수 없습니다: {text[:200]}")
        return (_clean(head.get("returnReasonCode")),
                _clean(head.get("returnAuthMsg") or head.get("errMsg")), [])

    root = ElementTree.fromstring(text)
    code = _clean(root.findtext(".//returnReasonCode") or root.findtext(".//resultCode") or "")
    msg = _clean(root.findtext(".//returnAuthMsg") or root.findtext(".//resultMsg") or "")
    items = [{c.tag: _clean(c.text) for c in item} for item in root.iterfind(".//items/item")]
    return code, msg, items


def fetch(session: requests.Session, key: str, target: tuple, endpoint_idx: list[int],
          throttle: Throttle | None = None, *, max_retries: int = 4,
          timeout: int = 15) -> list[dict]:
    lawd, bjdong, plat_gb, bun, ji, _ = target
    params = {
        "serviceKey": key, "sigunguCd": lawd, "bjdongCd": bjdong,
        "platGbCd": plat_gb, "bun": bun, "ji": ji,
        "numOfRows": 100, "pageNo": 1, "_type": "xml",
    }
    last: Exception | None = None
    for attempt in range(max_retries):
        # 엔드포인트가 하나 죽어 있으면 다음 것으로 넘어간다
        url = ENDPOINTS[endpoint_idx[0] % len(ENDPOINTS)]
        try:
            if throttle:
                throttle.wait()
            res = session.get(url, params=params, timeout=timeout)
            # 429는 내 잘못이다. 물러섰다가 다시 시도한다.
            if res.status_code == 429 and throttle:
                after = res.headers.get("Retry-After")
                throttle.penalize(float(after) if after and after.isdigit() else None)
                raise RuntimeError("429 Too Many Requests")
            # raise_for_status를 먼저 하면 403 본문에 담긴 오류 코드를 못 읽는다
            code, msg, items = read_response(res.text)
            if code in FATAL_CODES:
                raise FatalApiError(f"[{code}] {msg}")
            res.raise_for_status()
            if code and code not in SUCCESS_CODES:
                raise RuntimeError(f"API 오류 [{code}] {msg}")
            return items
        except FatalApiError:
            raise
        except Exception as exc:
            last = exc
            if attempt == 0 and len(ENDPOINTS) > 1:
                endpoint_idx[0] += 1     # 첫 실패에서 엔드포인트를 바꿔 본다
            time.sleep(min(1.5**attempt, 4) + random.uniform(0, 0.3))
    raise RuntimeError(f"{max_retries}회 실패: {describe(last)}")


def results(plan: list[tuple], key: str, endpoint_idx: list[int],
            workers: int, throttle: Throttle):
    """(target, items, exc)를 계획 순서대로 낸다.

    DB 쓰기는 호출부(메인 스레드) 한 곳에 모아 둔다. sqlite 연결을 여러 스레드가
    나눠 쓰면 깨지고, 순서가 뒤섞이면 진행 로그도 읽을 수 없게 된다.

    워커는 응답 대기(건당 0.5초쯤)를 겹치는 용도일 뿐이고, 실제 속도는 throttle이
    잡는다. 워커만 늘리면 초당 20건이 나가서 429를 맞는다 — 실제로 그랬다.
    """
    if workers <= 1:
        session = requests.Session()
        for target in plan:
            try:
                yield target, fetch(session, key, target, endpoint_idx, throttle), None
            except Exception as exc:
                yield target, None, exc
        return

    local = threading.local()

    def one(target: tuple):
        if not hasattr(local, "session"):
            local.session = requests.Session()   # 세션은 스레드마다 따로 둔다
        try:
            return target, fetch(local.session, key, target, endpoint_idx, throttle), None
        except Exception as exc:
            return target, None, exc

    # 통째로 map에 넘기면 계획 전체가 한 번에 큐로 들어간다. 묶음 단위로 흘린다.
    chunk = workers * 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i in range(0, len(plan), chunk):
            yield from pool.map(one, plan[i:i + chunk])


def to_row(item: dict, target: tuple, fetched_at: str) -> tuple:
    lawd, bjdong, plat_gb, bun, ji, umd = target
    park = sum(_to_int(item.get(k)) or 0 for k in
               ("indrMechUtcnt", "oudrMechUtcnt", "indrAutoUtcnt", "oudrAutoUtcnt"))
    return (
        lawd, bjdong, plat_gb, bun, ji,
        _clean(item.get("mgmBldrgstPk")) or f"{bun}-{ji}",
        umd,
        _clean(item.get("platPlc")), _clean(item.get("newPlatPlc")),
        _clean(item.get("bldNm")), _clean(item.get("dongNm")),
        _clean(item.get("mainPurpsCdNm")), _clean(item.get("strctCdNm")),
        _clean(item.get("useAprDay")),
        _to_int(item.get("grndFlrCnt")), _to_int(item.get("ugrndFlrCnt")),
        _to_int(item.get("hhldCnt")), _to_int(item.get("fmlyCnt")), _to_int(item.get("hoCnt")),
        _to_float(item.get("totArea")), _to_float(item.get("platArea")),
        _to_int(item.get("rideUseElvtCnt")), park or None,
        _clean(item.get("heatCdNm")), _clean(item.get("rserthqkDsgnApplyYn")),
        json.dumps(item, ensure_ascii=False, sort_keys=True), fetched_at,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="건축물대장 표제부 수집")
    parser.add_argument("--rt-db", default="seoul_rt.sqlite", help="실거래가 DB (조회 대상 추출용)")
    parser.add_argument("--db", default="bldg.sqlite")
    parser.add_argument("--lawd", default="", help="자치구 코드 제한 (쉼표 구분)")
    parser.add_argument("--rate", type=float, default=2.0,
                        help="초당 호출 수 상한. 429를 맞으면 여기서 더 느려진다")
    parser.add_argument("--workers", type=int, default=3,
                        help="동시 호출 수. 응답 대기를 겹치는 용도일 뿐 속도는 --rate가 잡는다")
    parser.add_argument("--max-calls", type=int, default=0, help="0이면 무제한. 일일 한도 보호용")
    parser.add_argument("--retry-errors", action="store_true", help="이전에 실패한 지번도 다시 시도")
    parser.add_argument("--probe", action="store_true",
                        help="지번 하나만 호출하고 원 응답을 그대로 출력한 뒤 종료 (진단용)")
    args = parser.parse_args()

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY 환경 변수가 없습니다.", file=sys.stderr)
        return 2
    if "%" in key:
        key = urllib.parse.unquote(key)

    lawd_filter = [c.strip() for c in args.lawd.split(",") if c.strip()]
    for code in lawd_filter:
        if code not in SEOUL_LAWD_CODES:
            print(f"알 수 없는 자치구 코드: {code}", file=sys.stderr)
            return 2

    # 진단 모드. 대량 실행 전에 엔드포인트/파라미터가 맞는지 30초 안에 확인한다.
    if args.probe:
        plan = targets(args.rt_db, lawd_filter)
        if not plan:
            print("조회 대상이 없습니다.", file=sys.stderr)
            return 2
        target = plan[0]
        print(f"대상: {target[5]} {int(target[3])}-{int(target[4])} "
              f"(sigunguCd={target[0]} bjdongCd={target[1]} platGbCd={target[2]})\n")
        session = requests.Session()
        for url in ENDPOINTS:
            print(f"--- {url}")
            try:
                res = session.get(url, timeout=20, params={
                    "serviceKey": key, "sigunguCd": target[0], "bjdongCd": target[1],
                    "platGbCd": target[2], "bun": target[3], "ji": target[4],
                    "numOfRows": 5, "pageNo": 1, "_type": "xml",
                })
                print(f"HTTP {res.status_code} · {len(res.content):,}바이트")
                print(res.text[:1200])
            except Exception as exc:
                print(f"요청 실패: {describe(exc, limit=600)}")
            print()
        return 0

    conn = sqlite3.connect(args.db)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")

    done_query = "SELECT lawd_cd, bjdong_cd, plat_gb, bun, ji FROM bldg_log"
    if not args.retry_errors:
        done_query += " WHERE status <> 'error'"
    done = {tuple(r) for r in conn.execute(done_query)}

    plan = [t for t in targets(args.rt_db, lawd_filter) if t[:5] not in done]
    print(f"조회 대상 {len(plan):,}건 (완료 {len(done):,}건)")
    if not plan:
        print("모두 수집 완료된 상태입니다.")
        return 0
    if args.max_calls and len(plan) > args.max_calls:
        # 미리 잘라 두면 루프 안에서 중단 조건을 볼 필요가 없다
        print(f"--max-calls({args.max_calls:,})만큼만 받습니다. 나머지는 다음 실행이 이어받습니다.")
        plan = plan[:args.max_calls]

    endpoint_idx = [0]
    calls = inserted = empty = errors = streak = 0
    started = time.monotonic()
    now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    throttle = Throttle(args.rate)
    print(f"워커 {args.workers}개 · 초당 {args.rate}건 상한으로 시작", flush=True)

    try:
        for target, items, exc in results(plan, key, endpoint_idx, args.workers, throttle):
            calls += 1
            gu = SEOUL_LAWD_CODES.get(target[0], target[0])
            if isinstance(exc, FatalApiError):
                print(f"치명적 오류로 중단: {exc}", file=sys.stderr)
                print("공공데이터포털에서 '국토교통부_건축물대장정보 서비스'(건축HUB) "
                      "활용신청이 되어 있는지 확인하세요.", file=sys.stderr)
                conn.commit()
                return 1
            if exc is not None:
                errors += 1
                streak += 1
                detail = describe(exc)
                conn.execute("INSERT OR REPLACE INTO bldg_log VALUES (?,?,?,?,?,?,?,?,?)",
                             (*target[:5], 0, "error", detail[:300], now()))
                conn.commit()
                if errors <= 5 or errors % 25 == 0:
                    print(f"  실패 {errors}: {gu} {target[3]}-{target[4]} — {detail}", flush=True)
                if streak >= MAX_CONSECUTIVE_FAILURES:
                    print(f"\n{streak}건 연속 실패로 중단합니다. 마지막 오류:\n  {detail}",
                          file=sys.stderr)
                    print("429가 계속되면 --rate를 낮추세요. 접속 자체가 안 되는 것 같으면 "
                          "--probe로 한 건만 쏴서 응답이 오는지 확인하세요.", file=sys.stderr)
                    break
                continue
            streak = 0
            eased = throttle.reward()
            if eased:
                print(f"  조용해서 간격을 {eased:.2f}초로 되돌립니다", flush=True)

            fetched_at = now()
            rows = [to_row(it, target, fetched_at) for it in items]
            if rows:
                conn.executemany(INSERT_SQL, rows)
                inserted += len(rows)
            else:
                empty += 1
            conn.execute("INSERT OR REPLACE INTO bldg_log VALUES (?,?,?,?,?,?,?,?,?)",
                         (*target[:5], len(rows), "ok" if rows else "empty", None, fetched_at))
            # 초반 20건은 매건, 이후 25건마다. 건당 속도와 실패율이 바로 보여야
            # 느린 것인지 재시도로 헛도는 것인지 실행 중에 판단할 수 있다.
            if calls <= 20 or calls % 25 == 0:
                conn.commit()
                per = (time.monotonic() - started) / calls
                print(f"[{calls}/{len(plan)}] {gu} {target[5]} {target[3]}-{target[4]} "
                      f"{len(rows)}동 | 누적 {inserted:,}동 "
                      f"빈{empty:,} 실패{errors:,} | 건당 {per:.2f}초", flush=True)
    except KeyboardInterrupt:
        print("\n중단됨. 재실행하면 이어서 받습니다.")
    finally:
        conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    print(f"\n완료. 이번 실행 {calls:,}회 호출, {inserted:,}동 적재 "
          f"(빈응답 {empty:,} / 실패 {errors:,}). DB 총 {total:,}동")
    if inserted:
        print("\n구조 분포 상위:")
        for strct, n in conn.execute(
            "SELECT strct, COUNT(*) FROM buildings WHERE strct <> '' "
            "GROUP BY strct ORDER BY 2 DESC LIMIT 6"
        ):
            print(f"  {strct}: {n:,}")
    conn.close()
    # 한 건도 못 받았는데 성공으로 끝내면 다음 실행이 같은 실패를 반복한다
    if calls and not inserted:
        print("한 건도 적재하지 못했습니다.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
