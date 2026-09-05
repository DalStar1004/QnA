# Vultr 배포 계획 — 주소창에 IP만 치면 게임이 뜨게 하기

작성일: 2026-09-05 · 대상: `word_connection_game.html`(혼자 하기) + `server/`(멀티플레이)

> **진행 상황** — 3장의 **1단계(로컬 코드 수정)는 끝났습니다.**
> 실제로 무엇을 어떻게 고쳤는지는 [1단계-코드수정-기록.md](1단계-코드수정-기록.md) 에 따로 남겼습니다.
> 아래 3장은 "무엇을 왜 고쳐야 하는가"를 적어 둔 원래 계획이며, 코드와 다른 부분이 생기면
> 기록 문서 쪽이 실제 모습입니다. 다음 할 일은 4장(Vultr 인스턴스 준비)부터입니다.

---

## 1. 목표와 "다 됐다"의 기준

친구에게 **`http://123.45.67.89`** 처럼 IP만 알려주면, 받는 사람은 아무것도 설치하지 않고
브라우저 주소창에 그것만 치고 바로 게임을 할 수 있어야 한다.

완료 기준(이 5가지가 모두 되면 끝):

| # | 확인할 것 | 기준 |
|---|---|---|
| 1 | `http://<IP>` | 포트 번호 없이 게임 시작 화면이 뜬다 |
| 2 | 혼자 하기 | 블록이 나오고 배경·아이콘·글꼴이 깨지지 않는다 |
| 3 | 멀티플레이 | 시작 화면의 [접속하기]를 누르면 방 만들기/참가가 되고, 두 브라우저에서 같은 방에 들어가진다 |
| 4 | 재부팅 | 서버를 리부팅해도 게임이 저절로 다시 뜬다 |
| 5 | 재배포 | 코드를 고친 뒤 명령 두 줄로 반영된다 |

---

## 2. 지금 상태 — 그대로 올리면 안 되는 이유

| 지금 | 올리면 생기는 일 |
|---|---|
| 서버가 **3000번 포트**로 뜬다 | `http://<IP>` 로는 안 들어가지고 `http://<IP>:3000` 을 쳐야 한다 → 목표 실패 |
| `/` 가 **멀티플레이 대기 화면**이다 | IP만 치고 들어온 사람이 닉네임·방 코드부터 만나서, 혼자서는 놀 수가 없다 |
| 혼자 하기 게임(`word_connection_game.html`)이 **서버에 없다** | `server/public/` 안에 들어 있지 않아 아예 서빙되지 않는다 |
| 혼자 하기가 쓰는 그림이 서버에 없다 | `assets/icon-*.png`, `champion-badge.png`, `assets/backgrounds/배경1~4.png` 가 `server/public/` 에 없다 (`public/assets` 에는 `bg1~4.png`·글꼴만 있다) |
| 멀티 서버 주소 기본값이 `http://localhost:3000` 이다 | 접속자가 [접속하기]를 누르면 **자기 PC**를 찌른다 → 연결 실패 |
| `tools/node` 는 **Windows용 node.exe** 다 | 리눅스 서버에서는 실행이 안 된다 |
| Ollama 기본 주소가 `127.0.0.1:11434` 다 | 서버에 Ollama가 없으면 AI 문장 힌트는 안 나온다 (게임은 글자 수·초성 힌트로 계속 진행됨) |
| 방 정보가 **메모리에만** 있다 | 서버를 재시작하면 진행 중이던 방이 전부 사라진다 |

> **원칙 예외 하나를 미리 적어 둔다.** `CLAUDE.md` 의 "이 폴더 안의 것만으로 돌아가야 한다"는
> **로컬(윈도우) 실행 기준**이다. 리눅스 서버에서는 `tools/node` 를 쓸 수 없으므로 서버 쪽 Node 는
> Docker 이미지(`node:20-alpine`) 또는 `apt` 로 설치한 Node 를 쓴다. 로컬 실행 방식(`서버 켜기.bat`)은
> 지금 그대로 두고 손대지 않는다.

---

## 3. 먼저 고칠 것 (코드 작업) — 서버를 사기 전에 로컬에서 끝낸다

이 5개를 로컬에서 먼저 고치고 `http://localhost:3000` 으로 확인한 뒤에 올린다.
서버에서 처음 고치기 시작하면 원인을 찾기가 훨씬 어렵다.

### 3.1 `/` 에 혼자 하기 화면을 띄운다 — `server/src/server.js`

