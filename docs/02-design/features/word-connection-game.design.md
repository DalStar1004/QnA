---
template: design
version: 1.3
---

# word-connection-game Design Document

> **파일 이름 안내 (2026-08-30 통합)** — 이 문서에 나오는 `word_connection_game_v2.html` 은
> 지금은 **`word_connection_game.html`** 입니다. v2 의 내용을 원래 파일로 옮기고 v2 는 없앴습니다.
> 아래 본문은 당시 결정을 그대로 남겨 둔 기록이라 예전 이름을 그대로 씁니다.

> **현재 코드와의 차이 안내 (2026-09-01 정리)** — 이 문서는 2026-08-23 설계 시점의 기록입니다.
> 그 뒤 바뀐 것 가운데 **지금 구조를 설명하는 부분(2장·3장·5.1·5.3·9장)은 현재 코드에 맞춰 고쳤고**,
> 그때의 결정과 진행 계획을 남긴 부분(Context Anchor, 2.0 아키텍처 비교, 8.2 테스트 시나리오,
> 11장 구현 순서)은 **기록이라 그대로 두고** 지금과 다른 곳에만 표시를 달았습니다.
>
> | 무엇이 | 설계 당시 | 지금 | 작업기록 |
> |---|---|---|---|
> | 블록 조작 | 드래그해서 선으로 잇기 | **왼쪽 클릭으로 고르고 오른쪽 클릭으로 완성** (다시 누르면 그 뒤가 되돌아감) | 045 · 046 |
> | 목표 글자 수 | 2~5 중 골라서 시작 | **기능 없음** — 카테고리의 단어면 길이와 상관없이 정답 | 001 |
> | 카테고리 | 8개 | **20개** + 파일(JSON/TXT/CSV)로 직접 추가 | 019 · 002 |
> | 게임 종류 | 혼자 하기 하나 | **모드 1 제시어 맞추기 · 모드 2 AI 스무고개 · 2인 대결 · 멀티플레이** | 006 · 028 · 033 |
> | 기록 | 최고 점수 하나 | **모드별 최고 점수 + 모드별 닉네임 랭킹(명예의 전당)** | 042 |


> **Summary**: `word_connection_game.html`을 참조하여 사전 확장·게임오버 모달·최고점수·효과음·카테고리 선택·콤보 보너스를 추가한 `word_connection_game_v2.html`을 클린 아키텍처(역할별 매니저 객체) 구조로 설계한다.
>
> **Project**: word_connection_game
> **Version**: 0.1
> **Author**: cupid4rang
> **Date**: 2026-08-23
> **Status**: Draft
> **Planning Doc**: [word-connection-game.plan.md](../../01-plan/features/word-connection-game.plan.md)

> **Pipeline**: 이 프로젝트는 9-phase Development Pipeline을 사용하지 않는 단일 정적 HTML 미니게임이므로 Pipeline References 표는 생략(N/A).

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 사전 부족으로 대부분의 난이도 설정에서 게임이 시작조차 안 되고, 게임 종료 후 피드백/재도전 동선이 없음 |
| **WHO** | `word_connection_game.html`을 로컬 브라우저에서 여는 캐주얼 플레이어(주 사용자: 개발자 본인/지인, 데스크톱 우선) |
| **RISK** | 사전을 늘려도 길이별 단어 분포가 불균형하면 여전히 특정 글자수·카테고리 조합에서 시작 불가 → 카테고리별 각 글자수(2~5)마다 최소 2단어 이상 확보로 완화 |
| **SUCCESS** | (1) 모든 글자수(2~5)에서 최소 1개 카테고리로 시작 가능 (2) 게임오버 모달에 최종/최고 점수·다시하기 (3) localStorage 최고점수 유지 (4) 정답/오답/시작/종료 효과음 (5) 카테고리 직접 선택 (6) 3연속 정답부터 콤보 보너스 |
| **SCOPE** | `word_connection_game_v2.html` 단일 파일(CSS/JS 인라인). 백엔드/빌드 도구 없음. 모바일 터치는 Out of Scope |

> **Design Anchor**: Pencil MCP 미사용 — 기존 `word_connection_game.html`의 CSS 변수(`--pink`, `--mint`, `--yellow` 등)와 클래이모픽(claymorphic) 버튼/모달 스타일을 그대로 재사용하므로 별도 Design Anchor 캡처는 생략.

---

## 1. Overview

### 1.1 Design Goals

- 기존 게임 로직(블록 선택, 정답 판정, 캔버스 라인, 타이머)을 최대한 보존하면서 신규 기능을 **역할별 객체(Manager)**로 분리해 추가한다.
- 빌드 도구 없이 `file://`로 더블클릭 실행해도 100% 동작해야 한다 (ES `import`/CORS 이슈 회피).
- 신규 기능 추가로 인해 기존 UX(토스트, 컨페티, 젤리 버튼, 애니메이션)가 깨지지 않아야 한다.

