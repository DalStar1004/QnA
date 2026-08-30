---
template: plan
version: 1.3
---

# word-connection-multiplayer Planning Document

> **파일 이름 안내 (2026-08-30 통합)** — 이 문서에 나오는 `word_connection_game_v2.html` 은
> 지금은 **`word_connection_game.html`** 입니다. v2 의 내용을 원래 파일로 옮기고 v2 는 없앴습니다.
> 아래 본문은 당시 결정을 그대로 남겨 둔 기록이라 예전 이름을 그대로 씁니다.


> **Summary**: `word_connection_game_v2.html`(싱글플레이 단어 연결 게임)을 여러 사람이 같은 방(룸)에 모여 실시간으로 경쟁할 수 있도록, Node.js + Express + Socket.IO 서버와 Docker 배포 환경을 새로 구축한다.
>
> **Project**: word_connection_game
> **Version**: 0.2
> **Author**: cupid4rang
> **Date**: 2026-08-23
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 현재 게임은 `file://`로 여는 완전한 싱글플레이 정적 페이지라서, 여러 사람이 같은 판을 두고 실시간으로 경쟁할 방법이 없다 |
| **Solution** | Node.js/Express/Socket.IO 기반 실시간 서버를 새로 만들어, 방 코드로 여러 명이 같은 방에 입장하고 동일한 보드를 보며 "먼저 맞히는 사람이 승"인 경쟁 게임으로 확장한다. Docker/Docker Compose로 어디서나 서버를 띄울 수 있게 한다 |
| **Function/UX Effect** | 닉네임 입력 → 방 생성/방 코드로 입장 → 방장이 시작 → 모두 같은 글자 보드를 보고 먼저 정답을 맞히면 점수 획득 → 60초 후 실시간 순위표 표시 |
| **Core Value** | 혼자 하던 캐주얼 게임을 "친구와 실시간 대전"으로 확장해 재미와 리플레이 가치를 크게 높인다 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 싱글플레이 정적 페이지에는 여러 사람이 함께 경쟁할 방법이 전혀 없음 |
| **WHO** | 방 코드를 공유받아 함께 플레이하는 지인 그룹(2~8명), 방장이 방을 만들고 시작을 트리거 |
| **RISK** | 같은 순간 여러 명이 정답을 제출하는 동시성 문제 → 서버가 유일한 정답 판정 권한을 갖는 authoritative 구조로 해결. 클라이언트 조작(콘솔에서 정답 직접 전송)으로 부정 가능 → 이번 범위에서는 캐주얼 게임 특성상 별도 방지 로직은 Out of Scope로 명시 |
| **SUCCESS** | (1) 방 생성/방 코드 입장 가능 (2) 방장 시작 시 모든 참가자에게 동일한 보드 브로드캐스트 (3) 먼저 정답 맞힌 사람만 점수 획득 및 즉시 다음 라운드 전환 (4) 60초 종료 시 전원에게 동일한 최종 순위표 표시 (5) `docker compose up`으로 서버가 정상 기동, 브라우저에서 접속 가능 |
| **SCOPE** | 신규 Node.js 서버(Express+Socket.IO) + 신규 멀티플레이 클라이언트 HTML(기존 `word_connection_game_v2.html` 룰/스타일 재사용) + Dockerfile/docker-compose.yml. 로그인·영구DB·재접속 복구·매칭메이킹은 Out of Scope |

---

## 1. Overview

### 1.1 Purpose

기존 싱글플레이 게임의 판정 로직과 룩앤필을 재사용하면서, 여러 사람이 실시간으로 같은 방에서 경쟁할 수 있는 온라인 멀티플레이어 버전을 서버 프로그램으로 구현한다.

### 1.2 Background

`word_connection_game_v2.html`(Do 단계 완료, 브라우저 테스트 대기 중)은 완전한 클라이언트 전용 싱글플레이 게임이다. 사용자가 "여러 사람이 할 수 있도록 Docker 환경에 서버를 구성"해 달라고 요청했고, 명확화 결과 **진짜 실시간 멀티플레이**(같은 보드를 보며 먼저 맞히는 사람이 승)를 원하는 것으로 확인됨.

