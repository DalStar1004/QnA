// Design Ref: §9.3 / §9.4 — 합성 루트(Composition Root).
// 모든 계층을 알고 있는 유일한 파일로, Infrastructure 구현체를 만들어 Application에 주입한다.

// 1. Node 내장/외부 라이브러리
const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

// 2. Application
const { RoomService } = require('./application/RoomService');
const { RoundService } = require('./application/RoundService');
const { QuizService } = require('./application/QuizService');

// 3. Infrastructure
const { InMemoryRoomRepository } = require('./infrastructure/InMemoryRoomRepository');
const { SocketIOBroadcaster } = require('./infrastructure/SocketIOBroadcaster');
const { roomCodeGenerator } = require('./infrastructure/roomCodeGenerator');
const { OllamaHintGenerator } = require('./infrastructure/OllamaHintGenerator');

// 4. Presentation
const { registerSocketHandlers } = require('./presentation/socketHandlers');

const PORT = Number(process.env.PORT) || 3000;
// AI 스무고개 힌트를 만들 로컬 LLM. 다른 PC의 Ollama 를 쓰려면 환경변수로 바꾼다.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// ---- 의존성 조립 (Design §9.2 의존성 역전) ----
const roomRepository = new InMemoryRoomRepository();
const broadcaster = new SocketIOBroadcaster(io);

const hintGenerator = new OllamaHintGenerator({ endpoint: OLLAMA_URL, model: OLLAMA_MODEL });

const roomService = new RoomService({ roomRepository, broadcaster, codeGenerator: roomCodeGenerator });
const roundService = new RoundService({ roomRepository, broadcaster });
const quizService = new QuizService({ roomRepository, broadcaster, hintGenerator });

registerSocketHandlers(io, { roomService, roundService, quizService });

// 클라이언트 정적 파일 서빙 — socket.io 클라이언트 스크립트는 Socket.IO가 /socket.io/ 로 자동 제공한다
app.use(express.static(PUBLIC_DIR));

// 컨테이너 헬스체크용 엔드포인트
app.get('/healthz', (req, res) => {
    res.json({ ok: true, rooms: roomRepository.size() });
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
    console.log(`  · AI 스무고개 힌트  ${OLLAMA_URL} (${OLLAMA_MODEL})`);
    console.log('    AI 가 꺼져 있어도 글자 수·초성 힌트로 게임은 진행됩니다.');
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
            console.log('     스무고개는 글자 수·초성 힌트로 진행되며, Ollama 를 켜면 다음 판부터 자동으로 붙습니다.');
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