정적 파일 서빙보다 **먼저** 라우트를 등록해야 한다. `express.static` 은 기본으로 `/` 에
`index.html`(= 멀티 화면)을 물려 주기 때문에, 순서를 지키지 않으면 이 라우트가 무시된다.

```js
// 정적 파일보다 먼저 — '/' 는 혼자 하기, '/multi' 는 멀티플레이
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'word_connection_game.html')));
app.get('/multi', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use(express.static(PUBLIC_DIR, { index: false }));
```

**곁가지 영향**: 로컬에서도 `http://localhost:3000` 이 멀티 대기실 대신 시작 화면으로 바뀐다.
이게 오히려 자연스럽지만, `server/README.md` 와 `README.md` 의 "3000번으로 들어가면 멀티 화면"
설명은 같이 고쳐야 한다.

### 3.2 멀티 서버 주소 기본값을 "지금 보고 있는 주소"로 — `word_connection_game.html`

`DEFAULT_MULTIPLAYER_URL` (3303번째 줄 근처)을 아래처럼 바꾼다.

```js
// 서버를 통해 열렸으면 그 서버가 곧 멀티 서버다. 파일을 직접 연 경우에만 예전 기본값을 쓴다.
const DEFAULT_MULTIPLAYER_URL =
    location.protocol.startsWith('http') ? location.origin + '/multi' : 'http://localhost:3000';
```

`goMultiplayer()` 는 이 주소에 `?from=start` 를 붙여 이동하므로 그대로 두면 된다.
멀티 화면은 그 표시를 보고 [← 처음 화면] 버튼을 띄운다.

서버 상태 확인 요청이 `target + '/healthz'` 로 붙는데, `target` 이 `http://<IP>/multi` 가 되면
`/multi/healthz` 를 찌르게 된다. 확인 요청은 `new URL('/healthz', target).href` 로 만들도록
같이 손보는 편이 낫다(실패해도 [접속하기]는 되지만, 항상 "서버 응답 없음"이 뜨면 헷갈린다).

### 3.3 혼자 하기 게임과 그림을 이미지에 담는다 — `server/Dockerfile`, `server/docker-compose.yml`

파일을 복사해 두 벌로 관리하면 반드시 한쪽만 고치는 날이 온다. 대신 **빌드 컨텍스트를
저장소 루트로 올려** 원본 한 벌에서 이미지를 만든다.

`server/docker-compose.yml`:

```yaml
services:
  app:
    build:
      context: ..                    # 저장소 루트 (루트의 게임 파일·그림을 담기 위해)
      dockerfile: server/Dockerfile
    container_name: word-connection-multiplayer
    ports:
      - "80:3000"                    # ← 핵심. 바깥 80 → 컨테이너 3000
    environment:
      PORT: 3000
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

`server/Dockerfile` — 경로 앞에 `server/` 가 붙는 점에 주의:

```dockerfile
FROM node:20-alpine
WORKDIR /app

COPY server/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/public ./public

# 혼자 하기 화면과 그 화면이 쓰는 그림들 (원본은 저장소 루트에 그대로 둔다)
COPY word_connection_game.html ./public/
COPY assets ./public/assets

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

- `COPY assets ./public/assets` 는 **덮어쓰기가 아니라 합치기**다. 기존 `bg1~4.png`·글꼴은 남고
  아이콘(`icon-*.png`, `champion-badge.png`, `thumb-bg*.png`)이 더해진다.
- 배경 그림은 `assets/backgrounds/` 안에 있으므로 위의 `COPY assets` 한 줄로 같이 들어온다.
  덕분에 한글 파일명을 Dockerfile 에 적을 일이 없다. 원본 그림(`아이콘.png` · `우승.png` ·
  `챔피언 뱃지.png`)은 `source-images/` 에 있고 `.dockerignore` 에서 빼 두었다.

**빌드 컨텍스트가 저장소 루트가 되므로 `.dockerignore` 를 루트에 새로 만든다.**
이걸 빼먹으면 106MB짜리 `tools/node` 와 52MB짜리 `.git` 이 전부 빌드에 딸려 들어간다.

루트 `.dockerignore`:

```
.git
.claude
.bkit
docs
tools
server/node_modules
server/README.md
README.md
CLAUDE.md
서버 켜기.bat
npm-debug.log
```

### 3.4 안내 문구에 남은 `localhost:3000` 을 정리한다

