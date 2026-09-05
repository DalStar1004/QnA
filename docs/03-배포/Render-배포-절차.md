# Render.com 배포 절차 — 이 프로젝트에 맞춘 설정값

작성일: 2026-09-05 · 대상: `server/` (멀티플레이 서버) + 루트의 혼자 하기 게임
전제: [Vultr-배포-계획.md](Vultr-배포-계획.md) 3장의 1단계 코드 수정이 끝나 있어야 합니다
([1단계-코드수정-기록.md](1단계-코드수정-기록.md) 참고). 이미 끝났습니다.

> 사내 공유 가이드(`render_deployment_guide.html`)의 절차를 따르되, **이 프로젝트에서만
> 달라지는 부분**을 짚어 둔 문서입니다. 가이드는 "저장소 루트에 `package.json`·`server.js`·
> `public/` 이 있는 구조"를 전제하는데, 우리 구조는 그것들이 전부 `server/` 안에 있습니다.
> 그래서 대시보드에서 **두 칸을 직접 지정**해야 합니다.

---

## 1. 가이드 Step 0 — 이미 충족된 것

| 가이드가 요구하는 것 | 우리 상태 |
|---|---|
| `package.json` 의 `scripts.start` | ✅ `server/package.json` → `"start": "node src/server.js"` |
| `process.env.PORT` 수용 | ✅ `server/src/server.js` → `Number(process.env.PORT) \|\| 3000` |
| GitHub 업로드 (Step 1) | ✅ `github.com/DalStar1004/QnA` (main) |
| 폴더 구조 | ⚠️ **다름** — 루트에 `package.json` 이 없고 `server/` 안에 있습니다 → 2장에서 처리 |

`server/node_modules` 에 네이티브 모듈(`*.node`)이 하나도 없습니다. 순수 JavaScript 라
윈도우에서 커밋된 것이 리눅스에서도 그대로 동작합니다. 다만 Render 는 어차피 `npm install` 을
새로 돌리므로 이 점을 걱정할 일은 없습니다.

---

## 2. Render 대시보드에 입력할 값

**New + ➔ Web Service ➔ GitHub ➔ `QnA` 저장소 선택** 까지는 가이드와 같습니다.
그다음 설정 화면에서 아래 값을 넣습니다. **굵게 표시한 두 칸이 가이드와 다른 부분입니다.**

| 칸 | 넣을 값 | 왜 |
|---|---|---|
| Name | 원하는 이름 (예: `word-connection-game`) | 이 이름이 주소가 됩니다 → `https://<이름>.onrender.com` |
| Language / Runtime | **Node** | 아래 3장 참고. 자동으로 **Docker** 가 잡히면 반드시 Node 로 바꿉니다 |
| Branch | `main` | |
| **Root Directory** | **`server`** | 루트에 `package.json` 이 없습니다. 비워 두면 빌드가 실패합니다 |
| Build Command | `npm install` | |
| Start Command | `npm start` | `node src/server.js` 를 직접 적어도 같습니다 |
| Instance Type | **Free ($0/month)** | |
| 나머지 | 그대로 | 환경변수도 넣을 것이 없습니다 (`PORT` 는 Render 가 알아서 넘겨줍니다) |

마지막으로 **[Deploy Web Service]** 를 누릅니다. 1~3분 뒤 상단에 초록색 **Live** 가 뜨면 끝입니다.

### 환경변수는 넣지 않아도 됩니다

- `PORT` — Render 가 자동으로 넣어 주고, 서버가 그 값을 받아 씁니다. **직접 지정하지 마세요.**
- `OLLAMA_URL` — 넣지 않습니다. Render 에는 Ollama 가 없습니다. AI 힌트가 없어도 스무고개는
  글자 수·초성 힌트로 진행되도록 서버(`QuizService`)가 처리합니다.

---

## 3. 이 프로젝트에서 걸릴 만한 것 (미리 알아두기)

### 3.1 Render 가 Docker 를 잡을 수 있습니다 — Node 로 바꾸세요

Root Directory 를 `server` 로 두면 그 안에 `Dockerfile` 이 있어서, Render 가 런타임을
**Docker** 로 자동 선택할 수 있습니다. 그러면 **빌드가 실패합니다.**

