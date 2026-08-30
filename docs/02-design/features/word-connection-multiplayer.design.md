---
template: design
version: 1.3
---

# word-connection-multiplayer Design Document

> **파일 이름 안내 (2026-08-30 통합)** — 이 문서에 나오는 `word_connection_game_v2.html` 은
> 지금은 **`word_connection_game.html`** 입니다. v2 의 내용을 원래 파일로 옮기고 v2 는 없앴습니다.
> 아래 본문은 당시 결정을 그대로 남겨 둔 기록이라 예전 이름을 그대로 씁니다.


> **Summary**: Node.js + Express + Socket.IO 기반 실시간 멀티플레이 서버를 클린 아키텍처(Domain/Application/Infrastructure/Presentation 완전 분리)로 설계하고, Socket.IO 이벤트 명세와 방/라운드 상태 모델을 정의한다.
>
> **Project**: word_connection_game
> **Version**: 0.2
> **Author**: cupid4rang
> **Date**: 2026-08-23
> **Status**: Draft
> **Planning Doc**: [word-connection-multiplayer.plan.md](../../01-plan/features/word-connection-multiplayer.plan.md)

> **Pipeline**: 9-phase Development Pipeline 미사용 — Pipeline References 표는 생략(N/A).

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 싱글플레이 정적 페이지에는 여러 사람이 실시간으로 같은 판을 두고 경쟁할 방법이 전혀 없음 |
| **WHO** | 방 코드를 공유받아 함께 플레이하는 지인 그룹(2~8명), 방장이 방을 만들고 시작을 트리거 |
| **RISK** | 동시 정답 제출 시 이중 채점 위험 → 서버가 유일한 정답 판정 권한(authoritative)을 가짐. 클라이언트 조작 부정행위 방지는 Out of Scope |
| **SUCCESS** | (1) 방 생성/방코드 입장 (2) 방장 시작 시 전원 동일 보드 브로드캐스트 (3) 먼저 맞힌 사람만 득점, 즉시 다음 라운드 (4) 60초 종료 시 전원 동일 순위표 (5) `docker compose up`으로 정상 기동 |
| **SCOPE** | 신규 Node.js 서버(Express+Socket.IO) + 신규 멀티플레이 클라이언트(`public/index.html`) + Dockerfile/docker-compose.yml. 로그인·영구DB·재접속 복구·매칭메이킹·부정방지는 Out of Scope |

> **Design Anchor**: Pencil MCP 미사용 — 클라이언트는 기존 `word_connection_game_v2.html`의 CSS 변수·클레이모픽 스타일·애니메이션 클래스를 그대로 재사용하므로 별도 Design Anchor 캡처는 생략.

---

## 1. Overview

### 1.1 Design Goals

- 정답 판정을 100% 서버 권한으로 두어 동시 제출 시에도 정확히 1명만 승자가 되도록 한다.
- Socket.IO 어댑터, 저장소 구현을 도메인/애플리케이션 로직과 분리해 향후 Redis 등으로 저장소를 교체하더라도 게임 규칙 코드는 건드리지 않도록 한다.
- 클라이언트는 기존 싱글플레이 게임의 시각적 판정 피드백(컨페티/플로팅텍스트/쉐이크 등)을 최대한 재사용해 개발량을 줄인다.

### 1.2 Design Principles

- **의존성 역전**: Application 계층은 구체적인 Socket.IO나 메모리 저장소가 아니라, 자신이 정의한 포트(인터페이스 역할의 JS 객체 계약)에만 의존한다.
- **단일 진실 공급원**: 라운드의 정답(`targetWords`)과 "이미 풀렸는가" 상태는 서버 메모리에만 존재하며 클라이언트로 절대 전송하지 않는다.
- **작은 이벤트 계약**: Socket.IO 이벤트는 `도메인:행위` 네이밍(`room:create`, `round:result` 등)으로 통일해 클라이언트/서버 양쪽에서 추적하기 쉽게 한다.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | server.js 한 파일에 방/라운드/소켓 로직 전부 작성 | Domain/Application/Infrastructure/Presentation 완전 분리 | dictionary/roomManager/roundEngine/socketHandlers 4개 모듈로만 분리 |
| **New Files** | 2~3 | 10+ | 5~6 |
| **Complexity** | Low | High | Medium |
| **Maintainability** | Medium | High (저장소 교체 용이) | High |
| **Effort** | Low | High | Medium |
| **Risk** | Low (결합도 높음) | Low (구조 깔끔, 초기 작업량 큼) | Low (균형) |
| **Recommendation** | 빠른 프로토타입 | 장기 유지보수/확장 | 기본 권장 |