### 1.2 Design Principles

- **단일 책임**: 오디오·저장소·콤보·모달·렌더링을 각각 독립된 객체로 분리해, 한 기능을 고쳐도 다른 기능에 영향이 적게 한다.
- **상태와 표현의 분리**: `GameState`는 순수 데이터만 보관하고 DOM을 직접 건드리지 않는다. DOM 조작은 `UIManager`/`ModalManager`만 담당한다.
- **점진적 재사용**: 기존 CSS 클래스(`.modal-card`, `.jelly-btn`, `.toast`, `.float-text` 등)를 그대로 재사용해 신규 UI(게임오버 모달, 콤보 텍스트)를 만든다.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | 기존 함수에 신규 로직 직접 삽입 | 역할별 Manager 객체로 완전 분리 + 기존 로직도 재구성 | 신규 기능만 소규모 객체로 분리, 기존 로직 최소 수정 |
| **New Files** | 0 (신규 파일 1개만 복제) | 0 (신규 파일 1개만 복제) | 0 (신규 파일 1개만 복제) |
| **Modified Sections** | 적음 | 많음 (기존 게임 로직 재구성 포함) | 중간 |
| **Complexity** | Low | High | Medium |
| **Maintainability** | Medium | High | High |
| **Effort** | Low | High | Medium |
| **Risk** | Low (결합도 높음) | Low (구조 깔끔, 초기 리팩터링 범위가 넓음) | Low (균형) |
| **Recommendation** | 빠른 수정 | 장기 유지보수 | 기본 권장 |

**Selected**: **Option B — Clean Architecture** — **Rationale**: 사용자가 명시적으로 선택. 향후 기능(터치 지원, 카테고리별 랭킹 등)을 추가하기 쉽도록 역할별 객체(Data/State/Service/Presentation/Controller)로 처음부터 분리해 구현한다. 단일 파일이라도 `<script>` 내부에서 IIFE 기반 모듈 패턴으로 계층을 나눈다.

> 이하 상세 설계는 Option B(클린 아키텍처) 기준으로 작성됨.

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         word_connection_game_v2.html                │
│                                                                     │
│  [Data]         Dictionary                                        │
│                   └─ 카테고리/단어 데이터 + getCategories() 등 조회 함수 │
│                                                                     │
│  [State]        GameState                                         │
│                   └─ score, timeLeft, isGameActive, comboCount,    │
│                      currentCategory, selectedBlocks 등 순수 상태값  │
│                                                                     │
│  [Service]      AudioManager   StorageManager   ComboManager       │
│                   └─ Web Audio    └─ localStorage   └─ 콤보 카운트/  │
│                      비프음 재생      최고점수 R/W        보너스 계산  │
│                                                                     │
│  [Presentation] UIManager        ModalManager                     │
│                   └─ 보드/캔버스/     └─ 설정 모달, 게임오버 모달       │
│                      토스트/컨페티      show/hide/populate           │
│                      렌더링                                        │
│                                                                     │
│  [Controller]   GameController                                    │
│                   └─ 이벤트 바인딩(click / contextmenu),            │
│                      startGame/stopGame/endGame/resetBoard 오케스트레이션 │
└──────────────────────────────────────────────────────────────────┘
```

**이후 추가된 구성요소 (2026-09-01 현재)** — 위 그림의 계층 규칙은 그대로 지키면서 늘어났다.

| Layer | Component | 하는 일 | 들어온 시점 |
|-------|-----------|--------|------------|
| Data | `CategoryManager` | 파일로 추가한 카테고리를 사전에 합치고 목록을 다시 만든다 | 002 |
| State | `QuizSession` | 모드 2 세션(진행 횟수·카테고리·라운드 기록·다음 문제 미리 받기) | 007 · 022 · 023 |
| State | `VersusManager` | 2인 대결의 차례·점수·고정 제시어 | (대결 추가 시) |
| Service | `LeaderboardManager` | 닉네임별 최고 기록 랭킹. 모드 1 / 모드 2 를 따로 둔다 | 042 |
| Service | `QuizManager` | 모드 2 한 라운드의 정답·힌트 공개·점수 계산 | 006 |
| Service | `LlamaClient` | Ollama(qwen2.5:7b) 호출 — 연결 확인·예열·문제 생성·모델 내리기 | 006 · 013 · 027 |
| Service | `BackgroundManager` | 배경1~4 적용과 저장 | 001 |
| Presentation | `Overlay` | 모달을 `show` 클래스 하나로 열고 닫는 공통 창구 | 008 |
| Presentation | `QuizPanelUI` | 보드 옆 AI 힌트 패널 렌더링 | 006 |

### 2.2 Data Flow

```
사용자 입력(왼쪽 클릭으로 블록 선택 → 오른쪽 클릭으로 완성)
  → pickBlock() 으로 선택을 쌓고, finishSelection() → submitSelectedWord()
  → 정답 판정 (GameState.currentTargetWords 참조)
  → 성공 시: GameState 갱신 + ComboManager.registerCorrect()
             + AudioManager.playCorrect()/playCombo()
             + UIManager(플로팅텍스트/컨페티/점수펄스)
  → 실패 시: ComboManager.reset() + AudioManager.playWrong()
             + UIManager(쉐이크/에러플래시)