우리 `server/Dockerfile` 은 빌드 컨텍스트가 **저장소 루트**라는 전제로 쓰여 있습니다
(`COPY server/package*.json ./` 처럼 경로 앞에 `server/` 가 붙어 있습니다). Render 는 Root Directory
를 컨텍스트로 잡으므로 그 경로들을 찾지 못합니다. 그 Dockerfile 은 Vultr 용이며 Render 와는
무관하니, **Language 를 Node 로 지정**하면 그만입니다.

### 3.2 15분 절전 (Free 플랜)

15분간 접속이 없으면 서버가 잠들고, 다시 깨우는 데 30초~1분이 걸립니다.
가이드의 팁대로 **시연 2~3분 전에 링크를 한 번 눌러 깨워** 두세요.

절전에 들어가면 **진행 중이던 방과 점수가 모두 사라집니다.** 방 정보를 메모리에만 두기
때문입니다(설계상 그렇습니다). 게임을 하는 도중에는 접속이 계속 있으므로 잠들지 않습니다.

### 3.3 혼자 하기 🤖 AI 스무고개는 Render 에서 막힐 수 있습니다

혼자 하기 모드의 AI 힌트는 **브라우저가 접속자 본인 PC의 `http://localhost:11434`(Ollama)를
직접 부르는** 구조입니다(`word_connection_game.html` 의 `/api/generate` 호출).

Render 주소는 `https://` 인데 Ollama 는 `http://` 라서, 브라우저 정책(혼합 콘텐츠 ·
Private Network Access)에 걸려 요청이 막힐 수 있습니다. **실제로 눌러 봐야 알 수 있습니다.**
막히더라도 게임이 죽지는 않고, 확정 힌트(글자 수·초성)로 진행됩니다.

**멀티플레이 스무고개는 영향이 없습니다.** 그쪽은 서버가 힌트를 만들기 때문입니다
(서버에 Ollama 가 없으므로 확정 힌트로 진행됩니다).

### 3.4 저장소가 큽니다

`tools/node`(106MB, 윈도우용 Node)까지 저장소에 들어 있어 clone 이 느릴 수 있습니다.
Render 는 그 폴더를 쓰지 않으므로 동작에는 문제가 없고, 빌드 시간만 조금 더 걸립니다.

---

## 4. 배포 후 확인할 것

주소는 `https://<서비스이름>.onrender.com` 입니다. **휴대폰(LTE)처럼 다른 네트워크에서**
확인해야 진짜 확인입니다.

- [ ] 주소만 쳤을 때 **혼자 하기 시작 화면**이 뜬다
- [ ] 배경 그림 4종과 아이콘(⚙️·시작·랭킹)이 깨지지 않는다
- [ ] 혼자 하기 한 판이 끝까지 된다 (왼쪽 클릭 선택 → 오른쪽 클릭 완성)
- [ ] [접속하기] 를 누르면 주소가 `https://<이름>.onrender.com/multi?from=start` 로 바뀐다
- [ ] 브라우저 두 개(다른 기기면 더 좋음)로 같은 방에 들어가 게임이 시작된다
- [ ] `https://<이름>.onrender.com/healthz` → `{"ok":true,"rooms":0}`
- [ ] 멀티 스무고개가 AI 없이도 힌트를 내며 진행된다

**멀티가 안 되면** 가장 먼저 볼 곳은 Render 의 Logs 탭입니다.
`socket.io` 연결이 막히면 화면에 "🚧 서버 주소로 열어야 해요" 안내가 뜹니다.

## 5. 고친 뒤 다시 올리기

가이드 Step 3 그대로입니다. **GitHub 의 `main` 에 push 하면 Render 가 알아서 다시 배포합니다.**

```bash
git add -A && git commit -m "…" && git push origin main
```

Render 대시보드의 Events 탭에서 진행 상황이 보이고, 다시 **Live** 가 되면 반영이 끝난 것입니다.

## 6. Vultr 계획과의 관계

[Vultr-배포-계획.md](Vultr-배포-계획.md) 는 그대로 둡니다. 1단계 코드 수정은 두 방식에 **공통으로**
필요한 것이었고(주소 분리 · 멀티 주소 자동 감지), 실제로 그 수정 덕분에 Render 에서도 `/` 가
혼자 하기 화면이 됩니다. 도커·포트 80·`.dockerignore` 설정은 Render 에서는 쓰이지 않고,
나중에 Vultr 로 옮기거나 직접 서버를 둘 때 그대로 쓸 수 있습니다.