**Selected**: **Option B — Clean Architecture** — **Rationale**: 사용자가 명시적으로 선택. Domain(순수 게임 규칙) / Application(유스케이스) / Infrastructure(Socket.IO, 메모리 저장소) / Presentation(소켓 이벤트 바인딩) 4계층으로 분리해, 추후 Redis 저장소 교체나 다른 실시간 전송 방식(SSE 등) 도입 시에도 게임 규칙 코드는 변경 없이 재사용 가능하게 한다.

> 이하 상세 설계는 Option B(클린 아키텍처) 기준으로 작성됨.

### 2.1 Component Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                            server/src                              │
│                                                                     │
│  [Presentation]   socketHandlers.js                                │
│                      └─ io.on('connection', ...) 이벤트 바인딩,      │
│                         Application 유스케이스 호출 + ack/브로드캐스트 │
│                              │                                     │
│                              ▼                                     │
│  [Application]    RoomService.js       RoundService.js             │
│                      └─ createRoom/       └─ startGame/             │
│                         joinRoom/            submitAnswer/          │
│                         leaveRoom            tick/endGame           │
│                      (RoomRepositoryPort, BroadcasterPort 에만 의존) │
│                              │                                     │
│                              ▼                                     │
│  [Domain]         Room.js / Player.js / Round.js / dictionary.js   │
│                      └─ 순수 엔티티 + 게임 규칙 (I/O 없음)             │
│                              ▲                                     │
│                              │ implements ports                    │
│  [Infrastructure] InMemoryRoomRepository.js                        │
│                    SocketIOBroadcaster.js                          │
│                    roomCodeGenerator.js                            │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
[클라이언트 A] room:create → socketHandlers → RoomService.createRoom()
  → Room 엔티티 생성 → InMemoryRoomRepository.save() → ack(roomCode)

[클라이언트 B] room:join(roomCode) → RoomService.joinRoom()
  → Room.addPlayer() (도메인 규칙: 8명 초과/이미 시작됨 검증)
  → SocketIOBroadcaster.toRoom(roomCode, 'room:players', ...)

[방장] game:start → RoundService.startGame()
  → Round 생성(카테고리/보드/정답단어, 정답단어는 서버 메모리에만 보관)
  → SocketIOBroadcaster.toRoom(roomCode, 'round:started', { board })
  → 1초 간격 타이머 → 'game:tick' 브로드캐스트

[여러 클라이언트] answer:submit(word) → RoundService.submitAnswer()
  → Round.checkAnswer(word) (순수 함수, "이미 풀림" 여부까지 판정)
  → 정답+최초 제출: Room.currentPlayer 점수 증가 → 'round:result' 브로드캐스트
     → 다음 Round 생성 → 'round:started' 브로드캐스트
  → 오답/이미 풀림: 제출자에게만 ack로 결과 반환 (브로드캐스트 없음)

타이머 0 도달 → RoundService.endGame() → 'game:over' 브로드캐스트
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| socketHandlers.js | RoomService, RoundService | 소켓 이벤트를 유스케이스 호출로 변환, 결과를 ack/브로드캐스트로 응답 |
| RoomService, RoundService | RoomRepositoryPort, BroadcasterPort (추상), Domain 엔티티 | 유스케이스 로직만 담당, 구체 구현을 모름 (의존성 역전) |
| InMemoryRoomRepository | (Domain 엔티티 타입만) | RoomRepositoryPort 구현체 — `Map<roomCode, Room>` |
| SocketIOBroadcaster | Socket.IO `io` 인스턴스 | BroadcasterPort 구현체 — `io.to(roomCode).emit(...)` 래핑 |
| Room, Player, Round, dictionary | (없음) | 외부 의존성 없는 순수 도메인 로직/데이터 |

