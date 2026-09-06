// Design Ref: §9.3 / §9.4 — 합성 루트(Composition Root).
// 모든 계층을 알고 있는 유일한 파일로, Infrastructure 구현체를 만들어 Application에 주입한다.

// 1. Node 내장/외부 라이브러리
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

// 2. Application
const { RoomService } = require('./application/RoomService');
const { RoundService } = require('./application/RoundService');
const { QuizService } = require('./application/QuizService');
const { ExamService } = require('./application/ExamService');

// 3. Infrastructure
const { InMemoryRoomRepository } = require('./infrastructure/InMemoryRoomRepository');
const { SocketIOBroadcaster } = require('./infrastructure/SocketIOBroadcaster');
const { roomCodeGenerator } = require('./infrastructure/roomCodeGenerator');
const { GroqHintGenerator } = require('./infrastructure/GroqHintGenerator');

// 4. Presentation
const { registerSocketHandlers } = require('./presentation/socketHandlers');

// 5. Domain — 모드 3 문제 파일 (서버를 켤 때 미리 읽어 준비 상태를 알린다)
const { getExamQuestions } = require('./domain/examContent');

const PORT = Number(process.env.PORT) || 3000;
/* AI 스무고개 힌트를 만들 LLM. 예전에는 이 PC의 Ollama 를 불렀고, 지금은 Groq API 를 부른다.
   키는 환경변수 GROQ_API_KEY 가 먼저이고, 없으면 아래 두 자리의 groq-key.txt 파일을 본다.
   파일 쪽을 둔 이유: 서버를 [서버 켜기.bat] 더블클릭으로 켜는 사람이 환경변수를 만들지 않아도
   메모장으로 키만 붙여넣으면 되게 하기 위해서다. 두 파일 다 .gitignore 로 저장소에서 뺀다.

   **QnA 폴더(저장소 루트)를 먼저 본다.** 게임 폴더를 열면 바로 보이는 자리라 찾기 쉽고,
   server/ 안쪽은 한 단계 더 들어가야 해서 파일을 어디 뒀는지 잊기 쉽다. */
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_KEY_FILES = [
    path.join(__dirname, '..', '..', 'groq-key.txt'),   // QnA 폴더 (저장소 루트)
    path.join(__dirname, '..', 'groq-key.txt')          // server 폴더
];
const GROQ_API_KEY = readGroqKey();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 키 파일 하나를 읽는다. 없거나 못 읽으면 빈 문자열. */
function readKeyFile(file) {
    try {
        return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch (error) {
        return '';
    }
}

/**
 * 환경변수 -> QnA 폴더 -> server 폴더 순으로 키를 찾는다.
 * 아무 데도 없으면 빈 문자열 (그때는 확정 힌트만으로 진행된다).
 */
function readGroqKey() {
    const fromEnv = String(process.env.GROQ_API_KEY || '').trim();
    if (fromEnv) return fromEnv;
    for (const file of GROQ_KEY_FILES) {
        const key = readKeyFile(file);
        if (key) return key;
    }
    return '';
}

/** 지금 키를 어느 파일에서 읽었는지 (없으면 넣어야 할 자리를 알려 준다). */
function groqKeyFileInUse() {
    return GROQ_KEY_FILES.find((file) => readKeyFile(file)) || GROQ_KEY_FILES[0];
}

/* ---------- 혼자 하기 게임 파일을 어디서 찾을 것인가 ----------
 * 이 파일(word_connection_game.html)과 그 화면이 쓰는 그림은 **저장소 루트**에 있다.
 * 원본을 한 벌로 두려고 server/public/ 으로 복사하지 않았기 때문에, 실행 환경에 따라 위치가 다르다.
 *
 *   · 도커로 띄운 경우 — Dockerfile 이 빌드할 때 public/ 안으로 넣어 준다.
 *   · 이 폴더에서 그냥 node 로 켠 경우(서버 켜기.bat) — 저장소 루트(server/ 의 한 단계 위)에 그대로 있다.
 *
 * 아래에서 그 두 경우를 모두 받아 준다. 도커 컨테이너에서는 ROOT_DIR 이 '/' 가 되지만
 * 거기에 게임 파일이 없으므로 LOCAL_RUN 이 false 가 되고, 루트를 뒤지는 길은 아예 열리지 않는다.
 */
const ROOT_DIR = path.join(__dirname, '..', '..');
const SOLO_FILE = 'word_connection_game.html';
const LOCAL_RUN = !fs.existsSync(path.join(PUBLIC_DIR, SOLO_FILE))
    && fs.existsSync(path.join(ROOT_DIR, SOLO_FILE));
const SOLO_PATH = LOCAL_RUN ? path.join(ROOT_DIR, SOLO_FILE) : path.join(PUBLIC_DIR, SOLO_FILE);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// ---- 의존성 조립 (Design §9.2 의존성 역전) ----
const roomRepository = new InMemoryRoomRepository();
const broadcaster = new SocketIOBroadcaster(io);

const hintGenerator = new GroqHintGenerator({
    apiKey: GROQ_API_KEY,
    model: GROQ_MODEL,
    // 서버를 켠 뒤에 키 파일을 만드는 경우가 흔하다. [연결하기] 를 누르면 여기서 다시 읽는다.
    keyLoader: readGroqKey
});

const roomService = new RoomService({ roomRepository, broadcaster, codeGenerator: roomCodeGenerator });
const roundService = new RoundService({ roomRepository, broadcaster });
const quizService = new QuizService({ roomRepository, broadcaster, hintGenerator });
// 모드 3은 문제 파일만 있으면 되므로 LLM 을 주입하지 않는다.
const examService = new ExamService({ roomRepository, broadcaster });

registerSocketHandlers(io, { roomService, roundService, quizService, examService });

/* ---------- 화면 두 개를 어느 주소에 둘지 ----------
 * 인터넷에 올리면 사람들은 주소창에 서버 주소만 치고 들어온다(예: http://123.45.67.89).
 * 그때 처음 만나는 화면이 멀티플레이 대기실이면, 방 코드를 받을 데가 없는 사람은 아무것도 못 한다.
 * 그래서 '/' 에는 **시작 화면이 있는 혼자 하기 게임**을 두고, 멀티플레이는 '/multi' 로 옮겼다.
 * 시작 화면의 [접속하기] 가 '/multi' 로 데려다 준다.
 *
 * 이 라우트는 반드시 express.static 보다 **먼저** 등록해야 한다.
 * express.static 은 기본으로 '/' 요청에 public/index.html(= 멀티 화면)을 돌려주기 때문이다.
 * 같은 이유로 static 쪽은 index:false 로 그 기본 동작을 꺼 둔다.
 */
app.get('/', (req, res) => res.sendFile(SOLO_PATH));
app.get('/multi', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// 클라이언트 정적 파일 서빙 — socket.io 클라이언트 스크립트는 Socket.IO가 /socket.io/ 로 자동 제공한다
app.use(express.static(PUBLIC_DIR, { index: false }));

/* 도커 없이 이 폴더에서 켠 경우에만, 혼자 하기 화면이 쓰는 그림을 저장소 루트에서 마저 꺼내 준다.
 * public/assets 에 없는 아이콘(icon-*.png · champion-badge.png)과 배경(backgrounds/)이 여기 해당한다.
 * 루트의 assets 폴더 하나만 열어 주므로 문서·설정 같은 다른 파일은 나가지 않는다. */
if (LOCAL_RUN) {
    app.use('/assets', express.static(path.join(ROOT_DIR, 'assets'), { index: false }));
    // 모드 3(산업재산권 문제)이 읽는 문제 파일도 루트에 있다.
    app.use('/quiz-data', express.static(path.join(ROOT_DIR, 'quiz-data'), { index: false }));
}

// 컨테이너 헬스체크용 엔드포인트
app.get('/healthz', (req, res) => {
    res.json({ ok: true, rooms: roomRepository.size() });
});

/* ---------- 혼자 하기 화면이 쓰는 AI 다리 ----------
 * 혼자 하기(모드 2)와 멀티플레이가 **같은 키 하나**(server/groq-key.txt)를 쓴다.
 * 그러면서도 키를 브라우저로 내려보내지 않으려고, 힌트 요청을 서버가 대신 보낸다.
 * 브라우저가 받는 것은 다 만들어진 힌트 문장뿐이다.
 *
 * 게임 파일을 두 번 눌러 연 경우(file://)에는 이 주소에 닿을 수 없다.
 * 그때 혼자 하기는 예전처럼 내장 사전으로 문제를 만든다 — 게임은 그대로 진행된다.
 */
const AI_CORS = (req, res, next) => {
    // 혼자 하기 화면을 다른 주소에서 열어 두고 이 서버를 쓰는 경우가 있다(파일로 연 경우 등).
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
};
app.use('/api/ai', AI_CORS, express.json({ limit: '8kb' }));

/** 지금 AI를 쓸 수 있는지. 키가 있으면 연결까지 맞춰 둔다(멀티플레이의 ai:status 와 같은 동작). */
app.get('/api/ai/status', async (req, res) => {
    const status = await quizService.checkAi();
    res.json({
        ok: !!status.ok,
        hasKey: hintGenerator.hasApiKey,
        connected: !!hintGenerator.connected,
        offByHost: !!status.offByHost,
        model: status.model || GROQ_MODEL,
        reason: status.reason || null
    });
});

/** 혼자 하기의 [연결하기]. 꺼 두었던 표시를 지우고 다시 잇는다. */
app.post('/api/ai/connect', async (req, res) => {
    const status = await quizService.connectAi();
    res.json({
        ok: !!status.ok,
        hasKey: hintGenerator.hasApiKey,
        connected: !!hintGenerator.connected,
        model: status.model || GROQ_MODEL,
        // 설정한 모델이 계정에 없어 다른 것으로 갈아탔으면 화면에도 알린다.
        switched: !!status.switched,
        requested: status.requested || GROQ_MODEL,
        reason: status.reason || null
    });
});

/* 혼자 하기의 [연결 끊기] 는 이 자리를 부르지 않는다.
   그 버튼은 '이 화면에서 AI를 안 쓴다' 는 뜻이고, 서버 연결을 끄면 같은 서버로 놀고 있는
   멀티플레이 방까지 확정 힌트로 떨어지기 때문이다. 서버 전체를 끄는 것은 대기실의 방장 버튼이다. */

/** 정답을 알려 주면 힌트 문장을 만들어 돌려준다. 키는 서버 밖으로 나가지 않는다. */
app.post('/api/ai/hints', async (req, res) => {
    const answer = String((req.body && req.body.answer) || '').trim();
    const category = String((req.body && req.body.category) || '').trim();
    // 낱말 하나와 카테고리 이름이면 충분하다. 긴 글이 들어오면 프롬프트로 쓰지 않는다.
    if (!answer || !category || answer.length > 20 || category.length > 30) {
        return res.status(400).json({ ok: false, reason: '정답과 카테고리를 확인해주세요' });
    }
    try {
        const hints = await hintGenerator.generateHints(answer, category);
        return res.json({ ok: true, hints, model: hintGenerator.model });
    } catch (error) {
        return res.json({ ok: false, reason: (error && error.message) || '힌트를 만들지 못했어요' });
    }
});

/**
 * 같은 인터넷(공유기)에 물린 다른 PC가 적어 넣을 주소를 모아 돌려준다.
 * 친구가 접속할 때 주소를 직접 찾아보지 않아도 되게, 서버를 켜면 바로 보여 준다.
 */
function lanAddresses() {
    const found = [];
    const groups = os.networkInterfaces();
    Object.keys(groups).forEach((name) => {
        (groups[name] || []).forEach((info) => {
            if (info.family === 'IPv4' && !info.internal) {
                found.push(info.address);
            }
        });
    });
    return found;
}

httpServer.listen(PORT, () => {
    console.log('');
    console.log('  🍭 멀티플레이 서버가 켜졌습니다! 이 창을 켜 둔 채로 게임하세요.');
    console.log('');
    console.log(`  · 이 PC에서는        http://localhost:${PORT}`);
    lanAddresses().forEach((address) => {
        console.log(`  · 같은 인터넷의 PC는  http://${address}:${PORT}`);
    });
    console.log('');
    console.log('    그 주소로 들어가면 시작 화면이 뜹니다. [접속하기] 를 누르면 멀티플레이(/multi)로 갑니다.');
    console.log('');
    console.log(`  · AI 스무고개 힌트  Groq API (${GROQ_MODEL})`
        + (GROQ_API_KEY ? '' : ' — API 키 없음'));
    console.log('    AI 가 꺼져 있어도 글자 수·초성 힌트로 게임은 진행됩니다.');
    console.log('');

    // 모드 3은 문제 파일이 있어야 한다. 서버를 켤 때 미리 읽어 두면, 없을 때 여기서 바로 알 수 있다.
    // (게임을 시작하려다 실패하고 나서야 알게 되면 원인을 찾기 어렵다)
    const examCount = getExamQuestions().length;
    console.log(examCount > 0
        ? `  · 산업재산권 문제  ${examCount}문제 준비됨`
        : '  · 산업재산권 문제  파일을 찾지 못했습니다 — 모드 3을 쓸 수 없습니다');
    console.log('');
    console.log('  종료하려면 Ctrl+C 를 누르거나 이 창을 닫으세요.');
    console.log('');

    // 서버가 뜨는 김에 AI 연결까지 잡아 둔다. 한 번 이어 두면 대기실에서 [연결 끊기] 를
    // 누르기 전까지 유지된다. 실패해도 서버는 그대로 돌아간다.
    if (!hintGenerator.hasApiKey) {
        console.log('  🤖 AI 연결 안 함 — Groq API 키가 없습니다.');
        console.log(`     ${GROQ_KEY_FILES[0]} 에 키를 한 줄 적어 두거나 GROQ_API_KEY 환경변수를 넣어주세요.`);
        console.log('     키가 없어도 스무고개는 글자 수·초성 힌트로 진행됩니다.');
        console.log('');
    } else {
        hintGenerator.ensureReady().then((status) => {
            if (status.ok) {
                console.log(`  🤖 AI 연결 완료 — Groq · ${status.model}`
                    + (status.switched ? ` (설정한 ${GROQ_MODEL} 가 없어 자동으로 바꿨습니다)` : ''));
                console.log(`     키를 읽은 곳: ${groqKeyFileInUse()}`);
            } else {
                console.log(`  🤖 AI 연결 실패 — ${status.reason}`);
                console.log('     스무고개는 글자 수·초성 힌트로 진행되며, 대기실에서 [연결하기] 로 다시 시도할 수 있습니다.');
            }
            console.log('');
        });
    }
    console.log('');
});

// 컨테이너 종료 시그널에 정상 응답 (docker stop 시 10초 대기 없이 즉시 종료)
['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
        console.log(`\n${signal} 수신 — 서버를 종료합니다`);
        httpServer.close(() => process.exit(0));
    });
});

module.exports = { app, httpServer, io };
