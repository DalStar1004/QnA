// Design Ref: §9.1 — Application 계층. 라운드 진행/타이머/정답 판정 유스케이스를 담당한다.
// Design Ref: §1.2 — 정답(targetWords)과 "이미 풀렸는가" 상태는 서버에만 존재하며 클라이언트로 나가지 않는다.

const { createRound } = require('../domain/Round');
const {
    RoomStatus,
    MIN_GAME_DURATION_SECONDS,
    MAX_GAME_DURATION_SECONDS
} = require('../domain/Room');
const { getCategoriesFittingBoard } = require('../domain/dictionary');
const { fail } = require('./ports');

const ROUND_TRANSITION_DELAY_MS = 2000;
const MIN_BLOCK_COUNT = 4;
const MAX_BLOCK_COUNT = 36;

class RoundService {
    /**
     * @param {Object} deps
     * @param {import('./ports').RoomRepositoryPort} deps.roomRepository
     * @param {import('./ports').BroadcasterPort} deps.broadcaster
     */
    constructor({ roomRepository, broadcaster }) {
        this.roomRepository = roomRepository;
        this.broadcaster = broadcaster;
    }

    /** FR-03: 방장이 시작하면 서버가 만든 동일한 보드가 방 전체에 동시에 전달된다 */
    startGame({ playerId, blockCount, category, durationSeconds }) {
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

        const settings = normalizeSettings({ blockCount, category, durationSeconds });
        if (!settings) {
            return fail('INVALID_SETTINGS');
        }

        const resolved = resolveCategory(settings);
        if (!resolved) {
            return fail('NO_VALID_CATEGORY');
        }

        room.settings = { ...settings };
        this._beginGame(room, resolved);
        return { ok: true };
    }

    /** Design §4.1 `game:restart` — 게임오버 후 저장된 설정 그대로 재시작 (방장 전용) */
    restartGame({ playerId }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        return this.startGame({ playerId, ...room.settings });
    }

    /**
     * FR-04 / FR-05: 정답 제출.
     * 정답이면서 최초 제출인 경우에만 득점하고, 방 전체에 결과를 알린 뒤 다음 라운드로 넘어간다.
     * 오답이거나 이미 다른 사람이 먼저 맞힌 경우에는 제출자에게만 ack로 답하고 브로드캐스트하지 않는다
     * (다른 참가자의 플레이를 방해하지 않기 위함 — Design §4.3).
     */
    submitAnswer({ playerId, word }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (!room.isPlaying() || !room.currentRound) {
            return { ok: true, correct: false, alreadySolved: false, duplicate: false };
        }

        const submitted = String(word || '');

        // 이번 게임에서 **이미 맞힌 낱말**이면 정답으로 치지 않고 되돌려 보낸다.
        // 같은 낱말로 계속 점수를 쌓을 수 없게 하기 위함이며, 판을 끝내지도 않는다 —
        // 제출한 사람만 "중복" 안내를 받고 다시 고르면 된다 (혼자 하기 모드와 같은 규칙).
        if (room.solvedWords.includes(submitted)) {
            return { ok: true, correct: false, alreadySolved: false, duplicate: true };
        }

        const result = room.currentRound.checkAnswer(submitted);
        if (!result.correct) {
            return { ok: true, correct: false, alreadySolved: result.alreadySolved, duplicate: false };
        }

        const winner = room.getPlayer(playerId);
        winner.addScore(1);
        room.solvedWords.push(submitted);
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'round:result', {
            winnerId: winner.id,
            winnerNickname: winner.nickname,
            word: String(word),
            players: room.playersPayload()
        });

        const solvedRoundIndex = room.currentRound.roundIndex;
        setTimeout(() => {
            // 타임아웃이 늦게 발화했을 때를 대비한 가드: 게임이 이미 끝났거나 방이 사라졌으면 무시한다.
            const liveRoom = this.roomRepository.findByCode(room.code);
            if (!liveRoom || !liveRoom.isPlaying()) {
                return;
            }
            if (liveRoom.currentRound && liveRoom.currentRound.roundIndex !== solvedRoundIndex) {
                return;
            }
            this._startNextRound(liveRoom);
        }, ROUND_TRANSITION_DELAY_MS);

        return { ok: true, correct: true, alreadySolved: false, duplicate: false };
    }

    /** Design §6.2 — 방이 비어 사라질 때 남은 타이머를 정리해 좀비 인터벌을 막는다 */
    disposeRoom(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.currentRound = null;
    }

    findRoomByPlayer(playerId) {
        return this.roomRepository.findAll().find((room) => room.hasPlayer(playerId));
    }

    _beginGame(room, resolvedCategory) {
        this._stopTimer(room);

        room.status = RoomStatus.PLAYING;
        room.resetScores();
        room.roundIndex = 0;
        room.solvedWords = [];
        room.timeLeft = room.settings.durationSeconds;
        room.activeCategory = resolvedCategory;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:started', {
            category: resolvedCategory,
            blockCount: room.settings.blockCount,
            durationSeconds: room.settings.durationSeconds
        });
        this.broadcaster.toRoom(room.code, 'room:players', {
            players: room.playersPayload(),
            hostId: room.hostId
        });

        this._startNextRound(room);
        this._startTimer(room);
    }

    _startNextRound(room) {
        room.roundIndex += 1;
        room.currentRound = createRound({
            roundIndex: room.roundIndex,
            category: room.activeCategory,
            blockCount: room.settings.blockCount,
            exclude: room.solvedWords
        });
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'round:started', room.currentRound.toClientPayload());
    }

    /** FR-06: 타이머는 서버가 관리하고 1초마다 방 전체에 남은 시간을 알린다 */
    _startTimer(room) {
        room.timerHandle = setInterval(() => {
            room.timeLeft -= 1;
            this.broadcaster.toRoom(room.code, 'game:tick', { timeLeft: room.timeLeft });
            if (room.timeLeft <= 0) {
                this._endGame(room);
            }
        }, 1000);
    }

    _stopTimer(room) {
        if (room.timerHandle) {
            clearInterval(room.timerHandle);
            room.timerHandle = null;
        }
    }

    _endGame(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.currentRound = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:over', {
            players: room.rankedPlayers()
        });
    }
}

/**
 * 목표 글자 수 설정은 없앴다 — 몇 글자짜리를 낼지는 서버가 라운드마다 알아서 고른다.
 * 대신 방장이 **게임 시간**을 정한다. 값이 없거나 이상하면 기본값(60초)으로 되돌린다.
 */
function normalizeSettings({ blockCount, category, durationSeconds }) {
    const blocks = Number(blockCount);
    const duration = Number(durationSeconds);

    if (!Number.isInteger(blocks) || blocks < MIN_BLOCK_COUNT || blocks > MAX_BLOCK_COUNT) {
        return null;
    }
    if (!Number.isInteger(duration)
        || duration < MIN_GAME_DURATION_SECONDS
        || duration > MAX_GAME_DURATION_SECONDS) {
        return null;
    }
    return {
        blockCount: blocks,
        category: typeof category === 'string' && category ? category : 'random',
        durationSeconds: duration
    };
}

/** 블록 개수 안에 정답 단어 2개를 넣을 수 있는 카테고리 중에서 고른다 */
function resolveCategory({ blockCount, category }) {
    const validCategories = getCategoriesFittingBoard(blockCount);
    if (validCategories.length === 0) {
        return null;
    }
    if (category === 'random') {
        return validCategories[Math.floor(Math.random() * validCategories.length)];
    }
    return validCategories.includes(category) ? category : null;
}

module.exports = { RoundService, ROUND_TRANSITION_DELAY_MS };