### 1.3 Related Documents

- 참조 파일: `word_connection_game_v2.html` (기존 싱글플레이 완성본 — 판정 규칙, 사전, 스타일 재사용)
- 관련 Plan/Design: `word-connection-game.plan.md`, `word-connection-game.design.md` (싱글플레이 기준 문서)

---

## 2. Scope

### 2.1 In Scope

- [ ] Node.js + Express + Socket.IO 서버 (룸 생성/참가, 라운드 진행, 정답 판정, 순위 계산을 서버가 authoritative하게 처리)
- [ ] 방 생성: 닉네임 입력 → 4자리 방 코드 발급, 방장 지정
- [ ] 방 참가: 닉네임 + 방 코드 입력으로 기존 방 입장 (인원 제한 2~8명)
- [ ] 방장 전용 "게임 시작" 트리거 → 서버가 카테고리/보드(글자 배열)를 생성해 방의 모든 참가자에게 동일하게 브로드캐스트
- [ ] 실시간 정답 판정: 참가자가 정답을 제출하면 서버가 검증 후 **가장 먼저 제출한 사람에게만** 점수 부여, 결과를 방 전체에 브로드캐스트, 즉시 다음 라운드로 전환
- [ ] 60초 타이머는 서버가 관리, 종료 시 전원에게 최종 순위표(닉네임 내림차순 점수) 브로드캐스트
- [ ] 방장 퇴장/연결 종료 시 다음 참가자에게 방장 위임, 참가자가 0명이 되면 방 자동 정리
- [ ] 신규 멀티플레이 클라이언트 페이지 (`public/index.html`) — 닉네임/방 코드 입력 화면 + 기존 게임 보드 UI/애니메이션 재사용
- [ ] Dockerfile + docker-compose.yml — `docker compose up`으로 서버 기동, 정적 클라이언트 파일도 같은 Express 서버가 서빙

### 2.2 Out of Scope

- 로그인/회원가입, 사용자 인증
- 리더보드/전적의 영구 저장(DB) — 이번 범위는 메모리(인메모리) 상태만 사용, 서버 재시작 시 초기화됨
- 재접속/네트워크 끊김 시 게임 상태 복구
- 로비 대기실/자동 매칭메이킹 (방 코드 수동 공유 방식만 지원)
- 모바일 터치 지원, HTTPS/TLS 인증서 발급(운영 배포 시 별도 처리 필요)
- 부정 방지(anti-cheat) — 클라이언트가 조작된 값을 보내는 것에 대한 방어는 하지 않음 (지인 간 캐주얼 플레이 전제)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 닉네임 입력 후 방을 생성하면 4자리 방 코드가 발급되고 생성자가 방장이 된다 | High | Pending |
| FR-02 | 닉네임 + 방 코드로 기존 방에 참가할 수 있다 (최대 8명, 최소 2명부터 시작 가능) | High | Pending |
| FR-03 | 방장이 "게임 시작"을 누르면 서버가 생성한 동일한 카테고리·보드가 방의 모든 참가자에게 동시에 표시된다 | High | Pending |
| FR-04 | 여러 참가자가 동시에 정답을 제출해도 서버가 가장 먼저 도착한 제출만 정답으로 인정하고 해당 참가자에게만 점수를 준다 | High | Pending |
| FR-05 | 한 라운드가 풀리면(정답자 발생) 즉시 모든 참가자 화면이 다음 라운드(새 보드)로 전환된다 | High | Pending |
| FR-06 | 60초 타이머 종료 시 전원에게 닉네임별 최종 점수 순위표가 표시된다 | High | Pending |
| FR-07 | 방장이 나가면 다음 참가자에게 방장 권한이 자동 위임되고, 방에 아무도 없으면 방이 정리(삭제)된다 | Medium | Pending |
| FR-08 | `docker compose up` 한 번으로 서버(+ 클라이언트 정적 파일 서빙)가 기동되어 브라우저로 접속할 수 있다 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Concurrency | 동일 라운드에 대한 동시 정답 제출 시 정확히 1명만 승자로 처리되어야 함 (race condition 없음) | 서버 측 라운드 상태를 단일 in-memory 객체로 관리하고 "이미 풀림" 플래그를 최초 처리 시 즉시 세팅 |
| Portability | 별도 설치 없이 Docker가 있는 환경이면 어디서나 동일하게 기동 | `docker compose up` 실행 확인 |
| Latency | 로컬/사내망 기준 정답 판정~브로드캐스트가 체감상 즉시(수백 ms 이내) 이루어짐 | Socket.IO 이벤트 왕복 시간 수동 확인 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] 위 8개 In-Scope 기능 모두 구현
- [ ] 2개 이상의 브라우저 탭(서로 다른 닉네임)으로 같은 방 코드에 입장해 동시 플레이 가능함을 수동 확인
- [ ] 동시에 같은 정답을 제출했을 때 한쪽만 점수를 받는지 확인
- [ ] `docker compose up`으로 서버가 기동되고, 다른 PC에서도 IP로 접속 가능함을 확인

