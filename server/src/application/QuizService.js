// Design Ref: §9.1 — Application 계층. AI 스무고개 모드의 라운드 진행을 담당한다.
//
// 단어 연결(RoundService)과 나란한 위치의 유스케이스다. 다른 점은 두 가지뿐이다.
//   - 끝나는 조건이 "시간"이 아니라 "정해진 라운드 수를 모두 마쳤을 때" 다.
//   - 문제를 만들 때 LLM 이 필요하다. 그래서 HintGeneratorPort 를 주입받는다.
//
// LLM 은 언제든 꺼져 있을 수 있으므로, **힌트 생성 실패로 게임이 멈추지 않게** 한다.
// 실패하면 확정 힌트(글자 수·초성·첫 글자)만으로 라운드를 진행한다.

const { QuizRound } = require('../domain/QuizRound');
const { RoomStatus, GameMode, MIN_QUIZ_ROUNDS, MAX_QUIZ_ROUNDS } = require('../domain/Room');
const { getCategories } = require('../domain/dictionary');
const { pickAnswer, assembleHints, buildQuizBoard } = require('../domain/quizContent');
const { fail } = require('./ports');

const MIN_BLOCK_COUNT = 4;
const MAX_BLOCK_COUNT = 36;
const HINT_INTERVAL_SECONDS = 10;   // 힌트가 하나씩 열리는 간격
const EXTRA_SECONDS = 20;           // 마지막 힌트 이후에 더 주는 여유 시간
const ROUND_TRANSITION_DELAY_MS = 3000;

class QuizService {
    /**
     * @param {Object} deps
     * @param {import('./ports').RoomRepositoryPort} deps.roomRepository
     * @param {import('./ports').BroadcasterPort} deps.broadcaster
     * @param {import('./ports').HintGeneratorPort} deps.hintGenerator
     */
    constructor({ roomRepository, broadcaster, hintGenerator }) {
        this.roomRepository = roomRepository;
        this.broadcaster = broadcaster;
        this.hintGenerator = hintGenerator;
    }

