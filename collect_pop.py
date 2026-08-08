#!/usr/bin/env python3
"""행정안전부 주민등록 인구·세대현황을 받아 data/pop.json으로 굽는다.

쓰임새는 시세 탭의 세대수 추이 카드다. 깡통의 기제는 "수요가 마르면 매매가
마르고, 매매가 마르면 반환 여력 검증이 안 된다"인데, 세대수 추이는 그 감소가
일시적 관망인지 구조적 수요 이탈인지 가르는 배경 지표다. 구 단위 스칼라만
쓰므로 물건 리포트에는 붙이지 않는다(구 통계는 개별 물건 위험을 말하지 않는다).

소스는 법정동별(행정동 통반단위) 주민등록 인구 및 세대현황 오픈API다
(공공데이터포털 15108071, 자동승인). 법정동 기준이라 우리 키와 안분 없이
맞는다는 것이 채택 이유다. 같은 data.go.kr 키(MOLIT_SERVICE_KEY)를 쓰되
활용신청이 따로 필요하다.

주의: 이 API의 파라미터·필드 표기는 문서 접근이 막힌 환경에서 작성해
후보를 순차 시도한다. 표기가 전부 어긋나면 원 응답 앞부분을 (키를 가린 채)
로그로 남기고 실패한다. 그 로그가 다음 수정의 명세다. ECOS 항목 코드를
같은 방식(실행 로그 검증)으로 확정한 전례가 있다.

사용법
    MOLIT_SERVICE_KEY=... python collect_pop.py --out data/pop.json
    MOLIT_SERVICE_KEY=... python collect_pop.py --probe   # 원 응답 확인
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

from lawd_codes import LAWD_CODES
from scrub import scrub

BASE = "https://apis.data.go.kr/1741000/stdgPpltnHhStus/selectStdgPpltnHhStus"

# 파라미터 표기 후보. 첫 실전에서 확인된 사실: 활용신청은 유효하고(JSON 응답),
# 오류는 NO_MANDATORY_REQUEST_PARAMETERS_ERROR였다. 즉 필수 파라미터 이름이
# 문제다. 행안부 주민등록 API 가족의 관례(기간 srchFrYm/srchToYm 또는 단월,
# 레벨 lv, 등록구분 regSeCd, 캐멀·스네이크 혼재)를 조합으로 전부 시도한다.
# 오류 응답이 head.resultMsg로 즉시 오므로 조합당 1행 호출이면 판별된다.
def _styles() -> list[dict]:
    out = []
    for nm in (
        {"fr": "srchFrYm", "to": "srchToYm", "code": "stdgCd", "lv": "lv", "reg": "regSeCd"},
        {"fr": "srch_fr_ym", "to": "srch_to_ym", "code": "stdg_cd", "lv": "lv", "reg": "reg_se_cd"},
        {"one": "statsYm", "code": "stdgCd", "lv": "lv", "reg": "regSeCd"},
        {"one": "stats_ym", "code": "stdg_cd", "lv": "lv", "reg": "reg_se_cd"},
    ):
        # 등록구분이 필수인 배포가 있다. 1이 거주자 구분이라는 가정까지 시도한다.
        for reg_val in (None, "1"):
            out.append({**nm, "reg_val": reg_val})
    return out


PARAM_STYLES = _styles()

# 응답 필드 후보. (법정동코드, 총인구수, 세대수)를 찾는다.
CODE_KEYS = ("stdgCd", "stdg_cd", "lgdngCd", "bjdCd", "stdgcd")
POP_KEYS = ("totNmprCnt", "tot_nmpr_cnt", "totPpltnCnt", "totPpltn", "ppltn", "totLvpopCnt")
HH_KEYS = ("hhCnt", "hh_cnt", "totHhCnt", "sedaeCnt", "hoCnt")


_WRAP_KEYS = ("Response", "response", "body", "items", "item", "row")


def _rows(body: object) -> list[dict]:
    """응답 어디에 행이 실렸든 꺼낸다. 포털 프록시는 포장 방식이 서비스마다 다르다.

    head 블록(totalCount 등 메타)은 절대 데이터 행으로 반환하면 안 된다.
    StanReginCd형 [{head:[...]},{row:[...]}]에서 head를 먼저 파고들면 메타를
    행이라고 돌려주게 되므로, head는 건너뛰고 row류 키를 먼저 찾는다.
    """
    if isinstance(body, dict):
        for key in _WRAP_KEYS:
            if key in body:
                found = _rows(body[key])
                if found:
                    return found
        for k, v in body.items():
            if k == "head":
                continue
            if isinstance(v, list):
                found = _rows(v)
                if found:
                    return found
    if isinstance(body, list):
        dicts = [x for x in body if isinstance(x, dict)]
        # 전부 dict인 배열이면서 데이터 행처럼 생겼으면 그대로 행이다
        leaf = [x for x in dicts if not any(k in x for k in ("head", "row", "items"))]
        if leaf and len(leaf) == len(dicts):
            return leaf
        # 블록 배열이면 row류 키를 가진 블록부터. head 블록은 마지막에도 안 판다.
        for x in dicts:
            if any(k in x for k in _WRAP_KEYS):
                found = _rows(x)
                if found:
                    return found
    return []


def _pick(row: dict, keys: tuple[str, ...]) -> str | None:
    for k in keys:
        if k in row:
            return str(row[k]).strip()
    lower = {k.lower(): v for k, v in row.items()}
    for k in keys:
        if k.lower() in lower:
            return str(lower[k.lower()]).strip()
    return None


def fetch_page(key: str, style: dict, ym: str, code: str, page: int,
               rows: int = 1000, level: int = 3) -> tuple[list[dict], str]:
    qs = {
        "serviceKey": key, "type": "JSON",
        "pageNo": page, "numOfRows": rows,
        style["lv"]: level,                  # 3이 법정동(읍면동), 2가 시군구 레벨 가정
    }
    if "one" in style:
        qs[style["one"]] = ym
    else:
        qs[style["fr"]] = ym
        qs[style["to"]] = ym
    if style.get("reg_val") is not None:
        qs[style["reg"]] = style["reg_val"]
    if code:
        qs[style["code"]] = code
    url = f"{BASE}?{urllib.parse.urlencode(qs)}"
    req = urllib.request.Request(url, headers={"User-Agent": "estate-pj"})
    with urllib.request.urlopen(req, timeout=30) as res:
        text = res.read().decode("utf-8")
    if not text.lstrip().startswith(("{", "[")):
        # 활용신청 전이거나 파라미터 오류면 XML이 온다
        return [], text
    try:
        return _rows(json.loads(text)), text
    except ValueError:
        return [], text


def month_list(n: int) -> list[str]:
    """지난달부터 거슬러 n개월. 이번 달은 말일 집계가 아직 없다."""
    y, m = date.today().year, date.today().month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(f"{y}{m:02d}")
    return list(reversed(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/pop.json")
    ap.add_argument("--months", type=int, default=36)
    ap.add_argument("--probe", action="store_true", help="한 페이지만 받아 원 응답을 출력")
    ap.add_argument("--sleep", type=float, default=0.15)
    args = ap.parse_args()

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY가 없습니다.", file=sys.stderr)
        return 1
    if "%" in key:
        key = urllib.parse.unquote(key)

    last_ym = month_list(1)[0]

    if args.probe:
        for style in PARAM_STYLES:
            print(f"--- 표기 {style}")
            try:
                rows, raw = fetch_page(key, style, last_ym, "11110", 1, rows=5)
            except Exception as exc:
                print(f"요청 실패: {scrub(exc)}")
                continue
            print(f"행 {len(rows)}개")
            print(scrub(raw)[:1500])
            print()
        return 0

    # 표기 확정: 첫 요청이 행을 돌려주는 조합을 쓴다. 전멸하면 조합별 응답을
    # 전부 남긴다. 그 목록이 곧 다음 수정의 명세다.
    style = None
    attempts: list[str] = []
    for cand in PARAM_STYLES:
        label = f"{cand.get('one') or cand['fr']}/reg={cand.get('reg_val')}"
        try:
            rows, raw = fetch_page(key, cand, last_ym, "11110", 1, rows=5)
        except Exception as exc:
            attempts.append(f"{label}: 요청 실패 {scrub(exc)}"[:200])
            continue
        if rows:
            style = cand
            print(f"파라미터 표기 확정: {label}")
            break
        attempts.append(f"{label}: {scrub(raw)[:200]}")
    if style is None:
        print("어느 파라미터 조합으로도 행을 받지 못했습니다. 활용신청(공공데이터포털 "
              "15108071) 여부를 확인하고, 아래 조합별 응답으로 표기를 맞추세요.", file=sys.stderr)
        for a in attempts:
            print(f"  {a}", file=sys.stderr)
        return 1

    # 필드 확정: 표본 행에서 코드·인구·세대 필드를 찾는다. 못 찾으면 행을 보여주고 멈춘다.
    sample_rows, _ = fetch_page(key, style, last_ym, "11110", 1, rows=5)
    sample = sample_rows[0]
    if not (_pick(sample, CODE_KEYS) and _pick(sample, POP_KEYS) and _pick(sample, HH_KEYS)):
        print("응답 필드명이 후보와 다릅니다. 표본 행:", file=sys.stderr)
        print(scrub(json.dumps(sample, ensure_ascii=False))[:600], file=sys.stderr)
        return 1
    # code 필터가 안 먹는 표기면 전국 행을 받아 프리픽스로 거르게 된다. 숫자는
    # 맞지만 호출이 수십 배가 되므로, 표기를 로그에 드러내 고칠 수 있게 한다.
    stray = [cd for cd in ((_pick(r, CODE_KEYS) or "") for r in sample_rows)
             if cd and not cd.startswith("11110")]
    if stray:
        print(f"주의: code 파라미터가 무시되는 표기입니다 (표본에 타 지역 코드 {stray[:3]}). "
              "정확성은 프리픽스 필터가 지키지만 호출 비용이 큽니다.", file=sys.stderr)

    months = month_list(args.months)
    sggs = sorted(LAWD_CODES)
    # series[lawd][ym] = [인구, 세대]
    series: dict[str, dict[str, list[int]]] = {c: {} for c in sggs}

    # 증분 수집. 이미 받은 (구, 월)은 건너뛰되 최근 2개월은 다시 받는다
    # (말일 집계 확정 전에 받은 값이 남아 있을 수 있다). 첫 실행만 전 구간이고
    # 이후 주간 실행은 70개 시군구 × 한두 달 수준이다. 발행본에 더해, 가드에
    # 막혀 발행 못 한 부분 진행(partial)도 이어받는다. 안 그러면 일일 한도가
    # 백필 규모보다 작을 때 매주 처음부터 받다 매주 실패하는 영구 루프가 된다.
    fresh = set(months[-2:])
    partial_path = f"{args.out}.partial"
    for src_path in (args.out, partial_path):
        if not os.path.exists(src_path):
            continue
        try:
            with open(src_path, encoding="utf-8") as fh:
                prev = json.load(fh).get("series", {})
            for c in sggs:
                for ym, v in prev.get(c, {}).items():
                    if ym in months and ym not in fresh:
                        series[c][ym] = v
        except Exception as exc:
            print(f"{src_path}을 읽지 못해 그 몫은 다시 받습니다: {scrub(exc)}")

    for ym in months:
        for code in sggs:
            if ym in series[code]:
                continue
            acc_p = acc_h = 0
            got = False
            page = 1
            while True:
                rows, raw = fetch_page(key, style, ym, code, page)
                if not rows:
                    if page == 1 and raw and not raw.lstrip().startswith(("{", "[")):
                        print(f"{ym} {code}: 비정상 응답 {scrub(raw)[:160]}", file=sys.stderr)
                    break
                for r in rows:
                    cd = _pick(r, CODE_KEYS) or ""
                    if cd and not cd.startswith(code):
                        continue          # 필터가 안 먹는 표기면 프리픽스로 거른다
                    p, h = _pick(r, POP_KEYS), _pick(r, HH_KEYS)
                    # 빈 문자열은 0이 아니라 결측이다. 0으로 합산해 [0,0]을 저장하면
                    # 차트가 "세대 0"이라는 조용한 거짓말을 그린다.
                    if p in (None, "") or h in (None, ""):
                        continue
                    acc_p += int(float(p.replace(",", "")))
                    acc_h += int(float(h.replace(",", "")))
                    got = True
                if len(rows) < 1000:
                    break
                page += 1
                time.sleep(args.sleep)
            if got:
                series[code][ym] = [acc_p, acc_h]
            time.sleep(args.sleep)

    def _dump(path: str, payload: dict) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    payload = {"asof": last_ym, "source": "행정안전부 주민등록 인구통계(법정동별)",
               "series": {c: v for c, v in series.items() if v}}

    # 커버리지 가드: 최신 월에 값이 붙은 시군구가 90% 미만이면 발행하지 않는다.
    # 일부만 조용히 빠진 파일이 배포되면 화면이 "그 구는 데이터 없음"으로 거짓말한다.
    # 단, 받은 만큼은 partial로 남겨 다음 실행이 이어받는다.
    covered = [c for c in sggs if last_ym in series[c]]
    if len(covered) < len(sggs) * 0.9:
        _dump(partial_path, payload)
        print(f"최신 월({last_ym}) 커버리지 {len(covered)}/{len(sggs)}. 발행하지 않고 "
              f"진행분을 {partial_path}에 남깁니다.", file=sys.stderr)
        missing = sorted(set(sggs) - set(covered))[:10]
        print(f"누락 예: {missing}", file=sys.stderr)
        return 1
    # 규모 검산: 서울 세대수는 400만대가 정상이다. 자릿수가 다르면 필드를 잘못 잡은 것이다.
    seoul_hh = sum(series[c][last_ym][1] for c in covered if c.startswith("11"))
    if not (3_000_000 < seoul_hh < 6_000_000):
        print(f"서울 세대수 합 {seoul_hh:,}이 상식 범위(300만~600만)를 벗어납니다. "
              "필드 매핑이 틀렸을 가능성이 큽니다. 발행하지 않습니다.", file=sys.stderr)
        return 1
    # 시군구 합계 검산: 표본 구를 시군구 레벨(lv=2) 한 행으로 다시 받아 동 합과
    # 대조한다. 안분·이중 계상 버그를 잡는 가장 싼 검산이다. 레벨 파라미터가
    # 지원되지 않아 검산 자체가 불가능하면 그 사실만 남기고 발행은 막지 않는다.
    for probe_code in ("11110", "41111"):
        if last_ym not in series.get(probe_code, {}):
            continue
        try:
            rows2, _ = fetch_page(key, style, last_ym, probe_code, 1, rows=5, level=2)
        except Exception:
            rows2 = []
        agg = [r for r in rows2 if (_pick(r, CODE_KEYS) or "") in (probe_code, probe_code + "00000")]
        if len(agg) != 1:
            print(f"{probe_code} 합계 검산 불가 (시군구 레벨 응답 {len(agg)}행). 발행은 계속합니다.")
            continue
        h2 = _pick(agg[0], HH_KEYS)
        if h2 in (None, ""):
            continue
        official = int(float(h2.replace(",", "")))
        ours = series[probe_code][last_ym][1]
        if official and abs(ours - official) > official * 0.01:
            print(f"{probe_code} 세대 합 검산 실패: 동 합 {ours:,} vs "
                  f"시군구 행 {official:,}. 발행하지 않습니다.", file=sys.stderr)
            return 1
        print(f"{probe_code} 합계 검산 통과 ({ours:,})")

    _dump(args.out, payload)
    if os.path.exists(partial_path):
        os.remove(partial_path)          # 발행됐으니 부분 진행은 소임을 다했다
    kb = os.path.getsize(args.out) / 1024
    print(f"{args.out} 기록: 시군구 {len(covered)}곳 × {len(months)}개월, {kb:.0f}KB, "
          f"서울 세대 {seoul_hh:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