---

## 3. Data Model

> DB를 사용하지 않으므로 "데이터 모델"은 서버 메모리(in-memory) 상의 도메인 엔티티 구조다. 3.3 SQL 스키마는 N/A.

### 3.1 Domain Entities

```typescript
// Room.js
interface Room {
  code: string;                 // 4자리 방 코드 (예: "7GHQ")
  hostId: string;                // 현재 방장 playerId(=socket.id)
  players: Map<string, Player>;  // playerId -> Player
  status: 'waiting' | 'playing' | 'ended';
  settings: { blockCount: number; wordLength: number; category: string | 'random' };
  currentRound: Round | null;
  timerHandle: NodeJS.Timeout | null;
  timeLeft: number;              // 남은 초 (기본 60)
  createdAt: number;
}

// Player.js
interface Player {
  id: string;       // socket.id
  nickname: string; // 최대 10자, textContent로만 렌더링(XSS 방지)
  score: number;
  connected: boolean;
}

// Round.js
interface Round {
  roundIndex: number;
  category: string;
  targetWords: [string, string]; // 서버 메모리에만 존재, 클라이언트로 절대 전송 안 함
  board: string[];               // 셔플된 글자 배열 — 클라이언트로 전송해 그대로 렌더링
  solved: boolean;                // 동시 제출 race condition 가드 플래그
}
```

### 3.2 Entity Relationships

```
[Room] 1 ──── N [Player]   (players: Map)
   │
   └── 1 ──── 1 [Round]     (currentRound, 라운드마다 교체됨)
```

### 3.3 Database Schema

N/A — 인메모리 저장소(Plan §7.2에서 확정)만 사용. `InMemoryRoomRepository`가 `Map<string, Room>`으로 전체 상태를 보관하며, 서버 프로세스 재시작 시 초기화된다.

### 3.4 Ports (Application이 정의하는 추상 계약)

```javascript
// application/ports.js — JSDoc으로 계약만 정의 (TypeScript 미사용)

/**
 * @typedef {Object} RoomRepositoryPort
 * @property {(room: Room) => void} save
 * @property {(code: string) => Room | undefined} findByCode
 * @property {(code: string) => void} delete
 * @property {() => Room[]} findAll
 */

/**
 * @typedef {Object} BroadcasterPort
 * @property {(roomCode: string, event: string, payload: any) => void} toRoom
 * @property {(playerId: string, event: string, payload: any) => void} toPlayer
 */
```

---

## 4. API Specification (Socket.IO Event Catalog)

> REST API는 없음(정적 파일 서빙 제외). 실시간 통신은 전부 Socket.IO 이벤트로 이루어진다.

### 4.1 Client → Server (콜백 ack 포함)

| Event | Payload | Ack Response | Description |
|-------|---------|---------------|-------------|
| `room:create` | `{ nickname: string }` | `{ ok:true, roomCode, playerId }` \| `{ ok:false, error }` | 방 생성, 생성자가 방장이 됨 |
| `room:join` | `{ nickname: string, roomCode: string }` | `{ ok:true, roomCode, playerId, players, hostId, settings }` \| `{ ok:false, error }` | 기존 방에 참가 |
| `game:start` | `{ blockCount:number, wordLength:number, category:string }` | `{ ok:true }` \| `{ ok:false, error }` | 방장 전용. 게임 시작 |
| `answer:submit` | `{ word: string }` | `{ ok:true, correct:boolean, alreadySolved?:boolean }` | 정답 제출 (제출자에게만 즉시 응답) |
| `game:restart` | `{}` | `{ ok:true }` \| `{ ok:false, error }` | 방장 전용. 게임오버 후 재시작 (game:start 재사용) |

