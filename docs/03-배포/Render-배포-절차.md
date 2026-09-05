# Render.com 배포 절차 — 이 프로젝트에 맞춘 설정값

작성일: 2026-09-05 · 대상: `server/` (멀티플레이 서버) + 루트의 혼자 하기 게임
전제: [Vultr-배포-계획.md](Vultr-배포-계획.md) 3장의 1단계 코드 수정이 끝나 있어야 합니다
([1단계-코드수정-기록.md](1단계-코드수정-기록.md) 참고). 이미 끝났습니다.

> 사내 공유 가이드(`render_deployment_guide.html`)의 절차를 그대로 따르면 됩니다.
> 가이드는 "저장소 루트에 `package.json` 이 있는 구조"를 전제하는데 우리는 그것이 `server/` 안에
> 있었습니다. 그래서 **루트에 `package.json` 을 하나 두어** 구조를 맞췄고, 이제 대시보드에서
> 따로 지정할 칸이 없습니다.

---

## 1. 가이드 Step 0 — 이미 충족된 것

| 가이드가 요구하는 것 | 우리 상태 |
|---|---|
| `package.json` 의 `scripts.start` | ✅ **루트에 `package.json` 을 두었습니다** (아래 설명) |
| `process.env.PORT` 수용 | ✅ `server/src/server.js` → `Number(process.env.PORT) \|\| 3000` |
| GitHub 업로드 (Step 1) | ✅ `github.com/DalStar1004/QnA` (main) |
| 폴더 구조 | ✅ 루트 `package.json` 으로 맞췄습니다 |

### 루트 `package.json` — 무엇을 하는 파일인가

실제 서버 코드는 그대로 `server/` 에 있습니다. 루트의 것은 **진입점 역할만** 합니다.

```json
{
  "scripts": {
    "start": "node server/src/server.js",
    "postinstall": "npm install --omit=dev --prefix server"
  }
}
```

- `start` — Render 가 `npm start` 를 부르면 `server/` 의 서버를 켭니다.
- `postinstall` — Render 가 `npm install` 을 돌리면 npm 이 이어서 이걸 자동으로 실행해
  `server/` 의 의존성(express · socket.io)을 설치합니다.
  **의존성 목록을 두 군데에 적지 않으려고** 이렇게 했습니다. 라이브러리를 추가할 때는
  지금까지처럼 `server/package.json` 만 고치면 됩니다.

이 파일 덕분에 대시보드에서 Root Directory 를 따로 지정할 필요가 없고,
루트에는 `Dockerfile` 이 없으므로 런타임이 Docker 로 잘못 잡히는 일도 없습니다.

`server/node_modules` 에 네이티브 모듈(`*.node`)이 하나도 없습니다. 순수 JavaScript 라
윈도우에서 커밋된 것이 리눅스에서도 그대로 동작합니다. 다만 Render 는 어차피 `npm install` 을
새로 돌리므로 이 점을 걱정할 일은 없습니다.

---

## 2. Render 대시보드에 입력할 값

**New + ➔ Web Service ➔ GitHub ➔ `QnA` 저장소 선택** 까지는 가이드와 같습니다.
그다음 설정 화면은 대부분 자동으로 채워집니다. 아래만 확인하세요.

| 칸 | 넣을 값 | 비고 |
|---|---|---|
| Name | 원하는 이름 (예: `word-connection-game`) | 이 이름이 주소가 됩니다 → `https://<이름>.onrender.com` |
| Language / Runtime | **Node** | 루트에 `package.json` 이 있으므로 보통 자동으로 잡힙니다 |
| Branch | `main` | |
| Root Directory | **비워 둡니다** | 루트 `package.json` 이 진입점 역할을 합니다 |
| Build Command | `npm install` | 기본값 그대로 |
| Start Command | `npm start` | 기본값 그대로 |
| Instance Type | **Free ($0/month)** | |
| 나머지 | 그대로 | 환경변수도 넣을 것이 없습니다 (`PORT` 는 Render 가 알아서 넘겨줍니다) |

마지막으로 **[Deploy Web Service]** 를 누릅니다. 1~3분 뒤 상단에 초록색 **Live** 가 뜨면 끝입니다.

### 환경변수는 넣지 않아도 됩니다

- `PORT` — Render 가 자동으로 넣어 주고, 서버가 그 값을 받아 씁니다. **직접 지정하지 마세요.**
- `OLLAMA_URL` — 넣지 않습니다. Render 에는 Ollama 가 없습니다. AI 힌트가 없어도 스무고개는
  글자 수·초성 힌트로 진행되도록 서버(`QuizService`)가 처리합니다.

---

## 3. 이 프로젝트에서 걸릴 만한 것 (미리 알아두기)

### 3.1 런타임이 Docker 로 잡히면 안 됩니다

`server/Dockerfile` 이 있긴 하지만 그것은 **Vultr 용**이고, 빌드 컨텍스트가 저장소 루트라는
전제로 쓰여 있습니다(`COPY server/package*.json ./`). Render 가 그것으로 빌드하면 경로를 찾지
못해 실패합니다.

Root Directory 를 비워 두면 Render 는 루트를 봅니다. 루트에는 `Dockerfile` 이 없고
`package.json` 만 있으므로 **Node 로 잡힙니다.** 혹시 화면에 Docker 가 선택돼 있으면
Node 로 바꾸세요.

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