- `server/public/index.html` 의 부팅 실패 안내에 `http://localhost:3000` 이 링크로 박혀 있다 → `/multi` 로.
- `server/README.md`·`README.md` 의 접속 주소 설명에 "인터넷에 올린 경우 `http://<서버 IP>`" 한 줄 추가.

### 3.5 로컬 확인

`서버 켜기.bat` 로 켜고 `http://localhost:3000` → 시작 화면, [접속하기] → 멀티 화면,
배경/아이콘 정상. 도커가 로컬에 있으면 `cd server && docker compose up --build` 로
**포트 80 매핑까지 포함해** 한 번 확인하면 서버에서 놀랄 일이 없다.

---

## 4. Vultr 인스턴스 준비

### 4.1 무엇을 사는가

| 항목 | 고를 것 | 이유 |
|---|---|---|
| 종류 | Cloud Compute — Shared CPU (Regular) | 이 게임에는 이걸로 충분하다 |
| 지역 | 서울(Seoul) — 목록에 없으면 도쿄(Tokyo) | 한국에서 접속할 것이므로 가까울수록 반응이 빠르다 |
| OS | **Ubuntu 24.04 LTS** | 자료가 가장 많고 도커 설치가 표준 절차다 |
| 사양 | **1 vCPU / 2GB RAM / 50GB** 권장 (1GB로도 되지만 빌드가 빡빡하다) | `npm install` + 도커 빌드 때 메모리를 쓴다 |
| 옵션 | Auto Backups는 선택, IPv6 켬, **SSH Key 등록** | 비밀번호 로그인보다 안전하다 |

요금은 지역·시점에 따라 다르므로 **콘솔에 표시되는 금액을 그대로 믿는다.** 대략 월 몇 달러대이고,
포함 대역폭(보통 1~2TB/월)이면 이 게임에는 충분하다. 배경 그림이 장당 1.5~2.4MB라
접속자가 늘면 대역폭을 가장 많이 먹는 것은 그 그림들이다.

메모리가 1GB라면 만들자마자 스왑을 1GB 잡아 두면 빌드 중 죽는 일을 막을 수 있다.

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 4.2 방화벽 — 두 겹이다

1. **Vultr Firewall Group** (콘솔에서 만들고 인스턴스에 붙인다) — `22/tcp`, `80/tcp` 만 열고 나머지는 막는다.
2. **서버 안의 ufw**

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw enable
```

**11434(Ollama)는 절대 밖으로 열지 않는다.** 인증이 없어서 누구나 모델을 쓰게 된다.

---

## 5. 배포 절차 (권장: Docker Compose)

Dockerfile·compose 파일이 이미 있고, 재부팅 자동 시작·헬스체크가 딸려 오므로 이 방식을 권장한다.

```bash
# 0) 접속
ssh root@<IP>

# 1) 기본 정리
apt update && apt upgrade -y
apt install -y git ca-certificates curl

# 2) 도커 설치 (공식 편의 스크립트)
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# 3) 소스 받기 — 저장소가 크므로 얕게 받는다
git clone --depth 1 https://github.com/DalStar1004/QnA.git /opt/qna
cd /opt/qna/server

# 4) 빌드 + 실행 (백그라운드)
docker compose up -d --build

# 5) 확인
docker compose ps
curl -s http://localhost/healthz    # {"ok":true,"rooms":0} 가 나와야 한다
docker compose logs -f              # 로그 보기 (Ctrl+C 로 빠져나옴)
```

저장소가 비공개라면 3)에서 인증이 필요하다. 가장 간단한 길은
**GitHub Personal Access Token** 을 쓰거나, 저장소를 공개로 돌리거나,
윈도우에서 `scp` 로 필요한 파일만 올리는 것이다.

> 받는 용량이 부담되면(약 150MB) `git clone --depth 1 --filter=blob:none` 을 쓰거나,
> `word_connection_game.html`·`assets`·`server/` 만 `scp` 로 올려도 된다 (배경은 `assets` 안에 있다).

### 5.1 도커를 쓰지 않는 대안 (systemd)

메모리가 아주 작거나 도커를 피하고 싶을 때.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
cd /opt/qna/server && npm install --omit=dev
```

3.3의 도커 설정 대신, 혼자 하기 파일들을 서버에서 한 번 복사해 둔다.

```bash
cd /opt/qna
cp word_connection_game.html server/public/
cp -r assets/. server/public/assets/
```

`/etc/systemd/system/qna.service`:

```ini
[Unit]
Description=단어 연결 게임 서버
After=network.target

[Service]
WorkingDirectory=/opt/qna/server
ExecStart=/usr/bin/node src/server.js
Environment=NODE_ENV=production
Environment=PORT=80
# 일반 사용자로도 80번 포트를 열 수 있게 해 주는 권한
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now qna
```

---

## 6. "IP만 치면 된다"를 만드는 방법 — 세 가지 중 하나

| 방법 | 어떻게 | 장점 | 단점 |
|---|---|---|---|
| **A. 도커 포트 매핑** (권장) | compose의 `ports: "80:3000"` | 설정 한 줄. 앱은 3000 그대로라 로컬과 같다 | 나중에 다른 사이트를 같이 올리기 어렵다 |
| B. 앱이 직접 80을 연다 | `PORT=80` + `CAP_NET_BIND_SERVICE` | 중간 단계가 없다 | 권한 설정이 한 겹 붙는다 |
| C. Nginx/Caddy 리버스 프록시 | 80에서 받아 3000으로 넘긴다 | 나중에 도메인·HTTPS·여러 서비스로 확장하기 좋다 | 부품이 하나 늘고, **WebSocket 설정을 빠뜨리면 멀티가 통째로 안 된다** |

지금 목표(게임 하나, IP 접속)에는 **A**가 맞다. 나중에 도메인을 붙일 때 C로 옮기면 된다.

C를 고르는 경우 Socket.IO 때문에 업그레이드 헤더가 **반드시** 필요하다.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 600s;
}
```

---

## 7. AI 스무고개(Ollama)를 어떻게 할 것인가

`qwen2.5:7b` 는 최소 8GB, 넉넉히는 16GB RAM을 요구한다. 게임을 돌리는 데 필요한 사양의
10배쯤 되는 서버를 사야 한다는 뜻이다. 그래서 **1단계에서는 서버에 Ollama를 올리지 않는다.**

| 모드 | 서버에 Ollama가 없을 때 |
|---|---|
| 멀티플레이 🤖 스무고개 | **그대로 진행된다.** 서버가 글자 수·초성 같은 확정 힌트로 대체한다 (`QuizService` 가 그렇게 만들어져 있다) |
| 혼자 하기 🤖 스무고개 | 브라우저가 **접속자 본인 PC**의 `localhost:11434` 를 부른다. 그 PC에 Ollama가 있으면 그대로 동작한다 |

혼자 하기 모드에서 각자 자기 Ollama를 쓰게 하려면, 그 사람 PC의 Ollama가 이 페이지의 출처를
허용해 줘야 한다(지금까지는 출처가 `file://`·`localhost` 였지만 앞으로는 `http://<IP>` 가 된다).

```
OLLAMA_ORIGINS=*     ← 접속하는 사람 PC의 환경변수. 그 PC에서만 쓰이는 설정이다
```

나중에 서버에서도 AI 힌트를 쓰고 싶다면:

```yaml
    environment:
      PORT: 3000
      OLLAMA_URL: http://host.docker.internal:11434
      OLLAMA_MODEL: qwen2.5:7b
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

호스트에 Ollama를 설치하고 위 설정을 붙이면 된다. **RAM 16GB 이상 인스턴스로 옮긴 뒤에** 한다.
집 PC의 Ollama를 서버가 부르게 하는 방법(공유기 포트포워딩)은 인증이 없어 권장하지 않는다.

---

## 8. 배포 후 검증 체크리스트

다른 네트워크(휴대폰 LTE 등)에서 확인해야 진짜 확인이다. 같은 PC에서만 보면 방화벽 문제가 안 보인다.

- [ ] `http://<IP>` — 포트 없이 시작 화면이 뜬다
- [ ] 배경 그림 4종이 다 나온다 (한글 파일명이 404가 안 난다 → 개발자도구 Network 탭에서 확인)
- [ ] 아이콘(⚙️·시작·랭킹)과 글꼴이 기본 글꼴로 안 떨어진다
- [ ] 혼자 하기 한 판이 끝까지 된다 (왼쪽 클릭 선택 → 오른쪽 클릭 완성)
- [ ] [접속하기] → 멀티 화면으로 넘어가고, 주소가 `http://<IP>/multi?from=start` 다
- [ ] 브라우저 두 개(다른 기기면 더 좋다)로 같은 방에 들어가 게임이 시작된다
- [ ] 멀티 스무고개가 AI 없이도 힌트를 내며 진행된다
- [ ] `curl http://<IP>/healthz` → `{"ok":true,...}`
- [ ] `sudo reboot` 후 1~2분 뒤 `http://<IP>` 가 저절로 다시 뜬다
- [ ] `docker compose logs --tail=50` 에 에러가 반복되지 않는다