### 4.2 Server → Room Broadcast

| Event | Payload | When |
|-------|---------|------|
| `room:players` | `{ players: [{id,nickname,score,connected}], hostId }` | 참가/퇴장/방장 변경 시마다 |
| `game:started` | `{ category, blockCount, wordLength }` | 방장이 게임 시작 시 |
| `round:started` | `{ board: string[], roundIndex: number }` | 새 라운드 시작 시 (게임 시작 직후 및 정답 발생 직후) |
| `round:result` | `{ winnerId, winnerNickname, word, players:[{id,nickname,score}] }` | 누군가 정답을 맞혔을 때 |
| `game:tick` | `{ timeLeft: number }` | 1초마다 |
| `game:over` | `{ players:[{id,nickname,score}] }` (점수 내림차순 정렬됨) | 60초 타이머 종료 시 |
| `error:notice` | `{ message: string }` | 특정 플레이어에게만: 잘못된 행동(방 없음, 방 꽉 참 등) 안내 |

### 4.3 상세 예시 — `answer:submit` 처리 흐름

**요청 (클라이언트 → 서버):**
```json
{ "word": "사과" }
```

**정답 & 최초 제출인 경우:**
1. 제출자에게 ack: `{ "ok": true, "correct": true }`
2. 방 전체에 브로드캐스트: `round:result` → `{ "winnerId": "abc123", "winnerNickname": "철수", "word": "사과", "players": [...] }`
3. 약 2초 후 방 전체에 `round:started` → 새 보드

**오답이거나 이미 다른 사람이 먼저 맞힌 경우:**
- 제출자에게만 ack: `{ "ok": true, "correct": false, "alreadySolved": true }` (브로드캐스트 없음 — 다른 플레이어의 게임 진행을 방해하지 않음)

---

## 5. UI/UX Design

### 5.1 Screen Layout

```
[1] 로비 화면
┌────────────────────────────┐
│ 🍭 단어 연결 게임 (멀티) 🍬     │
│  닉네임: [        ]         │
│  [🏠 방 만들기]               │
│  방 코드: [    ]  [🚪 참가하기] │
└────────────────────────────┘

[2] 대기실 화면
┌────────────────────────────┐
│ 방 코드: 7GHQ  (공유하세요)     │
│ 참가자: 철수(방장) 영희 민수      │
│ [▶ 게임 시작] (방장만 활성화,     │
│               2명 이상일 때만)  │
└────────────────────────────┘

[3] 게임 화면 (기존 v2 스타일 재사용 + 확장)
┌────────────────────────────┐
│ 🎯제시어 ⏱ 남은시간            │
│ 🏆 실시간 순위: 철수2 영희1 민수0 │
│  (보드 + 캔버스 라인, 기존과 동일) │
│  "🎉 철수님 정답! 사과"          │
│      (라운드 결과 플로팅)        │
└────────────────────────────┘

[4] 게임오버 화면 (모달, 기존 modal-card 재사용)
┌────────────────────────────┐
│ 🏁 게임 종료!                  │
│ 1위 철수 5점                  │
│ 2위 영희 3점                  │
│ 3위 민수 1점                  │
│ [🔁 다시하기](방장) [닫기]        │
└────────────────────────────┘
```

### 5.2 User Flow

