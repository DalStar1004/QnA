// Design Ref: §9.1 — Application 계층. 모드 3(산업재산권 문제)의 진행을 담당한다.
//
// QuizService(AI 스무고개)와 나란한 위치의 유스케이스다. 흐름이 거의 같아서 그 구조를 그대로 따랐고,
// 다른 점은 세 가지다.
//   - 문제를 만들지 않는다. **문제 파일에 있는 것을 처음부터 끝까지** 순서대로 낸다.
//   - LLM 이 필요 없다. 힌트가 없고, 대신 문제 문장을 그대로 보여 준다.
//   - 한 문제의 시간이 짧고(기본 10초) 방장이 정한다.
//
// 문제를 미리 만들 필요가 없으므로 prefetch 도 없다. 그래서 QuizService 보다 짧다.

const { ExamRound } = require('../domain/ExamRound');
const {
    RoomStatus, GameMode,
    MIN_EXAM_SECONDS, MAX_EXAM_SECONDS, EXAM_SECONDS_PER_QUESTION
} = require('../domain/Room');
const { getExamQuestions, buildExamBoard } = require('../domain/examContent');
const { fail } = require('./ports');

const MIN_BLOCK_COUNT = 4;
const MAX_BLOCK_COUNT = 36;
// 정답을 보여 주고 다음 문제로 넘어가기까지의 시간. 스무고개와 같게 맞춘다.
const ROUND_TRANSITION_DELAY_MS = 3000;

class ExamService {
    /**
     * @param {Object} deps
     * @param {import('./ports').RoomRepositoryPort} deps.roomRepository
     * @param {import('./ports').BroadcasterPort} deps.broadcaster
     */
    constructor({ roomRepository, broadcaster }) {
        this.roomRepository = roomRepository;
        this.broadcaster = broadcaster;
    }

