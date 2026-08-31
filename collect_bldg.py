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

from collect import (FATAL_CODES, QUOTA_CODE, SUCCESS_CODES, FatalApiError,
                     QuotaExhausted, _clean, _to_float, _to_int)
from lawd_codes import LAWD_CODES
from scrub import describe, scrub

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

CREATE TABLE IF NOT EXISTS bldg_meta (
    k TEXT PRIMARY KEY,
    v TEXT
);

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


def load_bjdong_map(path: str) -> dict[tuple[str, str], str]:
    """fetch_bjdong.py가 만든 공식 법정동 매핑. 없으면 빈 dict로 살고 payload가 대신한다."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    out = {}
    for lawd, umds in raw.items():
        for name, cd in umds.items():
            out[(lawd, name)] = cd
    print(f"법정동코드 공식 매핑 사용: {len(out)}개 동 ({path})")
    return out


def targets(rt_db: str, lawd_filter: list[str], bjdong_map: dict | None = None) -> list[tuple]:
    """실거래가 DB에서 조회 대상 지번을 뽑고, 법정동코드를 붙인다.

    법정동코드(umdCd)는 payload에서 얻는다. 처음에는 아파트 매매(apt_trade)에서만
    얻었는데, 그러면 아파트 '매매' 신고가 없는 동(정동·순화동·낙원동 같은 도심
    옛 동네)이 통째로 빠진다. 미매핑의 98.2%가 그 경우였고, 아파트 매매가 없는
    동네일수록 연립·다세대 전세의 위험을 봐야 하는 곳이라 빠진 쪽이 더 위험한
    쪽이었다. 그래서 소스를 가리지 않고 umdCd를 실은 payload 전부에서 모은다.
    """
    conn = sqlite3.connect(rt_db)
    # 공식 코드표가 있으면 그걸 기준으로 삼는다. 신고가 한 건도 없는 동까지 커버되고,
    # payload 값과 다르면 공식 쪽이 맞다. payload는 코드표에 없는 이름의 대비책으로 남긴다.
    umd_cd: dict[tuple[str, str], str] = dict(bjdong_map or {})
    payload_cd: dict[tuple[str, str], str] = {}
    # LIKE로 먼저 거르면 umdCd가 없는 소스의 행은 JSON 해석 없이 지나가고,
    # DISTINCT라 (동, 코드) 조합당 한 번만 받는다.
    for sgg, umd, cd in conn.execute(
        """
        SELECT DISTINCT json_extract(payload, '$.sggCd'),
                        json_extract(payload, '$.umdNm'),
                        json_extract(payload, '$.umdCd')
        FROM transactions WHERE payload LIKE '%umdCd%'
        """
    ):
        sgg, umd, cd = _clean(sgg), _clean(umd), _clean(cd)
        if sgg and umd and cd:
            payload_cd[(sgg, umd)] = cd
    # 공식 코드와 payload 코드가 다른 동은 done 키가 어긋나 재조회되고, 구코드로
    # 이미 적재된 buildings 행이 남아 조인에서 이중 계상될 수 있다. 0이 아니면
    # 구코드 행 정리를 설계해야 하므로, 실측치를 매 실행 로그에 남긴다.
    mismatch = [k for k, cd in payload_cd.items() if k in umd_cd and umd_cd[k] != cd]
    if bjdong_map:
        print(f"공식·payload 법정동코드 불일치: {len(mismatch)}건"
              + (f" (예: {sorted(mismatch)[:5]})" if mismatch else ""))
    for k, cd in payload_cd.items():
        umd_cd.setdefault(k, cd)

    rows, bad_jibun = [], 0
    unmapped: set[tuple[str, str]] = set()
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
        if not cd:
            unmapped.add((lawd, umd))
            continue
        parsed = parse_jibun(jibun)
        if not parsed:
            bad_jibun += 1
            continue
        rows.append((lawd, cd, *parsed, umd))
    conn.close()
    if unmapped:
        # "제외 N건"이라는 숫자만 찍으면 어느 동네가 빠졌는지 아무도 모른다.
        # 이름을 찍어야 다음 감사가 이 목록에서 시작할 수 있다.
        names = sorted(f"{LAWD_CODES.get(l, l)} {u or '(빈 동명)'}" for l, u in unmapped)
        print(f"공식 코드표에도 payload에도 없어 제외된 법정동 {len(names)}곳:")
        for name in names:
            print(f"  {name}")
    if bad_jibun:
        print(f"지번 파싱 실패로 제외: {bad_jibun:,}건")
    return sorted(set(rows))


# 인증키 가리기(SECRET_RE·describe)는 scrub.py에 있다. 여기 있던 패턴은
# serviceKey=만 잡아서 key=(VWorld)·confmKey=(juso)를 놓쳤다.

# 연속 실패가 이만큼 쌓이면 중단한다. 없으면 100% 실패 상태로 5시간을 돌다
# 타임아웃한다 — 실제로 한 시간을 그렇게 버렸다. 시작 전 preflight가 한 건을
# 먼저 확인하므로 여기까지 오는 경우는 도중에 차단당한 때뿐이다.
MAX_CONSECUTIVE_FAILURES = 15


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


class Requests:
    """실제로 나간 HTTP 요청 수.

    bldg_log는 지번당 한 행이라 쿼터와 눈금이 다르다. 실패 1건은 재시도까지
    최대 4요청이고, 사전 확인은 최대 3요청을 쓰면서 행을 아예 안 남긴다.
    8/31에 중복 방지 가드를 두 판 짰다가 둘 다 접었는데, 다시 짜려면 "회차가
    쿼터를 얼마나 썼는가"를 알아야 하고 지금은 그 값을 아무도 안 세고 있다.
    여기서부터 재 둔다. 동작은 안 바꾼다.

    한 군데는 못 남는다. 사전 확인에서 막혀 끝나는 회차는 수집 루프의
    try/finally에 들어가기 전에 돌아가므로 bldg_meta에 안 찍힌다. 그 회차가
    쓰는 것은 최대 3요청이고 발행도 안 하므로 지금은 감수한다. 로그에는
    남으니 나중에 세야 하면 거기서 세면 된다.
    """

    def __init__(self) -> None:
        self.n = 0
        self.lock = threading.Lock()

    def hit(self) -> None:
        with self.lock:
            self.n += 1


REQUESTS = Requests()


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
            REQUESTS.hit()
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
            if code == QUOTA_CODE:
                raise QuotaExhausted(f"[{code}] {msg}")
            res.raise_for_status()
            if code and code not in SUCCESS_CODES:
                raise RuntimeError(f"API 오류 [{code}] {msg}")
            return items
        except (FatalApiError, QuotaExhausted):
            raise
        except requests.exceptions.ConnectionError as exc:
            # 접속 자체가 안 되는 상태에서 네 번 더 두드려 봐야 15초씩 버릴 뿐이다.
            # 한도를 넘겨 차단당하면 429가 아니라 이 모양으로 온다.
            last = exc
            if attempt >= 1:
                break
            time.sleep(1)
        except Exception as exc:
            last = exc
            if attempt == 0 and len(ENDPOINTS) > 1:
                endpoint_idx[0] += 1     # 첫 실패에서 엔드포인트를 바꿔 본다
            time.sleep(min(1.5**attempt, 4) + random.uniform(0, 0.3))
    raise RuntimeError(f"{max_retries}회 실패: {describe(last)}")


# 사전 확인 재시도. 한 번 두드려 보고 포기하면 하루치 실행(수천 건)을 통째로
# 버린다. 실측(2026-08-15~17): 일일 크론 세 번이 모두 preflight ConnectTimeout
# 한 번으로 죽었다.
#
# 오래 기다리지 않는다. 한때 여기 "실패한 크론과 그 뒤 통과한 수동 실행의 간격이
# 15분, 57분이었다"는 관측을 회복 시간으로 읽고 15분씩 네 번을 기다렸다. 그
# 해석이 틀렸다는 것을 2026-08-25 정찰이 보였다. 한 러너에서 실거래 여섯 서비스와
# 이 대장까지 일곱이 전부 ConnectTimeout인 그 시각에, 다른 러너의 대장 크론은
# 정상으로 수집하고 있었다. 같은 호스트, 같은 인증키, 같은 시각인데 러너 IP만
# 달랐다. 차단은 IP에 걸린다.
#
# 그러면 그 "회복"은 시간이 아니라 새 잡이 새 IP를 뽑은 것이었다. 수동 실행은
# 늘 새 잡이다. 같은 잡에서 기다리는 것은 IP가 그대로라 값이 없으므로 빨리
# 접는다. 최악 약 3분이다(20초 시도 3회 + 60초 간격 2회). 실거래 수집기와 같은
# 정책이다(collect.py PREFLIGHT_*). 여기서 접어도 받은 게 0건이라 잃을 진행분은
# 없고, 다음 날 크론이 새 IP로 받는다.
PREFLIGHT_TRIES = 3
PREFLIGHT_GAP = 60


def preflight(key: str, target: tuple, endpoint_idx: list[int]) -> str | None:
    """본 수집 전에 한 건만 쏴 본다. 막혀 있으면 오류 설명을, 되면 None을 낸다.

    한도를 넘겨 차단당한 상태에서 그냥 시작하면 25건을 10분에 걸쳐 버린 뒤에야
    멈춘다. 실제로 그렇게 한 번 버렸다.
    """
    last: Exception | None = None
    for i in range(PREFLIGHT_TRIES):
        try:
            fetch(requests.Session(), key, target, endpoint_idx, max_retries=1, timeout=20)
            if i:
                print(f"  사전 확인 {i + 1}번째에 통과했습니다")
            return None
        except (FatalApiError, QuotaExhausted):
            raise            # 키와 쿼터 문제는 기다려도 안 풀린다. 즉시 알린다.
        except Exception as exc:
            # 엔드포인트는 돌리지 않는다. fetch가 이미 첫 실패에서 돌리고,
            # 여기서 또 올리면 엔드포인트가 둘 이상이 되는 날 시도마다 +2가 되어
            # 같은 곳에 고정된다. 지금은 ENDPOINTS가 하나라 어차피 무동작이다.
            last = exc
            if i < PREFLIGHT_TRIES - 1:
                # 자르지 않는다. 1·2회차 예외는 여기 말고 어디에도 안 남는데,
                # 앞 60자는 "1회 실패:" 접두사가 먹어서 원인 꼬리가 사라진다.
                # 쿼터인지 혼잡인지를 로그로 가릴 수 있어야 다음 판단이 선다.
                print(f"  사전 확인 {i + 1}회 실패: {describe(exc)}")
                print(f"  {PREFLIGHT_GAP // 60}분 뒤 다시 확인합니다")
                time.sleep(PREFLIGHT_GAP)
    return describe(last)


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
    parser.add_argument("--bjdong-map", default="bjdong.json",
                        help="fetch_bjdong.py 산출물. 없으면 payload 매핑만 쓴다")
    parser.add_argument("--db", default="bldg.sqlite")
    parser.add_argument("--lawd", default="", help="자치구 코드 제한 (쉼표 구분)")
    parser.add_argument("--rate", type=float, default=1.0,
                        help="초당 호출 수 상한. 429를 맞으면 여기서 더 느려진다")
    parser.add_argument("--workers", type=int, default=2,
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
        if code not in LAWD_CODES:
            print(f"알 수 없는 자치구 코드: {code}", file=sys.stderr)
            return 2

    # 진단 모드. 대량 실행 전에 엔드포인트/파라미터가 맞는지 30초 안에 확인한다.
    if args.probe:
        plan = targets(args.rt_db, lawd_filter, load_bjdong_map(args.bjdong_map))
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
                # 인증키를 되비쳐 주는 응답이 있다. 자르기 전에 가려야
                # 키가 절단면에 걸쳐도 안 샌다.
                print(scrub(res.text)[:1200])
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

    plan = [t for t in targets(args.rt_db, lawd_filter, load_bjdong_map(args.bjdong_map))
            if t[:5] not in done]
    print(f"조회 대상 {len(plan):,}건 (완료 {len(done):,}건)")
    # 잔여를 남긴다. 화면이 "대장이 며칠 멈췄다"를 말할 때 이 값이 0이면 멈춘
    # 것이 아니라 다 받은 것이다. 둘을 못 가르면 완주하는 날부터 없는 장애를
    # 매일 알리게 된다.
    #
    # 여기서 쓰는 것은 회차가 죽었을 때 남는 보수적인 바닥값이다. 진짜 값은
    # 루프가 끝난 뒤 write_remaining()이 다시 센다. 시작값만 남기면 안 되는
    # 이유가 있다. 마지막 수집 회차는 잔여 N으로 시작해 N건을 다 받고 끝나므로
    # N을 남긴다. 0은 그 다음 회차가 써야 하는데, 그 회차는 계획이 비어 한 행도
    # 안 늘리고, buildings.yml의 발행 가드가 "새로 적재된 동도 새로 조회한
    # 지번도 없으면 자산을 그대로 둔다"이므로 그 0은 러너와 함께 사라진다.
    # 영원히. 게다가 실거래가 매주 새 지번을 얹어 잔여가 다시 생기므로, 화면은
    # 주 나흘씩 "며칠째 새로 받은 것이 없습니다"를 거짓으로 말하게 된다(CTO).
    # 끝에 다시 세면 마지막 수집 회차가 0을 쓰면서 동시에 행을 늘려 가드를
    # 통과한다.
    plan_all = plan                       # --max-calls로 자르기 전. 끝에 다시 셀 때 쓴다.
    # 구를 골라 도는 회차는 이 값을 안 건드린다. 잔여는 전국 기준 한 칸인데
    # --lawd 11110 회차가 그 구를 다 받고 0을 쓰면, 경기 7만 지번이 남은 채로
    # 화면이 "다 받았다"로 읽어 지연을 영영 안 말한다. 다음 밤 회차가 다시
    # 덮어 저절로 낫지만, 그 사이가 조용한 거짓이라 애초에 안 쓴다.
    scoped = bool(lawd_filter)
    def stamp(left: int) -> None:
        if scoped:
            return
        conn.executemany(
            "INSERT OR REPLACE INTO bldg_meta (k, v) VALUES (?,?)",
            [("remaining", str(left)),
             # 이 회차가 실제로 쓴 요청 수. 화면은 안 읽는다. 중복 방지 가드를
             # 다시 짤 때 쓸 눈금을 모으는 자리다(Requests 주석 참고).
             ("requests", str(REQUESTS.n)),
             # ran_at은 지금 아무도 안 읽는다. 진단용으로만 남긴다. 화면이 쓰는 시각은
             # 이것이 아니라 bldg_log.fetched_at이다(bldg_join.state 주석 참고).
             ("ran_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))])

    # 잔여를 셀 때는 --retry-errors와 무관하게 늘 error를 미완료로 본다.
    # 그 플래그를 주면 done_query에서 이 조건이 빠지는데, 그대로 쓰면 한 동도
    # 못 받고 에러만 남긴 회차가 "다 받았다"로 0을 쓴다. 그러면 bldgLate가
    # 영영 침묵한다. 화면이 쓰는 시각(state의 at)도 error를 빼고 재므로 둘의
    # 기준을 맞춘다.
    left_query = ("SELECT lawd_cd, bjdong_cd, plat_gb, bun, ji FROM bldg_log "
                  "WHERE status <> 'error'")

    def write_remaining() -> None:
        """이번 회차가 끝난 뒤의 진짜 잔여를 센다.

        산술로 빼지 않고 질의를 다시 돌린다. 다음 회차가 계획을 세우는 방식과
        글자 그대로 같아야, 화면이 말하는 "다 받았다"와 수집기가 보는 "다
        받았다"가 안 어긋난다.
        """
        after = {tuple(r) for r in conn.execute(left_query)}
        stamp(sum(1 for t in plan_all if t[:5] not in after))
        conn.commit()

    stamp(len(plan))
    conn.commit()
    if not plan:
        print("모두 수집 완료된 상태입니다.")
        conn.close()
        return 0
    if args.max_calls and len(plan) > args.max_calls:
        # 미리 잘라 두면 루프 안에서 중단 조건을 볼 필요가 없다
        print(f"--max-calls({args.max_calls:,})만큼만 받습니다. 나머지는 다음 실행이 이어받습니다.")
        plan = plan[:args.max_calls]

    endpoint_idx = [0]
    calls = inserted = empty = errors = streak = 0
    quota_hit = False
    aborted = False   # 연속 실패로 계획을 포기했는가
    now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        blocked = preflight(key, plan[0], endpoint_idx)
    except QuotaExhausted as exc:
        # 첫 호출부터 한도면 오늘은 받을 게 없다. 실패가 아니라 정상 종료다.
        print(f"사전 확인에서 오늘 한도 소진 확인 ({scrub(exc)}). 다음 실행이 이어받습니다.")
        conn.close()
        return 0
    except FatalApiError as exc:
        print(f"사전 확인에서 치명적 오류: {scrub(exc)}", file=sys.stderr)
        conn.close()
        return 1
    # 건당 속도(per)의 기준. 사전 확인 뒤에 잡는다. 사전 확인이 최대 약 3분을
    # 쓰는데 그게 초반 호출에 분산되면, 실행 중에 "느린 것인지 재시도로 헛도는
    # 것인지"를 보려고 쓰는 지표가 통째로 못 쓰게 된다.
    started = time.monotonic()
    if blocked:
        print(f"사전 확인 실패 — 지금은 접속이 안 됩니다:\n  {blocked}", file=sys.stderr)
        print("차단은 IP 단위입니다(2026-08-25 정찰로 확정). 같은 잡에서 기다려도 "
              "안 풀리므로, 시간을 두는 것이 아니라 새 잡으로 다시 거세요.",
              file=sys.stderr)
        conn.close()
        return 1
    throttle = Throttle(args.rate)
    print(f"사전 확인 통과. 워커 {args.workers}개 · 초당 {args.rate}건 상한으로 시작", flush=True)

    try:
        for target, items, exc in results(plan, key, endpoint_idx, args.workers, throttle):
            calls += 1
            gu = LAWD_CODES.get(target[0], target[0])
            if isinstance(exc, QuotaExhausted):
                # 한도를 다 쓴 것은 실패가 아니다. 여기까지 저장하고 정상 종료한다.
                print(f"\n오늘 한도를 다 썼습니다 ({scrub(exc)}). 다음 실행이 이어받습니다.", flush=True)
                quota_hit = True
                break
            if isinstance(exc, FatalApiError):
                print(f"치명적 오류로 중단: {scrub(exc)}", file=sys.stderr)
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
                    aborted = True
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
        write_remaining()

    total = conn.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    # 지번 수와 요청 수를 갈라 적는다. 예전에는 calls를 "회 호출"이라고 찍었는데
    # 그것은 조회한 지번 수이지 쿼터를 쓴 요청 수가 아니다. 쿼터를 논할 때 쓰는
    # 눈금은 아래 요청 수다.
    print(f"\n완료. 이번 실행 지번 {calls:,}건, 요청 {REQUESTS.n:,}회, "
          f"{inserted:,}동 적재 (빈응답 {empty:,} / 실패 {errors:,}). "
          f"DB 총 {total:,}동")
    if inserted:
        print("\n구조 분포 상위:")
        for strct, n in conn.execute(
            "SELECT strct, COUNT(*) FROM buildings WHERE strct <> '' "
            "GROUP BY strct ORDER BY 2 DESC LIMIT 6"
        ):
            print(f"  {strct}: {n:,}")
    conn.close()
    # 연속 실패 중단은 오류율과 무관하게 그 자체로 실패다. 비율 가드에 맡기면
    # 이미 성공을 쌓아 둔 실행에서 errors가 상한(연속 실패 수)으로 고정돼 20%
    # 아래로 떨어지고, 계획을 포기했는데 초록불이 된다 (collect.py와 같은 구멍).
    if aborted:
        left = len(plan) - calls
        print(f"::error::연속 실패로 {calls:,}/{len(plan):,}건에서 중단했습니다. "
              f"{left:,}건을 받지 못했습니다. 원인이 해소되면 재실행하세요.")
        return 1
    # 오류 회계가 쿼터의 정상 종료보다 먼저다. 429 폭풍으로 20%를 넘긴 실행이
    # 쿼터 소진과 겹쳤다고 초록으로 끝나면 안 된다 (collect.py와 같은 원칙).
    # 표본이 작을 때의 헛 빨간불은 최소 호출 수 50으로 거른다.
    if calls >= 50 and errors > calls * 0.20:
        print(f"실패가 {errors}/{calls}건 ({errors / calls:.0%})으로 20%를 넘습니다. "
              "결과를 신뢰할 수 없어 실패로 종료합니다.", file=sys.stderr)
        return 1
    # 쿼터 소진은 실패가 아니다. 첫 호출부터 한도였으면 calls=1, inserted=0이라
    # 아래 검사에 걸려 빨간불이 되는데, 그건 내일 이어받으면 되는 정상 상태다.
    if quota_hit:
        return 0
    # 한 건도 못 받았는데 성공으로 끝내면 다음 실행이 같은 실패를 반복한다
    if calls and not inserted:
        print("한 건도 적재하지 못했습니다.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