```
로비(닉네임 입력) → [방 만들기] → 대기실(방코드 공유) → [게임 시작(방장)]
                  → [방 코드로 참가] → 대기실 →
  → 게임 화면(공유 보드, 실시간 순위) → 정답 시도 반복 → 60초 종료
  → 게임오버 모달(최종 순위) → [다시하기(방장)] → 게임 화면으로 복귀
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `NetworkManager` | `public/index.html` `<script>` | `socket.io-client` 연결, 이벤트 emit/on 래핑 (Infrastructure adapter 역할) |
| `GameState` (client) | `public/index.html` `<script>` | 클라이언트 로컬 상태(내 playerId, players 목록, board, timeLeft 등) — 서버 상태의 read-only 사본 |
| `UIManager` (client) | `public/index.html` `<script>` | 로비/대기실/게임/게임오버 화면 전환, 보드 렌더링, 순위 표시, 기존 v2의 토스트/컨페티/플로팅텍스트 재사용 |
| `LobbyController`, `GameController` (client) | `public/index.html` `<script>` | 사용자 입력(버튼 클릭, 드래그)을 NetworkManager emit 호출로 변환 |

### 5.4 Page UI Checklist

#### 로비 화면
- [ ] Input: 닉네임 (최대 10자, 필수)
- [ ] Button: 🏠 방 만들기 (닉네임 미입력 시 비활성화)
- [ ] Input: 방 코드 (4자)
- [ ] Button: 🚪 참가하기

#### 대기실 화면
- [ ] Text: 방 코드 표시 (복사 가능하도록 클릭 시 클립보드 복사)
- [ ] List: 참가자 닉네임 목록 (방장은 👑 아이콘 표시)
- [ ] Button: ▶ 게임 시작 — 방장에게만 표시, 참가자 2명 미만이면 비활성화 + 안내 문구
- [ ] Settings: 블록 개수/글자수/카테고리 선택 (싱글플레이 v2의 설정 모달 재사용)

#### 게임 화면
- [ ] Status card: 실시간 순위 (닉네임 + 점수, 점수 내림차순, 본인은 강조 표시)
- [ ] Status card: 남은 시간 (`game:tick` 수신마다 갱신)
- [ ] Status card: 제시어(카테고리)
- [ ] Board: 기존 v2와 동일한 블록 드래그 UI (단, 보드 배열은 서버가 보낸 값을 그대로 사용)
- [ ] Floating text: 라운드 결과 알림 ("🎉 {닉네임}님 정답! {단어}") — `round:result` 수신 시 전원에게 표시
- [ ] Toast: 오답/이미 풀림 안내 — 제출자 본인에게만 표시

#### 게임오버 모달
- [ ] Ranking list: 순위 · 닉네임 · 점수 (1위 강조)
- [ ] Button: 🔁 다시하기 — 방장에게만 표시
- [ ] Button: 닫기 — 대기실로 복귀

---

## 6. Error Handling

### 6.1 에러 코드 정의 (Socket.IO `error:notice` / ack의 `error` 필드)

| Code | Message | Cause | Handling |
|------|---------|-------|----------|
| `ROOM_NOT_FOUND` | 존재하지 않는 방 코드예요 | 잘못된 방 코드 입력 | 클라이언트에서 토스트로 안내, 로비 화면 유지 |
| `ROOM_FULL` | 방이 가득 찼어요 (최대 8명) | 9번째 참가 시도 | 참가 거부, 토스트 안내 |
| `GAME_ALREADY_STARTED` | 이미 게임이 진행 중인 방이에요 | 진행 중인 방에 신규 참가 시도 | 참가 거부, 토스트 안내 |
| `NOT_HOST` | 방장만 할 수 있어요 | 방장이 아닌 사람이 `game:start`/`game:restart` 시도 | 서버에서 무시 + 에러 반환 |
| `NOT_ENOUGH_PLAYERS` | 최소 2명 이상이어야 시작할 수 있어요 | 1명일 때 시작 시도 | 시작 버튼 비활성화 + 서버도 재검증 |
| `INVALID_NICKNAME` | 닉네임을 입력해주세요 (1~10자) | 빈 값/과도한 길이 | 클라이언트+서버 양쪽에서 검증 |

### 6.2 연결 종료(disconnect) 처리

| 상황 | 처리 |
|------|------|
| 참가자가 연결 종료 | Room에서 제거, `room:players` 브로드캐스트로 갱신 |
| 방장이 연결 종료 | `players` 목록의 다음 사람에게 `hostId` 위임 후 `room:players` 브로드캐스트 |
| 방에 아무도 남지 않음 | 진행 중이던 타이머(`timerHandle`) 정리 후 Room을 저장소에서 즉시 delete |

### 6.3 에러 응답 포맷

```json
{ "ok": false, "error": { "code": "ROOM_NOT_FOUND", "message": "존재하지 않는 방 코드예요" } }
```

---

## 7. Security Considerations

- [ ] 닉네임은 항상 `textContent`로만 DOM에 삽입 (innerHTML 금지) → 사용자 입력 기반 XSS 방지
- [ ] 닉네임 길이(1~10자), 방 코드 형식(영숫자 4자) 서버 측 검증 — 클라이언트 검증만 믿지 않음
- [ ] 로그인/인증 없음 — 민감정보 저장하지 않음 (닉네임+점수만 메모리에 보관, 게임 종료 후에도 방이 삭제되면 사라짐)
- [ ] Rate limiting: 이번 범위에서는 지인 간 소규모 캐주얼 플레이 전제로 별도 구현하지 않음 (Plan §2.2 Out of Scope)
- [ ] 정답 판정은 전적으로 서버 권한이므로, 클라이언트가 임의로 점수를 조작해 보내는 방식의 부정행위는 불가능 (단, 클라이언트가 `answer:submit`을 스크립트로 스팸 호출하는 것 자체를 막지는 않음 — Out of Scope)

---

## 8. Test Plan

> 자동화된 테스트 러너는 두지 않고, Do 단계 구현 직후 **여러 브라우저 탭을 이용한 수동 멀티플레이 QA**로 검증한다.

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| 수동 멀티탭 테스트 | 방 생성/참가/게임 진행 전체 흐름 | Chrome 여러 탭(시크릿 창 포함) | Do |
| Docker 기동 테스트 | `docker compose up` | 터미널 + 브라우저 접속 | Do |

### 8.2 수동 테스트 시나리오

| # | 시나리오 | 절차 | 성공 기준 |
|---|---------|------|----------|
| 1 | 방 생성/참가 | 탭 A에서 방 생성 → 탭 B/C에서 같은 코드로 참가 | 3개 탭 모두 동일한 참가자 목록을 봄 |
| 2 | 방 꽉 참 | 9번째 참가 시도 | `ROOM_FULL` 에러, 참가 거부 |
| 3 | 게임 시작 브로드캐스트 | 방장이 시작 클릭 | 모든 탭이 **동일한 글자 배열**의 보드를 동시에 봄 |
| 4 | 동시 정답 제출 | 두 탭에서 거의 동시에 같은 정답 제출 | 정확히 한 탭만 점수 획득 + 승자 브로드캐스트가 모두에게 일관되게 표시 |
| 5 | 오답 처리 | 한 탭에서 오답 제출 | 해당 탭에만 오답 피드백, 다른 탭은 영향 없음 |
| 6 | 라운드 전환 | 정답 발생 후 대기 | 약 2초 후 전원 새 보드로 동시 전환 |
| 7 | 타이머 종료 | 60초 경과 | 전원에게 동일한 최종 순위 모달 표시 |
| 8 | 방장 이탈 | 방장 탭을 닫음 | 남은 참가자 중 한 명에게 방장 자동 위임 |
| 9 | Docker 기동 | `docker compose up` 실행 | 컨테이너 정상 기동, `localhost:PORT`로 로비 화면 접속 성공 |

### 8.3 Seed Data Requirements

N/A — 별도 시드 데이터 불필요 (Domain의 `dictionary.js`가 정적 데이터, 기존 `word-connection-game.design.md` §3.1의 8개 카테고리/159단어를 그대로 이관).

---

## 9. Clean Architecture

### 9.1 Layer Structure

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Domain** | 순수 게임 규칙과 엔티티 (I/O 없음) | `server/src/domain/` — `Room.js`, `Player.js`, `Round.js`, `dictionary.js` |
| **Application** | 유스케이스 오케스트레이션 (Port에만 의존) | `server/src/application/` — `RoomService.js`, `RoundService.js`, `ports.js` |
| **Infrastructure** | Port 구현체 (Socket.IO, 메모리 저장소) | `server/src/infrastructure/` — `InMemoryRoomRepository.js`, `SocketIOBroadcaster.js`, `roomCodeGenerator.js` |
| **Presentation** | 소켓 이벤트 ↔ 유스케이스 변환 | `server/src/presentation/socketHandlers.js` |

### 9.2 Dependency Rules

```
┌─────────────────────────────────────────────────────────────┐
│                    Dependency Direction                      │
├─────────────────────────────────────────────────────────────┤
│  Presentation ──→ Application ──→ Domain                     │
│                        │              ▲                      │
│                        └──→ Ports ────┘ (인터페이스, Domain과 무관) │
│                                ▲                              │
│                         Infrastructure (Port 구현)             │
│                                                                │
│  규칙: Domain은 다른 어떤 계층도 참조하지 않는다 (순수).            │
│        Application은 Infrastructure의 "구체 클래스"를 직접        │
│        import하지 않고, server.js(합성 루트)가 생성자 주입으로     │
│        Infrastructure 구현체를 Application에 전달한다.            │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 File Import Rules