    /** 방장이 산업재산권 문제를 시작한다. 문제 파일에 있는 문제를 전부 낸다. */
    startGame({ playerId, blockCount, secondsPerQuestion }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (!room.isHost(playerId)) {
            return fail('NOT_HOST');
        }
        if (!room.canStart()) {
            return fail('NOT_ENOUGH_PLAYERS');
        }

        const settings = normalizeExamSettings({ blockCount, secondsPerQuestion });
        if (!settings) {
            return fail('INVALID_SETTINGS');
        }

        const questions = getExamQuestions();
        if (questions.length === 0) {
            // 문제 파일이 없으면 게임 자체가 성립하지 않는다. 방장에게 이유를 분명히 알린다.
            return fail('NO_EXAM_QUESTIONS');
        }

        this._stopTimer(room);
        room.mode = GameMode.EXAM;
        room.examSettings = settings;
        room.examQuestions = questions;
        room.status = RoomStatus.PLAYING;
        room.resetScores();
        room.roundIndex = 0;
        room.examRound = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:started', {
            mode: GameMode.EXAM,
            category: '산업재산권',
            totalRounds: questions.length,
            blockCount: settings.blockCount,
            secondsPerQuestion: settings.secondsPerQuestion
        });
        this.broadcaster.toRoom(room.code, 'room:players', {
            players: room.playersPayload(),
            hostId: room.hostId
        });

        this._startNextRound(room);
        return { ok: true };
    }

    /** 게임오버 후 같은 설정으로 다시 시작 (방장 전용) */
    restartGame({ playerId }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        return this.startGame({ playerId, ...room.examSettings });
    }

    /**
     * 정답 제출. 맞으면서 최초인 사람만 득점하고 곧바로 다음 문제로 넘어간다.
     * 점수는 **남은 시간**이다 — 빨리 맞힐수록 높다(혼자 하기 모드 3과 같은 계산).
     */
    submitAnswer({ playerId, word }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (!room.isPlaying() || !room.examRound) {
            return { ok: true, correct: false, alreadySolved: false };
        }

        const result = room.examRound.checkAnswer(word);
        if (!result.correct) {
            return { ok: true, correct: false, alreadySolved: result.alreadySolved };
        }

        const gained = Math.max(1, room.timeLeft);
        const winner = room.getPlayer(playerId);
        winner.addScore(gained);
        this.roomRepository.save(room);

        this._finishRound(room, {
            winnerId: winner.id,
            winnerNickname: winner.nickname,
            points: gained
        });
        return { ok: true, correct: true, alreadySolved: false, points: gained };
    }

    /** Design §6.2 — 방이 비어 사라질 때 남은 타이머를 정리해 좀비 인터벌을 막는다 */
    disposeRoom(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.examRound = null;
    }

    findRoomByPlayer(playerId) {
        return this.roomRepository.findAll().find((room) => room.hasPlayer(playerId));
    }

    _startNextRound(room) {
        const nextIndex = room.roundIndex + 1;
        const item = room.examQuestions[nextIndex - 1];

        // 방이 사라졌거나 게임이 이미 끝난 뒤에 이 자리에 올 수 있다.
        const liveRoom = this.roomRepository.findByCode(room.code);
        if (!liveRoom || liveRoom.status !== RoomStatus.PLAYING) {
            return;
        }
        if (!item) {
            this._endGame(liveRoom);
            return;
        }

        const examRound = new ExamRound({
            roundIndex: nextIndex,
            question: item.question,
            answers: item.answers,
            board: buildExamBoard(item.answers, liveRoom.examSettings.blockCount)
        });

        liveRoom.roundIndex = nextIndex;
        liveRoom.examRound = examRound;
        liveRoom.timeLeft = liveRoom.examSettings.secondsPerQuestion;
        this.roomRepository.save(liveRoom);

        this.broadcaster.toRoom(liveRoom.code, 'exam:round:started', {
            ...examRound.toClientPayload(liveRoom.examQuestions.length),
            timeLeft: liveRoom.timeLeft
        });

        this._startTimer(liveRoom);
    }

    /** 1초짜리 타이머. 시간이 다 되면 아무도 못 맞힌 채로 문제를 끝낸다. */
    _startTimer(room) {
        room.timerHandle = setInterval(() => {
            room.timeLeft -= 1;
            this.broadcaster.toRoom(room.code, 'game:tick', {
                timeLeft: room.timeLeft,
                nextHintIn: -1
            });
            if (room.timeLeft <= 0) {
                this._finishRound(room, { winnerId: null, winnerNickname: null });
            }
        }, 1000);
    }

    _stopTimer(room) {
        if (room.timerHandle) {
            clearInterval(room.timerHandle);
            room.timerHandle = null;
        }
    }

    /** 문제 마무리 — 정답을 공개하고, 마지막 문제였으면 게임을 끝낸다 */
    _finishRound(room, { winnerId, winnerNickname, points }) {
        this._stopTimer(room);
        const answer = room.examRound ? room.examRound.answerText() : '';
        const question = room.examRound ? room.examRound.question : '';
        const finishedIndex = room.roundIndex;
        room.examRound = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'exam:round:result', {
            roundIndex: finishedIndex,
            question,
            answer,
            winnerId,
            winnerNickname,
            points: points || 0,
            players: room.playersPayload()
        });

        setTimeout(() => {
            const liveRoom = this.roomRepository.findByCode(room.code);
            if (!liveRoom || liveRoom.status !== RoomStatus.PLAYING) return;
            // 뒤늦게 발화한 타임아웃이 다음 문제를 두 번 시작하지 않게 막는다 (스무고개와 같은 방어)
            if (liveRoom.roundIndex !== finishedIndex || liveRoom.examRound) return;

            if (liveRoom.roundIndex >= liveRoom.examQuestions.length) {
                this._endGame(liveRoom);
                return;
            }
            this._startNextRound(liveRoom);
        }, ROUND_TRANSITION_DELAY_MS);
    }

    _endGame(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.examRound = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:over', {
            players: room.rankedPlayers(),
            totalRounds: room.examQuestions.length
        });
    }
}

function normalizeExamSettings({ blockCount, secondsPerQuestion }) {
    const blocks = Number(blockCount);
    const seconds = Number(secondsPerQuestion);
    if (!Number.isInteger(blocks) || blocks < MIN_BLOCK_COUNT || blocks > MAX_BLOCK_COUNT) {
        return null;
    }
    if (!Number.isInteger(seconds) || seconds < MIN_EXAM_SECONDS || seconds > MAX_EXAM_SECONDS) {
        return null;
    }
    return { blockCount: blocks, secondsPerQuestion: seconds };
}

module.exports = {
    ExamService,
    ROUND_TRANSITION_DELAY_MS,
    EXAM_SECONDS_PER_QUESTION
};