    /** 방장이 스무고개를 시작한다. 첫 문제를 만드는 동안 방 전체에 준비 중임을 알린다. */
    async startGame({ playerId, rounds, category, blockCount }) {
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

        const settings = normalizeQuizSettings({ rounds, category, blockCount });
        if (!settings) {
            return fail('INVALID_SETTINGS');
        }
        const resolvedCategory = resolveCategory(settings.category);
        if (!resolvedCategory) {
            return fail('NO_VALID_CATEGORY');
        }

        this._stopTimer(room);
        room.mode = GameMode.QUIZ;
        room.quizSettings = settings;
        room.status = RoomStatus.PLAYING;
        room.resetScores();
        room.roundIndex = 0;
        room.usedAnswers = [];
        room.activeCategory = resolvedCategory;
        room.quizRound = null;
        room.prefetch = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:started', {
            mode: GameMode.QUIZ,
            category: resolvedCategory,
            totalRounds: settings.rounds,
            blockCount: settings.blockCount
        });
        this.broadcaster.toRoom(room.code, 'room:players', {
            players: room.playersPayload(),
            hostId: room.hostId
        });

        // 첫 문제는 기다려야 하므로 준비 중임을 알린다. 모델이 콜드 상태면 수십 초가 걸린다.
        // 문제가 만들어지기를 **기다리지 않고** 바로 응답한다. 여기서 붙들면 방장의 [게임 시작]
        // 버튼이 그 시간 내내 눌린 채로 남는데, 화면은 이미 quiz:preparing 으로 넘어가 있어
        // 기다릴 이유가 없다. 문제가 준비되면 quiz:round:started 가 방 전체에 알린다.
        this.broadcaster.toRoom(room.code, 'quiz:preparing', { roundIndex: 1 });
        this._autoConnect(room);
        this._startNextRound(room).catch((error) => {
            console.error('[quiz] 첫 라운드 시작 실패:', error);
            this._endGame(room);
        });
        return { ok: true };
    }

    /** 게임오버 후 같은 설정으로 다시 시작 (방장 전용) */
    restartGame({ playerId }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        return this.startGame({ playerId, ...room.quizSettings });
    }

    /**
     * 정답 제출. 맞으면서 최초인 사람만 득점하고 곧바로 다음 라운드로 넘어간다.
     * 오답은 제출자에게만 알린다 (다른 참가자의 플레이를 방해하지 않기 위함 — Design §4.3).
     */
    submitAnswer({ playerId, word }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (!room.isPlaying() || !room.quizRound) {
            return { ok: true, correct: false, alreadySolved: false };
        }

        const result = room.quizRound.checkAnswer(word);
        if (!result.correct) {
            return { ok: true, correct: false, alreadySolved: result.alreadySolved };
        }

        // 혼자 하기 모드 2와 같은 계산 — 본 힌트가 적을수록 높은 점수
        const gained = room.quizRound.points();
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

    /**
     * 대기실에서 스무고개를 고른 방장에게 보여 줄 AI 연결 상태.
     * 꺼져 있어도 게임은 되므로(확정 힌트만 나온다) 시작을 막지는 않고 알려 주기만 한다.
     */
    async checkAi() {
        if (!this.hintGenerator || !this.hintGenerator.ensureReady) {
            return { ok: false, reason: 'AI 힌트를 만들 수 없는 설정이에요' };
        }
        // 방장이 [연결 끊기] 로 꺼 두었다면 상태만 알려 주고 다시 잇지 않는다.
        if (this.hintGenerator.manuallyDisconnected) {
            return { ok: false, connected: false, offByHost: true, reason: '방장이 AI 연결을 꺼 두었어요' };
        }
        // 상태를 묻는 김에 **연결까지 끝내 둔다.** 방장이 대기실에서 스무고개를 고른 이 순간부터
        // 모델을 올려 두면, 게임을 시작했을 때 첫 문제를 기다리지 않는다
        // (예열이 없으면 콜드 로드로 실측 167초가 걸렸다).
        const status = await this.hintGenerator.ensureReady();
        return {
            ok: !!status.ok,
            connected: !!this.hintGenerator.connected,
            model: status.model || null,
            switched: !!status.switched,
            reason: status.reason || null
        };
    }

    /**
     * 대기실의 [연결하기] — 꺼 두었던 표시를 지우고 다시 잇는다.
     * 한 번 이어 두면 [연결 끊기] 를 누를 때까지 유지된다.
     */
    async connectAi() {
        if (!this.hintGenerator || !this.hintGenerator.connect) {
            return { ok: false, reason: 'AI 힌트를 만들 수 없는 설정이에요' };
        }
        const status = await this.hintGenerator.connect();
        return {
            ok: !!status.ok,
            connected: !!this.hintGenerator.connected,
            model: status.model || null,
            switched: !!status.switched,
            requested: status.requested || null,
            reason: status.reason || null
        };
    }

    /** 대기실의 [연결 끊기] — 다음 판부터는 확정 힌트만으로 진행된다. */
    disconnectAi() {
        if (!this.hintGenerator || !this.hintGenerator.disconnect) {
            return { ok: false, reason: 'AI 힌트를 만들 수 없는 설정이에요' };
        }
        this.hintGenerator.disconnect();
        return { ok: true, connected: false };
    }

    /** Design §6.2 — 방이 비어 사라질 때 남은 타이머를 정리해 좀비 인터벌을 막는다 */
    disposeRoom(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.quizRound = null;
        room.prefetch = null;
    }

    findRoomByPlayer(playerId) {
        return this.roomRepository.findAll().find((room) => room.hasPlayer(playerId));
    }

    /**
     * **자동 연결.** 스무고개를 시작하면 AI 연결은 서버가 알아서 잡는다.
     * 연결·예열이 끝나기를 기다리지 않고(첫 문제 만들기가 어차피 다시 확인한다),
     * 결과가 나오면 방 전체에 알려 준다 — 지금 힌트가 AI 것인지 아닌지를 모두가 알 수 있게.
     *
     * 실패해도 게임을 막지 않는다. 확정 힌트(글자 수·초성·첫 글자)만으로 계속 진행한다.
     */
    _autoConnect(room) {
        if (!this.hintGenerator || !this.hintGenerator.ensureReady) return;
        Promise.resolve(this.hintGenerator.ensureReady())
            .then((status) => {
                this.broadcaster.toRoom(room.code, 'quiz:ai', {
                    ok: !!status.ok,
                    model: status.model || null,
                    switched: !!status.switched,
                    reason: status.reason || null
                });
            })
            .catch(() => null);
    }

    /**
     * 문제 하나를 만든다. 정답은 **언제나 사전에서** 고르고, LLM 에는 힌트만 맡긴다.
     * 모델이 정답까지 고르면 카테고리와 상관없는 낱말이 나와도 걸러낼 자료가 없다.
     */
    async _createQuizRound(room, roundIndex) {
        const blockCount = room.quizSettings.blockCount;
        const answer = pickAnswer(room.activeCategory, blockCount, room.usedAnswers);
        if (!answer) return null;

        let llmHints = [];
        let aiGenerated = false;
        try {
            llmHints = await this.hintGenerator.generateHints(answer, room.activeCategory);
            aiGenerated = llmHints.length > 0;
        } catch (error) {
            // AI 가 꺼져 있어도 확정 힌트(글자 수·초성·첫 글자)만으로 풀 수 있다.
            console.warn(`[quiz] 힌트 생성 실패 — 확정 힌트로 진행합니다: ${error.message}`);
        }

        return new QuizRound({
            roundIndex,
            category: room.activeCategory,
            answer,
            hints: assembleHints(answer, llmHints),
            board: buildQuizBoard(answer, blockCount),
            aiGenerated
        });
    }

    /** 다음 라운드 문제를 미리 만들어 둔다. 지금 판을 푸는 동안 만들어 두면 기다림이 사라진다. */
    _startPrefetch(room) {
        if (room.prefetch) return;
        if (room.roundIndex >= room.quizSettings.rounds) return;
        // 실패는 여기서 삼킨다. 쓸 때가 되면 그 자리에서 다시 만든다.
        room.prefetch = this._createQuizRound(room, room.roundIndex + 1).catch(() => null);
    }

    async _startNextRound(room) {
        const nextIndex = room.roundIndex + 1;

        const pending = room.prefetch;
        room.prefetch = null;
        let quizRound = pending ? await pending : null;
        if (!quizRound) {
            quizRound = await this._createQuizRound(room, nextIndex);
        } else {
            quizRound.roundIndex = nextIndex;
        }

        // 방이 사라졌거나 게임이 이미 끝난 뒤에 문제가 도착할 수 있다 (LLM 응답이 늦는 경우).
        const liveRoom = this.roomRepository.findByCode(room.code);
        if (!liveRoom || liveRoom.status !== RoomStatus.PLAYING) {
            return;
        }
        if (!quizRound) {
            this._endGame(liveRoom);
            return;
        }

        liveRoom.roundIndex = nextIndex;
        liveRoom.quizRound = quizRound;
        liveRoom.usedAnswers.push(quizRound.answer);
        liveRoom.timeLeft = HINT_INTERVAL_SECONDS * quizRound.hints.length + EXTRA_SECONDS;
        this.roomRepository.save(liveRoom);

        this.broadcaster.toRoom(liveRoom.code, 'quiz:round:started', {
            ...quizRound.toClientPayload(liveRoom.quizSettings.rounds),
            timeLeft: liveRoom.timeLeft
        });

        // 첫 힌트는 기다리지 않고 바로 연다. 아무 단서 없이 10초를 보내지 않게.
        this._revealHint(liveRoom);
        this._startTimer(liveRoom);
        this._startPrefetch(liveRoom);
    }

    _revealHint(room) {
        const hint = room.quizRound.revealNextHint();
        if (!hint) return;
        this.broadcaster.toRoom(room.code, 'quiz:hint', hint);
    }

    /** 1초짜리 타이머 하나가 남은 시간과 힌트 공개를 함께 몬다 */
    _startTimer(room) {
        let elapsed = 0;
        room.timerHandle = setInterval(() => {
            elapsed += 1;
            room.timeLeft -= 1;
            if (elapsed % HINT_INTERVAL_SECONDS === 0) {
                this._revealHint(room);
            }
            // 힌트 패널의 '다음 힌트 N초' 는 서버 시계를 그대로 따라야 어긋나지 않는다.
            // 더 열 힌트가 없으면 -1 을 보내 '힌트 끝' 으로 표시하게 한다.
            const nextHintIn = room.quizRound && room.quizRound.hasMoreHints()
                ? HINT_INTERVAL_SECONDS - (elapsed % HINT_INTERVAL_SECONDS)
                : -1;
            this.broadcaster.toRoom(room.code, 'game:tick', { timeLeft: room.timeLeft, nextHintIn });
            if (room.timeLeft <= 0) {
                // 아무도 못 맞힌 채 시간이 다 됐다
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

    /** 라운드 마무리 — 정답을 공개하고, 마지막 라운드였으면 게임을 끝낸다 */
    _finishRound(room, { winnerId, winnerNickname, points }) {
        this._stopTimer(room);
        const answer = room.quizRound ? room.quizRound.answer : '';
        const finishedIndex = room.roundIndex;
        room.quizRound = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'quiz:round:result', {
            roundIndex: finishedIndex,
            answer,
            winnerId,
            winnerNickname,
            points: points || 0,
            players: room.playersPayload()
        });

        setTimeout(() => {
            const liveRoom = this.roomRepository.findByCode(room.code);
            if (!liveRoom || liveRoom.status !== RoomStatus.PLAYING) return;
            // 뒤늦게 발화한 타임아웃이 다음 라운드를 두 번 시작하지 않게 막는다
            if (liveRoom.roundIndex !== finishedIndex || liveRoom.quizRound) return;

            if (liveRoom.roundIndex >= liveRoom.quizSettings.rounds) {
                this._endGame(liveRoom);
                return;
            }
            this.broadcaster.toRoom(liveRoom.code, 'quiz:preparing', { roundIndex: finishedIndex + 1 });
            this._startNextRound(liveRoom).catch((error) => {
                console.error('[quiz] 다음 라운드 시작 실패:', error);
                this._endGame(liveRoom);
            });
        }, ROUND_TRANSITION_DELAY_MS);
    }

    _endGame(room) {
        this._stopTimer(room);
        room.status = RoomStatus.ENDED;
        room.quizRound = null;
        room.prefetch = null;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'game:over', {
            players: room.rankedPlayers()
        });
    }
}

function normalizeQuizSettings({ rounds, category, blockCount }) {
    const count = Number(rounds);
    const blocks = Number(blockCount);
    if (!Number.isInteger(count) || count < MIN_QUIZ_ROUNDS || count > MAX_QUIZ_ROUNDS) {
        return null;
    }
    // 정답을 블록으로 만들어야 하므로 보드가 필요하다. 단어 연결과 같은 범위를 쓴다.
    if (!Number.isInteger(blocks) || blocks < MIN_BLOCK_COUNT || blocks > MAX_BLOCK_COUNT) {
        return null;
    }
    return {
        rounds: count,
        blockCount: blocks,
        category: typeof category === 'string' && category ? category : 'random'
    };
}

/** 스무고개는 보드가 없으므로 블록 개수와 무관하다 — 사전의 모든 카테고리를 쓸 수 있다 */
function resolveCategory(category) {
    const categories = getCategories();
    if (categories.length === 0) return null;
    if (category === 'random') {
        return categories[Math.floor(Math.random() * categories.length)];
    }
    return categories.includes(category) ? category : null;
}

module.exports = {
    QuizService,
    HINT_INTERVAL_SECONDS,
    EXTRA_SECONDS,
    ROUND_TRANSITION_DELAY_MS
};