| From | Can Import | Cannot Import |
|------|-----------|---------------|
| Presentation (`socketHandlers.js`) | Application | Infrastructure, Domain 직접 |
| Application (`RoomService`, `RoundService`) | Domain, `ports.js` (타입 계약) | Infrastructure 구체 클래스, Presentation |
| Infrastructure (`InMemoryRoomRepository`, `SocketIOBroadcaster`) | Domain (엔티티 타입 참조만) | Application, Presentation |
| Domain (`Room`, `Player`, `Round`, `dictionary`) | (없음) | 다른 모든 계층 |
| `server.js` (합성 루트) | 전체 계층 | — (유일하게 모든 계층을 알고 있는 곳, 의존성 주입 담당) |

### 9.4 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| `Room`, `Player`, `Round` | Domain | `server/src/domain/` |
| `dictionary` (기존 v2 사전 이관) | Domain | `server/src/domain/dictionary.js` |
| `RoomService`, `RoundService` | Application | `server/src/application/` |
| `InMemoryRoomRepository` | Infrastructure | `server/src/infrastructure/InMemoryRoomRepository.js` |
| `SocketIOBroadcaster` | Infrastructure | `server/src/infrastructure/SocketIOBroadcaster.js` |
| `socketHandlers` | Presentation | `server/src/presentation/socketHandlers.js` |
| `server.js` | 합성 루트(Composition Root) | `server/src/server.js` |
| `public/index.html` (NetworkManager/UIManager/GameState) | 클라이언트(별도 애플리케이션) | `server/public/index.html` |

