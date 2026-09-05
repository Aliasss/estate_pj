#!/usr/bin/env python3
"""행정표준코드 법정동코드(StanReginCd)에서 서울 법정동 매핑을 내려받는다.

건축물대장 조회에는 (시군구 5자리, 법정동 5자리)가 필요한데, 지금까지는 실거래
payload에 실려 온 umdCd를 주워 썼다. 전 소스로 넓혀도 "그 동에 신고가 한 건도
없으면" 여전히 빠진다. 이 스크립트는 행안부 공식 코드표를 받아 그 구멍을 없앤다.

산출: bjdong.json  {"11110": {"청운동": "10100", ...}, "41220": {"팽성읍 대사리": "25331", ...}}
동·읍·면은 이름 그대로, 경기의 리(里)는 "읍면명 리명"으로 담는다. 실거래
umd_nm이 리 수준으로 오는 지역이 실재해서다. 매일 크론에서 받아도 부담이
없고, 코드 개편(동 통폐합)도 자동으로 따라간다.

사용법
    MOLIT_SERVICE_KEY=... python fetch_bjdong.py --out bjdong.json --prev bjdong.prev.json
공공데이터포털에서 "행정표준코드관리시스템 법정동코드" 활용신청이 되어 있어야
한다(자동승인).

종료 코드
    0  새 코드표를 썼다. 호출부는 이것을 릴리스에 보관한다.
    3  새 코드표가 옛것보다 짧아 옛것을 그대로 썼다. 보관은 안 한다.
    1  받지도 못했고 옛것도 없다. 호출부는 payload 매핑으로 넘어간다.

--prev를 두는 이유. 2026-09-02 회차(buildings run 47, 33659003895)의 계획이
"조회 대상 14,273건 (완료 164,977건)" = 대상 179,250이었는데, 그 앞뒤 회차는
181,718이었다(run 46 33536908851 종료 뒤 bldg_meta 역산, run 48 33781977409
종료 뒤 실측). 하루 만에 2,468건이 줄었다가 정확히 되돌아온 것이다. 그 사이
실거래 수집은 없었으므로(마지막이 9/1) targets()의 나머지 입력인 이 코드표가
그날만 반쪽으로 왔다고 보는 것이 가장 단순한 설명이다. 단정은 아니다. 그 회차
로그에서 코드표 자체의 크기를 확인하지는 못했다.

아래 지역별 하한(서울 400, 경기 500)은 그것을 못 잡았다. 동 몇십 개가 빠져도
하한은 넉넉히 넘기 때문이다.

그때는 손해가 없었다. 그 회차가 IP 차단으로 0건이라 줄어든 계획이 실제 수집에
안 닿았다. 정상 회차에 같은 일이 나면 그 회차는 2,468지번을 건너뛰고, 잔여가
줄어든 것이 완주에 가까워진 것으로 읽힌다. 화성시 4개 구 신설을 반년 놓친 것과
같은 형태다.

옛 표에 갇히면 어떻게 푸나

새 표가 계속 거부되면 매 회차 옛 표를 쓰고 잡은 초록으로 끝난다. 진짜 통폐합이
SHRINK_MAX를 넘는 규모로 일어나면 그 상태가 영영 안 풀린다. 풀려면 릴리스
data-latest에서 bjdong.json 자산을 지우면 된다. 다음 회차가 옛 표 없이 돌아
새 표를 그대로 채택한다. _keep의 경고문이 이 지시를 매 회차 함께 찍는다.

자동으로 푸는 장치는 안 만들었다. "같은 크기의 새 표가 이틀 연속 오면 통폐합으로
보고 채택한다"가 후보였는데, 절단은 하루짜리이고 통폐합은 결정론적이라는 관측에
기대는 것이라 관측이 하나뿐인 지금 짜면 또 근거 없는 상수가 하나 는다. 게다가
위 두 가드(totalCount, retired)가 절단을 먼저 잡으므로 여기까지 오는 일이 드물다.
고착이 실제로 한 번이라도 관측되면 그때 만든다.

그래서 가드를 셋 겹으로 둔다. 절단은 _collect_region이 totalCount와 받은 행
수를 견줘 오차 없이 잡고, 시군구 통째 소실은 retired 대조가 코드로 직접 잡는다.
직전 대비 개수 비교(SHRINK_MAX)는 그 둘이 놓친 것을 받는 마지막 그물이다.
초안은 마지막 그물 하나만 두고 문턱을 1%로 잡았는데, 그러면 서울 4개·경기 5개
동까지 통과한다. 밀집 동 넷이면 2,400지번이라 사건과 같은 크기다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

from lawd_codes import LAWD_CODES
from scrub import scrub

BASE = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList"

# 새 코드표가 옛것보다 짧아 옛것을 그대로 쓴 회차. 호출부가 이 값을 보고
# 릴리스 보관을 건너뛴다. 자산 시각을 이유 없이 움직이지 않으려는 것이다.
EXIT_KEPT_PREV = 3

# 코드표에서 빠져도 정상인 옛 코드. 구 재설치·신설로 갈린 시군구의 과거분이
# 이 코드에 남아 있어 수집 목록에는 두지만, 공식 코드표는 신설 코드만 서빙한다.
# 아래 retired 가드가 이 둘을 빼고 봐야 진짜 소실만 잡는다(lawd_codes.py 주석).
LEGACY_LAWD = {"41190", "41590"}

# 직전 대비 이만큼 넘게 줄면 절단으로 본다. 통폐합은 한두 개 단위라고 적어 놓고
# 문턱을 백분율로 두니 서울 4개·경기 5개까지 통과했다. 밀집 동은 하나가 600지번
# 남짓이라(송파 8,547지번 / 14개 동, buildings.yml 실측) 그 문턱이 2,400지번을
# 통과시킨다. 2026-09-02에 잃은 것이 2,468지번이었으니 사건과 같은 크기다.
# 절대값으로 바꿔 적어 둔 말과 맞춘다.
#
# 이건 마지막 그물이다. 절단은 위 _collect_region의 totalCount 대조가, 시군구
# 통째 소실은 아래 retired 가드가 오차 없이 먼저 잡는다.
SHRINK_MAX = 2

# 지역별 절대 하한. 새 표와 옛 표에 같이 건다. 합산으로 재면 "서울 온전 +
# 경기 절반 유실"이 통과하므로 지역별로 둔다. 실측 규모는 서울 460여, 경기 570여.
REGION_MIN = (("서울특별시", 400), ("경기도", 500))


def fetch_page(key: str, region: str, page: int, rows: int = 1000) -> dict:
    qs = urllib.parse.urlencode({
        "serviceKey": key, "type": "json",
        "pageNo": page, "numOfRows": rows,
        "locatadd_nm": region,
    })
    req = urllib.request.Request(f"{BASE}?{qs}", headers={"User-Agent": "estate-pj"})
    with urllib.request.urlopen(req, timeout=30) as res:
        text = res.read().decode("utf-8")
    if not text.lstrip().startswith("{"):
        # 활용신청 전이면 XML 오류가 온다. 본문을 가려서 앞부분만 보여 준다.
        raise RuntimeError(f"JSON이 아닌 응답: {scrub(text)[:200]}")
    return json.loads(text)


def region_counts(mapping: dict) -> dict[str, int]:
    """지역별 법정동 수. 합산으로 재면 "서울 온전 + 경기 절반 유실"이 통과한다."""
    return {
        "서울특별시": sum(len(v) for k, v in mapping.items() if k.startswith("11")),
        "경기도": sum(len(v) for k, v in mapping.items() if k.startswith("41")),
    }


def load_prev(path: str) -> dict | None:
    """직전 회차의 코드표. 없거나 못 읽으면 None이고, 그때는 비교를 안 한다.

    못 읽는 것을 실패로 삼지 않는다. 이 파일은 비교용 보조 자료이고, 처음 도는
    회차에는 아예 없다. 여기서 죽으면 코드표를 받을 수 있는 날에도 payload
    매핑으로 떨어진다.
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            prev = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"직전 코드표를 못 읽었습니다({scrub(exc)}). 비교를 건너뜁니다.",
              file=sys.stderr)
        return None
    if not isinstance(prev, dict) or not prev:
        print("직전 코드표가 비어 있습니다. 비교를 건너뜁니다.", file=sys.stderr)
        return None
    # 값이 dict가 아니면 load_bjdong_map이 umds.items()에서 죽는다. 여기서
    # 거른다. 이 파일은 _keep를 거쳐 그대로 bjdong.json이 될 수 있어서다.
    if not all(isinstance(v, dict) for v in prev.values()):
        print("직전 코드표의 모양이 예상과 다릅니다. 비교를 건너뜁니다.", file=sys.stderr)
        return None
    # 옛 표에도 새 표와 같은 하한을 건다. 안 그러면 반쪽짜리 옛 표가 하한 검사를
    # 통째로 우회해 조회 계획이 된다. 특히 한 지역이 통째로 빈 표를 쓰면 그날
    # 그 지역 수집이 0이 되고 잡은 초록으로 끝난다.
    c = region_counts(prev)
    for region, minimum in REGION_MIN:
        if c[region] < minimum:
            print(f"직전 코드표의 {region}이 {c[region]}개뿐입니다(최소 {minimum}). "
                  "못 믿을 표라 안 씁니다.", file=sys.stderr)
            return None
    return prev