---

## 9. 고친 뒤 다시 올리기 · 되돌리기

```bash
# 재배포
cd /opt/qna && git pull && cd server && docker compose up -d --build

# 로그
docker compose logs -f --tail=100

# 되돌리기 — 잘 돌던 커밋으로
cd /opt/qna && git log --oneline -5
git checkout <커밋해시> && cd server && docker compose up -d --build

# 완전히 내리기
docker compose down
```

배포 중 몇 초는 접속이 끊긴다. **진행 중이던 방은 메모리에만 있으므로 전부 사라진다.**
사람이 붙어 있을 때는 피하는 게 좋다.

---

## 10. 알아 둘 위험과 한계

| 항목 | 내용 | 어떻게 할 것인가 |
|---|---|---|
| HTTPS가 안 된다 | Let's Encrypt 인증서는 **도메인**이 있어야 발급된다. IP만으로는 못 받는다 | 1단계는 `http://` 로 간다. 브라우저의 "안전하지 않음" 표시는 정상. 나중에 도메인을 사면 Caddy로 자동 HTTPS |
| 상태가 메모리에만 있다 | 재시작·재배포 때 방이 사라진다 | 지금 규모에서는 감수한다. 필요해지면 Redis 컨테이너를 붙인다(compose에 자리는 이미 주석으로 있다) |
| 누구나 들어온다 | IP를 아는 사람은 다 접속한다 | 게임이라 큰 문제는 아니다. 원치 않으면 Vultr 방화벽에서 접속 IP를 제한한다 |
| 로그인·서버 저장이 없다 | 랭킹·닉네임은 각자 브라우저 `localStorage` 에 있다 | 서버에 개인정보가 남지 않는다는 뜻이기도 하다. 접속자끼리 랭킹은 공유되지 않는다 |
| 배경 그림이 무겁다 | 4장 합쳐 약 7MB. 첫 로딩이 느릴 수 있다 | 필요하면 WebP 변환·리사이즈로 1/5 이하로 줄인다 (별도 작업) |
| SSH 보안 | 22번이 열려 있으면 자동 공격이 붙는다 | SSH 키만 허용(`PasswordAuthentication no`), 원하면 `fail2ban` 설치 |
| 저장소 용량 | `tools/node`(106MB)까지 clone된다 | `--depth 1` 로 받고, 빌드에는 `.dockerignore` 로 제외한다 |

---

## 11. 작업 순서 요약

**1단계 — 로컬에서 (서버 사기 전)**

1. `server/src/server.js` — `/` 와 `/multi` 라우트 추가, `express.static` 을 `{ index: false }` 로
2. `word_connection_game.html` — `DEFAULT_MULTIPLAYER_URL` 을 `location.origin + '/multi'` 로, `/healthz` 주소 조립 수정
3. `server/Dockerfile` · `server/docker-compose.yml` — 빌드 컨텍스트를 루트로, 포트 `80:3000`, 루트 파일 COPY 추가
4. 루트 `.dockerignore` 새로 만들기
5. 안내 문구 정리(`index.html` 부팅 실패 링크, 두 README)
6. 로컬에서 `docker compose up --build` 로 확인 → 커밋 & GitHub push

**2단계 — Vultr에서**

7. 인스턴스 생성(Ubuntu 24.04, 서울/도쿄, 2GB, SSH 키) + Firewall Group(22·80)
8. 접속 → `apt upgrade` → 도커 설치 → ufw 설정
9. `git clone --depth 1` → `docker compose up -d --build`
10. 8장의 체크리스트 전부 확인 (다른 네트워크에서)

**3단계 — 나중에 (선택)**

11. 도메인 구입 → Caddy로 자동 HTTPS
12. 배경 그림 경량화
13. AI 힌트가 꼭 필요하면 큰 인스턴스 + 호스트 Ollama

---

## 12. 관련 문서

- [멀티플레이 Plan](../01-plan/features/word-connection-multiplayer.plan.md) · [Design](../02-design/features/word-connection-multiplayer.design.md)
- [server/README.md](../../server/README.md) — 로컬 실행 방법