---

## 10. Coding Convention Reference

### 10.1 Naming Conventions

| Target | Rule | Example |
|--------|------|---------|
| 클래스/엔티티 | PascalCase | `Room`, `Player`, `Round`, `RoomService` |
| 함수/메서드 | camelCase | `createRoom()`, `checkAnswer()`, `assignNextHost()` |
| Socket.IO 이벤트 | `도메인:행위` (콜론 구분) | `room:create`, `round:result`, `game:tick` |
| 상수 | UPPER_SNAKE_CASE | `MAX_PLAYERS`, `MIN_PLAYERS_TO_START`, `ROUND_TRANSITION_DELAY_MS` |
| 파일 | camelCase.js (클래스 파일만 PascalCase.js) | `roomCodeGenerator.js`, `RoomService.js` |

### 10.2 Import Order

```javascript
// 1. Node 내장/외부 라이브러리
const express = require('express');
const { Server } = require('socket.io');

// 2. Domain
const { Room } = require('./domain/Room');

// 3. Application
const { RoomService } = require('./application/RoomService');

// 4. Infrastructure
const { InMemoryRoomRepository } = require('./infrastructure/InMemoryRoomRepository');

// 5. Presentation
const { registerSocketHandlers } = require('./presentation/socketHandlers');
```

### 10.3 Environment Variables