def shrank(new: dict, prev: dict) -> str | None:
    """직전보다 크게 줄어든 지역이 있으면 그 사유, 아니면 None.

    초안은 b[region]이 0이면 그 지역 비교를 건너뛰었다. 그러면 경기가 통째로
    빠진 옛 표를 기준으로 삼은 날 경기 검사가 조용히 꺼진다. 옛 표가 성한지는
    load_prev가 이미 보므로 여기서 봐주지 않는다.
    """
    a, b = region_counts(new), region_counts(prev)
    for region in a:
        if b[region] - a[region] > SHRINK_MAX:
            return (f"{region} 법정동이 {b[region]}개에서 {a[region]}개로 "
                    f"{b[region] - a[region]}개 줄었습니다")
    for region in a:
        if a[region] < b[region]:
            print(f"참고: {region} 법정동 {b[region]} -> {a[region]} "
                  "(통폐합 범위로 보고 새 코드표를 씁니다)")
    return None


def _keep(prev: dict | None, out: str, why: str) -> int:
    """옛 코드표로 버틴다. 없으면 payload 매핑으로 넘긴다."""
    if prev is None:
        print(f"{why}. 직전 코드표도 없어 payload 매핑으로 넘어갑니다.", file=sys.stderr)
        return 1
    c = region_counts(prev)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(prev, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"::warning::{why}. 직전 코드표를 그대로 씁니다 "
          f"(서울 {c['서울특별시']}, 경기 {c['경기도']}). "
          "이 경고가 여러 회차 이어지면 진짜 개편일 수 있습니다. "
          "릴리스 data-latest에서 bjdong.json 자산을 지우면 다음 회차가 새 표를 씁니다.")
    return EXIT_KEPT_PREV


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="bjdong.json")
    ap.add_argument("--prev", default="",
                    help="직전 회차 코드표. 새것이 이보다 짧으면 이것을 쓴다")
    args = ap.parse_args()

    # 키 검사보다 먼저 읽는다. 초안은 뒤에 뒀는데, 그러면 시크릿이 만료·회전으로
    # 빈 날 릴리스에 멀쩡한 옛 코드표가 있어도 안 쓰고 payload 매핑으로 떨어진다.
    # 실무에서 가장 자주 나는 실패가 하필 옛것을 못 쓰는 유일한 갈래였다.
    prev = load_prev(args.prev)

    key = os.environ.get("MOLIT_SERVICE_KEY", "").strip()
    if not key:
        return _keep(prev, args.out, "MOLIT_SERVICE_KEY가 없습니다")
    if "%" in key:                       # 시크릿에 인코딩 키가 들어 있어도 동작하게
        key = urllib.parse.unquote(key)

    mapping: dict[str, dict[str, str]] = {}
    sgg_names: dict[str, str] = {}
    for region in ("서울특별시", "경기도"):
        try:
            _collect_region(key, region, mapping, sgg_names)
        except Exception as exc:
            print(f"법정동코드 조회 실패: {scrub(exc)}", file=sys.stderr)
            # 옛 코드표가 있으면 그것으로 버틴다. payload 매핑으로 떨어지는 것보다
            # 낫다. 2026-09-01 릴리스 스냅숏(seoul_rt.sqlite)에 targets()를 직접
            # 돌려 재면 payload 매핑만으로는 174,653지번인데, 같은 날 공식 코드표를
            # 쓴 회차의 대상은 181,718지번이었다(run 46 33536908851). 7,065지번
            # 차이다. 워크플로 로그가 아니라 손으로 돌린 값이라 회차 번호가 없다.
            return _keep(prev, args.out, "조회에 실패했습니다")

    # 수집 목록(lawd_codes.py)과 공식 코드표를 대조한다. 구 신설이 생기면 MOLIT은
    # 신설 코드로만 서빙해 옛 코드 조회가 0건 ok로 조용히 비는다. 화성시 4개 구
    # 신설(2026-02)을 반년 가까이 그렇게 놓쳤다. 이 대조가 그 침묵을 깬다.
    missing = sorted(set(sgg_names) - set(LAWD_CODES))
    if missing:
        print("경고: 공식 코드표에 있는데 수집 목록(lawd_codes.py)에 없는 시군구:")
        for c in missing:
            print(f"  {c} {sgg_names[c]}")
    # 수집 목록에 있는 시군구가 코드표에서 통째로 빠지면 그 구의 지번이 계획에서
    # 전부 사라진다. 이건 개수 비교로 잡을 수 없다. 법정동이 서넛뿐인 자치구
    # (관악·금천·양천 등)는 통째로 없어져도 지역 합계로는 서넛 줄어든 것이라
    # 어떤 백분율 문턱에도 안 걸린다. 여기서는 코드로 직접 보므로 오차가 없다.
    #
    # LEGACY_LAWD는 빼고 본다. 구 재설치·신설로 갈린 시군구의 옛 코드라 공식
    # 코드표에는 원래 없고 수집 목록에만 있다. 그 둘까지 걸면 매 회차 걸린다.
    retired = sorted(set(LAWD_CODES) - set(sgg_names) - LEGACY_LAWD)
    if retired:
        names = ", ".join(f"{c} {LAWD_CODES[c]}" for c in retired)
        return _keep(prev, args.out,
                     f"수집 목록의 시군구가 코드표에서 빠졌습니다({names})")

    # 지역별로 따로 검사한다. 합산 임계는 "서울 온전 + 경기 절반 유실" 같은
    # 부분 유실을 통과시킨다. 서울 460여, 경기 570여가 실측 기준이다.
    n = sum(len(v) for v in mapping.values())
    counts = {
        "서울특별시": sum(len(v) for k, v in mapping.items() if k.startswith("11")),
        "경기도": sum(len(v) for k, v in mapping.items() if k.startswith("41")),
    }
    for region, minimum in REGION_MIN:
        if counts[region] < minimum:
            print(f"{region} 법정동이 {counts[region]}개뿐입니다(최소 {minimum}). "
                  "응답이 잘렸거나 필터가 어긋났습니다.", file=sys.stderr)
            return _keep(prev, args.out, f"{region} 코드표가 하한 미만입니다")

    # 절대 하한은 성기다. 동 몇십 개가 빠져도 넉넉히 넘는데, 그 몇십 개가
    # 수천 지번을 계획에서 떨어뜨린다(머리말의 2026-09-02 실측). 직전과 견준다.
    if prev is not None:
        why = shrank(mapping, prev)
        if why:
            return _keep(prev, args.out, why)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(mapping, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{args.out} 기록: {len(mapping)}개 시군구, 법정동 {n}개 "
          f"(서울 {counts['서울특별시']}, 경기 {counts['경기도']})")
    return 0