타이머 종료 → GameController.endGameByTimeOut()
  → StorageManager.trySetHighScore(GameState.score)
  → AudioManager.playGameOver()
  → ModalManager.showGameOverResult(score, highScore, isNewRecord)
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| GameController | GameState, Dictionary, AudioManager, StorageManager, ComboManager, UIManager, ModalManager | 게임 흐름 오케스트레이션 (유일하게 모든 모듈을 참조) |
| UIManager | GameState (읽기 전용) | 현재 상태를 화면에 렌더링 |
| ModalManager | StorageManager (읽기), GameState (읽기) | 게임오버 모달에 최종/최고 점수 표시 |
| ComboManager | GameState.comboCount (읽기/쓰기) | 콤보 카운트 증가/리셋 및 보너스 점수 계산 |
| AudioManager, StorageManager | (없음) | 순수 유틸리티, 다른 모듈에 의존하지 않음 |
| Dictionary, GameState | (없음) | 외부 의존성 없는 순수 데이터/상태 홀더 |
| LeaderboardManager | StorageManager | 모드별 랭킹 read/write (2026-09-01 추가) |
| QuizManager | (없음) | 모드 2 한 라운드의 정답/힌트/점수 (2026-09-01 추가) |
| LlamaClient | StorageManager (주소·모델 읽기) | Ollama 호출 — 실패해도 게임은 내장 사전으로 진행 (2026-09-01 추가) |
| QuizSession | LlamaClient | 다음 라운드 문제 미리 받기 (2026-09-01 추가) |
| CategoryManager | Dictionary, StorageManager | 파일로 추가한 카테고리 병합 (2026-09-01 추가) |

---

## 3. Data Model

> 이 기능은 DB/서버가 없으므로 "데이터 모델"은 (1) 메모리상의 JS 데이터 구조와 (2) `localStorage` 스키마 두 가지뿐이다. 3.3 SQL 스키마, 4장 API 명세는 해당 없음(N/A).

### 3.1 Dictionary 데이터 구조

```javascript
// category(string) -> word(string)[]
const dictionary = {
  "과일": ["사과", "포도", ...],
  "동물": ["여우", "너구리", ...],
  // ...
};
```

**FR-01 제약조건 (Do 단계에서 반드시 충족)** — *아래는 설계 당시 조건이다.
목표 글자 수 기능이 001 에서 없어져 길이별 조건은 더 이상 적용되지 않고,
지금은 **카테고리 20개**에 한 카테고리당 단어 2개 이상만 있으면 된다.
사용자가 파일로 추가한 카테고리도 같은 규칙으로 검사한다.*:
- 카테고리 **8개 이상**
- 각 카테고리마다 글자수 2, 3, 4, 5 **각각 최소 2단어 이상** 포함
- Do 단계 구현 직후, 브라우저 콘솔에서 아래와 같은 자체 검증 로직을 1회 실행해 조건 충족을 확인한다 (제품 코드에 포함할 필요는 없음, 검증 후 제거 가능):
  ```javascript
  Object.entries(dictionary).forEach(([cat, words]) => {
    for (let len = 2; len <= 5; len++) {
      const count = words.filter(w => w.length === len).length;
      if (count < 2) console.warn(`부족: ${cat} / ${len}글자 (${count}개)`);
    }
  });
  ```
- 권장 카테고리(8개): 과일, 동물, 나라이름, 도시/지역이름, 음식, 색깔, 직업, 스포츠 — 각 카테고리당 10~14개 단어를 골고루 배치해 2~5글자 조건을 만족시킨다. 자연스러운 단어가 부족한 길이가 있으면 같은 범주의 합성어/전문 용어(예: 색깔 카테고리의 "연두색"(3), "다홍색"(3), "인디고블루"류는 지양하고 실제 통용되는 한국어 단어 위주로 채운다)로 보완한다.

### 3.2 GameState (in-memory)

