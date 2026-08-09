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
import signal
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

from lawd_codes import LAWD_CODES
from scrub import scrub

BASE = "https://apis.data.go.kr/1741000/stdgPpltnHhStus/selectStdgPpltnHhStus"

# 파라미터 격자. 실전 두 번의 실측으로 좁혔다. 1차: 활용신청 유효(JSON 응답).
# 2차: 월 파라미터가 statsYm일 때만 오류가 NO_MANDATORY(필수 누락)에서
# INVALID(값·이름 하나가 틀림)로 바뀌었다. 즉 월 표기는 statsYm이 유력하고,
# 남은 변수는 type 대소문자, lv 유무, 지역코드 파라미터의 이름·자릿수,
# 등록구분 유무다. 전부 격자로 돌리되 유력 조합을 앞세워 조기 종료를 노린다.
# 오류 응답이 head.resultMsg로 즉시 오므로 조합당 1행 호출이면 판별된다.
def _styles() -> list[dict]:
    out = []
    for month, month_to in (("statsYm", None), ("stats_ym", None),
                            ("srchFrYm", "srchToYm"), ("srch_fr_ym", "srch_to_ym")):
        for type_val in ("JSON", "json"):
            for use_lv in (True, False):
                for code_key, code_len in (("stdgCd", 5), ("stdgCd", 10),
                                           ("admmCd", 5), (None, 0)):
                    for reg_val in (None, "1"):
                        out.append({
                            "month": month, "month_to": month_to, "type": type_val,
                            "use_lv": use_lv, "code_key": code_key,
                            "code_len": code_len, "reg_val": reg_val,
                        })
    return out


PARAM_STYLES = _styles()


def style_label(s: dict) -> str:
    return (f"{s['month']}/type={s['type']}/lv={'o' if s['use_lv'] else 'x'}"
            f"/code={s['code_key'] or 'x'}{s['code_len'] or ''}/reg={s['reg_val'] or 'x'}")

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