def _collect_region(key: str, region: str, mapping: dict, sgg_names: dict) -> None:
    page, total = 1, None
    seen = 0
    raw: list[tuple[str, str]] = []
    while True:
        try:
            body = fetch_page(key, region, page)
        except Exception as exc:
            raise RuntimeError(f"{region} 조회 실패: {scrub(exc)}") from exc
        blocks = body.get("StanReginCd")
        if not blocks:
            # 오류 구조는 {"RESULT": {...}} 또는 nationalCode 오류 포맷으로 온다
            raise RuntimeError(f"{region} 응답에 데이터가 없습니다: "
                               f"{scrub(json.dumps(body, ensure_ascii=False))[:200]}")
        rows = []
        for b in blocks:
            if "head" in b:
                for h in b["head"]:
                    if "totalCount" in h:
                        total = int(h["totalCount"])
            rows.extend(b.get("row", []))
        seen += len(rows)
        for r in rows:
            cd = (r.get("region_cd") or "").strip()
            name = (r.get("locallow_nm") or "").strip()
            if len(cd) != 10 or not name:
                continue
            # 시군구 자체(읍면동 코드 000)는 매핑에는 안 담지만 이름은 챙긴다.
            # 구 신설(부천, 화성)을 수집 목록과 대조해 알리는 데 쓴다.
            if cd[5:8] == "000":
                full = (r.get("locatadd_nm") or "").strip()
                sgg_names[cd[:5]] = full.replace(region, "").strip() or name
                continue
            raw.append((cd, name))
        if total is None or page * 1000 >= total:
            break
        page += 1

    # 여기가 절단을 잡는 자리다. API는 totalCount로 "이만큼 있다"고 말해 놓고
    # 그보다 적게 준다. 지금까지 이 값을 페이지 루프의 종료 조건으로만 쓰고
    # 받은 것과 대조하지는 않았다. 그래서 응답이 잘려도 아무도 몰랐다.
    #
    # 하류의 개수 비교(절대 하한, 직전 대비)로는 이것을 확실히 못 잡는다.
    # 동 몇 개가 빠지면 하한은 넉넉히 넘고, 빠진 동이 밀집 지역이면 지번은
    # 수천인데 동 수로는 서너 개라 백분율 문턱에도 안 걸린다. 여기서는 오차가
    # 없다. 몇 행 있다고 했는지와 몇 행 받았는지만 견주면 된다.
    if total is not None and seen != total:
        raise RuntimeError(f"{region} 응답이 잘렸습니다: {total}행이라고 하고 "
                           f"{seen}행을 줬습니다")

    # 동·읍·면(리 코드 00)은 이름 그대로. 리(里) 행은 "읍면명 리명"으로 담는다.
    # 처음에는 리를 걷어냈는데, 경기 실거래 umd_nm이 "팽성읍 대사리"처럼 리
    # 수준으로 오는 것을 실측했다. 리를 버리면 그 동네 건축물대장 조회가 통째로
    # 빠지고, 조회에 쓰는 법정동 5자리도 리 코드까지 있어야 맞는 지번을 찾는다.
    emd = {cd[:8]: name for cd, name in raw if cd[8:10] == "00"}
    for cd, name in raw:
        if cd[8:10] == "00":
            mapping.setdefault(cd[:5], {})[name] = cd[5:10]
        else:
            parent = emd.get(cd[:8])
            full = f"{parent} {name}" if parent else name
            mapping.setdefault(cd[:5], {})[full] = cd[5:10]


if __name__ == "__main__":
    sys.exit(main())