```typescript
interface GameState {                // 2026-09-01 현재 코드 기준
  mode: 'solo' | 'versus' | 'quiz';  // 지금 돌고 있는 판의 종류
  score: number;
  highScore: number;                 // StorageManager에서 로드된 값의 캐시 (모드별)
  timeLeft: number;
  duration: number;                  // 이번 판의 제한 시간 (모드 2는 힌트 수에 따라 길어진다)
  isGameActive: boolean;
  answerListUnlocked: boolean;       // 정답 목록은 한 판을 마친 뒤에만 열 수 있다
  currentCategory: string;
  currentBlockCount: number;
  currentTargetWords: string[];      // 현재 라운드의 정답 후보
  solvedWords: string[];             // 이번 게임에서 이미 맞춘 단어
  comboCount: number;                // 연속 정답 횟수 (오답/셔플 시 0으로 리셋)
  selectedCategoryOption: string;    // "random" | 실제 카테고리명 (설정에서 선택)
  selectedBlocks: HTMLElement[];     // 왼쪽 클릭으로 고른 순서대로 쌓인다
}
```

> 설계 당시의 `currentLengthLimit`(목표 글자 수)은 001 에서 기능째 없어졌고,
> `isMuted` 는 `GameState` 가 아니라 `AudioManager` 안에 있다.
> `mode` · `duration` · `answerListUnlocked` 는 그 뒤 모드가 늘면서 생겼다.

### 3.3 localStorage 스키마

모두 `wordConnectionGame.` 으로 시작한다 (2026-09-01 현재 13개).

| Key | Type | Description |
|-----|------|-------------|
| `highScore` | 숫자 문자열 | 모드 1(제시어 맞추기) 최고 점수 |
| `quizHighScore` | 숫자 문자열 | 모드 2(AI 스무고개) 최고 점수 — 점수 폭이 달라 키를 나눴다 |
| `leaderboard` | JSON 배열 | 모드 1 랭킹 `[{name, score, ts}]` — 닉네임당 최고 1건, 최대 30건 |
| `quizLeaderboard` | JSON 배열 | 모드 2 랭킹. 같은 구조지만 점수 폭이 달라 따로 둔다 |
| `nickname` | 문자열 | 랭킹에 올라갈 내 닉네임 |
| `background` | 문자열 | 고른 게임 배경 (`none` \| `1`~`4`) |
| `customCategories` | JSON 객체 | 파일로 추가한 카테고리 `{ 이름: [단어…] }` |
| `quizRounds` | 숫자 문자열 | 모드 2 를 몇 번 진행할지 (기본 3) |
| `quizCategory` | 문자열 | 모드 2 에서 마지막에 고른 카테고리 |
| `llmEndpoint` | 문자열 | Ollama 주소 (기본 `http://localhost:11434`) |
| `llmModel` | 문자열 | 모델 이름 (기본 `qwen2.5:7b`) |
| `llmModelMigrated` | `'1'` | 기본 모델을 `llama3.2` → `qwen2.5:7b` 로 한 번만 옮겼다는 표시 (021) |
| `multiplayerUrl` | 문자열 | 멀티플레이 서버 주소 (기본 `http://localhost:3000`) |

> `localStorage` 접근이 불가능한 환경(프라이빗 브라우징, `file://` 제한 등)을 대비해
> `StorageManager` 는 모든 읽기/쓰기를 `try/catch` 로 감싸고, 실패하면 메모리 사본으로만
> 운용해 게임 진행 자체는 막지 않는다 (6장 에러 처리 참조).

---

## 4. API Specification

N/A — 서버/백엔드가 없는 순수 클라이언트 정적 HTML이므로 API가 존재하지 않는다.

---

## 5. UI/UX Design

### 5.1 Screen Layout (2026-09-01 현재)

```
┌──────────────────────────────────────────────────────┐
│  🍭 단어 연결 게임 🍬                                    │
│  (랭킹 1위가 있으면 👑 챔피언 배너)                        │
├──────────────────────────────────────────────────────┤
│ [⚙️ 설정] [▶ 게임시작] [⚔ 대결] [🏅 랭킹] [⏹ 종료] [🔊]  │
├──────────────────────────────────────────────────────┤
│ [🍬 모드 1 · 제시어 맞추기] [🤖 모드 2 · AI 스무고개]      │
├──────────────────────────────────────────────────────┤
│ 🖱 왼쪽 클릭으로 고르고 · 오른쪽 클릭으로 완성 (규칙 배너)   │
├──────────────────────────────────────────────────────┤
│ [🎯 제시어] [⏱ 남은시간] [🏆 점수(최고:N)]                │
├──────────────────────────────────────────────────────┤
│  🔇 🎲                        │  🤖 AI 힌트 패널        │
│      (블록 보드 + 캔버스 라인)   │  (모드 2 에서만 보인다)  │
├──────────────────────────────────────────────────────┤
│  (콤보 3+ 달성 시 "🔥 3 COMBO! +1" 플로팅)                │
└──────────────────────────────────────────────────────┘

설정 모달:
┌────────────────────────────────┐
│ ⚙️ 게임 설정                      │
│ 🙋 내 닉네임    [        ]      │
│ 🧩 블록 개수    [   16   ]      │
│ 📚 카테고리     [ 랜덤 ▾ ]       │
│ 📂 카테고리 파일 추가 [파일 선택]  │
│ 🖼 게임 배경    [기본 1 2 3 4]   │
│ 🔁 스무고개 횟수 [    3   ]      │
│ ⚙️ qwen2.5:7b 연결 (Ollama)     │
│         [완료 ✔]                 │
└────────────────────────────────┘

> 설계 당시에 있던 `🔤 목표 글자수` 는 001 에서 없앴다.
> 닉네임·카테고리 파일·배경·스무고개 설정은 그 뒤에 들어왔다.

게임오버 모달 (신규):
┌──────────────────────────┐
│ ⏰ 시간 종료!                │
│  (🎉 신기록! 배지, 조건부)    │
│         12                 │ ← 최종 점수 (기존 modal-score 스타일)
│  최고 점수: 15점            │
│  [🔁 다시하기]  [닫기]       │
└──────────────────────────┘
```