def fetch_page(key: str, style: dict, ym: str, code: str | None, page: int,
               rows: int = 1000, level: int = 3) -> tuple[list[dict], str]:
    qs = {
        "serviceKey": key, "type": style.get("type", "JSON"),
        "pageNo": page, "numOfRows": rows,
        style["month"]: ym,
    }
    if style.get("month_to"):
        qs[style["month_to"]] = ym
    if style.get("use_lv"):
        qs["lv"] = level                     # 3이 법정동(읍면동), 2가 시군구 레벨 가정
    if style.get("reg_val") is not None:
        qs["regSeCd"] = style["reg_val"]
    if code and style.get("code_key"):
        qs[style["code_key"]] = code if style.get("code_len") == 5 else f"{code:0<10}"
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
    ap.add_argument("--budget-min", type=int, default=240,
                    help="이 시간을 넘기면 받은 만큼 저장하고 스스로 멈춘다")
    args = ap.parse_args()

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        print("MOLIT_SERVICE_KEY가 없습니다.", file=sys.stderr)
        return 1
    if "%" in key:
        key = urllib.parse.unquote(key)

    last_ym = month_list(1)[0]

    # 시계는 여기서 켠다. 파라미터 탐색을 지나서 켜면 탐색에 매달린 시간이
    # 예산에 안 잡힌다. 5시간 무출력으로 잘렸던 실행이 정확히 그랬다. 그때
    # 로그에는 "파라미터 표기 확정"도 전멸 덤프도 없었다. 탐색 루프에 갇혀
    # 있었다는 뜻이고, 그 구간을 아무도 재고 있지 않았다.
    started = time.monotonic()

    def over_budget(where: str) -> bool:
        if time.monotonic() - started <= args.budget_min * 60:
            return False
        print(f"시간 예산 {args.budget_min}분 소진 ({where}). 여기서 접습니다.",
              file=sys.stderr, flush=True)
        return True

    # 진행분을 만들기 전 구간에서 잘릴 수도 있다. 그때 저장할 것은 없지만,
    # 최소한 어디서 죽었는지는 남겨야 한다. 아무 말 없이 사라지는 게 지난
    # 실패를 진단 불가로 만든 원인이었다. 수집이 시작되면 아래에서 진행분까지
    # 저장하는 핸들러로 교체한다.
    def _on_signal_early(signum: int, _frame) -> None:
        print(f"신호 {signum} 수신. 아직 수집 전(준비·파라미터 탐색) 구간이라 "
              "남길 진행분이 없습니다.", file=sys.stderr, flush=True)
        os._exit(1)

    for _sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(_sig, _on_signal_early)

    if args.probe:
        for style in PARAM_STYLES:
            print(f"--- {style_label(style)}")
            try:
                rows, raw = fetch_page(key, style, last_ym, "11110", 1, rows=5)
            except Exception as exc:
                print(f"요청 실패: {scrub(exc)}")
                continue
            print(f"행 {len(rows)}개 · {scrub(raw)[:400]}")
        return 0

    # 표기 확정: 첫 요청이 행을 돌려주는 조합을 쓴다. 전멸하면 조합별 응답을
    # 전부 남긴다. 그 목록이 곧 다음 수정의 명세다. 단, 네트워크가 아예 죽어
    # 있으면(자정 전후 data.go.kr 무응답 시간대를 실측했다) 파라미터 문제가
    # 아니므로 일찍 접고 그렇게 말한다. 30초 타임아웃 8번으로 4분을 태울 이유도,
    # 파라미터를 의심하며 헛수정할 이유도 없다.
    style = None
    attempts: list[str] = []
    net_fails = 0
    for cand in PARAM_STYLES:
        # 조합마다 예산을 본다. urlopen의 timeout은 소켓 연산당 값이라 응답을
        # 찔끔거리는 서버 하나면 요청 하나가 무한정 잡힌다. 128 x 30초라는
        # 명목 상한이 실제 상한이 아니라는 뜻이다. 요청 사이에서라도 끊는다.
        if over_budget(f"파라미터 탐색 {len(attempts)}/{len(PARAM_STYLES)}조합"):
            return 1
        label = style_label(cand)
        try:
            rows, raw = fetch_page(key, cand, last_ym, "11110", 1, rows=5)
        except Exception as exc:
            net_fails += 1
            attempts.append(f"{label}: 요청 실패 {scrub(exc)}"[:200])
            if net_fails >= 3 and net_fails == len(attempts):
                print("호스트가 응답하지 않습니다 (연속 3회 요청 실패). 파라미터 문제가 "
                      "아니라 접속 문제입니다. 시간대를 바꿔 재실행하세요.", file=sys.stderr)
                for a in attempts:
                    print(f"  {a}", file=sys.stderr)
                return 1
            continue
        if rows:
            style = cand
            print(f"파라미터 표기 확정: {label}")
            break
        attempts.append(f"{label}: {scrub(raw)[:160]}")
        time.sleep(0.1)
    if style is None:
        print("어느 파라미터 조합으로도 행을 받지 못했습니다. 활용신청(공공데이터포털 "
              "15108071) 여부를 확인하고, 아래 조합별 응답으로 표기를 맞추세요.", file=sys.stderr)
        # 같은 오류의 반복은 접고 서로 다른 응답만 남긴다. 128개 조합을 다 찍으면
        # 로그가 명세가 아니라 소음이 된다.
        seen_msgs = set()
        shown = 0
        for a in attempts:
            body = a.split(": ", 1)[-1]
            if body in seen_msgs:
                continue
            seen_msgs.add(body)
            print(f"  {a}", file=sys.stderr)
            shown += 1
            if shown >= 20:
                break
        print(f"  (총 {len(attempts)}개 조합 시도, 고유 응답 {len(seen_msgs)}종)", file=sys.stderr)
        return 1

    # 필드 확정: 표본 행에서 코드·인구·세대 필드를 찾는다. 못 찾으면 행을 보여주고 멈춘다.
    sample_rows, _ = fetch_page(key, style, last_ym, "11110", 1, rows=5)
    sample = sample_rows[0]
    if not (_pick(sample, CODE_KEYS) and _pick(sample, POP_KEYS) and _pick(sample, HH_KEYS)):
        print("응답 필드명이 후보와 다릅니다. 표본 행:", file=sys.stderr)
        print(scrub(json.dumps(sample, ensure_ascii=False))[:600], file=sys.stderr)
        return 1
    # 지역코드 필터가 실제로 먹는지 본다. 표본에 타 지역 코드가 섞였거나 코드
    # 파라미터가 아예 없는 조합이면, 시군구별 호출 대신 전국 한 달을 페이지로
    # 받아 접두사로 나누는 모드로 간다. 호출 수는 페이지 수만큼이라 오히려 싸다.
    stray = [cd for cd in ((_pick(r, CODE_KEYS) or "") for r in sample_rows)
             if cd and not cd.startswith("11110")]
    filter_ok = bool(style.get("code_key")) and not stray
    if not filter_ok:
        print("지역코드 필터 없이 전국 응답 모드로 갑니다 (월 단위 페이지 수집, 접두사 분배).")

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

    def _add(acc: dict, cd: str, p: str | None, h: str | None) -> None:
        # 빈 문자열은 0이 아니라 결측이다. 0으로 합산해 [0,0]을 저장하면
        # 차트가 "세대 0"이라는 조용한 거짓말을 그린다. 시군구 자체 합계 행
        # (읍면동 코드 000)이 섞여 오면 이중 계상이므로 걷어낸다.
        if p in (None, "") or h in (None, ""):
            return
        if len(cd) == 10 and cd[5:8] == "000":
            return
        acc[0] += int(float(p.replace(",", "")))
        acc[1] += int(float(h.replace(",", "")))
        acc[2] = True

    def _dump(path: str, payload: dict) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    def _save_partial() -> None:
        _dump(partial_path, {"asof": last_ym,
                             "source": "행정안전부 주민등록 인구통계(법정동별)",
                             "series": {c: v for c, v in series.items() if v}})

    done_cells = 0
    total_cells = sum(1 for ym in months for c in sggs if ym not in series[c])

    # 여기부터는 잃을 진행분이 있다. 준비 구간용 핸들러를 저장하는 핸들러로
    # 바꾼다. 러너 타임아웃과 취소는 SIGINT나 SIGTERM으로 오는데, SIGINT가
    # 일으키는 KeyboardInterrupt는 BaseException이라 아래 except Exception이
    # 못 잡고 SIGTERM은 파이썬 예외조차 아니다. 예산만으로는 못 지킨다.
    #
    # 저장을 출력보다 먼저 한다. 본체가 stderr에 쓰는 도중 신호가 들어오면
    # print가 재진입 오류를 낼 수 있는데, 그때도 데이터는 이미 디스크에 있다.
    # 순서를 뒤집지 말 것.
    def _on_signal(signum: int, _frame) -> None:
        _save_partial()
        print(f"신호 {signum} 수신. 진행분 {done_cells}/{total_cells}구간을 "
              f"{partial_path}에 남기고 종료합니다.", file=sys.stderr, flush=True)
        os._exit(1)

    for _sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(_sig, _on_signal)

    def _collect_all() -> None:
        nonlocal done_cells
        # 시간 예산은 탐색 구간과 같은 시계(started)를 쓴다. 여기서 다시 켜면
        # 워크플로가 배정한 시간을 탐색과 수집이 각각 한 번씩 두 번 쓴다.
        def over_budget() -> bool:
            if time.monotonic() - started > args.budget_min * 60:
                print(f"시간 예산 {args.budget_min}분 소진 ({done_cells}/{total_cells} 구간). "
                      "받은 만큼 저장하고 다음 실행이 이어받습니다.", flush=True)
                return True
            return False
        for ym in months:
            todo = [c for c in sggs if ym not in series[c]]
            if not todo:
                continue
            if over_budget():
                return
            if filter_ok:
                for code in todo:
                    if over_budget():
                        return
                    acc = [0, 0, False]
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
                                continue      # 필터가 어긋난 행은 계상하지 않는다
                            _add(acc, cd, _pick(r, POP_KEYS), _pick(r, HH_KEYS))
                        if len(rows) < 1000:
                            break
                        page += 1
                        time.sleep(args.sleep)
                    if acc[2]:
                        series[code][ym] = [acc[0], acc[1]]
                    done_cells += 1
                    # 두 시간짜리 백필이 무소식이면 밖에서는 폭주와 구분이 안 된다
                    if done_cells % 200 == 0:
                        el = time.monotonic() - started
                        print(f"진행 {done_cells}/{total_cells} 구간, {el / 60:.0f}분 경과", flush=True)
                    time.sleep(args.sleep)
            else:
                # 전국 모드: 한 달을 통째로 페이지네이션해 접두사로 나눈다.
                accs = {c: [0, 0, False] for c in todo}
                page = 1
                while True:
                    rows, raw = fetch_page(key, style, ym, None, page)
                    if not rows:
                        if page == 1 and raw:
                            print(f"{ym}: 행 없음 {scrub(raw)[:160]}", file=sys.stderr)
                        break
                    for r in rows:
                        cd = _pick(r, CODE_KEYS) or ""
                        if cd[:5] in accs:
                            _add(accs[cd[:5]], cd, _pick(r, POP_KEYS), _pick(r, HH_KEYS))
                    if len(rows) < 1000:
                        break
                    page += 1
                    if page > 120:
                        # 12만 행을 넘기면 통반 레벨 전국 응답이다. 이 모드로 받을 물건이 아니다.
                        raise RuntimeError(f"{ym}: 페이지가 120을 넘습니다. 응답 레벨이 너무 깊습니다.")
                    time.sleep(args.sleep)
                for c, acc in accs.items():
                    if acc[2]:
                        series[c][ym] = [acc[0], acc[1]]
                done_cells += len(todo)
                el = time.monotonic() - started
                print(f"진행 {ym} 완료 ({done_cells}/{total_cells} 구간, {el / 60:.0f}분 경과)", flush=True)
                time.sleep(args.sleep)


    try:
        _collect_all()
    except Exception as exc:
        # 어떤 예외로 죽어도 받은 만큼은 partial로 남긴다. 워크플로의 데이터
        # 커밋이 partial까지 실어 가므로 다음 실행이 그 지점부터 이어받는다.
        # 몇 시간짜리 백필이 마지막 예외 하나로 통째로 증발하면 안 된다.
        _save_partial()
        print(f"수집 중 오류로 중단, 진행분 {done_cells}/{total_cells}구간을 "
              f"{partial_path}에 남겼습니다: {scrub(exc)}", file=sys.stderr)
        return 1

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
    probe_codes = ("11110", "41111") if (style.get("use_lv") and filter_ok) else ()
    if not probe_codes:
        print("합계 검산 불가 (lv 또는 지역코드 필터가 없는 표기). 규모 검산만 통과했습니다.")
    for probe_code in probe_codes:
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