### 4.2 Quality Criteria

- [ ] 서버 콘솔에 처리되지 않은 예외(unhandled exception)가 발생하지 않음
- [ ] 방장 이탈/참가자 이탈 시 서버가 죽지 않고 정상적으로 방 상태를 정리함

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 동시 정답 제출 시 이중 채점(두 명 모두 점수 획득) | High | Medium | 라운드별 "solved" 플래그를 서버 메모리에서 동기적으로 체크 후 세팅(Node.js 이벤트 루프의 단일 스레드 특성을 이용해 race condition 회피) |
| 클라이언트가 서버 대신 자체적으로 보드를 생성해 참가자 간 화면이 어긋남 | Medium | Medium | 보드(글자 배열)는 반드시 서버가 1회 생성해 Socket.IO로 브로드캐스트, 클라이언트는 받은 배열을 그대로 렌더링만 함 |
| 방장이 이탈하면 방이 좀비 상태로 남음 | Medium | Low | Socket.IO `disconnect` 이벤트에서 방장 위임/빈 방 정리 로직을 항상 실행 |
| Docker 환경에서 포트 충돌 | Low | Low | docker-compose.yml에서 호스트 포트를 명시적으로 노출하고 README에 변경 방법 안내 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `server/` (신규 디렉터리) | Node.js 서버 | Express + Socket.IO 서버, 룸/라운드 상태 관리 |
| `server/public/index.html` (신규) | 클라이언트 정적 파일 | `word_connection_game_v2.html`의 사전/스타일/판정 UX를 재사용해 멀티플레이용으로 재구성 |
| `Dockerfile`, `docker-compose.yml` (신규) | 배포 설정 | 서버 컨테이너 빌드/실행 정의 |
| `word_connection_game_v2.html` (기존) | 정적 HTML | 변경 없음 (싱글플레이 버전으로 계속 독립 사용 가능) |

### 6.2 Current Consumers

- 없음 — 완전히 새로운 서버/클라이언트를 추가하는 것이며, 기존 싱글플레이 파일이나 다른 코드에 영향을 주지 않음

### 6.3 Verification

- [ ] 기존 `word_connection_game_v2.html`은 이번 변경과 무관하게 그대로 단독 실행됨을 확인
- [ ] 신규 서버/클라이언트가 별도 경로(`server/`)에 격리되어 있어 기존 파일과 충돌하지 않음을 확인

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| Starter | 정적 구조 | 백엔드 없는 사이트 | ☐ |
| **Dynamic** | 기능 단위 모듈, 자체 백엔드/실시간 서버 | 백엔드가 있는 웹앱 | ☑ |
| Enterprise | 마이크로서비스, 엄격한 계층 분리 | 대규모 트래픽 시스템 | ☐ |