### 5.2 User Flow

```
페이지 로드 → (설정 기본값/카테고리 select 채움) → [게임 시작]
  → 라운드 진행(왼쪽 클릭으로 블록 선택 → 오른쪽 클릭으로 완성) → 정답/오답 피드백 → (콤보 누적)
  → 시간 종료 → 게임오버 모달(최종/최고 점수) → [다시하기] → 새 게임 시작
                                              └ [닫기] → 대기 상태로 복귀
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| Dictionary | `<script>` 상단 데이터 블록 | 카테고리/단어 데이터 보관 및 조회 |
| GameState | `<script>` 상태 블록 | 게임 진행 중 상태값 단일 소스 |
| AudioManager | `<script>` 서비스 블록 | Web Audio 오실레이터 기반 효과음 재생, 음소거 토글 |
| StorageManager | `<script>` 서비스 블록 | `localStorage` 최고점수 read/write, 실패 시 degrade |
| ComboManager | `<script>` 서비스 블록 | 연속 정답 카운트, 보너스 점수 계산, 리셋 |
| UIManager | `<script>` 표현 블록 | 보드/캔버스/토스트/플로팅텍스트/컨페티/상태카드 렌더링 |
| ModalManager | `<script>` 표현 블록 | 설정 모달, 게임오버 모달 show/hide/populate |
| GameController | `<script>` 하단 오케스트레이션 블록 | 이벤트 바인딩 및 전체 게임 흐름 제어 |
| LeaderboardManager | `<script>` 서비스 블록 | 모드별 닉네임 랭킹 — 지금 기록보다 높은 점수만 등록 (2026-09-01 추가) |
| CategoryManager | `<script>` 데이터 블록 | 파일로 추가한 카테고리 병합/삭제 (2026-09-01 추가) |
| BackgroundManager | `<script>` 서비스 블록 | 배경1~4 적용/저장 (2026-09-01 추가) |
| QuizManager · QuizSession · LlamaClient | `<script>` 서비스 블록 | 모드 2(AI 스무고개) 라운드·세션·Ollama 호출 (2026-09-01 추가) |
| VersusManager | `<script>` 상태 블록 | 2인 대결의 차례·점수·고정 제시어 (2026-09-01 추가) |
| Overlay · QuizPanelUI | `<script>` 표현 블록 | 모달 열고 닫기 공통 창구, AI 힌트 패널 (2026-09-01 추가) |

### 5.4 Page UI Checklist

#### 메인 화면 (단일 페이지)

- [ ] Button(top-nav): 🔊/🔇 음소거 토글 아이콘 버튼 — 클릭 시 `AudioManager.isMuted` 토글, 아이콘 즉시 전환
- [ ] Status card(점수): 기존 점수 값 아래 "최고 N점" 서브텍스트 추가 (게임 시작 전에도 저장된 최고점수 표시)
- [ ] Floating text: 콤보 3회 이상 정답 시 "🔥 N COMBO! +{보너스}" 텍스트 (기존 `.float-text.good` 스타일 재사용/변형)
- [ ] Settings modal: 카테고리 select (옵션: "🎲 랜덤" + `Object.keys(dictionary)` 전체, 기본값 랜덤)
- [ ] Game Over modal: 제목("⏰ 시간 종료!"), 최종 점수(큰 숫자, 기존 `.modal-score` 스타일), 최고 점수 텍스트, 신기록 시 "🎉 신기록!" 배지(조건부 표시), "🔁 다시하기" 버튼(바로 `startGame()` 재호출), "닫기" 버튼(대기 상태로 복귀)

---

## 6. Error Handling

> 서버가 없으므로 HTTP 에러코드 대신 클라이언트 예외 상황을 정의한다.

### 6.1 예외 상황 정의

| 상황 | 원인 | 처리 |
|------|------|------|
| 선택한 카테고리에 단어 2개 미만 (설계 당시에는 "카테고리+글자수 조합") | 사전에 단어 부족 | 기존 로직처럼 `showToast(..., "warn")`로 안내 후 시작 취소. 카테고리를 특정 값으로 선택했을 때도 동일하게 검증(랜덤일 때는 유효한 카테고리 중에서만 추첨하던 기존 로직 유지) |
| 오디오 재생 실패 (`AudioContext` 정책상 사용자 제스처 전 호출 불가) | 브라우저 자동재생 정책 | `AudioManager`는 "게임 시작" 버튼 클릭(사용자 제스처) 시점에 최초로 `AudioContext` 생성/`resume()`. 실패해도 `try/catch`로 무시하고 게임 진행에는 영향 없음 |
| `localStorage` 접근 불가 (프라이빗 모드, 브라우저 정책 등) | 브라우저 설정 | `StorageManager`가 `try/catch`로 감싸 실패 시 `highScore`를 메모리 값(0)으로만 운용, 저장 실패해도 게임 진행에는 영향 없음 |

### 6.2 사용자 피드백 포맷

기존 `showToast(message, type)` 함수를 그대로 재사용한다 (`info`/`warn` 타입).

---

## 7. Security Considerations

- 사용자 입력은 블록 개수 숫자 입력(`min`/`max` 이미 존재), 카테고리 select(고정 옵션),
  닉네임·카테고리 파일·Ollama 주소 정도이며, 화면에 넣을 때 `textContent` 로만 다뤄 XSS 위험이 없다
- 서버/인증 없음 — 해당 항목 전부 N/A
- **밖으로 나가는 데이터**: 기본 상태에서는 없다. 모드 2 에서만 이 PC 의 Ollama(`localhost`)로
  카테고리와 힌트 요청을 보내고, 멀티플레이를 고르면 사용자가 적은 서버 주소로 접속한다
- **`localStorage` 에 남는 것**: 최고 점수뿐 아니라 **닉네임과 랭킹(닉네임+점수)**,
  고른 배경, 파일로 추가한 카테고리, 모드 2 설정이 함께 저장된다 (3.3 참조).
  모두 이 브라우저 안에만 있고 밖으로 전송되지 않는다

---

## 8. Test Plan

> 이 프로젝트는 빌드 도구/테스트 러너가 없는 단일 정적 HTML이므로 curl/Playwright 대신 **수동 브라우저 QA 체크리스트**로 대체한다. Do 단계에서 구현 직후 아래 항목을 실제 브라우저(Chrome)에서 수동 확인한다.

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| 기능 수동 테스트 | 게임 플레이 전체 흐름 | Chrome 수동 확인 | Do |
| 사전 검증 | Dictionary 길이/카테고리 커버리지 | 브라우저 콘솔 스크립트(§3.1) | Do |

### 8.2 수동 테스트 시나리오 (L2/L3 대응)

| # | 시나리오 | 절차 | 성공 기준 |
|---|---------|------|----------|
| 1 | ~~글자수별 시작 가능 여부~~ | *001 에서 목표 글자 수 기능을 없애 해당 없음. 대신 **카테고리별 시작 가능 여부**(20개 카테고리를 각각 골라 시작)를 확인한다* | 모든 카테고리가 경고 토스트 없이 정상 시작됨 |
| 2 | 카테고리 직접 선택 | 설정에서 특정 카테고리를 선택 후 시작 | 제시어가 선택한 카테고리로 고정됨 |
| 3 | 정답 처리 | 블록을 왼쪽 클릭으로 골라 정답 단어를 만들고 오른쪽 클릭으로 완성 | 점수 +1, 컨페티/사운드 재생, 새 라운드로 전환 |
| 4 | 콤보 보너스 | 정답을 3회 연속 성공 | 3회째부터 콤보 플로팅 텍스트 + 보너스 점수 반영 확인 |
| 5 | 콤보 리셋 | 콤보 도중 오답 제출 | 콤보 카운트가 0으로 리셋됨 (다음 정답은 다시 1부터) |
| 6 | 게임오버 모달 | 타이머 0초 도달 | 모달에 최종 점수·최고 점수 표시, "다시하기" 클릭 시 새 게임 시작 |
| 7 | 최고 점수 영속성 | 높은 점수로 게임오버 → 브라우저 새로고침 | 새로고침 후에도 상태카드에 갱신된 최고 점수가 표시됨 |
| 8 | 음소거 토글 | 음소거 버튼 클릭 후 정답/오답 발생 | 소리가 재생되지 않음, 아이콘이 🔇로 전환됨 |
| 9 | 기존 UX 회귀 없음 | 기존 시나리오(셔플, 설정 변경, 게임 종료 버튼) | 기존과 동일하게 동작 |

### 8.3 Seed Data Requirements

N/A — 별도 시드 데이터 불필요 (Dictionary 자체가 정적 데이터).

---

## 9. Clean Architecture

### 9.1 Layer Structure (단일 파일 내 `<script>` 블록 순서)

| Layer | Responsibility | 위치(파일 내 순서) |
|-------|---------------|----------|
| **Data** | 정적 사전 데이터 + 조회 헬퍼 | `<script>` 최상단 — `dictionary`, `Dictionary.getCategories()` 등 |
| **State** | 게임 진행 상태 보관 (순수 데이터, DOM 없음) | Data 다음 — `GameState` 객체 |
| **Service** | 오디오/저장소/콤보 등 부수효과가 있는 로직 | State 다음 — `AudioManager`, `StorageManager`, `ComboManager` |
| **Presentation** | DOM 렌더링 전담 (보드/캔버스/토스트/모달) | Service 다음 — `UIManager`, `ModalManager` |
| **Controller** | 이벤트 바인딩 + 전체 흐름 오케스트레이션 | 파일 최하단 — `GameController` (기존 `onclick="startGame()"` 등에서 호출되는 진입점 함수들을 포함) |

> 2026-09-01 현재 각 계층에 들어온 것: Data 에 `CategoryManager`,
> State 에 `VersusManager` · `QuizSession`, Service 에 `LeaderboardManager` ·
> `BackgroundManager` · `QuizManager` · `LlamaClient`,
> Presentation 에 `Overlay` · `QuizPanelUI`. 계층 규칙(2.3 · 9.2)은 그대로 지킨다.

### 9.2 Dependency Rules

```
┌─────────────────────────────────────────────────────────────┐
│                    Dependency Direction                      │
├─────────────────────────────────────────────────────────────┤
│  GameController ──→ UIManager, ModalManager                  │
│         │                  │            │                    │
│         ├──→ AudioManager, StorageManager, ComboManager       │
│         │                  │            │                    │
│         └──→ GameState ←───┴────────────┘                    │
│                    ↑                                          │
│                Dictionary                                    │
│                                                                │
│  규칙: GameState/Dictionary는 다른 모듈을 참조하지 않는다.       │
│        Service/Presentation 계층은 GameController를 참조하지    │
│        않는다 (역참조 금지 — 순환 의존 방지).                    │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 File Import Rules

