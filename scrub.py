"""인증키 스크러버. 로그·DB로 나가는 문자열에서 키를 가리는 한 곳.

인증키는 쿼리스트링에 실려 나가고, requests/urllib3 예외 메시지는 실패한 URL을
통째로 담는다. 그대로 로그에 찍으면 키가 샌다 — 첫 실행에서 실제로 13자가
노출됐다. collect.py의 fetch_log.message는 공개 릴리스로 올라가는 seoul_rt.sqlite
안의 컬럼이라, 여기서 새면 로그가 아니라 배포물에 박제된다.

수집기가 셋(collect / collect_bldg / geocode)인데 패턴이 파일마다 따로 살면
반드시 어긋난다. 실제로 collect_bldg의 패턴은 serviceKey=만 잡아서 VWorld의
key=와 juso의 confmKey=를 놓쳤다. 그래서 한 곳에 모은다.
"""

from __future__ import annotations

import re

# probe_sources.py에서 검증된 패턴. serviceKey=(공공데이터포털) 외에
# key=(VWorld), confmKey=(juso)까지 잡는다. URL 인코딩된 키(%2F 등)도
# [^&\s'"<]가 그대로 삼킨다.
SECRET_RE = re.compile(r"((?:serviceKey|confmKey|key)=)[^&\s'\"<]+", re.I)


def scrub(text: object) -> str:
    """문자열(또는 예외 등 아무것이나)에서 인증키를 ***로 가린다."""
    return SECRET_RE.sub(r"\1***", str(text))


def describe(exc: BaseException, limit: int = 240) -> str:
    """예외 한 줄 요약.

    urllib3 메시지는 URL이 앞에 오고 진짜 원인('Caused by ConnectTimeoutError…')이
    맨 끝에 온다. 앞만 잘라 쓰면 원인을 영영 못 본다. 양끝을 남긴다.
    """
    text = scrub(exc).replace("\n", " ")
    if len(text) > limit:
        text = f"{text[:70]} … {text[-(limit - 73):]}"
    return f"{type(exc).__name__}: {text}"