| Prefix | Purpose | Scope | Example |
|--------|---------|-------|---------|
| `PORT` | 서버 리스닝 포트 | Server | `PORT=3000` |

### 10.4 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| 모듈 시스템 | CommonJS(`require`) — TypeScript/ESM 빌드 도구 없이 Node.js에서 바로 실행 |
| 의존성 주입 | 생성자 주입 (`new RoomService(roomRepository, broadcaster)`), `server.js`가 유일한 합성 루트 |
| 에러 처리 | Application 계층은 결과 객체(`{ ok, error }`)를 반환, Presentation이 이를 ack/브로드캐스트로 변환. 예외를 throw하지 않아 소켓 핸들러가 항상 안전하게 응답 가능 |
| 클라이언트 재사용 | `public/index.html`은 `word_connection_game_v2.html`의 CSS/애니메이션 클래스를 그대로 복사해 재사용 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
server/
├── src/
│   ├── domain/
│   │   ├── Room.js
│   │   ├── Player.js
│   │   ├── Round.js
│   │   └── dictionary.js
│   ├── application/
│   │   ├── ports.js
│   │   ├── RoomService.js
│   │   └── RoundService.js
│   ├── infrastructure/
│   │   ├── InMemoryRoomRepository.js
│   │   ├── SocketIOBroadcaster.js
│   │   └── roomCodeGenerator.js
│   ├── presentation/
│   │   └── socketHandlers.js
│   └── server.js
├── public/
│   └── index.html
├── package.json
├── Dockerfile
└── docker-compose.yml
```

### 11.2 Implementation Order

1. [ ] `package.json` + 의존성(express, socket.io) 설치 스크립트 정의
2. [ ] Domain 계층: `dictionary.js`(기존 v2 사전 이관), `Player.js`, `Room.js`(addPlayer/removePlayer/isFull/canStart 규칙), `Round.js`(생성+`checkAnswer` 순수함수)
3. [ ] Application 계층: `ports.js`(계약 정의), `RoomService.js`, `RoundService.js`
4. [ ] Infrastructure 계층: `InMemoryRoomRepository.js`, `roomCodeGenerator.js`, `SocketIOBroadcaster.js`
5. [ ] Presentation 계층: `socketHandlers.js` (§4 이벤트 카탈로그 전체 구현)
6. [ ] `server.js`: Express 정적 서빙(`public/`) + HTTP 서버 + Socket.IO 초기화 + 의존성 주입 조립
7. [ ] `public/index.html`: 로비/대기실/게임/게임오버 4개 화면, 기존 v2 스타일·판정 피드백 재사용, `NetworkManager`로 Socket.IO 클라이언트 연동
8. [ ] `Dockerfile` + `docker-compose.yml` 작성
9. [ ] §8.2 수동 테스트 시나리오 9개 전체 확인 (`docker compose up` 포함)

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| Domain + Application | `module-1` | 게임 규칙/유스케이스 (Room/Player/Round/RoomService/RoundService) | 25-30 |
| Infrastructure + Presentation + server.js | `module-2` | Socket.IO 배선, 메모리 저장소, 서버 부트스트랩 | 25-30 |
| 클라이언트(public/index.html) | `module-3` | 로비/대기실/게임/게임오버 4개 화면 + NetworkManager | 25-30 |
| Docker 배포 | `module-4` | Dockerfile, docker-compose.yml, 기동 검증 | 10-15 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| Session 1 | Plan + Design | 전체 (완료) | - |
| Session 2 | Do | `--scope module-1,module-2` | 40-50 |
| Session 3 | Do | `--scope module-3` | 30-40 |
| Session 4 | Do | `--scope module-4` | 15-20 |
| Session 5 | Check + Report | 전체 | 20-25 |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-08-23 | Initial draft (Option B 클린 아키텍처, Socket.IO 이벤트 카탈로그 확정) | cupid4rang |