빌드 도구가 없는 단일 HTML이므로 ES `import`/`export`는 사용하지 않는다 (`file://`로 열었을 때 모듈 CORS 문제 회피). 대신 IIFE 패턴으로 각 Manager를 상수 객체로 선언한다:

```javascript
const AudioManager = (function () {
  let isMuted = false;
  let ctx = null;
  function ensureContext() { /* ... */ }
  function playCorrect() { /* ... */ }
  // ...
  return { ensureContext, playCorrect, playWrong, playStart, playGameOver, toggleMute, get isMuted() { return isMuted; } };
})();
```

| From | Can Reference | Cannot Reference |
|------|-----------|---------------|
| GameController | 모든 모듈 | (없음) |
| UIManager / ModalManager | GameState, Dictionary (읽기) | GameController |
| AudioManager / StorageManager / ComboManager | GameState (해당되는 경우만, 예: ComboManager) | GameController, UIManager |
| GameState / Dictionary | (없음) | 다른 모든 모듈 |

### 9.4 This Feature's Layer Assignment

| Component | Layer | 비고 |
|-----------|-------|------|
| `dictionary`, `Dictionary` | Data | 기존 `dictionary` 객체를 확장 + 조회 헬퍼 추가 |
| `GameState` | State | 기존 전역 변수(`score`, `timeLeft`, `isGameActive` 등)를 하나의 객체로 통합 |
| `AudioManager` | Service | 신규 — Web Audio 오실레이터 기반, 외부 리소스 없음 |
| `StorageManager` | Service | 신규 — `localStorage` 최고점수 R/W |
| `ComboManager` | Service | 신규 — 콤보 카운트/보너스 계산 |
| `UIManager` | Presentation | 기존 `showToast/spawnFloatText/spawnConfetti/drawLines/generateBoard` 등을 이 객체 아래로 재구성 |
| `ModalManager` | Presentation | 기존 `openSettings/closeSettings` + 신규 게임오버 모달 로직 |
| `GameController` | Controller | 기존 `startGame/stopGame/generateNewRound/endGameByTimeOut` 등을 재구성해 이 블록에 위치, `onclick` 핸들러들의 진입점 |

