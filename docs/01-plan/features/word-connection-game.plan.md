---
template: plan
version: 1.3
---

# word-connection-game Planning Document

> **파일 이름 안내 (2026-08-30 통합)** — 이 문서에 나오는 `word_connection_game_v2.html` 은
> 지금은 **`word_connection_game.html`** 입니다. v2 의 내용을 원래 파일로 옮기고 v2 는 없앴습니다.
> 아래 본문은 당시 결정을 그대로 남겨 둔 기록이라 예전 이름을 그대로 씁니다.


> **Summary**: 기존 `word_connection_game.html`(단어 연결 게임)을 참조하여, 사전 대폭 확장 · 최고 점수 기록 · 게임 오버 모달 · 효과음 · 카테고리 선택 UI · 콤보 보너스를 추가한 개선판 게임을 제작한다.
>
> **Project**: QnA (word_connection_game)
> **Version**: 0.1
> **Author**: cupid4rang
> **Date**: 2026-08-23
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 기존 게임은 사전이 3개 카테고리 × 7단어뿐이라 2글자 외 난이도를 고르면 곧바로 플레이 불가능하고, 시간 종료 시 토스트만 뜨고 최종 결과/재도전 흐름이 끊기며, 최고 기록도 남지 않아 반복 플레이 동기가 약하다. |
| **Solution** | 사전을 카테고리·단어 수 모두 대폭 확장하고, 게임 오버 시 결과 모달(최종 점수/최고 기록/다시하기)을 띄우며, `localStorage` 기반 최고 점수, 정답/오답 효과음, 카테고리 직접 선택 UI, 연속 정답 콤보 보너스를 추가한다. |
| **Function/UX Effect** | 모든 글자수(2~5) 옵션에서 실제 플레이가 가능해지고, 게임이 끝나도 성취(최고 기록 갱신 여부)가 즉시 보이며, 효과음과 콤보 연출로 몰입감이 높아진다. |
| **Core Value** | 반복 플레이를 유도하는 "성장/기록" 루프(최고 점수·콤보)를 완성해 완성도 높은 미니게임으로 만든다. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 사전 부족으로 대부분의 난이도 설정에서 게임이 시작조차 안 되고, 게임 종료 후 피드백/재도전 동선이 없음 |
| **WHO** | `word_connection_game.html`을 로컬 브라우저에서 여는 캐주얼 플레이어(주 사용자: 개발자 본인/지인, 데스크톱 우선) |
| **RISK** | 사전을 늘려도 길이별 단어 분포가 불균형하면 여전히 특정 글자수·카테고리 조합에서 시작 불가 → 카테고리별 각 글자수(2~5)마다 최소 2단어 이상 확보로 완화 |
| **SUCCESS** | (1) 모든 글자수(2~5) 옵션에서 최소 1개 이상 카테고리로 게임 시작 가능 (2) 시간 종료 시 게임오버 모달에 최종 점수·최고 기록·다시하기 표시 (3) localStorage에 최고 점수가 유지됨 (4) 정답/오답/시작 시 효과음 재생 (5) 설정에서 카테고리를 직접 고를 수 있음 (6) 3연속 이상 정답 시 콤보 보너스 점수 지급 |
| **SCOPE** | 단일 HTML 파일(`word_connection_game_v2.html`) 내에서 CSS/JS 인라인으로 전부 구현. 백엔드/빌드 도구 없음 |

---

## 1. Overview

### 1.1 Purpose

`word_connection_game.html`(2글자 카테고리 3개짜리 프로토타입)을 참조하여, 실제로 오래 플레이할 수 있는 완성도 있는 미니게임으로 발전시킨다.

### 1.2 Background

기존 파일은 드래그로 블록을 이어 카테고리에 속한 단어를 맞추는 캐주얼 게임으로 UI/애니메이션은 이미 잘 갖춰져 있으나(토스트, 컨페티, 젤리 버튼 등), **콘텐츠(사전)와 종료 후 루프(기록/재도전)**가 비어 있어 실제 게임으로서 완성도가 낮다.

### 1.3 Related Documents

- 참조 파일: `word_connection_game.html` (프로젝트 루트, 기존 프로토타입)
- 결과물: `word_connection_game_v2.html` (신규 파일, 기존 파일은 보존)

---

## 2. Scope

### 2.1 In Scope

- [ ] 사전 대폭 확장: 카테고리 8개 이상, 각 카테고리마다 글자수 2~5별로 최소 2단어씩 확보 (총 100+ 단어)
- [ ] 게임 오버 모달: 시간 종료 시 기존 `.modal-overlay`/`.modal-card` 스타일 재사용해 최종 점수, 최고 기록(신기록 여부 강조), "다시하기"/"닫기" 버튼 표시
- [ ] 최고 점수 기록: `localStorage`에 카테고리 무관 통합 최고 점수 저장, 상태 카드 또는 게임오버 모달에 표시
- [ ] 효과음: Web Audio API(`AudioContext` 오실레이터)로 정답/오답/게임시작/게임오버 효과음을 외부 파일 없이 구현, 음소거 토글 버튼 제공
- [ ] 카테고리 선택 UI: 설정 모달에 "랜덤" 또는 특정 카테고리를 고르는 select 추가
- [ ] 콤보 보너스: 연속 정답 카운트를 추적해 3연속부터 보너스 점수(+1 추가 등) 및 별도 콤보 연출(플로팅 텍스트) 지급, 오답/셔플 시 콤보 초기화

### 2.2 Out of Scope