> 이 프로젝트는 bkend.ai BaaS를 사용하지 않는 **자체 Node.js 서버**이므로 Dynamic 레벨의 "BaaS 연동" 항목은 해당 없음(N/A) — 대신 자체 실시간 서버로 대체한다.

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| 서버 프레임워크 | Express / Fastify / Koa | Express | 가장 널리 쓰이고 Socket.IO와의 통합 예제가 풍부해 유지보수 용이 |
| 실시간 통신 | Socket.IO / 순수 WebSocket / SSE | Socket.IO | 룸(room) 기능이 내장되어 있어 방 단위 브로드캐스트 구현이 간단함 |
| 상태 저장소 | 메모리 / Redis / DB | 메모리(in-memory Map) | 사용자가 영구 저장 불필요를 선택 — 서버 프로세스 하나로 충분, Docker 구성이 단순해짐 |
| 정답 판정 권한 | 클라이언트 판정 / 서버 판정 | 서버(authoritative) | 동시 제출 시 단일 승자 보장을 위해 반드시 서버가 유일한 판정자여야 함 |
| 배포 | Docker 단일 컨테이너 / docker-compose 다중 서비스 | docker-compose (앱 서비스 1개) | 메모리 저장소만 쓰므로 DB 컨테이너 불필요, 향후 Redis 추가 시 compose에 서비스만 추가하면 되도록 여지를 둠 |

### 7.3 Clean Architecture Approach

```
Selected Level: Dynamic (자체 실시간 서버, BaaS 미사용)

server/
├── src/
│   ├── server.js        # Express 앱 + HTTP 서버 + Socket.IO 초기화, 정적 파일 서빙
│   ├── dictionary.js     # word_connection_game_v2.html의 dictionary를 서버 공용 모듈로 이관
│   ├── roomManager.js    # 방 생성/참가/퇴장, 방장 위임, 방 목록(in-memory Map)
│   ├── roundEngine.js    # 라운드 생성(보드/타깃단어), 정답 판정(authoritative), 타이머
│   └── socketHandlers.js # Socket.IO 이벤트 바인딩 (createRoom/joinRoom/startGame/submitAnswer 등)
├── public/
│   └── index.html         # 멀티플레이 클라이언트 (닉네임/방코드 입력 + 게임 보드 UI)
├── package.json
├── Dockerfile
└── docker-compose.yml
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [ ] `CLAUDE.md` 없음 — 이번 Plan 문서와 Design 문서가 컨벤션의 기준이 됨
- [ ] 기존 프로젝트에 Node.js 컨벤션 없음 (신규 도입)
- [ ] ESLint/Prettier/TypeScript 미사용 — 순수 JavaScript(CommonJS)로 단순하게 시작

### 8.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| **Naming** | 없음 | 파일 camelCase(`roomManager.js`), Socket.IO 이벤트명 camelCase(`createRoom`, `submitAnswer`) | High |
| **폴더 구조** | 없음 | `server/src`, `server/public` (7.3 참조) | High |
| **에러 처리** | 없음 | 모든 Socket.IO 핸들러는 try/catch로 감싸고 실패 시 해당 소켓에만 `errorMessage` 이벤트 전송 (서버 전체가 죽지 않도록) | High |

### 8.3 Environment Variables Needed

| Variable | Purpose | Scope | To Be Created |
|----------|---------|-------|:-------------:|
| `PORT` | 서버가 리스닝할 포트 (기본 3000) | Server | ☑ |

### 8.4 Pipeline Integration

N/A — 9-phase Development Pipeline 미사용.

---

## 9. Next Steps

1. [ ] 설계 문서 작성 (`word-connection-multiplayer.design.md`) — Socket.IO 이벤트 명세, 룸/라운드 상태 모델, 클라이언트 화면 흐름 상세화
2. [ ] 사용자 확인
3. [ ] 구현 시작 (`server/` 디렉터리 + Dockerfile/docker-compose.yml)

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-08-23 | Initial draft (실시간 멀티플레이, Node.js+Socket.IO, 메모리 저장, 방코드 입장 확정) | cupid4rang |