---

## 10. Coding Convention Reference

### 10.1 Naming Conventions

| Target | Rule | Example |
|--------|------|---------|
| Manager 객체 | PascalCase | `AudioManager`, `StorageManager`, `ComboManager`, `UIManager`, `ModalManager`, `GameController` |
| 함수/메서드 | camelCase | `playCorrect()`, `trySetHighScore()`, `registerCorrect()` |
| 상수 | UPPER_SNAKE_CASE | `CONFETTI_COLORS`, `COMBO_THRESHOLD`, `HIGH_SCORE_KEY` |
| DOM id | camelCase | `categorySelect`, `muteBtn`, `gameOverOverlay`, `gameOverScore` |
| CSS 클래스(신규) | 기존 kebab-case 패턴 유지 | `.combo-badge`, `.gameover-record` |

### 10.2 Script 내부 순서 (Import 대신)

빌드 도구가 없으므로 "import 순서" 대신 **`<script>` 내부 선언 순서** 규칙을 따른다:

```javascript
// 1. Data
const dictionary = { ... };
const Dictionary = { ... };

// 2. State
const GameState = { ... };

// 3. Service (Data/State에만 의존)
const AudioManager = (function () { ... })();
const StorageManager = (function () { ... })();
const ComboManager = (function () { ... })();

// 4. Presentation (Data/State 읽기 전용 참조)
const UIManager = (function () { ... })();
const ModalManager = (function () { ... })();

// 5. Controller (모든 모듈 오케스트레이션, 최하단)
function startGame() { /* GameController 진입점 */ }
function stopGame() { ... }
// ... 기존 onclick 핸들러들과 동일한 이름/시그니처 유지
```

