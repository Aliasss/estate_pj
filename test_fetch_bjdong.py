#!/usr/bin/env python3
"""fetch_bjdong의 가드 넷을 검증한다.

이 저장소에 테스트가 없어서, 2026-09-05에 이 파일들을 고칠 때 리뷰가 잡은
구멍 둘(옛 표에 하한이 안 걸림, prev에 한 지역이 없으면 그 지역 검사가 조용히
꺼짐)이 프로덕션에 나갈 뻔했다. 둘 다 스무 줄짜리 테스트면 잡혔을 것이라
같이 남긴다. 여기 있는 함수는 전부 망을 안 타므로 그냥 돌리면 된다.

    python test_fetch_bjdong.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

import fetch_bjdong as fb

FAILED = []


def check(name: str, got, want) -> None:
    ok = got == want
    print(f"  {'통과' if ok else '실패'}  {name}")
    if not ok:
        print(f"        받은 값 {got!r}, 기대 {want!r}")
        FAILED.append(name)


def table(seoul: int, gyeonggi: int) -> dict:
    """실측 규모(서울 460여, 경기 570여)를 흉내낸 코드표."""
    m: dict[str, dict[str, str]] = {}
    for i in range(seoul):
        m.setdefault("11%03d" % (110 + i % 25), {})["서울동%d" % i] = "%05d" % i
    for i in range(gyeonggi):
        m.setdefault("41%03d" % (110 + i % 46), {})["경기동%d" % i] = "%05d" % i
    return m


def write(d: str, name: str, obj) -> str:
    p = os.path.join(d, name)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    return p


def main() -> int:
    d = tempfile.mkdtemp()
    base = table(462, 573)

    print("region_counts")
    check("지역별로 센다", fb.region_counts(base), {"서울특별시": 462, "경기도": 573})

    print("shrank - 통폐합은 통과, 절단은 차단 (SHRINK_MAX=%d)" % fb.SHRINK_MAX)
    check("변화 없음", fb.shrank(table(462, 573), base), None)
    check("서울 -2 (통폐합)", fb.shrank(table(460, 573), base), None)
    check("서울 -3 (문턱 밖)",
          bool(fb.shrank(table(459, 573), base)), True)
    check("경기 -50 (페이지 유실)",
          bool(fb.shrank(table(462, 523), base)), True)
    check("양쪽 증가", fb.shrank(table(470, 580), base), None)
    # 초안은 prev의 해당 지역이 0이면 비교를 건너뛰어, 경기가 통째로 빈 표를
    # 기준으로 삼은 날 경기 검사가 조용히 꺼졌다.
    check("prev에 경기가 없어도 경기를 본다",
          bool(fb.shrank(table(462, 0), table(462, 573))), True)

    print("load_prev - 못 믿을 표는 안 쓴다")
    check("없는 파일", fb.load_prev(os.path.join(d, "nope.json")), None)
    check("빈 문자열", fb.load_prev(""), None)
    bad = os.path.join(d, "bad.json")
    with open(bad, "w") as fh:
        fh.write("{ not json")
    check("깨진 JSON", fb.load_prev(bad), None)
    check("빈 dict", fb.load_prev(write(d, "empty.json", {})), None)
    check("dict가 아님", fb.load_prev(write(d, "list.json", [1, 2])), None)
    check("값이 dict가 아님",
          fb.load_prev(write(d, "flat.json", {"11110": "문자열"})), None)
    # 옛 표에도 새 표와 같은 하한을 건다. 안 그러면 반쪽짜리 옛 표가 하한 검사를
    # 통째로 우회해 조회 계획이 된다.
    check("하한 미만인 옛 표",
          fb.load_prev(write(d, "tiny.json", table(5, 3))), None)
    check("한 지역이 통째로 빈 옛 표",
          fb.load_prev(write(d, "half.json", table(462, 0))), None)
    check("정상", fb.load_prev(write(d, "ok.json", base)) is not None, True)

    print("_keep - 종료 코드와 산출")
    out = os.path.join(d, "out.json")
    check("옛 표가 있으면 3", fb._keep(base, out, "시험"), fb.EXIT_KEPT_PREV)
    with open(out, encoding="utf-8") as fh:
        check("옛 표를 그대로 쓴다", json.load(fh), base)
    out2 = os.path.join(d, "out2.json")
    check("옛 표가 없으면 1", fb._keep(None, out2, "시험"), 1)
    check("그때는 파일도 안 쓴다", os.path.exists(out2), False)

    print()
    if FAILED:
        print(f"실패 {len(FAILED)}건: {', '.join(FAILED)}")
        return 1
    print("전부 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