- 모바일 터치 이벤트 지원 (요청 시 별도 진행)
- 서버/백엔드, 멀티플레이, 사용자 로그인
- 카테고리별 개별 최고 점수 랭킹, 외부 사운드 파일 사용
- 접근성(ARIA) 전면 개편

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 사전을 카테고리 8개 이상, 카테고리별 글자수 2~5마다 2단어 이상으로 확장한다 | High | Pending |
| FR-02 | 시간 종료 시 게임 오버 모달을 띄우고 최종 점수·최고 기록·다시하기 버튼을 제공한다 | High | Pending |
| FR-03 | 최고 점수를 `localStorage`에 저장하고 갱신 시 신기록 연출을 보여준다 | High | Pending |
| FR-04 | 정답/오답/게임 시작/게임 오버 시점에 Web Audio API로 효과음을 재생하고, 음소거 토글을 제공한다 | Medium | Pending |
| FR-05 | 설정 모달에서 카테고리를 "랜덤" 또는 특정 값으로 선택할 수 있다 | Medium | Pending |
| FR-06 | 연속 3정답부터 콤보 보너스 점수를 지급하고, 오답/게임종료/셔플 시 콤보를 리셋한다 | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 단일 HTML 파일, 외부 리소스는 Google Fonts만 사용(효과음 포함 전부 인라인) | 브라우저 네트워크 탭에서 요청 목록 확인 |
| Compatibility | 최신 Chrome/Edge에서 정상 동작 | 수동 실행 확인 |
| Data Persistence | 최고 점수는 브라우저 재시작 후에도 유지 | `localStorage` 확인 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] 위 6개 In-Scope 기능 모두 구현
- [ ] 글자수 2/3/4/5 각각으로 게임 시작 시 최소 1개 카테고리로 정상 진행됨을 수동 확인
- [ ] 게임 오버 모달 → 다시하기 → 정상적으로 재시작되는지 확인
- [ ] 브라우저 새로고침 후에도 최고 점수 유지 확인

### 4.2 Quality Criteria

- [ ] 콘솔 에러 없음
- [ ] 기존 애니메이션/토스트/컨페티 등 기존 UX 유지(회귀 없음)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 사전 확장 시 특정 카테고리에 글자수별 단어가 부족해 여전히 시작 불가 조합 발생 | Medium | Medium | 카테고리별 글자수 2~5 각각 최소 2단어를 의도적으로 채워 넣고, 시작 전 유효성 검사(기존 로직 재사용) 유지 |
| Web Audio API 브라우저 정책상 사용자 상호작용 전에는 소리 재생 불가 | Low | Medium | "게임 시작" 버튼 클릭(사용자 제스처) 시점에 `AudioContext`를 최초 생성/resume |
| 콤보 로직이 기존 정답 판정 로직과 얽혀 회귀 버그 유발 | Medium | Low | 콤보 카운터를 기존 `solvedWords`/점수 로직과 분리된 별도 상태로 관리 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `word_connection_game_v2.html` (신규) | Static HTML file | `word_connection_game.html`을 복제 후 사전/모달/오디오/콤보/카테고리UI 기능 추가 |
| `word_connection_game.html` (기존) | Static HTML file | 변경 없음 (참조용으로 보존) |

### 6.2 Current Consumers

- 없음 — 독립 정적 HTML 파일이며 다른 페이지/스크립트에서 참조하지 않음 (프로젝트 내 다른 HTML에서 링크되지 않음)

### 6.3 Verification

- [ ] 신규 파일이 기존 파일과 독립적으로 브라우저에서 단독 실행됨을 확인
- [ ] 기존 `word_connection_game.html`은 수정하지 않아 그대로 동작함을 확인

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | Simple structure, 정적 HTML/CSS/JS | Static sites, 미니게임 | ☑ |
| Dynamic | BaaS 연동 | - | ☐ |
| Enterprise | 마이크로서비스 | - | ☐ |

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| 구조 | 단일 HTML 파일 vs 분리(js/css) | 단일 HTML 파일 | 기존 파일과 동일한 패턴 유지, 배포/공유 용이 |
| 오디오 | 외부 mp3 vs Web Audio 오실레이터 | Web Audio 오실레이터 | 추가 에셋 파일 없이 인라인으로 해결 가능 |
| 저장소 | 서버 vs localStorage | localStorage | 백엔드 없는 정적 게임에 적합 |
| 스타일 | 기존 CSS 변수/클래스 재사용 vs 신규 디자인 | 기존 CSS 변수·컴포넌트(모달, 토스트, 젤리버튼) 재사용 | 일관된 톤앤매너 유지, 개발 비용 절감 |

### 7.3 Clean Architecture Approach

```
Selected Level: Starter

word_connection_game_v2.html
  ├─ <style> 기존 스타일 + 게임오버 모달/음소거 버튼/콤보 텍스트 스타일 추가
  ├─ <body> 기존 마크업 + 카테고리 select, 음소거 버튼, 게임오버 모달 마크업 추가
  └─ <script>
       ├─ dictionary (확장된 데이터)
       ├─ 기존 게임 로직 (startGame/generateBoard/판정 등, 최소 수정)
       ├─ 신규: audio 모듈 (beep 재생 함수들)
       ├─ 신규: combo 상태 및 보너스 로직
       └─ 신규: highScore 저장/로드/모달 표시 로직
```

---

## 8. Convention Prerequisites

이 프로젝트는 별도의 `CLAUDE.md`/린트/타입스크립트 설정이 없는 정적 HTML 미니 프로젝트이므로 8장의 컨벤션/환경변수/파이프라인 항목은 해당 없음(N/A)으로 스킵한다.

---

## 9. Next Steps

1. [ ] 설계 문서 작성 (`word-connection-game.design.md`)
2. [ ] 사용자 확인
3. [ ] 구현 시작 (`word_connection_game_v2.html` 작성)

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-08-23 | Initial draft | cupid4rang |
