# -*- coding: utf-8 -*-
"""사용자가 입력한 프롬프트를 '프롬프트-원문.md'에 자동으로 덧붙이는 스크립트.

Claude Code의 UserPromptSubmit 훅이 이 스크립트를 실행하며,
프롬프트 내용이 담긴 JSON을 표준입력(stdin)으로 넘겨준다.
훅 설정 위치: .claude/settings.json

수동으로 확인하려면:
    echo '{"prompt":"테스트"}' | python docs/작업기록/_프롬프트기록.py
"""
import io
import json
import os
import sys
from datetime import datetime

LOG_NAME = "프롬프트-원문.md"
HEADER = """# 프롬프트 원문 기록

이 파일은 Claude Code에 입력한 프롬프트를 **자동으로** 쌓아 두는 곳입니다.
(설정: `.claude/settings.json`의 UserPromptSubmit 훅 → `_프롬프트기록.py`)

정리된 작업 내용은 `작업기록.md`에 있습니다.
"""


def main():
    # 훅이 넘겨주는 JSON. 형식이 달라지거나 비어 있어도 게임/세션에는 영향이 없도록 조용히 종료한다.
    try:
        # 콘솔 기본 인코딩(Windows: cp949)이 아니라 UTF-8로 직접 해석해야 한글이 깨지지 않는다.
        raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    except Exception:
        return 0
    if not raw.strip():
        return 0

    try:
        data = json.loads(raw)
    except Exception:
        return 0

    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return 0

    # 훅은 사람이 입력한 것 말고 시스템이 넣는 알림도 함께 넘겨준다.
    # (백그라운드 작업이 끝났을 때 오는 <task-notification> 같은 것)
    # 이 파일은 '사람이 적은 프롬프트' 기록이므로 그런 것은 남기지 않는다.
    if prompt.startswith("<task-notification>") or prompt.startswith("<system-reminder>"):
        return 0

    session = (data.get("session_id") or "")[:8]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), LOG_NAME)
    is_new = not os.path.exists(log_path)

    with io.open(log_path, "a", encoding="utf-8", newline="") as f:
        if is_new:
            f.write(HEADER)
        f.write("\n---\n\n")
        f.write("### %s%s\n\n" % (stamp, (" · 세션 %s" % session) if session else ""))
        f.write("```text\n%s\n```\n" % prompt)

    return 0


if __name__ == "__main__":
    sys.exit(main())
