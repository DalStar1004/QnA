// Design Ref: §9.1 / §9.3 — Presentation 계층.
// 소켓 이벤트를 Application 유스케이스 호출로 변환하고, 결과를 ack/브로드캐스트로 되돌린다.
// 이 계층만 socket 객체를 직접 다루며, Domain을 직접 참조하지 않는다.
// Design §4 이벤트 카탈로그를 그대로 구현한다.

const { GameMode } = require('../domain/Room');

/**
 * @param {import('socket.io').Server} io
 * @param {Object} services
 * @param {import('../application/RoomService').RoomService} services.roomService
 * @param {import('../application/RoundService').RoundService} services.roundService
 * @param {import('../application/QuizService').QuizService} services.quizService
 */
function registerSocketHandlers(io, { roomService, roundService, quizService, examService }) {
    // 방이 어떤 모드인지에 따라 진행을 맡을 유스케이스가 갈린다.
    // 소켓 이벤트 이름은 하나로 두고, 여기서 방의 모드를 보고 갈라 준다.
    const serviceFor = (playerId) => {
        const room = roomService.findRoomByPlayer(playerId);
        if (!room) return roundService;
        if (room.mode === GameMode.QUIZ) return quizService;
        if (room.mode === GameMode.EXAM) return examService;
        return roundService;
    };

    io.on('connection', (socket) => {
        // ---- Design §4.1 `room:create` ----
        handle(socket, 'room:create', (payload, ack) => {
            const result = roomService.createRoom({ playerId: socket.id, nickname: payload && payload.nickname });
            if (!result.ok) {
                return respond(socket, ack, result);
            }
            socket.join(result.roomCode);
            respond(socket, ack, result);
            broadcastPlayersOf(roomService, socket.id);
            return undefined;
        });

        // ---- Design §4.1 `room:join` ----
        handle(socket, 'room:join', (payload, ack) => {
            const result = roomService.joinRoom({
                playerId: socket.id,
                nickname: payload && payload.nickname,
                roomCode: payload && payload.roomCode
            });
            if (!result.ok) {
                return respond(socket, ack, result);
            }
            socket.join(result.roomCode);
            respond(socket, ack, result);
            broadcastPlayersOf(roomService, socket.id);
            return undefined;
        });

        // ---- Design §4.1 `game:start` (방장 전용) ----
        // 방장이 고른 모드에 따라 단어 연결 / AI 스무고개로 갈라진다.
        // 스무고개는 첫 문제를 LLM 으로 만드는 동안 기다려야 해서 비동기다.
        handle(socket, 'game:start', (payload, ack) => {
            if (payload && payload.mode === GameMode.QUIZ) {
                quizService.startGame({
                    playerId: socket.id,
                    rounds: payload.rounds,
                    category: payload.category,
                    blockCount: payload.blockCount
                })
                    .then((result) => respond(socket, ack, result))
                    .catch((error) => {
                        console.error('[socket] game:start(quiz) 처리 중 오류:', error);
                        respond(socket, ack, {
                            ok: false,
                            error: { code: 'INTERNAL_ERROR', message: '문제를 만들지 못했어요' }
                        });
                    });
                return undefined;
            }
            // 모드 3은 문제를 만들 것이 없어서(파일에 있는 것을 그대로 낸다) 동기다.
            if (payload && payload.mode === GameMode.EXAM) {
                const examResult = examService.startGame({
                    playerId: socket.id,
                    blockCount: payload.blockCount,
                    secondsPerQuestion: payload.secondsPerQuestion
                });
                return respond(socket, ack, examResult);
            }
            const result = roundService.startGame({
                playerId: socket.id,
                blockCount: payload && payload.blockCount,
                category: payload && payload.category,
                durationSeconds: payload && payload.durationSeconds
            });
            return respond(socket, ack, result);
        });

        // ---- Design §4.1 `game:restart` (방장 전용) ----
        handle(socket, 'game:restart', (payload, ack) => {
            const result = serviceFor(socket.id).restartGame({ playerId: socket.id });
            if (result && typeof result.then === 'function') {
                result
                    .then((settled) => respond(socket, ack, settled))
                    .catch(() => respond(socket, ack, {
                        ok: false,
                        error: { code: 'INTERNAL_ERROR', message: '다시 시작하지 못했어요' }
                    }));
                return undefined;
            }
            return respond(socket, ack, result);
        });

        // ---- Design §4.1 `answer:submit` — 제출자에게만 즉시 ack ----
        // 단어 연결은 블록을 이어 만든 낱말, 스무고개는 입력창에 적은 낱말이 들어온다.
        handle(socket, 'answer:submit', (payload, ack) => {
            const result = serviceFor(socket.id).submitAnswer({
                playerId: socket.id,
                word: payload && payload.word
            });
            return respond(socket, ack, result);
        });

        // ---- AI(로컬 LLM) 연결 상태 확인 — 대기실에서 스무고개를 고른 방장에게 보여 준다 ----
        handle(socket, 'ai:status', (payload, ack) => {
            if (typeof ack !== 'function') return undefined;
            quizService.checkAi()
                .then((status) => ack(status))
                .catch(() => ack({ ok: false }));
            return undefined;
        });

        // ---- Design §6.2 연결 종료 처리 ----
        socket.on('disconnect', () => {
            try {
                const result = roomService.leaveRoom(socket.id);
                if (!result.ok || !result.room) {
                    return;
                }
                if (result.roomClosed) {
                    // 방에 아무도 남지 않음 → 타이머를 정리해 좀비 인터벌을 막는다
                    if (result.room.mode === GameMode.QUIZ) {
                        quizService.disposeRoom(result.room);
                    } else if (result.room.mode === GameMode.EXAM) {
                        examService.disposeRoom(result.room);
                    } else {
                        roundService.disposeRoom(result.room);
                    }
                    return;
                }
                roomService.broadcastPlayers(result.room);
            } catch (error) {
                console.error('[socket] disconnect 처리 중 오류:', error);
            }
        });
    });
}

/**
 * 모든 핸들러를 try/catch로 감싼다 (Design §8.2 컨벤션).
 * 하나의 잘못된 요청 때문에 서버 전체가 죽지 않도록 보장한다.
 */
function handle(socket, event, handler) {
    socket.on(event, (payload, ack) => {
        try {
            handler(payload, ack);
        } catch (error) {
            console.error(`[socket] ${event} 처리 중 오류:`, error);
            respond(socket, ack, {
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: '서버에서 문제가 발생했어요' }
            });
        }
    });
}

/** ack 콜백이 없을 수도 있으므로 항상 방어적으로 호출하고, 실패는 error:notice로도 알린다 */
function respond(socket, ack, result) {
    if (typeof ack === 'function') {
        ack(result);
    }
    if (!result.ok && result.error) {
        socket.emit('error:notice', { message: result.error.message });
    }
    return result;
}

/** 참가 직후 방 전체에 갱신된 참가자 목록을 알린다. 방을 못 찾으면 조용히 넘어간다. */
function broadcastPlayersOf(roomService, playerId) {
    const room = roomService.findRoomByPlayer(playerId);
    if (room) {
        roomService.broadcastPlayers(room);
    }
}

module.exports = { registerSocketHandlers };