### 10.3 Environment Variables

N/A — 서버/배포 환경변수 없음.

### 10.4 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| 모듈화 방식 | ES modules 대신 IIFE 기반 상수 객체 (file:// 호환) |
| 상태 관리 | 단일 `GameState` 객체 (기존 산재된 전역 변수 통합) |
| 에러 처리 | Service 계층에서 `try/catch`로 degrade, 게임 흐름은 절대 막지 않음 |
| 기존 함수명 | `onclick` 등에 이미 노출된 함수명(`startGame`, `stopGame`, `resetBoard`, `openSettings`, `closeSettings`)은 시그니처를 유지해 HTML 마크업 수정 최소화 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
word_connection_game_v2.html   (신규, word_connection_game.html을 복제해서 시작)
  <style>  ... 기존 스타일 + .combo-badge, .mute-btn, 게임오버 모달 전용 스타일(신기록 배지 등) 추가
  <body>   ... 기존 마크업 + 음소거 버튼, 카테고리 select, 게임오버 모달 마크업 추가
  <script> ... 10.2절 순서대로 Data → State → Service → Presentation → Controller
```

### 11.2 Implementation Order

1. [ ] `word_connection_game.html` → `word_connection_game_v2.html` 복제
2. [ ] Dictionary 확장 (8개 카테고리, §3.1 제약조건) + 콘솔 자체 검증
3. [ ] 기존 전역 변수를 `GameState` 객체로 통합 리팩터링 (기능 변경 없이 구조만 정리)
4. [ ] `StorageManager` 구현 + 상태카드에 최고점수 서브텍스트 노출
5. [ ] `ModalManager`에 게임오버 모달 추가 (마크업 + show/hide + 다시하기 바인딩), `endGameByTimeOut()`에서 토스트 대신 모달 호출로 교체
6. [ ] `AudioManager` 구현 (정답/오답/시작/게임오버 비프음) + 음소거 버튼 UI/바인딩
7. [ ] `ComboManager` 구현 + 정답 처리 로직에 연결 + 콤보 플로팅 텍스트/보너스 점수 반영
8. [ ] 설정 모달에 카테고리 select 추가, `startGame()`의 카테고리 결정 로직에 "랜덤 vs 지정" 분기 반영
9. [ ] §8.2 수동 테스트 시나리오 9개 전체 수동 확인

### 11.3 Session Guide

> 파일이 단일 HTML(약 1,000~1,300줄 예상)이라 대부분 한 번의 Do 세션으로 처리 가능하지만, 분리가 필요하면 아래 모듈 단위로 나눌 수 있다.

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| 사전 확장 + State 리팩터링 | `module-1` | Dictionary 확장, GameState 통합 | 15-20 |
| 게임오버 모달 + 최고점수 | `module-2` | StorageManager, ModalManager(게임오버) | 15-20 |
| 효과음 + 콤보 + 카테고리 선택 | `module-3` | AudioManager, ComboManager, 설정 카테고리 select | 20-25 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| Session 1 | Plan + Design | 전체 (완료) | - |
| Session 2 | Do | `--scope module-1,module-2` | 30-40 |
| Session 3 | Do | `--scope module-3` | 20-25 |
| Session 4 | Check + Report | 전체 | 15-20 |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-08-23 | Initial draft (Option B 클린 아키텍처 선택) | cupid4rang |
| 0.2 | 2026-08-30 | 파일 이름 통합 안내 추가 (`_v2` → 원래 파일) | cupid4rang |
| 0.3 | 2026-09-01 | 조작 방식 변경 반영(드래그 → 왼쪽/오른쪽 클릭) — 작업기록 045 · 046 | cupid4rang |
| 0.4 | 2026-09-01 | 현재 코드와 어긋난 서술 정리 — GameState · localStorage 스키마 · 화면 배치 · 구성요소 목록 · 보안 항목을 지금 기준으로 갱신 (작업기록 048) | cupid4rang |
