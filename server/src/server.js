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
const { OllamaHintGenerator } = require('./infrastructure/OllamaHintGenerator');
const { GroqHintGenerator } = require('./infrastructure/GroqHintGenerator');
const GeminiService = require('./services/GeminiService');

// 4. Presentation
const { registerSocketHandlers } = require('./presentation/socketHandlers');
const { registerAiRoutes } = require('./presentation/aiRoutes');

// 5. Domain — 모드 3 문제 파일 (서버를 켤 때 미리 읽어 준비 상태를 알린다)
const { getExamQuestions } = require('./domain/examContent');

const PORT = Number(process.env.PORT) || 3000;
// AI 스무고개 힌트를 만들 로컬 LLM. 다른 PC의 Ollama 를 쓰려면 환경변수로 바꾼다.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

/* ---------- 시험 구현: AI 스무고개 힌트를 어디서 만들지 ----------
 * 이 값은 두 가지에 쓰인다.
 *   ① 멀티플레이(QuizService)가 쓸 hintGenerator — 'gemini'가 아니면 전부 Ollama로 본다.
 *      (이 분기는 이번 Groq 이식과 무관하게 예전 그대로다 — 아래에서 바뀌지 않는다)
 *   ② 혼자 하기 모드 2의 /api/ai/* 가, 화면이 provider를 안 실어 보냈을 때 쓸 기본값
 *      (③ 참고: 화면은 이제 항상 'groq'|'gemini' 를 실어 보내므로 평소엔 안 쓰인다)
 * 'groq'는 ②에서만 의미가 있다 — 멀티플레이 hintGenerator는 여전히 gemini/ollama 둘뿐이다.
 * 그 밖의 값이거나 고른 것을 쓸 수 없으면(키 없음 등) 기존 내장 사전 힌트로 넘어간다.
 * 이 값 하나로 배포 방식을 바꾸는 것은 아니다 — Render 등 실제 배포는 그대로 두고
 * 로컬에서 켤 때만 넣어 시험해 보는 스위치다. */
const AI_PROVIDER = (() => {
    const value = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
    return (value === 'gemini' || value === 'groq') ? value : 'ollama';
})();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

// AI_PROVIDER 가 'gemini'면 Gemini를, 아니면(기본값) 기존 Ollama를 그대로 쓴다.
// 둘 다 HintGeneratorPort 모양(ensureReady/generateHints)이라 QuizService는 어느 쪽인지 모른다.
const hintGenerator = AI_PROVIDER === 'gemini'
    ? { ensureReady: GeminiService.ensureReady, generateHints: GeminiService.generateHints }
    : new OllamaHintGenerator({ endpoint: OLLAMA_URL, model: OLLAMA_MODEL });

/* ---------- 혼자 하기 모드 2 전용: Groq를 Gemini와 나란히 상시 준비 ----------
 * 위 hintGenerator(멀티플레이용, AI_PROVIDER로 Ollama/Gemini 중 고정)와는 별개다.
 * 혼자 하기는 사용자가 설정에서 Groq/Gemini를 자유롭게 고르고 전환할 수 있어야 하므로,
 * AI_PROVIDER 값과 무관하게 Groq도 항상 만들어 대기시켜 둔다(서버.js:presentation/aiRoutes.js 가 씀).
 *
 * 기존 GROQ_API_KEY/GEMINI_API_KEY 환경변수가 있으면 그 값을 초기 키로 그대로 써서
 * 서버가 뜨자마자 연결까지 마쳐 둔다(예전처럼 별다른 조작 없이 바로 쓸 수 있게 하는 하위 호환).
 * 실패해도 서버는 그대로 뜬다 — 화면에서 [연결하기]로 다시 시도할 수 있다. */
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const groqHintGenerator = new GroqHintGenerator({ model: GROQ_MODEL });
if (process.env.GROQ_API_KEY) {
    groqHintGenerator.setApiKey(process.env.GROQ_API_KEY);
    groqHintGenerator.connect().catch(() => {});
}
if (process.env.GEMINI_API_KEY) {
    GeminiService.setApiKey(process.env.GEMINI_API_KEY);
    GeminiService.connect().catch(() => {});
}

const roomService = new RoomService({ roomRepository, broadcaster, codeGenerator: roomCodeGenerator });
const roundService = new RoundService({ roomRepository, broadcaster });
// 모드 2는 이제 고정된 하나가 아니라 방마다 고른 Groq/Gemini를 쓴다(대기실에서 방장이 고른다).
// 혼자 하기 API(aiRoutes.js)가 쓰는 것과 같은 전역 인스턴스를 그대로 넘겨 새로 만들지 않는다.
// (위 hintGenerator/AI_PROVIDER는 더 이상 멀티플레이가 쓰지 않지만, 서버 시작 로그 안내에는
//  여전히 쓰이므로 그대로 둔다.)
const quizService = new QuizService({
    roomRepository,
    broadcaster,
    geminiService: GeminiService,
    groqHintGenerator
});
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

// 혼자 하기(브라우저)가 AI_PROVIDER='gemini' 일 때만 쓰는 경로. 'ollama'(기본값)면
// 브라우저가 예전처럼 Ollama를 직접 부르므로 이 라우트는 호출되지 않는다.
registerAiRoutes(app, { getDefaultProvider: () => AI_PROVIDER, geminiService: GeminiService, groqHintGenerator });

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
    if (AI_PROVIDER === 'gemini') {
        // 모델명만 알려 준다 — 키가 있는지 없는지는 아래 연결 확인 결과로만 드러난다.
        console.log(`  · AI 스무고개 힌트  Gemini (${GeminiService.getModel()}) — 시험 구현`);
    } else {
        console.log(`  · AI 스무고개 힌트  ${OLLAMA_URL} (${OLLAMA_MODEL})`);
    }
    console.log('    AI 가 꺼져 있어도 글자 수·초성 힌트로 게임은 진행됩니다.');
    console.log('  · 혼자 하기 모드 2  Groq/Gemini 중 골라 연결 가능 (⚙️ 게임 설정, 기본값 Groq)');
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

    // 서버가 뜨는 김에 AI 연결까지 잡아 둔다. 첫 스무고개 판에서 모델을 올리느라
    // 몇 분씩 기다리는 일을 없애기 위함이다. 실패해도 서버는 그대로 돌아간다.
    hintGenerator.ensureReady().then((status) => {
        if (status.ok) {
            console.log(`  🤖 AI 연결 완료 — ${status.model}`
                + (status.switched ? ` (설정한 ${OLLAMA_MODEL} 가 없어 자동으로 바꿨습니다)` : ''));
        } else {
            console.log(`  🤖 AI 연결 실패 — ${status.reason}`);
            console.log(AI_PROVIDER === 'gemini'
                ? '     스무고개는 글자 수·초성 힌트로 진행되며, GEMINI_API_KEY를 넣고 다시 켜면 붙습니다.'
                : '     스무고개는 글자 수·초성 힌트로 진행되며, Ollama 를 켜면 다음 판부터 자동으로 붙습니다.');
        }
        console.log('');
    });
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
