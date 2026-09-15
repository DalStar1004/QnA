// Design Ref: §9.1 — Application 계층. AI 스무고개 모드의 라운드 진행을 담당한다.
//
// 단어 연결(RoundService)과 나란한 위치의 유스케이스다. 다른 점은 두 가지뿐이다.
//   - 끝나는 조건이 "시간"이 아니라 "정해진 라운드 수를 모두 마쳤을 때" 다.
//   - 문제를 만들 때 LLM 이 필요하다. 그래서 HintGeneratorPort 를 주입받는다.
//
// LLM 은 언제든 꺼져 있을 수 있으므로, **힌트 생성 실패로 게임이 멈추지 않게** 한다.
// 실패하면 확정 힌트(글자 수·초성·첫 글자)만으로 라운드를 진행한다.

const { QuizRound } = require('../domain/QuizRound');
const { RoomStatus, GameMode, MIN_QUIZ_ROUNDS, MAX_QUIZ_ROUNDS, AiProvider, AI_PROVIDERS } = require('../domain/Room');
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
     * @param {typeof import('../services/GeminiService')} deps.geminiService 혼자 하기와 공유하는 전역 인스턴스
     * @param {import('../infrastructure/GroqHintGenerator').GroqHintGenerator} deps.groqHintGenerator 혼자 하기와 공유하는 전역 인스턴스
     */
    constructor({ roomRepository, broadcaster, geminiService, groqHintGenerator }) {
        this.roomRepository = roomRepository;
        this.broadcaster = broadcaster;
        // 새로 만들지 않고 server.js(합성 루트)가 혼자 하기 API와 함께 주입하는 것을 그대로 쓴다.
        this.geminiService = geminiService;
        this.groqHintGenerator = groqHintGenerator;
    }

    /**
     * 방이 고른 provider(Groq/Gemini)를 혼자 하기와 같은 모양(ensureReady/generateHints/model)으로
     * 감싼다. 어느 쪽이든 server.js가 만든 **전역 인스턴스 하나뿐**이라, 서로 다른 두 방이
     * 같은 provider를 골라도 같은 연결·사용량 상태를 공유한다(혼자 하기와도 공유한다).
     */
    _generatorFor(providerName) {
        if (providerName === AiProvider.GROQ) {
            const groq = this.groqHintGenerator;
            return {
                ensureReady: () => groq.ensureReady(),
                generateHints: (answer, category) => groq.generateHints(answer, category),
                model: () => groq.model,
                usage: () => groq.usage,
                managed: () => groq.managed
            };
        }
        const gemini = this.geminiService;
        return {
            ensureReady: () => gemini.ensureReady(),
            generateHints: (answer, category) => gemini.generateHints(answer, category),
            model: () => gemini.getModel(),
            usage: () => null,
            managed: () => gemini.isManaged()
        };
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
     * 대기실에서 부르는 AI 연결 상태 확인. 이제는 고정된 하나가 아니라
     * **그 방이 고른 aiProvider**를 확인한다 — 방장·참가자 누가 불러도 같은(읽기 전용) 결과를 본다.
     * 꺼져 있어도 게임은 되므로(확정 힌트만 나온다) 시작을 막지는 않고 알려 주기만 한다.
     */
    async checkAi({ playerId }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return { ok: false, reason: '방을 찾을 수 없어요' };
        }
        const provider = room.aiProvider;
        const generator = this._generatorFor(provider);
        // 상태를 묻는 김에 **연결까지 끝내 둔다.** 방장이 대기실에서 스무고개를 고른 이 순간부터
        // 모델을 올려 두면, 게임을 시작했을 때 첫 문제를 기다리지 않는다
        // (예열이 없으면 콜드 로드로 실측 167초가 걸렸다).
        const status = await generator.ensureReady();
        return {
            ok: !!status.ok,
            provider,
            model: status.model || generator.model() || null,
            switched: !!status.switched,
            reason: status.reason || null,
            usage: generator.usage(),
            managed: generator.managed()
        };
    }

    /**
     * 방장이 대기실에서 힌트 AI(Groq/Gemini)를 고른다.
     * 참가자가 시도하거나 게임 중에 부르면 서버가 거부한다 — 화면에는 방장에게만
     * 보이는 선택 UI가 있지만, 클라이언트를 신뢰하지 않고 여기서도 다시 확인한다.
     */
    setAiProvider({ playerId, provider }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (!room.isHost(playerId)) {
            return fail('NOT_HOST');
        }
        if (room.isPlaying()) {
            return fail('GAME_ALREADY_STARTED');
        }
        const normalized = String(provider || '').toLowerCase();
        if (AI_PROVIDERS.indexOf(normalized) === -1) {
            return fail('INVALID_AI_PROVIDER');
        }
        room.aiProvider = normalized;
        this.roomRepository.save(room);

        this.broadcaster.toRoom(room.code, 'room:aiProvider', { provider: room.aiProvider });
        // 바꾼 AI가 지금 연결돼 있는지도 곧바로 알려 준다(참가자 화면도 함께 갱신).
        this._broadcastAiStatus(room).catch(() => null);
        return { ok: true, provider: room.aiProvider };
    }

    /** 방이 고른 provider의 지금 연결 상태를 방 전체에 알린다 (설명은 checkAi와 같다) */
    async _broadcastAiStatus(room) {
        const generator = this._generatorFor(room.aiProvider);
        const status = await generator.ensureReady();
        this.broadcaster.toRoom(room.code, 'room:aiStatus', {
            provider: room.aiProvider,
            ok: !!status.ok,
            model: status.model || generator.model() || null,
            reason: status.reason || null,
            usage: generator.usage(),
            managed: generator.managed()
        });
    }

    /**
     * 방장이 대기실에서 [연결하기]/[연결 끊기]를 누른 뒤(둘 다 기존 /api/ai/* REST를 그대로
     * 쓴다 — 여기서 새로 만들지 않는다), 지금 상태를 방 전체에 다시 알려 달라고 부를 때 쓴다.
     * 상태를 다시 계산해서 알리기만 할 뿐 아무것도 바꾸지 않으므로 방장이 아니어도 된다.
     */
    refreshAiStatus({ playerId }) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        this._broadcastAiStatus(room).catch(() => null);
        return { ok: true };
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
        const generator = this._generatorFor(room.aiProvider);
        Promise.resolve(generator.ensureReady())
            .then((status) => {
                this.broadcaster.toRoom(room.code, 'quiz:ai', {
                    ok: !!status.ok,
                    provider: room.aiProvider,
                    model: status.model || generator.model() || null,
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

        const generator = this._generatorFor(room.aiProvider);
        let llmHints = [];
        let aiGenerated = false;
        try {
            llmHints = await generator.generateHints(answer, room.activeCategory);
            aiGenerated = llmHints.length > 0;
        } catch (error) {
            // AI 가 꺼져 있어도 확정 힌트(글자 수·초성·첫 글자)만으로 풀 수 있다.
            // 선택하지 않은 다른 AI로 자동 전환하지 않는다 — 실패하면 그냥 내장 힌트로 넘어간다.
            console.warn(`[quiz] ${room.aiProvider} 힌트 생성 실패 — 확정 힌트로 진행합니다: ${error.message}`);
        }

        return new QuizRound({
            roundIndex,
            category: room.activeCategory,
            answer,
            hints: assembleHints(answer, llmHints),
            board: buildQuizBoard(answer, blockCount),
            aiGenerated,
            // 실패해서 내장 힌트로 대체된 경우에는 어떤 provider를 시도했는지 화면에
            // 보여줄 필요가 없으므로 null로 둔다(성공했을 때만 의미 있는 값이다).
            provider: aiGenerated ? room.aiProvider : null,
            model: aiGenerated ? generator.model() : null
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
