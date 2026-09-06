        /* =========================================================
           0. 공통 도우미
           화면 전체가 id 로 요소를 찾으므로, 한 번 찾은 요소는 캐시해서 다시 쓴다.
           모달은 'show' 클래스 하나로만 열리고 닫히므로 Overlay 한 곳에 모은다.
        ========================================================= */
        const dom = (function () {
            const cache = new Map();
            return function (id) {
                let el = cache.get(id);
                if (!el) {
                    el = document.getElementById(id);
                    if (el) cache.set(id, el);
                }
                return el;
            };
        })();

        const Overlay = {
            open(id) { dom(id).classList.add('show'); },
            close(id) { dom(id).classList.remove('show'); },
            isOpen(id) { return dom(id).classList.contains('show'); }
        };

        // 요소 하나를 만들면서 클래스와 글자를 같이 붙인다. 목록을 그리는 코드가 크게 짧아진다.
        // 글자는 항상 textContent 로 넣으므로 사용자/LLM 문자열이 HTML로 해석될 일이 없다.
        function makeEl(tag, className, text) {
            const el = document.createElement(tag);
            if (className) el.className = className;
            if (text != null) el.textContent = text;
            return el;
        }

        // 같은 애니메이션을 다시 재생하려면 클래스를 뗐다가 리플로우를 강제한 뒤 다시 붙여야 한다.
        function replayAnimation(el, className) {
            el.classList.remove(className);
            void el.offsetWidth;
            el.classList.add(className);
        }

        /* =========================================================
           1. Data Layer
           Design Ref: §9 Clean Architecture — Data 계층 (다른 모듈에 의존하지 않음)
           Plan SC: 모든 글자수(2~5)에서 최소 1개 카테고리로 게임 시작 가능해야 함
        ========================================================= */
        // 카테고리·단어는 quiz-data/word-categories.json 에서 불러와 채운다 (loadWordCategories 참고).
        // 그 전까지는 빈 사전이며, initGame() 이 로딩을 끝낸 뒤에야 아래 코드가 이어서 실행된다.
        const dictionary = {};

        // 파일로 추가한 카테고리를 지웠을 때 원래 사전으로 되돌리기 위한 원본 사본.
        // dictionary 와 마찬가지로 처음엔 비어 있다가 loadWordCategories() 가 채운다.
        const BUILTIN_DICTIONARY = JSON.parse(JSON.stringify(dictionary));

        // 기본 카테고리·단어를 담아 둔 JSON. 문서 위치 기준 상대경로라 로컬 서버·Render 어디서든 통한다.
        const WORD_CATEGORIES_URL = 'quiz-data/word-categories.json';
        // 로딩이 끝나기 전에 [게임 시작]을 눌러 빈 사전으로 시작하는 일을 막는 데 쓴다.
        let dictionaryReady = false;

        /**
         * 기본 카테고리·단어 JSON을 받아와 BUILTIN_DICTIONARY 를 채우고, 사용자 카테고리와
         * 합쳐 dictionary 를 완성한다. initGame() 이 다른 초기화보다 먼저 이 함수를 기다린다.
         * 실패하면 dictionaryReady 를 계속 false 로 두어(빈 사전으로 넘어가지 않는다),
         * 원인을 콘솔에 남기고 화면에도 실패한 경로를 담아 안내한다.
         */
        async function loadWordCategories() {
            try {
                const res = await fetch(WORD_CATEGORIES_URL);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const parsed = await res.json();

                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('최상위 형식이 { 카테고리: [단어...] } 객체가 아닙니다.');
                }
                Object.keys(parsed).forEach(name => {
                    const words = parsed[name];
                    if (!Array.isArray(words) || !words.every(w => typeof w === 'string')) {
                        throw new Error(`'${name}' 항목이 문자열 배열이 아닙니다.`);
                    }
                });

                Object.keys(parsed).forEach(name => { BUILTIN_DICTIONARY[name] = parsed[name].slice(); });
                CategoryManager.rebuild(); // 여기서 사용자 카테고리와 합쳐 dictionary 를 완성한다.
                dictionaryReady = true;
            } catch (err) {
                console.error(`[word-categories] ${WORD_CATEGORIES_URL} 을(를) 불러오지 못했습니다:`, err);
                UIManager.showToast(
                    `단어 데이터를 불러오지 못했습니다 (${WORD_CATEGORIES_URL}). 새로고침해서 다시 시도해주세요.`,
                    'warn'
                );
            }
        }

        const Dictionary = {
            getCategories() {
                return Object.keys(dictionary);
            },
            getWords(category) {
                return (dictionary[category] || []).slice();
            },
            // 글자 수 제한이 없어졌으므로, 판정 기준은 '두 단어가 블록 안에 들어가는가' 하나뿐이다.
            canFit(category, totalBlocks) {
                const lengths = this.getWords(category).map(w => w.length).sort((a, b) => a - b);
                return lengths.length >= 2 && (lengths[0] + lengths[1]) <= totalBlocks;
            },
            getValidCategories(totalBlocks) {
                return this.getCategories().filter(c => this.canFit(c, totalBlocks));
            },
            /**
             * 이번 판에 낼 단어를 고른다. 글자 수는 서로 달라도 된다 (예: '사과' + '파인애플').
             * @param {string[]} exclude 이미 맞힌 단어 — 다시 내지 않는다
             * @returns {string[]|null} 보통 단어 2개, 남은 단어가 하나뿐이면 1개, 다 맞혔으면 null
             */
            pickRound(category, totalBlocks, exclude) {
                const skip = exclude || [];
                const pool = this.getWords(category)
                    .filter(w => skip.indexOf(w) === -1 && w.length <= totalBlocks)
                    .sort(() => Math.random() - 0.5);
                if (pool.length === 0) return null;

                for (let i = 0; i < pool.length; i++) {
                    for (let j = 0; j < pool.length; j++) {
                        if (i === j) continue;
                        if (pool[i].length + pool[j].length <= totalBlocks) {
                            return [pool[i], pool[j]];
                        }
                    }
                }
                return [pool[0]]; // 두 단어를 함께 넣을 수 없으면 한 단어만 낸다
            },
            // 보드에서 만든 글자 조합이 해당 카테고리의 단어인지 확인한다 (길이 무관).
            hasWord(category, word) {
                return this.getWords(category).includes(word);
            }
        };

        /* =========================================================
           2. State Layer
           Design Ref: §9.4 — 기존에 산재된 전역 변수를 하나의 상태 객체로 통합
        ========================================================= */
        const GAME_DURATION = 60; // 모드 1 한 판 제한 시간(초)
        const SHUFFLE_MAX = 5;    // 한 게임에 쓸 수 있는 [단어변경] 횟수
        // 글자를 고르고 이 시간(ms) 동안 추가 선택이 없으면 선택만 자동으로 푼다.
        // 나중에 3000 등으로 바꾸고 싶으면 이 값 하나만 고치면 된다. (게임 방법 안내문도 이 값을 그대로 읽는다)
        const AUTO_DESELECT_MS = 2000;

        // 화면 전체가 어떤 게임 모드인지. 'classic' = 모드 1(제시어 맞추기), 'quiz' = 모드 2(AI 스무고개).
        // GameState.mode 는 '지금 돌고 있는 판'의 종류이고, appMode 는 '사용자가 고른 모드'다.
        let appMode = 'classic';

        const GameState = {
            mode: 'solo',            // 'solo' | 'versus' | 'quiz'
            score: 0,
            highScore: 0,
            timeLeft: GAME_DURATION,
            duration: GAME_DURATION, // 이번 판의 제한 시간 (모드 2는 힌트 개수에 따라 길어진다)
            isGameActive: false,
            // 정답 목록은 한 판을 끝까지 마친 뒤에만 열 수 있다.
            // 시작 전에 열어 버리면 답을 외우고 시작할 수 있어서 게임이 성립하지 않는다.
            answerListUnlocked: false,
            currentCategory: "",
            currentBlockCount: 0,
            currentTargetWords: [],
            solvedWords: [],
            comboCount: 0,
            selectedCategoryOption: "random",
            selectedBlocks: [],
            // 정답을 맞힌 뒤 연출이 끝나고 다음 판이 깔릴 때까지 잠깐 서는 자리.
            // 이 동안에는 블록을 고를 수도, 다시 제출할 수도 없다.
            // 자동 제출이 생기면서 연출 도중에 한 번 더 제출되는 길이 열렸기 때문이다.
            isResolving: false,
            // [단어변경] 남은 횟수. 게임을 새로 시작할 때만 5로 돌아간다.
            shuffleLeft: SHUFFLE_MAX,
            // 빠르게 두 번 눌러 한 번의 의도로 두 번 깎이는 것을 막는 잠금.
            isShuffling: false,
            // 마지막 글자 선택 후 AUTO_DESELECT_MS 동안 추가 선택이 없으면 선택만 푸는 타이머.
            deselectTimer: null,
            resetForNewGame() {
                this.score = 0;
                this.timeLeft = this.duration;
                this.isGameActive = true;
                this.solvedWords = [];
                this.comboCount = 0;
                this.isResolving = false;
                this.isShuffling = false;
                this.disarmDeselectTimer();
            },
            /**
             * 글자를 고르거나(선택 추가) 되돌릴(선택 취소) 때마다 다시 부른다.
             * 정답 자동 제출, 판 교체, 게임 종료 때는 disarmDeselectTimer 로 취소한다 —
             * 그래야 이전 문제의 타이머가 새 문제의 선택을 지우는 일이 없다.
             */
            armDeselectTimer() {
                this.disarmDeselectTimer();
                this.deselectTimer = setTimeout(() => {
                    this.deselectTimer = null;
                    // 그 사이 정답 제출·판 교체·게임 종료로 선택이 이미 비었으면 할 일이 없다.
                    if (!this.isGameActive || this.selectedBlocks.length === 0) return;
                    UIManager.resetSelection();
                }, AUTO_DESELECT_MS);
            },
            disarmDeselectTimer() {
                clearTimeout(this.deselectTimer);
                this.deselectTimer = null;
            },
            /**
             * [단어변경] 횟수를 채운다. **게임을 새로 시작할 때만** 부른다.
             * resetForNewGame 에 넣지 않은 이유 — 모드 2 는 라운드마다 그것을 부르므로
             * 거기 넣으면 다음 문제로 넘어갈 때마다 횟수가 되살아난다.
             * 모드 1 은 한 판이, 모드 2 는 세션 전체가 '한 게임'이다.
             */
            resetShuffles() {
                this.shuffleLeft = SHUFFLE_MAX;
                this.isShuffling = false;
            },
            resetForGameEnd() {
                this.isGameActive = false;
                this.currentCategory = "";
                this.solvedWords = [];
                this.comboCount = 0;
                this.selectedBlocks = [];
                this.isResolving = false;
                this.disarmDeselectTimer();
            }
        };

        // 같은 화면에서 번갈아 플레이하는 2인 대결 상태.
        // 두 플레이어가 같은 조건(카테고리)에서 겨루도록 lockedCategory 로 제시어를 고정한다.
        const VersusManager = {
            active: false,
            turn: 0,
            players: [],
            lockedCategory: "",
            start(name1, name2) {
                this.active = true;
                this.turn = 0;
                this.lockedCategory = "";
                this.players = [
                    { name: name1, score: 0, played: false },
                    { name: name2, score: 0, played: false }
                ];
            },
            recordTurn(score) {
                const player = this.players[this.turn];
                player.score = score;
                player.played = true;
            },
            get isLastTurn() {
                return this.turn >= this.players.length - 1;
            },
            get winnerIndex() {
                const [p1, p2] = this.players;
                if (p1.score === p2.score) return -1;
                return p1.score > p2.score ? 0 : 1;
            },
            reset() {
                this.active = false;
                this.turn = 0;
                this.players = [];
                this.lockedCategory = "";
            }
        };

        /* =========================================================
           3. Service Layer (Audio / Storage / Combo)
           Design Ref: §9 — GameState/Dictionary에만 의존, DOM은 직접 다루지 않음
        ========================================================= */

        // Plan FR-04: 정답/오답/시작/종료 효과음 + 음소거 토글 (외부 파일 없이 Web Audio 오실레이터 사용)
        const AudioManager = (function () {
            let ctx = null;
            let muted = false;

            function ensureContext() {
                try {
                    if (!ctx) {
                        const AudioCtx = window.AudioContext || window.webkitAudioContext;
                        ctx = new AudioCtx();
                    } else if (ctx.state === 'suspended') {
                        ctx.resume();
                    }
                } catch (e) {
                    ctx = null; // 미지원 브라우저는 조용히 무시 (§6.1 예외 처리)
                }
            }

            function beep(freq, duration, type, volume) {
                if (muted || !ctx) return;
                try {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = type || 'sine';
                    osc.frequency.value = freq;
                    gain.gain.value = volume || 0.2;
                    osc.connect(gain).connect(ctx.destination);
                    osc.start();
                    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
                    osc.stop(ctx.currentTime + duration);
                } catch (e) { /* 재생 실패는 게임 진행에 영향 없음 */ }
            }

            // 짧은 음을 순서대로 이어 붙인다. 음 하나는 [주파수, 길이(초), 파형, 볼륨, 시작 지연(ms)].
            function melody(notes) {
                notes.forEach(([freq, duration, type, volume, delay]) => {
                    if (delay) setTimeout(() => beep(freq, duration, type, volume), delay);
                    else beep(freq, duration, type, volume);
                });
            }

            return {
                ensureContext,
                playStart() {
                    ensureContext();
                    melody([[523, 0.12, 'sine', 0.18, 0], [784, 0.18, 'sine', 0.18, 120]]);
                },
                playCorrect() {
                    melody([[880, 0.15, 'triangle', 0.18, 0], [1200, 0.15, 'triangle', 0.16, 90]]);
                },
                playCombo() {
                    melody([[660, 0.1, 'square', 0.15, 0], [880, 0.1, 'square', 0.15, 80],
                            [1100, 0.16, 'square', 0.15, 160]]);
                },
                playWrong() {
                    beep(180, 0.25, 'sawtooth', 0.13);
                },
                // 모드 2: 새 힌트가 열렸을 때의 짧은 알림음
                playHint() {
                    melody([[740, 0.09, 'sine', 0.14, 0], [988, 0.14, 'sine', 0.12, 90]]);
                },
                playWin() {
                    melody([[523, 0.12, 'triangle', 0.18, 0], [659, 0.12, 'triangle', 0.18, 110],
                            [784, 0.12, 'triangle', 0.18, 220], [1047, 0.3, 'triangle', 0.18, 330]]);
                },
                playGameOver() {
                    melody([[392, 0.2, 'sine', 0.18, 0], [330, 0.2, 'sine', 0.18, 180],
                            [262, 0.3, 'sine', 0.18, 360]]);
                },
                toggleMute() {
                    muted = !muted;
                    return muted;
                },
                get isMuted() { return muted; }
            };
        })();

        // Plan FR-03: localStorage 기반 최고 점수 (접근 실패 시 메모리로 degrade, §6.1)
        // 확장: 닉네임별 랭킹 / 닉네임 / 선택한 배경도 같은 방식으로 보관한다.
        const StorageManager = (function () {
            const HIGH_SCORE_KEY = 'wordConnectionGame.highScore';
            // 모드 2는 점수 폭이 달라서 모드 1 기록과 섞이지 않도록 키를 분리한다.
            const QUIZ_HIGH_SCORE_KEY = 'wordConnectionGame.quizHighScore';
            // 모드 3(산업재산권 문제)도 같은 이유로 따로 둔다.
            const EXAM_HIGH_SCORE_KEY = 'wordConnectionGame.examHighScore';
            // 모드 1 설정. 예전에는 저장하지 않아서 화면을 새로 열 때마다 기본값으로 돌아갔다.
            const BLOCK_COUNT_KEY = 'wordConnectionGame.blockCount';
            const CATEGORY_KEY = 'wordConnectionGame.category';
            const LLM_ENDPOINT_KEY = 'wordConnectionGame.llmEndpoint';
            const LLM_MODEL_KEY = 'wordConnectionGame.llmModel';
            const QUIZ_CATEGORY_KEY = 'wordConnectionGame.quizCategory';
            const QUIZ_ROUNDS_KEY = 'wordConnectionGame.quizRounds';
            // 모드 2의 블록 개수. 예전에는 모드 1의 칸을 같이 썼는데, 두 모드는 판의 성격이 달라
            // (모드 1은 여러 단어를 찾고, 모드 2는 낱말 하나를 맞힌다) 알맞은 값이 서로 다르다.
            const QUIZ_BLOCKS_KEY = 'wordConnectionGame.quizBlocks';
            const DEFAULT_LLM_ENDPOINT = 'http://localhost:11434';
            const DEFAULT_LLM_MODEL = 'qwen2.5:7b';
            // 예전 기본 모델. 아래 migrateLegacyModel() 이 한 번만 새 기본값으로 옮긴다.
            const LEGACY_LLM_MODEL = 'llama3.2';
            const LLM_MODEL_MIGRATED_KEY = 'wordConnectionGame.llmModelMigrated';
            // 멀티플레이 서버 주소. 다른 PC가 서버일 수 있어서 사용자가 고칠 수 있게 두고 기억해 둔다.
            const MULTIPLAYER_URL_KEY = 'wordConnectionGame.multiplayerUrl';
            /*
             * 이 화면이 **서버를 통해** 열렸다면(http://…) 그 서버가 곧 멀티플레이 서버다.
             * 인터넷에 올린 경우 접속자는 서버 주소만 알고 들어오는데, 여기에 'localhost' 가 박혀 있으면
             * [접속하기] 가 접속자 **자기 PC**를 찌르게 되어 아무도 멀티를 못 한다.
             * 그래서 지금 보고 있는 주소에서 자동으로 뽑는다. 게임 파일을 두 번 눌러 연 경우(file://)에만
             * 예전 기본값을 쓴다 — 그때는 뽑아낼 주소가 없다.
             */
            const DEFAULT_MULTIPLAYER_URL =
                location.protocol === 'http:' || location.protocol === 'https:'
                    ? location.origin + '/multi'
                    : 'http://localhost:3000';
            const LEADERBOARD_KEY = 'wordConnectionGame.leaderboard';
            const EXAM_LEADERBOARD_KEY = 'wordConnectionGame.examLeaderboard';
            // 모드 2는 세션 총점이라 점수 폭이 달라서, 최고 점수처럼 랭킹도 키를 분리한다.
            const QUIZ_LEADERBOARD_KEY = 'wordConnectionGame.quizLeaderboard';
            const NICKNAME_KEY = 'wordConnectionGame.nickname';
            const BACKGROUND_KEY = 'wordConnectionGame.background';
            const CUSTOM_CATEGORY_KEY = 'wordConnectionGame.customCategories';
            /* 모드 3 설정.
               모드 1과 **따로** 둔다 — 한 문제를 10초 안에 푸는 모드와 여러 단어를 찾는 모드는
               알맞은 블록 개수가 서로 달라서, 한쪽을 고치면 다른 쪽이 망가진다. */
            const EXAM_TIME_KEY = 'wordConnectionGame.examTime';
            const EXAM_BLOCKS_KEY = 'wordConnectionGame.examBlocks';
            // 사용자가 파일로 더 넣은 문제
            const EXAM_EXTRA_KEY = 'wordConnectionGame.examExtraQuestions';

            // localStorage를 못 쓰는 환경(파일 프로토콜 제한/시크릿 모드)에서는
            // 이 메모리 사본으로 degrade 해서 게임 진행 자체는 막히지 않게 한다.
            const memory = {
                leaderboard: null, quizLeaderboard: null, examLeaderboard: null,
                nickname: null, background: null, customCategories: null, examExtras: null,
                llmEndpoint: null, llmModel: null, quizCategory: null, quizRounds: null,
                multiplayerUrl: null
            };

            function readRaw(key) {
                try { return localStorage.getItem(key); } catch (e) { return null; }
            }
            function writeRaw(key, value) {
                try { localStorage.setItem(key, value); } catch (e) { /* degrade */ }
            }

            /*
             * 기본 모델을 llama3.2 -> qwen2.5:7b 로 바꿨다.
             * [연결 확인] 을 누르면 화면에 채워져 있던 값이 그대로 저장되기 때문에,
             * 예전 기본값을 고른 적도 없는 사람의 브라우저에 'llama3.2' 가 남아 있다.
             * 저장값이 기본값을 이기므로 그대로 두면 새 기본 모델이 영영 적용되지 않는다.
             * 그래서 딱 한 번만 새 기본값으로 옮기고 표시를 남긴다.
             * 표시가 남은 뒤에 사용자가 직접 llama3.2 를 고르면 그 선택은 그대로 지켜진다.
             */
            function migrateLegacyModel() {
                if (readRaw(LLM_MODEL_MIGRATED_KEY)) return;
                writeRaw(LLM_MODEL_MIGRATED_KEY, '1');
                if (readRaw(LLM_MODEL_KEY) === LEGACY_LLM_MODEL) {
                    writeRaw(LLM_MODEL_KEY, DEFAULT_LLM_MODEL);
                }
            }
            migrateLegacyModel();

            /* ---------- 모드별 기록 칸 고르기 ----------
               모드 1(classic) · 모드 2(quiz) · 모드 3(exam)은 점수 폭이 서로 달라서
               최고 점수와 랭킹을 각각 따로 보관한다. 모르는 값이 들어오면 모드 1로 본다. */
            function highScoreKeyOf(kind) {
                if (kind === 'quiz') return QUIZ_HIGH_SCORE_KEY;
                if (kind === 'exam') return EXAM_HIGH_SCORE_KEY;
                return HIGH_SCORE_KEY;
            }
            function leaderboardKeyOf(kind) {
                if (kind === 'quiz') return QUIZ_LEADERBOARD_KEY;
                if (kind === 'exam') return EXAM_LEADERBOARD_KEY;
                return LEADERBOARD_KEY;
            }
            function leaderboardSlotOf(kind) {
                if (kind === 'quiz') return 'quizLeaderboard';
                if (kind === 'exam') return 'examLeaderboard';
                return 'leaderboard';
            }

            return {
                // kind: 'quiz'(모드 2) · 'exam'(모드 3) · 그 외에는 모드 1 기록
                getHighScore(kind) {
                    return parseInt(readRaw(highScoreKeyOf(kind)) || '0', 10) || 0;
                },
                trySetHighScore(score, kind) {
                    const current = this.getHighScore(kind);
                    if (score > current) {
                        writeRaw(highScoreKeyOf(kind), String(score));
                        return true;
                    }
                    return false;
                },
                /* ---------- 시작 화면: 멀티플레이 서버 주소 ---------- */
                getMultiplayerUrl() {
                    const saved = memory.multiplayerUrl !== null
                        ? memory.multiplayerUrl
                        : readRaw(MULTIPLAYER_URL_KEY);
                    if (!saved) return DEFAULT_MULTIPLAYER_URL;
                    /*
                     * 멀티 화면이 '/' 에서 '/multi' 로 옮겨 갔다. 예전에 [접속하기] 를 눌러 본 사람의
                     * 브라우저에는 'http://localhost:3000' 처럼 **경로 없는 주소**가 저장돼 있는데,
                     * 그대로 두면 시작 화면으로 되돌아와 아무리 눌러도 멀티로 못 간다.
                     * 저장값이 지금 보고 있는 서버를 가리키면 항상 새 주소로 바꿔 준다.
                     * 다른 PC를 가리키는 주소는 사용자가 일부러 적은 것이므로 건드리지 않는다.
                     */
                    try {
                        if (new URL(saved).origin === location.origin) return DEFAULT_MULTIPLAYER_URL;
                    } catch (e) { /* 주소가 아니면 저장값을 그대로 쓴다 */ }
                    return saved;
                },
                setMultiplayerUrl(url) {
                    let value = (url || '').trim() || DEFAULT_MULTIPLAYER_URL;
                    // 'localhost:3000' 처럼 앞을 빼먹고 적는 일이 잦다. 저장할 때 채워 두면
                    // 꺼내 쓰는 쪽은 항상 바로 쓸 수 있는 주소를 받는다.
                    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
                    memory.multiplayerUrl = value;
                    writeRaw(MULTIPLAYER_URL_KEY, value);
                },
                /* ---------- 모드 2: qwen2.5:7b 연결 설정 ---------- */
                getLlmEndpoint() {
                    if (memory.llmEndpoint !== null) return memory.llmEndpoint;
                    return readRaw(LLM_ENDPOINT_KEY) || DEFAULT_LLM_ENDPOINT;
                },
                setLlmEndpoint(url) {
                    const value = (url || '').trim() || DEFAULT_LLM_ENDPOINT;
                    memory.llmEndpoint = value;
                    writeRaw(LLM_ENDPOINT_KEY, value);
                },
                getLlmModel() {
                    if (memory.llmModel !== null) return memory.llmModel;
                    return readRaw(LLM_MODEL_KEY) || DEFAULT_LLM_MODEL;
                },
                setLlmModel(name) {
                    const value = (name || '').trim() || DEFAULT_LLM_MODEL;
                    memory.llmModel = value;
                    writeRaw(LLM_MODEL_KEY, value);
                },
                getQuizCategory() {
                    if (memory.quizCategory !== null) return memory.quizCategory;
                    return readRaw(QUIZ_CATEGORY_KEY) || '';
                },
                setQuizCategory(name) {
                    const value = (name || '').trim();
                    memory.quizCategory = value;
                    writeRaw(QUIZ_CATEGORY_KEY, value);
                },
                // 스무고개를 몇 번 진행할지 (기본 3회)
                getQuizRounds() {
                    if (memory.quizRounds !== null) return memory.quizRounds;
                    return parseInt(readRaw(QUIZ_ROUNDS_KEY) || '3', 10) || 3;
                },
                setQuizRounds(count) {
                    memory.quizRounds = count;
                    writeRaw(QUIZ_ROUNDS_KEY, String(count));
                },
                /* ---------- 모드 1 설정 ---------- */
                // 블록 개수. 모드 2·3의 값과는 별개다.
                getBlockCount() {
                    const value = parseInt(readRaw(BLOCK_COUNT_KEY) || '', 10);
                    return Number.isFinite(value) ? value : CLASSIC_DEFAULT_BLOCKS;
                },
                setBlockCount(count) {
                    writeRaw(BLOCK_COUNT_KEY, String(count));
                },
                // 고른 카테고리. 'random' 이거나 카테고리 이름이다.
                getCategoryOption() {
                    return readRaw(CATEGORY_KEY) || 'random';
                },
                setCategoryOption(value) {
                    writeRaw(CATEGORY_KEY, value || 'random');
                },

                // 모드 2의 블록 개수 (모드 1·모드 3과 서로 다른 값이다)
                getQuizBlocks() {
                    const value = parseInt(readRaw(QUIZ_BLOCKS_KEY) || '', 10);
                    return Number.isFinite(value) ? value : QUIZ_DEFAULT_BLOCKS;
                },
                setQuizBlocks(count) {
                    writeRaw(QUIZ_BLOCKS_KEY, String(count));
                },
                // kind: 'quiz'(모드 2) · 'exam'(모드 3) · 그 외에는 모드 1 랭킹
                getLeaderboard(kind) {
                    const slot = leaderboardSlotOf(kind);
                    if (memory[slot]) return memory[slot];
                    const raw = readRaw(leaderboardKeyOf(kind));
                    if (!raw) return [];
                    try {
                        const parsed = JSON.parse(raw);
                        return Array.isArray(parsed) ? parsed : [];
                    } catch (e) {
                        return [];
                    }
                },
                setLeaderboard(list, kind) {
                    memory[leaderboardSlotOf(kind)] = list;
                    writeRaw(leaderboardKeyOf(kind), JSON.stringify(list));
                },
                getNickname() {
                    if (memory.nickname !== null) return memory.nickname;
                    return readRaw(NICKNAME_KEY) || '';
                },
                setNickname(name) {
                    memory.nickname = name;
                    writeRaw(NICKNAME_KEY, name);
                },
                getBackground() {
                    if (memory.background !== null) return memory.background;
                    return readRaw(BACKGROUND_KEY) || 'none';
                },
                setBackground(id) {
                    memory.background = id;
                    writeRaw(BACKGROUND_KEY, id);
                },
                // 파일로 추가한 카테고리 { 이름: [단어...] }
                /* ---------- 모드 3 설정 ---------- */
                // 한 문제에 주는 시간(초). 모드 1의 설정과 서로 영향을 주지 않는다.
                getExamTime() {
                    const value = parseInt(readRaw(EXAM_TIME_KEY) || '', 10);
                    return Number.isFinite(value) ? value : EXAM_DEFAULT_TIME;
                },
                setExamTime(seconds) {
                    writeRaw(EXAM_TIME_KEY, String(seconds));
                },
                // 보드에 깔 블록 개수. 정답 글자가 다 들어가지 못하면 게임이 알아서 늘린다.
                getExamBlocks() {
                    const value = parseInt(readRaw(EXAM_BLOCKS_KEY) || '', 10);
                    return Number.isFinite(value) ? value : EXAM_DEFAULT_BLOCKS;
                },
                setExamBlocks(count) {
                    writeRaw(EXAM_BLOCKS_KEY, String(count));
                },
                // 파일로 더 넣은 문제. [{question, answers:[]}] 형태로 쌓인다.
                getExamExtras() {
                    if (memory.examExtras) return memory.examExtras;
                    const raw = readRaw(EXAM_EXTRA_KEY);
                    if (!raw) return [];
                    try {
                        const parsed = JSON.parse(raw);
                        return Array.isArray(parsed) ? parsed : [];
                    } catch (e) {
                        return [];
                    }
                },
                setExamExtras(list) {
                    memory.examExtras = list;
                    writeRaw(EXAM_EXTRA_KEY, JSON.stringify(list));
                },

                getCustomCategories() {
                    if (memory.customCategories) return memory.customCategories;
                    const raw = readRaw(CUSTOM_CATEGORY_KEY);
                    if (!raw) return {};
                    try {
                        const parsed = JSON.parse(raw);
                        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
                    } catch (e) {
                        return {};
                    }
                },
                setCustomCategories(map) {
                    memory.customCategories = map;
                    writeRaw(CUSTOM_CATEGORY_KEY, JSON.stringify(map));
                }
            };
        })();

        // 배경1~4 선택 기능. body의 background-image를 스크림 레이어와 함께 2단으로 깐다.
        const BackgroundManager = (function () {
            const FILES = {
                '1': 'assets/backgrounds/배경1.png',
                '2': 'assets/backgrounds/배경2.png',
                '3': 'assets/backgrounds/배경3.png',
                '4': 'assets/backgrounds/배경4.png'
            };
            let current = 'none';

            function apply(id, persist) {
                current = FILES[id] ? id : 'none';
                if (current === 'none') {
                    document.body.classList.remove('has-bg');
                    document.documentElement.style.removeProperty('--bg-img');
                } else {
                    // CSS가 별도 파일(assets/css/)로 분리되면서, --bg-img 안의 url()은
                    // 이 값을 쓰는 스타일시트(assets/css/) 기준으로 다시 풀린다 — 상대경로를
                    // 그대로 넣으면 assets/css/assets/backgrounds/... 처럼 어긋난다.
                    // document.baseURI 기준의 완전한 URL로 만들어 두면 어느 스타일시트에서
                    // 읽든 항상 같은 곳을 가리킨다. 로컬 주소·배포 도메인은 여기 적지 않는다 —
                    // document.baseURI가 지금 문서가 실제로 열린 주소를 그대로 알려준다.
                    document.documentElement.style.setProperty('--bg-img', `url('${new URL(FILES[current], document.baseURI).href}')`);
                    document.body.classList.add('has-bg');
                }
                if (persist !== false) StorageManager.setBackground(current);
                return current;
            }

            return {
                apply,
                get current() { return current; },
                label(id) { return FILES[id] ? `배경${id}` : '기본 배경'; }
            };
        })();

        /* ---------- 사용자 카테고리 (파일로 추가) ----------
           JSON / TXT / CSV 파일을 읽어 dictionary에 카테고리를 덧붙인다.
           기본 사전은 BUILTIN_DICTIONARY에 그대로 두고, 파일 카테고리는 따로 보관했다가
           rebuild() 에서 합쳐 넣기 때문에 언제든 개별 삭제로 되돌릴 수 있다. */
        const CategoryManager = (function () {
            const WORD_RE = /^[가-힣]{2,10}$/;
            const MAX_NAME_LEN = 14;

            function addWords(buckets, name, words) {
                buckets[name] = (buckets[name] || []).concat(words);
            }

            // JSON 파일. 두 가지 형식을 모두 받아들인다.
            //   { "이름": [단어...] }   또는   [{ category: "이름", words: [단어...] }, ...]
            function parseJson(text, fileName, warnings, buckets) {
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch (e) {
                    warnings.push(`${fileName}: JSON 형식이 올바르지 않습니다.`);
                    return;
                }

                if (Array.isArray(parsed)) {
                    parsed.forEach(item => {
                        if (!item || typeof item !== 'object') return;
                        const name = item.category || item.name || item.title;
                        const words = item.words || item.list || item.items;
                        if (name && Array.isArray(words)) addWords(buckets, name, words);
                    });
                } else if (parsed && typeof parsed === 'object') {
                    Object.keys(parsed).forEach(name => {
                        if (Array.isArray(parsed[name])) addWords(buckets, name, parsed[name]);
                    });
                }
            }

            // TXT / CSV 파일. 한 줄에 카테고리 하나를 적는다.
            //   "이름, 단어1, 단어2"  |  "이름: 단어1 단어2"  |  "이름 단어1 단어2"
            // '#' 이나 '//' 로 시작하는 줄은 설명으로 보고 넘긴다.
            function parseLines(text, buckets) {
                text.split(/\r?\n/).forEach(line => {
                    const row = line.trim();
                    if (!row || row.startsWith('#') || row.startsWith('//')) return;

                    // 첫 구분자까지가 카테고리 이름(공백이 들어간 이름도 그대로 유지된다).
                    const sep = row.match(/[,:;\t：]/);
                    let name, rest;
                    if (sep) {
                        const at = row.indexOf(sep[0]);
                        name = row.slice(0, at).trim();
                        rest = row.slice(at + 1);
                    } else {
                        const tokens = row.split(/\s+/).filter(Boolean);
                        name = tokens.shift();
                        rest = tokens.join(' ');
                    }

                    // 남은 부분은 쉼표든 공백이든 모두 단어 구분자로 본다.
                    const words = rest.split(/[,:;\t：\s]+/).map(w => w.trim()).filter(Boolean);
                    if (name && words.length > 0) addWords(buckets, name, words);
                });
            }

            // 파일 한 개의 텍스트를 { 카테고리명: [단어...] } 형태로 해석한다.
            function parseText(text, fileName, warnings) {
                const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
                if (!trimmed) {
                    warnings.push(`${fileName}: 파일이 비어 있습니다.`);
                    return {};
                }

                const buckets = Object.create(null);
                const looksLikeJson = trimmed[0] === '{' || trimmed[0] === '[';
                if (looksLikeJson) parseJson(trimmed, fileName, warnings, buckets);
                else parseLines(trimmed, buckets);
                return buckets;
            }

            // 이름/단어를 정리하고 사용할 수 없는 값은 걸러낸다.
            function normalize(buckets, fileName, warnings) {
                const clean = Object.create(null);
                Object.keys(buckets).forEach(rawName => {
                    const name = String(rawName).trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
                    // 'random'(랜덤 옵션)과 'constructor' 같은 프로토타입 이름은 쓸 수 없다.
                    if (!name || name === 'random') return;
                    if (Object.prototype.hasOwnProperty.call(Object.prototype, name)) {
                        warnings.push(`${fileName}: '${name}'은(는) 카테고리 이름으로 쓸 수 없습니다.`);
                        return;
                    }

                    const words = [];
                    let skipped = 0;
                    buckets[rawName].forEach(raw => {
                        const word = String(raw).trim().replace(/\s+/g, '');
                        if (!WORD_RE.test(word)) {
                            if (word) skipped++;
                            return;
                        }
                        if (!words.includes(word)) words.push(word);
                    });

                    if (words.length < 2) {
                        warnings.push(`${fileName}: '${name}'은(는) 쓸 수 있는 단어가 2개 미만이라 건너뛰었습니다.`);
                        return;
                    }
                    if (skipped > 0) {
                        warnings.push(`${fileName}: '${name}'에서 한글 2~10글자가 아닌 단어 ${skipped}개를 제외했습니다.`);
                    }
                    clean[name] = (clean[name] || []).concat(words);
                });
                return clean;
            }

            // File.text() 가 UTF-8 로 읽은 Promise 를 돌려주므로 FileReader 콜백이 필요 없다.
            function readFile(file) {
                return file.text()
                    .then(text => ({ name: file.name, text: String(text || '') }))
                    .catch(() => ({ name: file.name, text: '', failed: true }));
            }

            // 기본 사전 + 사용자 카테고리를 합쳐 dictionary를 다시 만든다.
            function rebuild() {
                const custom = StorageManager.getCustomCategories();
                Object.keys(dictionary).forEach(key => { delete dictionary[key]; });
                Object.keys(BUILTIN_DICTIONARY).forEach(key => {
                    dictionary[key] = BUILTIN_DICTIONARY[key].slice();
                });
                Object.keys(custom).forEach(name => {
                    const words = Array.isArray(custom[name]) ? custom[name] : [];
                    if (words.length < 2) return;
                    // 기본 카테고리와 이름이 같으면 단어를 합친다.
                    const merged = (dictionary[name] || []).slice();
                    words.forEach(w => { if (!merged.includes(w)) merged.push(w); });
                    dictionary[name] = merged;
                });
            }

            return {
                rebuild,
                getCustom() { return StorageManager.getCustomCategories(); },
                // 선택한 파일들을 읽어 카테고리를 추가한다. 결과 요약을 Promise로 돌려준다.
                importFiles(fileList) {
                    const files = Array.prototype.slice.call(fileList || []);
                    const warnings = [];
                    if (files.length === 0) {
                        return Promise.resolve({ addedCategories: [], wordCount: 0, warnings });
                    }

                    return Promise.all(files.map(readFile)).then(results => {
                        const collected = {};
                        results.forEach(res => {
                            if (res.failed) {
                                warnings.push(`${res.name}: 파일을 읽지 못했습니다.`);
                                return;
                            }
                            const clean = normalize(parseText(res.text, res.name, warnings), res.name, warnings);
                            Object.keys(clean).forEach(name => {
                                collected[name] = (collected[name] || []).concat(
                                    clean[name].filter(w => !(collected[name] || []).includes(w))
                                );
                            });
                        });

                        const custom = Object.assign({}, StorageManager.getCustomCategories());
                        const addedCategories = [];
                        let wordCount = 0;
                        Object.keys(collected).forEach(name => {
                            const existing = Array.isArray(custom[name]) ? custom[name].slice() : [];
                            collected[name].forEach(w => {
                                if (!existing.includes(w)) { existing.push(w); wordCount++; }
                            });
                            custom[name] = existing;
                            addedCategories.push(name);
                        });

                        if (addedCategories.length > 0) {
                            StorageManager.setCustomCategories(custom);
                            rebuild();
                        }
                        return { addedCategories, wordCount, warnings };
                    });
                },
                remove(name) {
                    const custom = Object.assign({}, StorageManager.getCustomCategories());
                    if (!(name in custom)) return false;
                    delete custom[name];
                    StorageManager.setCustomCategories(custom);
                    rebuild();
                    return true;
                }
            };
        })();

        // 닉네임별 최고 기록 랭킹. 1위가 곧 '챔피언'이며 챔피언 뱃지.png를 받는다.
        // 모드 1(제시어 맞추기)과 모드 2(AI 스무고개)는 점수 폭이 달라서 랭킹을 따로 둔다.
        // kind 는 'quiz' 또는 'classic' 이며, 빠뜨리면 모드 1 랭킹을 뜻한다.
        const LeaderboardManager = (function () {
            const MAX_ENTRIES = 30;

            function sorted(list) {
                return list.slice().sort((a, b) => b.score - a.score || a.ts - b.ts);
            }

            return {
                getAll(kind) {
                    return sorted(StorageManager.getLeaderboard(kind));
                },
                getChampion(kind) {
                    const all = this.getAll(kind);
                    return all.length ? all[0] : null;
                },
                /**
                 * 한 판(모드 2는 한 세션)의 결과를 등록한다. 닉네임당 최고 기록 1건만 남는다.
                 * 지금 랭킹에 올라 있는 내 점수를 '넘었을 때만' 새로 등록한다.
                 * 같은 점수는 등록하지 않는다 — 순위는 그대로인데 기록 시각만 밀려서
                 * 먼저 올린 사람이 동점자에게 밀리는 일을 막는다.
                 * @returns {{registered:boolean, previousScore:number, isPersonalBest:boolean,
                 *            isChampion:boolean, becameChampion:boolean}}
                 */
                submit(name, score, kind) {
                    const trimmed = (name || '').trim() || '게스트';
                    const result = {
                        registered: false, previousScore: 0, isPersonalBest: false,
                        isChampion: false, becameChampion: false
                    };
                    if (!(score > 0)) return result;

                    const previousChampion = this.getChampion(kind);
                    const list = StorageManager.getLeaderboard(kind);
                    const existing = list.find(entry => entry.name === trimmed);
                    result.previousScore = existing ? existing.score : 0;

                    // 최신 랭킹에 올라 있는 점수를 넘지 못하면 아무것도 바꾸지 않는다.
                    if (existing && score <= existing.score) {
                        result.isChampion = !!previousChampion && previousChampion.name === trimmed;
                        return result;
                    }

                    if (!existing) {
                        list.push({ name: trimmed, score, ts: Date.now() });
                    } else {
                        existing.score = score;
                        existing.ts = Date.now();
                    }
                    result.registered = true;
                    result.isPersonalBest = true;

                    StorageManager.setLeaderboard(sorted(list).slice(0, MAX_ENTRIES), kind);

                    const champion = this.getChampion(kind);
                    result.isChampion = !!champion && champion.name === trimmed;
                    result.becameChampion = result.isChampion &&
                        (!previousChampion || previousChampion.name !== trimmed);
                    return result;
                },
                clear(kind) {
                    StorageManager.setLeaderboard([], kind);
                }
            };
        })();

        // Plan FR-06: 3연속 정답부터 콤보 보너스, 오답/게임종료/셔플 시 리셋
        const ComboManager = (function () {
            const THRESHOLD = 3;
            return {
                threshold: THRESHOLD,
                registerCorrect() {
                    GameState.comboCount++;
                    const bonus = GameState.comboCount >= THRESHOLD ? 1 : 0;
                    return { comboCount: GameState.comboCount, bonus };
                },
                reset() {
                    GameState.comboCount = 0;
                }
            };
        })();

        /* =========================================================
           4. Presentation Layer (렌더링 전담, DOM만 다룸)
           Design Ref: §9 — GameState/Dictionary 읽기 전용 참조, Controller를 역참조하지 않음
        ========================================================= */
        const board = dom('board');
        const canvas = dom('lineCanvas');
        const ctx2d = canvas.getContext('2d');
        const boardContainer = dom('board-container');
        const toastContainer = dom('toast-container');
        const scoreCard = dom('scoreCard');
        const timerCard = dom('timerCard');
        const shuffleFab = dom('shuffleFab');
        const categoryCard = dom('categoryCard');
        const championBanner = dom('championBanner');
        const versusBar = dom('versusBar');

        const CONFETTI_COLORS = ['#FF6B8B', '#4ECCA3', '#FFD166', '#A78BFA', '#FFA26B', '#63C7FF'];
        const GOOD_LABELS = ["Sweet!", "Awesome!", "정답이에요!", "새콤달콤!"];

        // 목표 단어 글자를 채우고 남은 블록을 메우는 흔한 한글 글자들
        const FILLER_CHARS = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히강건경고과관광구국군권금기길김남대도동명문미민박방배백번부북분산서석선설성세수숙순승시신심안양연영오용우원유윤은이인임장전정제조종주지진찬창채천철최추춘태하한해현호홍화환회효훈흥희";

        // 블록 -> 캔버스 기준 중심 좌표. 판이 새로 그려질 때만 다시 잰다.
        const blockCenters = new Map();

        // 랭킹은 모드 1(classic) · 모드 2(quiz) · 모드 3(exam) 세 갈래다.
        // UIManager(챔피언 배너)와 ModalManager(랭킹 모달) 양쪽에서 써서 최상위 스코프에 둔다.
        function normalizeBoard(board) {
            return (board === 'quiz' || board === 'exam') ? board : 'classic';
        }

        const UIManager = (function () {
            function showToast(message, type) {
                const toast = makeEl('div', `toast ${type || 'info'}`, message);
                toastContainer.appendChild(toast);
                setTimeout(() => toast.remove(), 2800);
            }

            function spawnFloatText(text, kind) {
                const el = makeEl('div', `float-text ${kind || 'good'}`, text);
                boardContainer.appendChild(el);
                el.addEventListener('animationend', () => el.remove());
                setTimeout(() => el.remove(), 1200);
            }

            function spawnConfetti() {
                const count = 24;
                for (let i = 0; i < count; i++) {
                    const piece = makeEl('div', 'confetti-piece');
                    const angle = Math.random() * Math.PI * 2;
                    const distance = 60 + Math.random() * 90;
                    const dx = Math.cos(angle) * distance;
                    const dy = Math.sin(angle) * distance - 30;
                    const rot = (Math.random() * 720 - 360) + 'deg';
                    piece.style.setProperty('--dx', `${dx}px`);
                    piece.style.setProperty('--dy', `${dy}px`);
                    piece.style.setProperty('--rot', rot);
                    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
                    piece.style.width = piece.style.height = `${6 + Math.random() * 8}px`;
                    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '3px';
                    piece.style.animation = `confettiBurst ${0.6 + Math.random() * 0.4}s ease-out forwards`;
                    boardContainer.appendChild(piece);
                    piece.addEventListener('animationend', () => piece.remove());
                    setTimeout(() => piece.remove(), 1200);
                }
            }

            function pulseScore() {
                replayAnimation(scoreCard, 'pulse-score');
            }

            function flashBoard(kind) {
                boardContainer.classList.remove('flash-success', 'flash-error');
                replayAnimation(boardContainer, kind === 'success' ? 'flash-success' : 'flash-error');
            }

            function shakeAndGlowBlocks(blocks) {
                blocks.forEach(b => replayAnimation(b, 'shake-error'));
            }

            function popSuccessBlocks(blocks) {
                blocks.forEach(b => replayAnimation(b, 'pop-success'));
            }

            function updateShuffleFabState() {
                // 게임 중이면서 남은 횟수가 있을 때만 쓸 수 있다.
                const usable = GameState.isGameActive && GameState.shuffleLeft > 0;
                shuffleFab.classList.toggle('disabled', !usable);
                shuffleFab.disabled = !usable;

                const label = dom('shuffleLabel');
                if (label) label.textContent = `단어변경 (${GameState.shuffleLeft}/${SHUFFLE_MAX})`;
            }

            /**
             * 글자판 자리의 시작 영역을 켜고 끈다.
             * 판이 돌고 있거나(스무고개는 세션 중이면) 감추고, 그 밖에는 보여 준다.
             * 시작 처리는 기존 startGame() 을 그대로 쓰므로 여기서는 보이기만 다룬다.
             */
            function updateBoardStart() {
                const panel = dom('boardStartPanel');
                if (!panel) return;
                const quizRunning = (typeof QuizSession !== 'undefined') && QuizSession.active;
                panel.hidden = GameState.isGameActive || quizRunning;

                const isQuiz = appMode === 'quiz';
                dom('boardStartTitle').textContent = isQuiz
                    ? 'AI 힌트 맞히기를 시작할까요?'
                    : '준비되면 시작하세요';
                dom('boardStartSub').textContent = isQuiz
                    ? 'AI가 낸 낱말을 힌트를 보고 맞히는 게임이에요. 힌트를 적게 볼수록 점수가 높아요.'
                    : '글자를 이어 제시어와 관련된 단어를 만드는 게임이에요.';
                panel.querySelector('.board-start-go').lastChild.textContent =
                    isQuiz ? '스무고개 시작' : '게임 시작';
            }

            /* 게임 중에는 [게임 시작]이 할 일이 없다. 버튼 줄이 흔들리지 않게
               자리는 그대로 두고 색과 클릭만 거둔다. 판을 다시 깔고 싶으면
               보드 위 [단어 변경] 이나 [게임 종료] 를 쓰면 된다. */
            function updateNavState() {
                const startBtn = dom('startNavBtn');
                if (!startBtn) return;
                const busy = GameState.isGameActive;
                startBtn.classList.toggle('is-idle', busy);
                startBtn.disabled = busy;
                startBtn.title = busy
                    ? '게임이 진행 중입니다'
                    : '새 판을 시작합니다';
            }

            // 설정에서 고른 카테고리 이름 ('랜덤'이면 주사위 표시)
            function selectedCategoryLabel() {
                const select = dom('categorySelect');
                const value = (select && select.value) || 'random';
                return value === 'random' ? '🎲 랜덤' : value;
            }

            function updateCategoryDisplay() {
                // 모드 2에서는 사용자가 입력한 카테고리를 보여준다. (정답 목록은 열 수 없다)
                if (appMode === 'quiz') {
                    const quizLabel = QuizManager.category || StorageManager.getQuizCategory() || '카테고리 선택';
                    dom('categoryName').textContent = `🤖 ${quizLabel}`;
                    dom('quizRuleCategoryName').textContent = quizLabel;
                    const quizHint = dom('categoryHint');
                    quizHint.textContent = GameState.isGameActive
                        ? '힌트로 맞히기'
                        : '눌러서 카테고리 선택';
                    categoryCard.classList.toggle('locked', GameState.isGameActive);
                    categoryCard.title = GameState.isGameActive
                        ? 'AI가 고른 정답을 맞혀보세요'
                        : '카테고리를 골라 새 문제를 받습니다';
                    return;
                }

                // 모드 3은 문제 파일이 곧 카테고리다. 고를 것이 없으므로 카드를 잠가 둔다.
                if (appMode === 'exam') {
                    dom('categoryName').textContent = '📜 산업재산권';
                    dom('categoryHint').textContent = ExamSession.active
                        ? `⏱ ${examTimeLimit()}초 안에 맞혀보세요`
                        : '🖊 눌러서 문제 시작';
                    categoryCard.classList.toggle('locked', GameState.isGameActive);
                    categoryCard.title = ExamSession.active
                        ? '문제 파일에 있는 문제를 순서대로 풉니다'
                        : '문제 파일에 있는 문제를 처음부터 냅니다';
                    return;
                }

                // 게임 중에는 실제 제시어, 시작 전에는 설정에서 고른 카테고리를 보여준다.
                const label = (GameState.isGameActive && GameState.currentCategory)
                    ? GameState.currentCategory
                    : selectedCategoryLabel();
                dom('categoryName').textContent = label;
                // 규칙 배너에도 현재 제시어를 반영해 '무엇이 정답인지'를 화면에서 바로 알 수 있게 한다.
                dom('ruleCategoryName').textContent = label;

                // 정답 목록을 언제 볼 수 있는지 카드에서 바로 알린다.
                // 게임 중에는 물론이고, 아직 한 판도 마치지 않았을 때도 볼 수 없다.
                const hint = dom('categoryHint');
                const canOpen = !GameState.isGameActive && GameState.answerListUnlocked;
                if (GameState.isGameActive) {
                    hint.textContent = '게임 중 비공개';
                    categoryCard.title = '게임 중에는 정답을 볼 수 없어요';
                } else if (!GameState.answerListUnlocked) {
                    hint.textContent = '게임 후 공개';
                    categoryCard.title = '한 판을 마치면 정답 목록을 볼 수 있어요';
                } else {
                    hint.textContent = '눌러서 정답 보기';
                    categoryCard.title = '정답 목록 보기';
                }
                categoryCard.classList.toggle('locked', !canOpen);
            }

            function updateScoreDisplay() {
                dom('score').textContent = GameState.score;
            }

            function updateTimerDisplay() {
                const timerEl = dom('timer');
                timerEl.textContent = GameState.isGameActive ? `${GameState.timeLeft}초` : "대기중";
                if (GameState.isGameActive && GameState.timeLeft <= 10 && GameState.timeLeft > 0) {
                    timerCard.classList.add('timer-warning');
                } else {
                    timerCard.classList.remove('timer-warning');
                }
            }

            function updateHighScoreDisplay() {
                dom('highScoreSub').textContent = `최고 기록 ${GameState.highScore}점`;
            }

            // 기록 1위(챔피언)를 상단 배너에 챔피언 뱃지.png 와 함께 노출한다.
            // 랭킹이 모드별로 나뉘므로 지금 고른 모드의 1위를 보여준다.
            function updateChampionBanner() {
                const champion = LeaderboardManager.getChampion(normalizeBoard(appMode));
                if (!champion) {
                    championBanner.style.display = 'none';
                    return;
                }
                championBanner.style.display = 'flex';
                dom('championLabel').textContent = appMode === 'quiz'
                    ? '👑 스무고개 1위'
                    : appMode === 'exam' ? '👑 산업재산권 1위' : '👑 제시어 맞추기 1위';
                dom('championName').textContent = champion.name;
                dom('championScore').textContent = `${champion.score}점`;
            }

            function updateVersusBar() {
                if (!VersusManager.active) {
                    versusBar.style.display = 'none';
                    return;
                }
                versusBar.style.display = 'flex';
                VersusManager.players.forEach((player, i) => {
                    dom(`versusName${i}`).textContent = player.name;
                    dom(`versusScore${i}`).textContent =
                        player.played ? `${player.score}점` : '-';
                    dom(`versusSlot${i}`)
                        .classList.toggle('active', VersusManager.turn === i);
                });
            }

            function resizeCanvas() {
                canvas.width = boardContainer.offsetWidth;
                canvas.height = boardContainer.offsetHeight;
            }

            function clearCanvas() {
                ctx2d.clearRect(0, 0, canvas.width, canvas.height);
            }

            /**
             * 블록 중심 좌표를 판이 만들어질 때 한 번만 재어 둔다.
             * 고를 때마다 블록마다 getBoundingClientRect 를 부르면 매번 레이아웃이 다시 계산되고,
             * 선택된 블록에 걸린 transform 때문에 선이 흔들린다. 레이아웃 위치를 쓰면 둘 다 없어진다.
             */
            function cacheBlockCenters() {
                blockCenters.clear();
                const originX = board.offsetLeft;
                const originY = board.offsetTop;
                board.querySelectorAll('.block').forEach(block => {
                    blockCenters.set(block, {
                        x: originX + block.offsetLeft + block.offsetWidth / 2,
                        y: originY + block.offsetTop + block.offsetHeight / 2
                    });
                });
            }

            function drawLines() {
                clearCanvas();
                if (GameState.selectedBlocks.length < 2) return;

                const gradient = ctx2d.createLinearGradient(0, 0, canvas.width, canvas.height);
                gradient.addColorStop(0, '#FF9DB3');
                gradient.addColorStop(1, '#FF6B8B');

                ctx2d.save();
                ctx2d.shadowColor = 'rgba(255, 107, 139, 0.6)';
                ctx2d.shadowBlur = 12;
                ctx2d.beginPath();
                ctx2d.lineWidth = 9;
                ctx2d.strokeStyle = gradient;
                ctx2d.lineCap = "round";
                ctx2d.lineJoin = "round";

                GameState.selectedBlocks.forEach((block, index) => {
                    const center = blockCenters.get(block);
                    if (!center) return;
                    if (index === 0) ctx2d.moveTo(center.x, center.y);
                    else ctx2d.lineTo(center.x, center.y);
                });
                ctx2d.stroke();
                ctx2d.restore();
            }

            function resetSelection() {
                GameState.disarmDeselectTimer();
                GameState.selectedBlocks.forEach(b => {
                    b.classList.remove('selected');
                    b.classList.remove('shake-error');
                });
                GameState.selectedBlocks = [];
                clearCanvas();
            }

            function renderBoard(totalBlocks, targetWords) {
                clearBoard();

                const cols = Math.ceil(Math.sqrt(totalBlocks));
                // 타일 크기는 CSS(:root --tile / --tile-gap)가 정한다.
                // 여기서 픽셀을 다시 적으면 두 곳이 어긋나므로 calc 로 넘긴다.
                board.style.width = `calc(${cols} * (var(--tile) + var(--tile-gap)))`;

                // 목표 단어의 글자를 먼저 넣고, 남는 칸은 흔한 글자로 채운 뒤 섞는다.
                const chars = targetWords.join('').split('');
                while (chars.length < totalBlocks) {
                    chars.push(FILLER_CHARS.charAt(Math.floor(Math.random() * FILLER_CHARS.length)));
                }
                for (let i = chars.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [chars[i], chars[j]] = [chars[j], chars[i]];
                }

                // 블록마다 리스너를 다는 대신 보드 한 곳에서 위임받는다 (아래 초기화 부분 참고).
                const fragment = document.createDocumentFragment();
                chars.forEach(char => fragment.appendChild(makeEl('div', 'block', char)));
                board.appendChild(fragment);

                // 레이아웃이 잡힌 뒤에 캔버스 크기와 블록 좌표를 잰다.
                setTimeout(() => {
                    resizeCanvas();
                    cacheBlockCenters();
                }, 0);
            }

            // 보드를 비우고 선택/선 그리기 상태도 함께 초기화한다.
            function clearBoard() {
                GameState.disarmDeselectTimer();
                board.innerHTML = "";
                blockCenters.clear();
                GameState.selectedBlocks = [];
                clearCanvas();
            }

            // 상단 HUD 전체를 현재 상태에 맞춰 한 번에 다시 그린다.
            function syncHud() {
                updateShuffleFabState();
                updateNavState();
                updateBoardStart();
                updateCategoryDisplay();
                updateScoreDisplay();
                updateHighScoreDisplay();
                updateTimerDisplay();
                updateVersusBar();
            }

            // 밖에서 실제로 쓰는 것만 내보낸다. (개별 HUD 갱신은 syncHud 가 대신한다)
            return {
                showToast, spawnFloatText, spawnConfetti, pulseScore, flashBoard,
                shakeAndGlowBlocks, popSuccessBlocks, syncHud, updateNavState, updateBoardStart,
                updateCategoryDisplay, updateScoreDisplay, updateTimerDisplay, updateHighScoreDisplay,
                updateChampionBanner, updateVersusBar,
                resizeCanvas, clearCanvas, drawLines, cacheBlockCenters,
                resetSelection, renderBoard, clearBoard
            };
        })();

        const ModalManager = (function () {
            function populateCategorySelect(preferred) {
                const select = dom('categorySelect');
                const keep = preferred || select.value || 'random';
                const custom = CategoryManager.getCustom();
                select.innerHTML = "";
                const randomOption = makeEl('option', null, "🎲 랜덤");
                randomOption.value = "random";
                select.appendChild(randomOption);

                Dictionary.getCategories().forEach(cat => {
                    // 파일로 추가한 카테고리는 목록에서 바로 구분되도록 표시한다.
                    const opt = makeEl('option', null, (cat in custom) ? `📂 ${cat}` : cat);
                    opt.value = cat;
                    select.appendChild(opt);
                });

                select.value = keep;
                if (!select.value) select.value = 'random';
            }

            // 정답 목록: 선택한 카테고리(랜덤이면 전체)의 단어를 모두 보여준다.
            function renderAnswerList() {
                const select = dom('categorySelect');
                const value = (select && select.value) || 'random';
                const categories = (value === 'random' || !dictionary[value])
                    ? Dictionary.getCategories()
                    : [value];

                dom('answerListSub').textContent = (value === 'random')
                    ? '🎲 랜덤이라 모든 카테고리의 정답을 보여드려요'
                    : `'${value}' 카테고리의 정답 ${Dictionary.getWords(value).length}개`;

                const container = dom('answerList');
                container.innerHTML = '';

                categories.forEach(name => {
                    const words = Dictionary.getWords(name);
                    const group = makeEl('div', 'answer-group');
                    const wrap = makeEl('div', 'answer-words');
                    words.forEach(word => wrap.appendChild(makeEl('span', 'answer-chip', word)));

                    group.appendChild(makeEl('div', 'answer-group-title', `${name} (${words.length}개)`));
                    group.appendChild(wrap);
                    container.appendChild(group);
                });
            }

            // 파일로 추가한 카테고리 목록 (개별 삭제 가능)
            function renderCustomCategories() {
                const container = dom('customCatList');
                if (!container) return;
                const custom = CategoryManager.getCustom();
                const names = Object.keys(custom);
                container.innerHTML = '';

                names.forEach(name => {
                    const row = makeEl('div', 'custom-cat-row');
                    const del = makeEl('button', 'cc-del', '삭제');
                    del.type = 'button';
                    del.dataset.category = name;

                    row.appendChild(makeEl('span', 'cc-name', `📂 ${name}`));
                    row.appendChild(makeEl('span', 'cc-count', `${custom[name].length}단어`));
                    row.appendChild(del);
                    container.appendChild(row);
                });
            }

            /** 모드 3에서 파일로 더 넣은 문제 목록. 기본 문제 파일의 문제는 여기 나오지 않는다. */
            function renderExamExtras() {
                const container = dom('examExtraList');
                if (!container) return;
                const extras = StorageManager.getExamExtras();
                container.innerHTML = '';

                if (extras.length === 0) {
                    const base = ExamBank.questions.length;
                    container.appendChild(makeEl('div', 'settings-note',
                        base > 0
                            ? `지금 문제 ${base}개(파일에 있는 것)로 진행합니다. 파일을 올리면 여기에 추가분이 표시돼요.`
                            : '파일을 올리면 여기에 추가한 문제가 표시돼요.'));
                    return;
                }

                extras.forEach((item, index) => {
                    const row = makeEl('div', 'custom-cat-row');
                    const del = makeEl('button', 'cc-del', '삭제');
                    del.type = 'button';
                    del.dataset.examIndex = String(index);

                    const title = item.question.length > 24 ? item.question.slice(0, 24) + '…' : item.question;
                    row.appendChild(makeEl('span', 'cc-name', `📜 ${title}`));
                    row.appendChild(makeEl('span', 'cc-count', item.answers.join(', ')));
                    row.appendChild(del);
                    container.appendChild(row);
                });
            }

            /**
             * 지금 고른 모드의 설정 묶음만 남기고 나머지는 숨긴다.
             * 설정이 세 모드 분량이라 한꺼번에 펼치면 어느 것이 지금 게임에 적용되는지 알기 어렵고,
             * 다른 모드의 '블록 개수'를 고쳐 놓고 왜 안 바뀌냐고 헤매기 쉽다.
             * `data-modes` 를 적지 않은 항목(닉네임 · 배경)은 모드와 상관없이 늘 보인다.
             */
            function syncSettingsMode() {
                document.querySelectorAll('#settingsOverlay .settings-group').forEach(group => {
                    const modes = (group.dataset.modes || '').split(/\s+/).filter(Boolean);
                    group.hidden = modes.length > 0 && modes.indexOf(appMode) === -1;
                });
                const MODE_LABEL = {
                    classic: '🍬 모드 1 · 제시어 맞추기',
                    quiz: '🤖 모드 2 · AI 힌트 맞히기',
                    exam: '📜 모드 3 · 산업재산권 문제'
                };
                dom('settingsModeSub').textContent =
                    `${MODE_LABEL[appMode] || MODE_LABEL.classic} 설정이에요. 모드를 바꾸면 그 모드의 설정이 나옵니다.`;
            }

            // 배경 선택 버튼들의 선택 표시를 현재 설정에 맞춘다.
            function syncBackgroundPicker() {
                document.querySelectorAll('#bgPicker .bg-option').forEach(btn => {
                    btn.classList.toggle('selected', btn.dataset.bg === BackgroundManager.current);
                });
            }

            /**
             * '이 점수가 랭킹에 올라갔는지'를 결과 모달에 한 줄로 적는다.
             * 지금 랭킹에 올라 있는 내 점수를 넘지 못하면 등록되지 않으므로, 그 이유를 알려준다.
             */
            function describeRankResult(el, result, score, label) {
                if (!el) return;
                const r = result || {};
                el.style.display = 'block';
                if (r.registered) {
                    el.textContent = r.previousScore > 0
                        ? `🏅 ${label} 기록을 ${r.previousScore}점 → ${score}점으로 새로 올렸어요`
                        : `🏅 ${label}에 새로 등록했어요`;
                } else if (r.previousScore > 0) {
                    el.textContent = `📌 이미 등록된 ${r.previousScore}점보다 낮아서 ${label}은 그대로예요`;
                } else {
                    el.style.display = 'none';
                }
            }

            // 랭킹 모달에서 지금 보고 있는 탭. 모달을 열 때 현재 모드에 맞춰 정해진다.
            let rankingBoard = 'classic';

            // normalizeBoard 는 최상위 스코프로 옮겼다 (UIManager.updateChampionBanner 도 같이 쓴다).

            function renderRanking() {
                document.querySelectorAll('#rankTabs .rank-tab').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.board === rankingBoard);
                });
                const isQuizBoard = rankingBoard === 'quiz';
                const isExamBoard = rankingBoard === 'exam';
                dom('rankSub').textContent = isQuizBoard
                    ? '스무고개 세션 총점 · 닉네임별 최고 기록 TOP 10'
                    : isExamBoard
                        ? '산업재산권 문제 총점 · 닉네임별 최고 기록 TOP 10'
                        : '한 판 점수 · 닉네임별 최고 기록 TOP 10';

                const list = LeaderboardManager.getAll(rankingBoard).slice(0, 10);
                const container = dom('rankList');
                container.innerHTML = '';

                if (list.length === 0) {
                    container.appendChild(makeEl('div', 'rank-empty', isQuizBoard
                        ? '아직 스무고개 기록이 없어요. 한 세션을 끝까지 마쳐보세요!'
                        : isExamBoard
                            ? '아직 산업재산권 문제 기록이 없어요. 전체 문제를 한 번 풀어보세요!'
                            : '아직 기록이 없어요. 게임을 한 판 즐겨보세요!'));
                    return;
                }

                list.forEach((entry, index) => {
                    const row = makeEl('div', 'rank-row' + (index === 0 ? ' rank-first' : ''));
                    row.appendChild(makeEl('div', 'rank-no', index === 0 ? '👑' : `${index + 1}`));
                    row.appendChild(makeEl('div', 'rank-name', entry.name));
                    row.appendChild(makeEl('div', 'rank-score', `${entry.score}점`));

                    // 1위에게만 챔피언 뱃지.png
                    if (index === 0) {
                        const badge = makeEl('img', 'rank-badge-img');
                        badge.src = 'assets/champion-badge.png';
                        badge.alt = '챔피언 뱃지';
                        row.appendChild(badge);
                    }

                    container.appendChild(row);
                });
            }

            return {
                populateCategorySelect,
                renderCustomCategories,
                renderExamExtras,
                syncSettingsMode,
                renderAnswerList,
                syncBackgroundPicker,
                renderRanking,
                describeRankResult,
                openSettings() {
                    syncSettingsMode();
                    syncBackgroundPicker();
                    const muteBtn = dom('settingsMuteBtn');
                    if (muteBtn) muteBtn.textContent = AudioManager.isMuted ? '🔇 소리 켜기' : '🔊 소리 끄기';
                    renderCustomCategories();
                    // 모드 3 설정도 저장값으로 채운다. 모드 1의 블록 개수와 서로 다른 값이다.
                    dom('examBlockCount').value = StorageManager.getExamBlocks();
                    dom('examTimeInput').value = StorageManager.getExamTime();
                    // 목록에 '기본 문제 몇 개'를 적어 주려면 파일을 읽어야 한다. 실패해도 그냥 넘어간다.
                    ExamBank.load().catch(() => {}).then(renderExamExtras);
                    renderExamExtras();
                    // 모드 2 설정(블록 개수 · 횟수 · Ollama 주소 · 모델)도 저장값으로 채워 둔다.
                    dom('quizBlockCount').value = StorageManager.getQuizBlocks();
                    dom('quizRoundsInput').value = StorageManager.getQuizRounds();
                    dom('llmEndpointInput').value = StorageManager.getLlmEndpoint();
                    dom('llmModelInput').value = StorageManager.getLlmModel();
                    writeLlmStatus(dom('llmSettingsStatus'),
                        '연결 상태를 보려면 [연결 확인]을 눌러주세요.', '');
                    // 설명은 항상 접힌 상태로 열어 설정 화면이 길어지지 않게 한다.
                    [['formatGuide', 'formatGuideBtn'], ['examGuide', 'examGuideBtn']].forEach(([guideId, btnId]) => {
                        const guide = dom(guideId);
                        const guideBtn = dom(btnId);
                        if (!guide || !guideBtn) return;
                        guide.style.display = 'none';
                        guideBtn.textContent = '작성 예시 ▾';
                        guideBtn.setAttribute('aria-expanded', 'false');
                    });
                    Overlay.open('settingsOverlay');
                },
                closeSettings() {
                    Overlay.close('settingsOverlay');
                },
                showGameOver(finalScore, highScore, isNewRecord, championResult, endInfo) {
                    const info = endInfo || {};
                    dom('gameOverScore').textContent = finalScore;
                    dom('gameOverHighScore').textContent = `최고 점수: ${highScore}점`;
                    dom('gameOverRecordBadge').style.display = isNewRecord ? 'inline-block' : 'none';

                    // 정답을 모두 맞혀서 끝났는지, 시간이 다 돼서 끝났는지 구분해 보여준다.
                    dom('gameOverTitle').textContent =
                        info.cleared ? '🎉 정답을 모두 맞혔어요!' : '⏰ 시간 종료!';

                    // 다 맞혔을 때는 걸린 시간을 함께 보여준다.
                    const timeEl = dom('gameOverTime');
                    timeEl.style.display = info.cleared ? 'inline-block' : 'none';
                    timeEl.textContent = `⏱ 걸린 시간 ${info.elapsedSeconds || 0}초 (남은 시간 ${info.remainSeconds || 0}초)`;

                    describeRankResult(dom('gameOverRankNote'), championResult, finalScore, '랭킹');

                    const badge = dom('gameOverChampionBadge');
                    const sub = dom('gameOverSub');
                    if (championResult && championResult.isChampion) {
                        badge.style.display = 'block';
                        sub.textContent = championResult.becameChampion
                            ? '🏅 랭킹 1위 등극! 챔피언 뱃지를 획득했어요'
                            : '👑 챔피언 자리를 지켰어요';
                    } else {
                        badge.style.display = 'none';
                        sub.textContent = info.cleared
                            ? `제시어의 단어 ${info.solvedCount || 0}개를 모두 찾았어요!`
                            : '이번 게임 결과예요';
                    }
                    Overlay.open('gameOverOverlay');
                },
                hideGameOver() {
                    Overlay.close('gameOverOverlay');
                },
                openVersusSetup() {
                    const saved = StorageManager.getNickname();
                    const input1 = dom('versusName1Input');
                    if (!input1.value) input1.value = saved || '플레이어 1';
                    Overlay.open('versusSetupOverlay');
                },
                closeVersusSetup() {
                    Overlay.close('versusSetupOverlay');
                },
                showVersusTurn(index, name) {
                    dom('versusTurnTitle').textContent = `⚔ ${index + 1}번 플레이어 차례`;
                    dom('versusTurnSub').textContent =
                        index === 0 ? '먼저 도전할 차례예요. 준비되면 시작!' : '상대 점수를 넘어보세요!';
                    dom('versusTurnName').textContent = name;
                    Overlay.open('versusTurnOverlay');
                },
                hideVersusTurn() {
                    Overlay.close('versusTurnOverlay');
                },
                showVersusResult(players, winnerIndex) {
                    const trophy = dom('versusTrophy');
                    const title = dom('versusResultTitle');
                    const winnerName = dom('versusWinnerName');

                    if (winnerIndex === -1) {
                        // 무승부에는 우승.png 를 띄우지 않는다.
                        trophy.style.display = 'none';
                        title.textContent = '🤝 무승부!';
                        winnerName.textContent = `${players[0].score}점 동점`;
                    } else {
                        trophy.style.display = 'block';
                        // 애니메이션을 매 판 다시 재생시키기 위해 리플로우를 강제한다.
                        trophy.style.animation = 'none';
                        void trophy.offsetWidth;
                        trophy.style.animation = '';
                        title.textContent = '🏆 우승!';  // 애니메이션을 매 판 다시 재생시킨다
                        winnerName.textContent = `${players[winnerIndex].name} 승리!`;
                    }

                    const boardEl = dom('versusScoreboard');
                    boardEl.innerHTML = '';
                    players.forEach((player, i) => {
                        const row = makeEl('div', 'vs-row' + (i === winnerIndex ? ' win' : ''));
                        row.appendChild(makeEl('span', null, (i === winnerIndex ? '🏆 ' : '') + player.name));
                        row.appendChild(makeEl('span', 'vs-row-score', `${player.score}점`));
                        boardEl.appendChild(row);
                    });

                    Overlay.open('versusResultOverlay');
                },
                hideVersusResult() {
                    Overlay.close('versusResultOverlay');
                },
                openAnswerList() {
                    renderAnswerList();
                    Overlay.open('answerListOverlay');
                },
                closeAnswerList() {
                    Overlay.close('answerListOverlay');
                },
                openRanking() {
                    // 지금 고른 모드의 랭킹부터 보여준다.
                    rankingBoard = normalizeBoard(appMode);
                    renderRanking();
                    Overlay.open('rankingOverlay');
                },
                setRankingBoard(board) {
                    rankingBoard = normalizeBoard(board);
                    renderRanking();
                },
                currentRankingBoard() {
                    return rankingBoard;
                },
                closeRanking() {
                    Overlay.close('rankingOverlay');
                }
            };
        })();


        /* =========================================================
           4.5 모드 2 — AI(qwen2.5:7b) 스무고개
           사용자가 입력한 카테고리에서 LLM이 정답 낱말 하나를 고르고,
           10초마다 힌트를 하나씩 보드 옆 패널에 열어 준다.
           LLM에 연결하지 못하면 내장 사전으로 문제를 만들어 게임은 계속되게 한다.
        ========================================================= */

        const QUIZ_HINT_INTERVAL = 10;  // 힌트가 하나씩 열리는 간격(초)
        const QUIZ_HINT_TOTAL = 6;      // 보드 옆에 띄우는 힌트는 한 판에 6개까지만
        // LLM에는 6개를 요청해 다듬은 뒤 3개만 쓴다.
        // 한국어가 아닌 글자가 섞인 힌트는 통째로 버리기 때문에 걸러질 몫까지 넉넉히 받아 둔다.
        const QUIZ_LLM_HINT_REQUEST = 6;
        const QUIZ_LLM_HINT_MIN = 2;    // 이만큼도 안 남으면 문제를 다시 받는다
        const QUIZ_LLM_MAX_ATTEMPTS = 3; // 검사에 걸린 응답을 다시 받아 볼 횟수
        // 이만큼 안에 문제가 준비되면 로딩 화면을 띄우지 않는다. 미리 받아 둔 판이 여기 해당한다.
        const QUIZ_LOADING_DELAY = 200;
        const QUIZ_EXTRA_TIME = 20;     // 마지막 힌트 이후에 더 주는 여유 시간(초)
        const QUIZ_MAX_ROUNDS = 10;     // 한 세션에서 진행할 수 있는 최대 스무고개 횟수
        // 모드 2의 블록 개수 기본값과 허용 범위. 예전에 모드 1의 칸을 같이 쓸 때의 기본값이 16이라
        // 쓰던 사람에게 갑자기 판이 달라 보이지 않도록 같은 값으로 둔다.
        const QUIZ_DEFAULT_BLOCKS = 16;
        const QUIZ_BLOCKS_MIN = 4, QUIZ_BLOCKS_MAX = 36;
        // 모드 1의 블록 개수 기본값과 허용 범위 (마크업의 value/min/max 와 같은 값)
        const CLASSIC_DEFAULT_BLOCKS = 16;
        const CLASSIC_BLOCKS_MIN = 4, CLASSIC_BLOCKS_MAX = 36;
        const QUIZ_ANSWER_RE = /^[가-힣]{2,6}$/;

        /* ---------- 힌트 문장 만들기 / 다듬기 (LLM 응답 유무와 무관하게 항상 필요) ---------- */
        const QuizContent = (function () {
            const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

            // '수박' -> 'ㅅ ㅂ'
            function initials(word) {
                return word.split('').map(ch => {
                    const code = ch.charCodeAt(0) - 0xAC00;
                    if (code < 0 || code > 11171) return ch;
                    return CHOSUNG[Math.floor(code / 588)];
                }).join(' ');
            }

            function escapeRe(text) {
                return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }

            /*
             * 힌트에 쓸 수 있는 글자만 추린 화이트리스트.
             * 한글(음절·자모), 숫자, 공백, 흔한 문장부호까지만 허용한다.
             * 작은 로컬 모델은 한국어로만 쓰라고 해도 영어·한자·다른 나라 문자를 섞는 일이 잦다.
             * (실제로 관측된 예: ".big cat.", "비ONGODB", "圆形的球和脚用韩语怎么说?")
             * 이런 힌트는 고쳐 쓰기보다 통째로 버리는 편이 낫다. 확정 힌트 3개가 항상 뒤에 붙으므로
             * 몇 개가 버려져도 문제는 풀 수 있다.
             */
            const HINT_ALLOWED_RE = /^[가-힣ㄱ-ㅎㅏ-ㅣ0-9\s.,!?'"()\[\]·…~%\-]+$/;

            /**
             * LLM이 준 힌트 한 줄을 게임에 쓸 수 있게 다듬는다.
             * - 줄바꿈/번호/따옴표 정리, 60자 제한
             * - 한국어가 아닌 글자가 섞여 있으면 버린다
             * - 힌트 안에 정답이 그대로 들어 있으면 ○○ 로 가린다 (스포일러 방지)
             */
            function sanitizeHint(text, answer) {
                let value = String(text == null ? '' : text)
                    .replace(/\s+/g, ' ')
                    .replace(/^["'\-\d.)\s]+/, '')
                    .trim();
                if (!value) return '';
                // 가리기 전에 검사한다. ○ 는 화이트리스트에 없고, 정답은 어차피 한글이라 통과한다.
                if (!HINT_ALLOWED_RE.test(value)) return '';
                value = value.replace(new RegExp(escapeRe(answer), 'g'), '○'.repeat(answer.length));
                if (value.length > 60) value = value.slice(0, 59) + '…';
                return value.length >= 2 ? value : '';
            }

            // LLM 힌트 묶음에서 쓸 수 있는 것만 남긴다. 몇 개가 살아남았는지로 재요청을 판단한다.
            function cleanHints(rawHints, answer) {
                return (rawHints || []).map(h => sanitizeHint(h, answer)).filter(Boolean);
            }

            // 어떤 힌트가 나오든 마지막에는 반드시 풀 수 있도록 붙이는 확정 힌트 3개.
            function closingHints(answer) {
                return [
                    `글자 수는 ${answer.length}글자예요.`,
                    `초성은 "${initials(answer)}" 예요.`,
                    `첫 글자는 '${answer.charAt(0)}'(으)로 시작해요.`
                ];
            }

            /**
             * LLM 힌트 + 확정 힌트를 합쳐 최대 QUIZ_HINT_TOTAL개의 목록을 만든다.
             * 확정 힌트는 절대 잘리지 않도록 LLM 힌트 쪽을 먼저 줄인다.
             */
            function assemble(answer, rawHints) {
                const closing = closingHints(answer);
                const room = Math.max(0, QUIZ_HINT_TOTAL - closing.length);
                return cleanHints(rawHints, answer).slice(0, room).concat(closing);
            }

            // 사용자가 입력한 카테고리와 가장 비슷한 내장 카테고리를 찾는다.
            /**
             * 입력한 카테고리와 맞아떨어지는 내장 카테고리를 찾는다. 없으면 null.
             * 정답을 사전에서 고를지 모델에게 맡길지 가르는 기준이라, 억지로 하나를 골라 주지 않는다.
             */
            function matchBuiltinCategory(input) {
                const names = Dictionary.getCategories();
                const norm = s => String(s).replace(/\s+/g, '');
                const target = norm(input);
                if (!target) return null;
                let hit = names.find(n => norm(n) === target);
                // 부분 일치는 두 글자부터만 본다. 한 글자를 허용하면 '물' 이 '동물' 에 걸리는 식으로
                // 엉뚱한 카테고리가 잡혀 제시어와 정답이 어긋난다.
                if (!hit && target.length >= 2) {
                    hit = names.find(n => norm(n).indexOf(target) !== -1 || target.indexOf(norm(n)) !== -1);
                }
                return hit || null;
            }

            // 이 낱말을 담고 있는 내장 카테고리들을 찾는다.
            function categoriesOf(word) {
                return Dictionary.getCategories().filter(c => Dictionary.getWords(c).indexOf(word) !== -1);
            }

            /**
             * 정답이 제시어와 실제로 연관되는지 사전으로 확인한다.
             * - 내장 카테고리면: 반드시 그 카테고리 안에 있는 낱말이어야 한다.
             * - 사전에 없는 카테고리(사용자가 자유롭게 적은 말)면 대조할 목록이 없다.
             *   대신 **다른 카테고리의 낱말은 아닌지**를 본다.
             *   '바다 생물' 이라고 했는데 직업 사전에 있는 '회계사' 가 나오는 경우를 걸러낸다.
             */
            function answerFitsCategory(answer, category) {
                const builtin = matchBuiltinCategory(category);
                if (builtin) return Dictionary.getWords(builtin).indexOf(answer) !== -1;
                return categoriesOf(answer).length === 0;
            }

            // 내장 사전에서 정답으로 쓸 낱말을 하나 고른다. 쓸 낱말이 없으면 null.
            function pickAnswer(category) {
                const words = Dictionary.getWords(category).filter(w => QUIZ_ANSWER_RE.test(w));
                if (!words.length) return null;
                return words[Math.floor(Math.random() * words.length)];
            }

            /**
             * LLM에 연결하지 못했을 때 쓰는 대체 문제. 사전에서 정답과 힌트를 직접 만든다.
             * 예전에는 카테고리를 못 찾으면 아무거나 하나 골라 문제를 냈는데,
             * 그 바람에 화면의 제시어와 정답이 다른 카테고리에서 나오는 일이 있었다.
             * 이제는 사전에 없는 카테고리면 문제를 만들지 않고 null 을 돌려준다.
             */
            function offlineQuiz(input) {
                const source = matchBuiltinCategory(input);
                if (!source) return null;
                const words = Dictionary.getWords(source).filter(w => QUIZ_ANSWER_RE.test(w));
                if (words.length < 2) return null;

                const answer = words[Math.floor(Math.random() * words.length)];
                const others = words.filter(w => w !== answer).sort(() => Math.random() - 0.5);

                const lead = [
                    `'${source}' 안에 있는 낱말이에요.`,
                    answer.length >= 3
                        ? '세 글자가 넘는, 조금 긴 낱말이에요.'
                        : '짧고 부르기 쉬운 낱말이에요.',
                    others.length >= 2
                        ? `'${others[0]}', '${others[1]}' 와(과) 같은 무리에 속해요.`
                        : `${source} 하면 떠오르는 낱말이에요.`
                ];

                return { answer, hints: assemble(answer, lead), category: source };
            }

            return {
                initials, sanitizeHint, cleanHints, assemble, offlineQuiz,
                matchBuiltinCategory, pickAnswer,
                categoriesOf, answerFitsCategory
            };
        })();

        /* ---------- Ollama에서 도는 qwen2.5:7b 모델을 부르는 얇은 클라이언트 ---------- */
        const LlamaClient = (function () {
            const REQUEST_TIMEOUT = 60000; // 로컬 CPU 추론이 느릴 수 있어 넉넉히 잡는다
            const PING_TIMEOUT = 8000;
            // 모델을 처음 메모리에 올리는 데는 REQUEST_TIMEOUT 을 훌쩍 넘길 수 있다.
            // (측정: qwen2.5:7b 콜드 로드 45초, 콜드 상태에서 문제 생성까지 115초)
            const WARMUP_TIMEOUT = 300000;
            // 모델을 내리는 요청은 다른 요청이 끝날 때까지 Ollama 안에서 기다릴 수 있어 넉넉히 잡는다.
            const UNLOAD_TIMEOUT = 60000;
            // 예열해 둔 모델이 곧바로 내려가면 의미가 없으므로 기본 5분보다 길게 잡아 둔다.
            const KEEP_ALIVE = '30m';

            // 사용자 메시지에만 "한글로 쓰라"고 적으면 모델이 힌트를 통째로 영어로 쓰는 일이 잦았다.
            // (동물 카테고리에서 "WOODLAND ANIMAL", "KING OF BEASTS" 처럼 6개 전부 영어로 나왔다)
            // 시스템 프롬프트에 절대 규칙으로 못박으니 눈에 띄게 줄었다.
            const SYSTEM_PROMPT =
                '당신은 한국어 스무고개 출제자입니다. 설명 없이 요청된 JSON 한 개만 출력합니다.\n' +
                '절대 규칙: 출력에 쓸 수 있는 문자는 한글과 숫자와 기본 문장부호뿐입니다. ' +
                '영어 알파벳(a-z, A-Z), 한자, 가나, 이모지를 단 한 글자도 쓰지 마십시오. ' +
                '영어 단어가 떠오르면 반드시 한글 뜻이나 한글 표기로 바꿔 쓰십시오.';

            // 힌트만 만들 때는 온도를 낮춘다. 온도가 높으면 모델이 영어로 새는 일이 많아지는데,
            // 이 경로는 정답을 사전에서 무작위로 고르므로 다양성을 온도에 기댈 이유가 없다.
            const HINT_TEMPERATURE = 0.3;

            function endpoint() {
                return StorageManager.getLlmEndpoint().replace(/\/+$/, '');
            }
            function modelName() {
                return StorageManager.getLlmModel();
            }

            // 진행 중인 요청을 모아 둔다. [연결 닫기] 는 이것부터 끊고 모델을 내린다.
            // 끊지 않고 내리면, 뒤늦게 끝난 요청이 keep_alive 30분으로 모델을 곧바로 다시 올려 버린다.
            // (실제로 확인: unload 직후 /api/ps 는 비어 있다가, 남아 있던 힌트 요청이 끝나면서 다시 채워졌다)
            const inflight = new Set();

            // [연결 닫기] 를 누른 뒤에는 새 요청을 내보내지 않는다.
            // 이 표시가 없으면 다음 라운드의 미리 받기(startPrefetch)가 모델을 곧장 다시 올린다.
            let closed = false;

            function fetchWithTimeout(url, options, timeoutMs) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                inflight.add(controller);
                return fetch(url, Object.assign({}, options, { signal: controller.signal }))
                    .finally(() => {
                        clearTimeout(timer);
                        inflight.delete(controller);
                    });
            }

            /**
             * 진행 중인 요청을 모두 끊고, 새 요청도 막는다.
             * @returns {number} 실제로 끊은 요청 수 (사용자에게 알려 주려고 돌려준다)
             */
            function abortAll() {
                closed = true;
                const pending = Array.from(inflight);
                inflight.clear();
                pending.forEach(c => { try { c.abort(); } catch (e) { /* 이미 끝난 요청 */ } });
                return pending.length;
            }

            /** [연결 확인] / [스무고개 시작] 으로 다시 연결할 때 잠금을 푼다. */
            function reopen() {
                closed = false;
            }

            /** 지금 모델이 정말 메모리에 올라가 있는지 확인한다. (/api/ps 가 올라가 있는 모델만 알려 준다) */
            async function isLoaded() {
                const res = await fetchWithTimeout(endpoint() + '/api/ps', { method: 'GET' }, PING_TIMEOUT);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const wanted = modelName();
                return ((data && data.models) || [])
                    .some(m => m.name === wanted || String(m.name).indexOf(wanted + ':') === 0);
            }

            // 설치된 모델 목록을 받아 연결 상태를 확인한다.
            async function ping() {
                const res = await fetchWithTimeout(endpoint() + '/api/tags', { method: 'GET' }, PING_TIMEOUT);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const names = ((data && data.models) || []).map(m => m.name);
                const wanted = modelName();
                const hasModel = names.some(n => n === wanted || n.indexOf(wanted + ':') === 0);
                return { names, hasModel };
            }

            // 예열은 모델당 한 번이면 된다. 모델 이름이 바뀌면 새로 예열한다.
            let warmedModel = null;

            /**
             * 모델을 미리 메모리에 올려 둔다.
             * Ollama 는 prompt 를 비워 보내면 생성 없이 로드만 하므로 예열에 딱 맞다.
             * 이걸 해 두지 않으면 첫 문제 요청이 콜드 로드에 걸려 REQUEST_TIMEOUT 을 넘긴다.
             */
            async function warmUp() {
                const model = modelName();
                if (warmedModel === model) return;
                warmedModel = model;
                try {
                    const res = await fetchWithTimeout(endpoint() + '/api/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: model, prompt: '', keep_alive: KEEP_ALIVE })
                    }, WARMUP_TIMEOUT);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    // 본문을 읽어 버려야 연결이 제때 정리된다. (스트리밍 응답이라 그냥 두면 열린 채 남는다)
                    await res.text().catch(() => '');
                } catch (e) {
                    warmedModel = null; // 실패했으면 다음에 다시 시도할 수 있게 되돌린다
                    throw e;
                }
            }

            /**
             * 모델을 메모리에서 내린다. keep_alive 를 0으로 주면 Ollama 가 곧바로 언로드한다.
             * 예열해 둔 것을 되돌리는 셈이라 warmedModel 도 함께 지운다.
             *
             * 주의: 이 요청 하나만으로는 부족하다. 다른 요청이 아직 돌고 있으면 그 요청이 끝나면서
             * 모델을 다시 올린다. 부르는 쪽에서 abortAll() 로 먼저 끊고, isLoaded() 로 확인해야 한다.
             */
            async function unload() {
                const model = modelName();
                warmedModel = null;
                const res = await fetchWithTimeout(endpoint() + '/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: model, prompt: '', keep_alive: 0 })
                }, UNLOAD_TIMEOUT);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                await res.text().catch(() => '');
            }

            // 한글·숫자만 쓰라는 규칙. 정답을 고를 때든 힌트만 만들 때든 똑같이 붙인다.
            const KOREAN_ONLY_RULES = [
                '★ 가장 중요한 규칙: 한글과 숫자만 쓰세요.',
                '  영어 알파벳, 한자, 일본어, 그 밖의 외국 문자를 한 글자라도 섞으면 안 됩니다.',
                '  예를 들어 "big cat", "FOOTBALL", "圆形" 같은 표기는 금지입니다.',
                '  외래어를 쓰려면 "빅캣", "풋볼" 처럼 한글로 적으세요.'
            ];

            /**
             * 정답이 이미 정해져 있을 때 쓰는 프롬프트.
             * 모델이 낱말을 지어내는 일이 없어지므로, 남은 일은 힌트를 쓰는 것뿐이다.
             */
            function buildHintPrompt(answer, category) {
                return [
                    `카테고리: "${category}"`,
                    `정답: "${answer}"`,
                    '',
                    `이 정답을 맞히기 위한 스무고개 힌트 ${QUIZ_LLM_HINT_REQUEST}개를 만드세요.`,
                    '   - 1번이 가장 막연하고, 뒤로 갈수록 구체적이어야 합니다.',
                    `   - 힌트에 "${answer}" 를 그대로 쓰면 안 됩니다.`,
                    '   - 각 힌트는 40자 이내의 한국어 한 문장입니다.',
                    '   - 사실만 쓰세요. 확실하지 않은 내용은 아예 빼세요.',
                    ''
                ].concat(KOREAN_ONLY_RULES).concat([
                    '',
                    '아래 형식의 JSON만 출력하세요.',
                    '{"hints":["힌트1","힌트2","힌트3"]}'
                ]).join('\n');
            }

            // 힌트만 받아 오는 응답을 검사한다. 걸러내고 남은 것이 모자라면 실패로 돌려 재요청한다.
            function parseHintsJson(content, answer) {
                const text = String(content || '');
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start === -1 || end <= start) return null;
                let parsed;
                try {
                    parsed = JSON.parse(text.slice(start, end + 1));
                } catch (e) {
                    return null;
                }
                const hints = QuizContent.cleanHints(Array.isArray(parsed.hints) ? parsed.hints : [], answer);
                return hints.length >= QUIZ_LLM_HINT_MIN ? hints : null;
            }

            // 정답을 이미 알려 준 상태로 힌트만 요청한다.
            async function requestHintsOnce(answer, category) {
                // [연결 닫기] 이후에는 부르지 않는다. 여기서 막지 않으면 다음 라운드의 미리 받기가
                // 모델을 다시 메모리에 올려, 방금 닫은 연결이 없던 일이 된다.
                if (closed) throw new Error('AI 연결을 닫아 두었습니다.');
                const res = await fetchWithTimeout(endpoint() + '/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelName(),
                        stream: false,
                        format: 'json',
                        keep_alive: KEEP_ALIVE,
                        // num_predict 로 출력 길이를 막아 둔다. 드물게 모델이 JSON 을 끝내지 못하고
                        // 토큰을 계속 뽑아내다 REQUEST_TIMEOUT 을 통째로 써 버리는 일이 있었다.
                        options: { temperature: HINT_TEMPERATURE, top_p: 0.95, num_predict: 400 },
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            { role: 'user', content: buildHintPrompt(answer, category) }
                        ]
                    })
                }, REQUEST_TIMEOUT);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                return parseHintsJson(data && data.message ? data.message.content : '', answer);
            }

            /** 정답이 정해진 상태에서 쓸 만한 힌트가 나올 때까지 몇 번 물어본다. */
            async function createHints(answer, category) {
                let lastError = null;
                for (let attempt = 0; attempt < QUIZ_LLM_MAX_ATTEMPTS; attempt++) {
                    let hints = null;
                    try {
                        hints = await requestHintsOnce(answer, category);
                    } catch (e) {
                        lastError = e;
                        if (e && e.name === 'AbortError') break;
                        continue;
                    }
                    if (hints) return hints;
                    lastError = new Error('쓸 만한 힌트를 받지 못했습니다.');
                }
                throw lastError || new Error('힌트 생성 실패');
            }

            /**
             * 카테고리 하나로 스무고개 문제를 만든다.
             *
             * **정답은 언제나 사전에서 고른다.** 모델에게는 힌트만 맡긴다.
             * 모델이 정답까지 고르면 제시어와 상관없는 낱말이 나와도 대조할 자료가 없어 걸러낼 수 없다.
             * 정답을 사전이 정해 주면 "제시어의 사전 안에 있는 낱말" 이라는 것이 구조적으로 보장된다.
             *
             * 사전에 없는 카테고리는 문제를 만들지 않고 `unknownCategory` 예외를 던진다.
             * 호출부가 이 표시를 보고 사용자에게 다른 카테고리를 받는다.
             * @returns {Promise<{answer:string, hints:string[], category:string}>}
             */
            async function createQuiz(category) {
                const builtin = QuizContent.matchBuiltinCategory(category);
                const answer = builtin ? QuizContent.pickAnswer(builtin) : null;
                if (!answer) {
                    const err = new Error('사전에 없는 카테고리입니다: ' + category);
                    err.unknownCategory = true;
                    throw err;
                }
                // 힌트를 못 받으면 예외를 그대로 올린다. 호출부가 사전 힌트로 대체한다.
                const hints = await createHints(answer, builtin);
                return { answer, hints: QuizContent.assemble(answer, hints), category: builtin };
            }

            return {
                ping,
                warmUp,
                unload,
                createQuiz,
                abortAll,
                reopen,
                isLoaded,
                get closed() { return closed; },
                get model() { return modelName(); },
                get endpoint() { return endpoint(); }
            };
        })();

        /* ---------- AI 제공자 분기 (시험 구현) ----------
           서버가 AI_PROVIDER 로 고른 것을 그대로 따른다. 'ollama'(기본값이자 지금까지의 동작)면
           브라우저가 지금까지처럼 Ollama(LlamaClient)를 직접 부른다 — 이 블록은 LlamaClient를
           한 글자도 바꾸지 않는다. 서버가 'gemini' 라고 답할 때만 /api/ai/* 를 거친다
           (브라우저가 Gemini를 직접 호출하는 일은 없다). */
        const AiQuiz = (function () {
            let cachedProvider = 'ollama';

            // /api/ai/status 자체가 없으면(정적 서버로만 열었을 때 등) Ollama 취급한다 —
            // 지금까지 항상 그래 왔던 경로이므로 조용히 그대로 두는 것이 안전하다.
            async function status() {
                try {
                    const res = await fetch('/api/ai/status');
                    const data = res.ok ? await res.json() : null;
                    cachedProvider = (data && data.provider === 'gemini') ? 'gemini' : 'ollama';
                    return data || { provider: 'ollama', ok: false, reason: null };
                } catch (e) {
                    cachedProvider = 'ollama';
                    return { provider: 'ollama', ok: false, reason: null };
                }
            }

            function provider() {
                return cachedProvider;
            }

            /** 정답은 여기서도 항상 사전에서 고른다 — LlamaClient.createQuiz와 같은 이유. */
            async function createQuizViaGemini(category) {
                const builtin = QuizContent.matchBuiltinCategory(category);
                const answer = builtin ? QuizContent.pickAnswer(builtin) : null;
                if (!answer) {
                    const err = new Error('사전에 없는 카테고리입니다: ' + category);
                    err.unknownCategory = true;
                    throw err;
                }
                const res = await fetch('/api/ai/hints', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ category: builtin, answer: answer })
                });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data || !data.ok || !Array.isArray(data.hints)) {
                    throw new Error((data && data.reason) || 'Gemini 힌트를 받지 못했습니다.');
                }
                return { answer, hints: QuizContent.assemble(answer, data.hints), category: builtin };
            }

            /** 호출부는 이 함수 하나만 쓰면 된다. provider가 'gemini'가 아니면 기존 경로 그대로다. */
            async function createQuiz(category) {
                if (cachedProvider === 'gemini') return createQuizViaGemini(category);
                return LlamaClient.createQuiz(category);
            }

            return { status, provider, createQuiz };
        })();

        /* ---------- 힌트 패널 렌더링 (DOM 전담) ---------- */
        const QuizPanelUI = (function () {
            const listEl = dom('hintList');
            const nextEl = dom('hintNext');
            const footEl = dom('hintFoot');
            const titleEl = dom('hintTitle');

            function setVisible(on) {
                boardContainer.classList.toggle('quiz-mode', !!on);
            }

            function showMessage(text) {
                listEl.innerHTML = '';
                listEl.appendChild(makeEl('div', 'hint-empty', text));
            }

            function reset() {
                showMessage(`카테고리를 입력하면 AI가 문제를 내고, 10초마다 힌트를 하나씩 (최대 ${QUIZ_HINT_TOTAL}개) 열어 줍니다.`);
                nextEl.textContent = '대기중';
                footEl.textContent = '힌트를 적게 볼수록 점수가 높아요';
            }

            // 몇 번째 라운드인지 패널 제목에 표시한다. round가 0이면 라운드 표시를 지운다.
            function setRound(round, total) {
                titleEl.textContent = round > 0 ? `🤖 힌트 맞히기 ${round}/${total}` : '🤖 AI 힌트 맞히기';
            }

            // 지금까지 열린 힌트만 그린다. 마지막 항목에 등장 애니메이션을 준다.
            function render(hints, animateLast) {
                listEl.innerHTML = '';
                if (!hints.length) {
                    showMessage('첫 힌트를 준비하고 있어요…');
                    return;
                }
                hints.forEach((text, index) => {
                    const row = makeEl('div', 'hint-item' + (animateLast && index === hints.length - 1 ? ' fresh' : ''));
                    row.appendChild(makeEl('span', 'hint-no', `${index + 1}.`));
                    row.appendChild(makeEl('span', null, text));
                    listEl.appendChild(row);
                });
                listEl.scrollTop = listEl.scrollHeight;
            }

            // 남은 힌트가 없으면 -1을 넘긴다.
            // 모드 3처럼 다른 문구를 그대로 쓰고 싶으면 문자열을 넘긴다.
            function updateNext(seconds) {
                if (typeof seconds === 'string') {
                    nextEl.textContent = seconds;
                    return;
                }
                nextEl.textContent = seconds < 0 ? '힌트 끝' : `다음 힌트 ${seconds}초`;
            }

            function setFoot(text) {
                footEl.textContent = text;
            }

            // 판이 끝났을 때 정답을 패널 맨 아래에 붙인다.
            function appendAnswer(answer) {
                const row = makeEl('div', 'hint-item answer');
                row.appendChild(makeEl('span', 'hint-no', '정답'));
                row.appendChild(makeEl('span', null, answer));
                listEl.appendChild(row);
                listEl.scrollTop = listEl.scrollHeight;
            }

            // 모드 3은 라운드 표기가 달라서 제목을 직접 적는다.
            function setTitle(text) {
                titleEl.textContent = text;
            }

            return { setVisible, reset, render, updateNext, setFoot, appendAnswer, showMessage, setRound, setTitle };
        })();

        /* ---------- 모드 2 세션: '스무고개를 몇 번 진행할지'와 라운드별 기록 ---------- */
        const QuizSession = {
            active: false,
            totalRounds: 0,
            round: 0,        // 진행 중인 라운드 번호 (1부터)
            category: '',    // 세션 시작 때 한 번 정하고, 모든 라운드가 이 카테고리를 쓴다
            prefetch: null,          // 다음 라운드 문제를 미리 받아 두는 Promise
            prefetchCategory: '',    // 그 Promise 를 어떤 카테고리로 만들었는지
            totalScore: 0,
            history: [],     // [{ round, category, answer, score, cleared, hintsUsed }]

            start(rounds) {
                this.active = true;
                this.totalRounds = rounds;
                this.round = 1;
                this.category = '';
                // 스무고개는 세션 전체가 한 게임이다. 라운드가 넘어가도 횟수는 이어진다.
                GameState.resetShuffles();
                this.clearPrefetch();
                this.totalScore = 0;
                this.history = [];
            },

            // 한 라운드가 끝났을 때 결과를 쌓는다. 누적 점수도 여기서 갱신된다.
            record(entry) {
                this.history.push(entry);
                this.totalScore += entry.score;
            },

            next() {
                this.round++;
            },

            /**
             * 다음 라운드 문제를 미리 만들어 둔다.
             * 카테고리가 세션 내내 같아졌기 때문에(022) 가능한 방법이다.
             * 사용자가 이번 판을 푸는 동안 만들어 두면 다음 판은 기다림 없이 시작된다.
             */
            startPrefetch() {
                if (!this.active || !this.category) return;
                if (this.round >= this.totalRounds) return; // 마지막 판이면 미리 받을 것이 없다
                if (this.prefetch) return;
                this.prefetchCategory = this.category;
                // 실패는 여기서 삼킨다. 쓸 때가 되면 그 자리에서 다시 요청한다.
                this.prefetch = AiQuiz.createQuiz(this.category).catch(() => null);
            },

            // 미리 받아 둔 문제를 꺼낸다. 카테고리가 다르면 쓰지 않는다.
            takePrefetch(category) {
                if (!this.prefetch || this.prefetchCategory !== category) return null;
                const pending = this.prefetch;
                this.clearPrefetch();
                return pending;
            },

            clearPrefetch() {
                this.prefetch = null;
                this.prefetchCategory = '';
            },

            /**
             * 정해진 횟수를 다 채웠을 때 세션을 닫는다.
             * 최종 결과 화면이 history 와 누적 점수를 그대로 써야 하므로 reset() 과 달리 기록은 남긴다.
             * 여기서 active 를 내려야 라운드를 더 시작할 수 없다.
             */
            finish() {
                this.active = false;
                this.clearPrefetch(); // 세션이 끝났으면 미리 받아 둔 문제도 버린다
            },

            reset() {
                this.active = false;
                this.totalRounds = 0;
                this.round = 0;
                this.category = '';
                this.clearPrefetch();
                this.totalScore = 0;
                this.history = [];
            }
        };

        /* ---------- 모드 2 한 라운드의 진행 상태 ---------- */
        const QuizManager = {
            active: false,
            category: '',   // 사용자가 입력한 카테고리
            answer: '',     // AI가 고른 정답 낱말
            hints: [],
            shown: 0,       // 지금까지 열린 힌트 수
            nextIn: 0,      // 다음 힌트까지 남은 초
            source: 'llm',  // 'llm' = AI가 만든 힌트, 'offline' = 내장 사전

            load(category, quiz, source) {
                this.active = true;
                this.category = category;
                this.answer = quiz.answer;
                this.hints = quiz.hints.slice();
                this.shown = 0;
                this.nextIn = 0;
                this.source = source;
            },

            reset() {
                this.active = false;
                this.category = '';
                this.answer = '';
                this.hints = [];
                this.shown = 0;
                this.nextIn = 0;
            },

            isAnswer(word) {
                return this.active && !!this.answer && word === this.answer;
            },

            // 힌트를 적게 볼수록 높은 점수. 첫 힌트만 보고 맞히면 만점.
            points() {
                const used = Math.max(1, this.shown);
                return Math.max(1, this.hints.length + 1 - used);
            },

            revealNext() {
                if (this.shown >= this.hints.length) return false;
                this.shown++;
                QuizPanelUI.render(this.hints.slice(0, this.shown), true);
                QuizPanelUI.setFoot(`지금 맞히면 ${this.points()}점 · 남은 힌트 ${this.hints.length - this.shown}개`);
                AudioManager.playHint();
                return true;
            },

            // 1초마다 타이머에서 호출된다. 10초가 지나면 힌트를 하나 연다.
            tick() {
                if (!this.active) return;
                if (this.nextIn > 0) this.nextIn--;
                if (this.nextIn <= 0) {
                    if (this.revealNext()) {
                        this.nextIn = QUIZ_HINT_INTERVAL;
                    } else {
                        QuizPanelUI.setFoot('힌트가 모두 나왔어요! 시간이 끝나기 전에 맞혀보세요.');
                    }
                }
                QuizPanelUI.updateNext(this.shown >= this.hints.length ? -1 : this.nextIn);
            },

            // 판이 끝나면 힌트를 멈추고 정답을 공개한다.
            finish() {
                if (!this.answer) return;
                QuizPanelUI.render(this.hints.slice(0, Math.max(this.shown, 1)), false);
                QuizPanelUI.appendAnswer(this.answer);
                QuizPanelUI.updateNext(-1);
                // 정답을 사전에서 고르는 경우가 생겨서, 두 경우 모두 맞는 말로 바꿨다.
                QuizPanelUI.setFoot(this.source === 'llm'
                    ? 'AI가 힌트를 만든 문제였어요'
                    : 'AI에 연결하지 못해 내장 사전으로 낸 문제였어요');
                this.active = false;
            }
        };

        /* =========================================================
           모드 3 — 산업재산권 문제
           quiz-data/산업재산권_문제.txt 에 적힌 문제를 처음부터 끝까지 낸다.
           한 문제당 10초, 시간이 지나면 정답을 보여주고 다음 문제로 넘어간다.
           맞히는 방법은 모드 2와 같다 — 보드의 글자 블록을 눌러 정답을 만든다.
        ========================================================= */

        // 문제 파일 위치. 이 폴더만 옮기면 되도록 한 곳에 모아 둔다.
        const EXAM_FILE = 'quiz-data/산업재산권_문제.txt';
        /* 모드 3 설정의 기본값과 허용 범위.
           **모드 1과 값을 나눠 쓴다.** 한 문제를 10초 안에 푸는 모드와 여러 단어를 찾는 모드는
           알맞은 블록 개수가 서로 달라서, 한쪽 설정을 다른 쪽에 그대로 쓰면 게임이 이상해진다. */
        const EXAM_DEFAULT_TIME = 10;    // 한 문제에 주는 시간(초)
        const EXAM_DEFAULT_BLOCKS = 12;  // 보드에 깔 블록 개수
        const EXAM_TIME_MIN = 5, EXAM_TIME_MAX = 120;
        const EXAM_BLOCKS_MIN = 4, EXAM_BLOCKS_MAX = 36;
        // 설정값이 정답 글자를 다 담지 못하면 이만큼 여유를 두고 자동으로 늘린다.
        const EXAM_MIN_SPARE_BLOCKS = 2;

        function examTimeLimit() { return StorageManager.getExamTime(); }

        /**
         * 문제 파일을 읽어 문제 목록으로 만든다.
         *
         * 파일 형식은 사람이 손으로 적기 좋게 두 줄이 한 쌍이다.
         *     문제: 〜무엇이라고 하나요?
         *     답 : 특허
         * '답' 뒤의 콜론 앞뒤 공백이 들쭉날쭉하고, 정답이 여러 개인 문제는 쉼표로 나뉜다.
         * 파일을 고치는 사람이 형식을 정확히 맞추지 않아도 되도록 여기서 너그럽게 읽는다.
         */
        const ExamBank = {
            questions: [],
            loaded: false,
            loading: null,
            error: '',

            parse(text) {
                const list = [];
                let current = null;
                // 메모장이 UTF-8 로 저장하면 파일 맨 앞에 BOM 이 붙는다. 그대로 두면 첫 줄이
                // '문제:' 로 시작하지 않는 것으로 보여 첫 문제를 통째로 놓친다.
                // \r\n / \n 어느 쪽으로 저장돼도 되게 한다.
                text.replace(/^﻿/, '').split(/\r?\n/).forEach((rawLine) => {
                    const line = rawLine.trim();
                    if (!line) return;
                    const questionMatch = line.match(/^문제\s*[:：]\s*(.+)$/);
                    if (questionMatch) {
                        current = { question: questionMatch[1].trim(), answers: [] };
                        return;
                    }
                    const answerMatch = line.match(/^답\s*[:：]\s*(.+)$/);
                    if (answerMatch && current) {
                        current.answers = answerMatch[1]
                            .split(',')
                            // 블록으로 만들 글자라서 가운데 공백도 함께 지운다 ('신 지식' -> '신지식')
                            .map(part => part.replace(/\s+/g, ''))
                            .filter(Boolean);
                        if (current.answers.length) list.push(current);
                        current = null;
                    }
                });
                return list;
            },

            /**
             * 실제로 낼 문제 = **파일에 있는 문제 + 사용자가 파일로 더 넣은 문제**.
             * 기본 문제 파일은 그대로 두고, 추가분만 브라우저에 쌓아 둔다.
             */
            all() {
                return this.questions.concat(StorageManager.getExamExtras());
            },

            /** 같은 문제인지 판단하는 기준. 공백 차이만 있는 문장은 같은 문제로 본다. */
            keyOf(item) {
                return item.question.replace(/\s+/g, '');
            },

            /**
             * 파일에서 읽은 문제들을 '추가 문제'로 넣는다.
             * 내려받은 파일을 고쳐서 다시 올리면 기본 문제가 통째로 딸려 오므로,
             * **이미 있는 문제는 건너뛴다.** 그러지 않으면 같은 문제가 두 번씩 나온다.
             * @returns {{added:number, skipped:number}}
             */
            addQuestions(list) {
                const extras = StorageManager.getExamExtras();
                const seen = new Set(this.questions.concat(extras).map(item => this.keyOf(item)));
                let added = 0, skipped = 0;
                list.forEach((item) => {
                    const key = this.keyOf(item);
                    if (seen.has(key)) { skipped++; return; }
                    seen.add(key);
                    extras.push({ question: item.question, answers: item.answers.slice() });
                    added++;
                });
                if (added > 0) StorageManager.setExamExtras(extras);
                return { added, skipped };
            },

            /** 추가한 문제를 하나 지운다. 기본 문제는 지울 수 없다(파일을 고쳐야 한다). */
            removeExtra(index) {
                const extras = StorageManager.getExamExtras();
                if (index < 0 || index >= extras.length) return;
                extras.splice(index, 1);
                StorageManager.setExamExtras(extras);
            },

            /** 지금 낼 문제 전부를 문제 파일 형식의 글로 만든다 (내려받기용). */
            toText() {
                return this.all()
                    .map(item => `문제: ${item.question}\n답: ${item.answers.join(', ')}`)
                    .join('\n\n') + '\n';
            },

            /** 파일을 한 번만 읽고 결과를 기억한다. 여러 번 불러도 요청은 한 번이다. */
            load() {
                if (this.loaded) return Promise.resolve(this.questions);
                if (this.loading) return this.loading;
                this.loading = fetch(EXAM_FILE, { cache: 'no-store' })
                    .then((res) => {
                        if (!res.ok) throw new Error(`${res.status}`);
                        return res.text();
                    })
                    .then((text) => {
                        const parsed = this.parse(text);
                        if (!parsed.length) throw new Error('EMPTY');
                        this.questions = parsed;
                        this.loaded = true;
                        this.error = '';
                        return parsed;
                    })
                    .catch((err) => {
                        // 파일을 두 번 눌러 연 경우(file://)에는 브라우저가 파일 읽기를 막는다.
                        // 왜 안 되는지 화면에 그대로 알려 주려고 사유를 나눠 둔다.
                        this.error = (location.protocol === 'file:')
                            ? 'file'
                            : (err && err.message === 'EMPTY' ? 'empty' : 'network');
                        this.loading = null;
                        throw err;
                    });
                return this.loading;
            }
        };

        /* ---------- 모드 3 한 문제의 진행 상태 (모드 2의 QuizManager 와 같은 자리) ---------- */
        const ExamManager = {
            active: false,
            question: '',
            answers: [],    // 정답이 여러 개인 문제가 있어서 배열이다
            solved: '',     // 실제로 맞힌 정답

            load(item) {
                this.active = true;
                this.question = item.question;
                this.answers = item.answers.slice();
                this.solved = '';
            },

            reset() {
                this.active = false;
                this.question = '';
                this.answers = [];
                this.solved = '';
            },

            /**
             * 정답이 여러 개인 문제는 **그중 하나만 만들어도 맞은 것으로 본다.**
             * 10초 안에 블록으로 여러 낱말을 잇달아 만드는 것은 사실상 불가능하기 때문이다.
             * 결과 화면에서는 정답을 전부 보여 준다.
             */
            isAnswer(word) {
                return this.active && this.answers.indexOf(word) !== -1;
            },

            // 남은 시간이 곧 점수다. 빨리 맞힐수록 높다 (최소 1점).
            points() {
                return Math.max(1, GameState.timeLeft);
            },

            answerText() {
                return this.answers.join(', ');
            },

            // 판이 끝나면 패널 맨 아래에 정답을 붙인다.
            finish() {
                if (!this.answers.length) return;
                QuizPanelUI.appendAnswer(this.answerText());
                QuizPanelUI.updateNext(-1);
                QuizPanelUI.setFoot(this.solved
                    ? `맞혔어요 — ${this.solved}`
                    : '시간이 다 됐어요. 정답을 확인하세요.');
                this.active = false;
            }
        };

        /* ---------- 모드 3 세션: 파일에 있는 문제를 처음부터 끝까지 ---------- */
        const ExamSession = {
            active: false,
            order: [],       // 이번 세션에서 낼 문제 목록 (파일에 적힌 순서 그대로)
            round: 0,        // 진행 중인 문제 번호 (1부터)
            totalScore: 0,
            history: [],     // [{ round, question, answers, solved, score, cleared }]

            start(questions) {
                this.active = true;
                this.order = questions.slice();
                this.round = 1;
                this.totalScore = 0;
                this.history = [];
            },

            get totalRounds() {
                return this.order.length;
            },

            currentQuestion() {
                return this.order[this.round - 1] || null;
            },

            record(entry) {
                this.history.push(entry);
                this.totalScore += entry.score;
            },

            next() {
                this.round++;
            },

            finish() {
                this.active = false;
            },

            reset() {
                this.active = false;
                this.order = [];
                this.round = 0;
                this.totalScore = 0;
                this.history = [];
            }
        };

        /* =========================================================
           5. Controller Layer
           Design Ref: §9 — 모든 모듈을 오케스트레이션하는 유일한 계층
           기존 onclick 핸들러(startGame/stopGame/resetBoard/openSettings/closeSettings)와
           동일한 함수명을 유지해 마크업 수정을 최소화함
        ========================================================= */

        function openSettings() { ModalManager.openSettings(); }

        function closeSettings() {
            // 닉네임은 설정을 닫을 때 확정 저장한다.
            const nicknameInput = dom('nickname');
            StorageManager.setNickname((nicknameInput.value || '').trim());

            // 모드 2 설정도 여기서 확정한다. [스무고개 시작]은 저장된 값만 읽는다.
            saveLlmSettingsFromForm();
            const rounds = parseInt(dom('quizRoundsInput').value, 10);
            if (Number.isFinite(rounds) && rounds >= 1 && rounds <= QUIZ_MAX_ROUNDS) {
                StorageManager.setQuizRounds(rounds);
            } else {
                // 잘못된 값을 저장하면 다음에 게임이 시작되지 않는다. 이전 값을 지킨다.
                UIManager.showToast(
                    `스무고개 횟수는 1~${QUIZ_MAX_ROUNDS}회 사이여야 해요. 이전 값(${StorageManager.getQuizRounds()}회)을 그대로 씁니다.`,
                    'warn');
            }

            // 모드 1·2·3의 블록 개수와 시간. 셋 다 각자의 칸이라 서로 영향을 주지 않는다.
            saveNumberSetting(dom('blockCount'), CLASSIC_BLOCKS_MIN, CLASSIC_BLOCKS_MAX,
                StorageManager.getBlockCount(), '모드 1', '블록 개수', '개',
                (v) => StorageManager.setBlockCount(v));
            StorageManager.setCategoryOption(dom('categorySelect').value);
            saveNumberSetting(dom('quizBlockCount'), QUIZ_BLOCKS_MIN, QUIZ_BLOCKS_MAX,
                StorageManager.getQuizBlocks(), '모드 2', '블록 개수', '개',
                (v) => StorageManager.setQuizBlocks(v));
            saveNumberSetting(dom('examBlockCount'), EXAM_BLOCKS_MIN, EXAM_BLOCKS_MAX,
                StorageManager.getExamBlocks(), '모드 3', '블록 개수', '개',
                (v) => StorageManager.setExamBlocks(v));
            saveNumberSetting(dom('examTimeInput'), EXAM_TIME_MIN, EXAM_TIME_MAX,
                StorageManager.getExamTime(), '모드 3', '한 문제 시간', '초',
                (v) => StorageManager.setExamTime(v));

            // 모드 3 화면에 시간이 적혀 있으므로, 설정을 바꾸면 바로 반영한다.
            if (appMode === 'exam' && !ExamSession.active) resetExamPanel();
            UIManager.syncHud();

            ModalManager.closeSettings();
        }

        /**
         * 모드별 숫자 설정 한 칸을 저장한다.
         * 잘못된 값을 저장하면 다음 판이 이상해지므로, 범위를 벗어나면 이전 값을 지키고 알려 준다.
         */
        function saveNumberSetting(input, min, max, previous, modeLabel, label, unit, save) {
            const value = parseInt(input.value, 10);
            if (Number.isFinite(value) && value >= min && value <= max) {
                save(value);
                return;
            }
            input.value = previous;
            UIManager.showToast(
                `${modeLabel} ${label}는 ${min}~${max}${unit} 사이여야 해요. 이전 값(${previous}${unit})을 그대로 씁니다.`,
                'warn');
        }

        function toggleMute() {
            const muted = AudioManager.toggleMute();
            const btn = dom('settingsMuteBtn');
            if (btn) btn.textContent = muted ? '🔇 소리 켜기' : '🔊 소리 끄기';
        }

        function currentNickname() {
            const value = (dom('nickname').value || '').trim();
            return value || StorageManager.getNickname() || '게스트';
        }

        let timerInterval = null;

        /**
         * 1초짜리 공용 카운트다운. 모드 1과 모드 2가 같은 타이머를 쓴다.
         * 모드 2에서는 매 초 QuizManager.tick()이 다음 힌트를 열 시점을 계산한다.
         */
        function startCountdown() {
            clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                GameState.timeLeft--;
                UIManager.updateTimerDisplay();
                if (GameState.mode === 'quiz') {
                    QuizManager.tick();
                }
                // 모드 3은 힌트가 없고 남은 시간만 보여 준다.
                if (GameState.mode === 'exam') {
                    QuizPanelUI.updateNext(`${Math.max(0, GameState.timeLeft)}초 남음`);
                }
                if (GameState.timeLeft <= 0) {
                    endGameByTimeOut();
                }
            }, 1000);
        }

        /**
         * 한 판을 실제로 시작한다. 1인 플레이와 대결 모드가 공유하는 진입점.
         * @param {{forceCategory?: string}} options 대결 2번째 차례에서 제시어를 고정할 때 사용
         * @returns {boolean} 설정 검증에 실패하면 false
         */
        function beginPlay(options) {
            options = options || {};
            // 단어 데이터 로딩이 아직 끝나지 않았으면(또는 실패했으면) 빈 사전으로 시작하지 않는다.
            if (!dictionaryReady) {
                UIManager.showToast("단어 데이터를 불러오는 중입니다. 잠시 후 다시 시도해주세요.", "warn");
                return false;
            }
            clearInterval(timerInterval);
            ModalManager.closeSettings();
            ModalManager.hideGameOver();
            AudioManager.ensureContext();

            GameState.currentBlockCount = parseInt(dom('blockCount').value, 10);
            GameState.selectedCategoryOption = dom('categorySelect').value;

            if (!Number.isFinite(GameState.currentBlockCount) || GameState.currentBlockCount < CLASSIC_BLOCKS_MIN) {
                UIManager.showToast("블록 개수는 4개 이상으로 정해주세요.", "warn");
                return false;
            }

            // 실제로 판을 연 값을 기억해 둔다. 설정 창을 [완료] 로 닫지 않고 시작해도
            // 다음에 화면을 열었을 때 같은 값으로 시작할 수 있다.
            // 숫자 칸에는 36을 넘겨 적을 수도 있는데(그런 판도 그대로 돌아간다), 기억은
            // 설정 화면이 다룰 수 있는 범위 안으로 맞춰 둔다. 그러지 않으면 다음에 설정을 닫을 때
            // '범위를 벗어났다'는 안내가 계속 뜬다.
            StorageManager.setBlockCount(Math.min(CLASSIC_BLOCKS_MAX,
                Math.max(CLASSIC_BLOCKS_MIN, GameState.currentBlockCount)));
            StorageManager.setCategoryOption(GameState.selectedCategoryOption);

            // 글자 수 제한이 없으므로, 두 단어가 블록 안에 들어가는 카테고리인지만 확인한다.
            const validCategories = Dictionary.getValidCategories(GameState.currentBlockCount);
            if (validCategories.length === 0) {
                UIManager.showToast("블록 개수가 너무 적어 단어 2개를 넣을 수 없습니다. 블록 개수를 늘려주세요.", "warn");
                return false;
            }

            if (options.forceCategory && validCategories.includes(options.forceCategory)) {
                GameState.currentCategory = options.forceCategory;
            } else if (GameState.selectedCategoryOption === "random") {
                GameState.currentCategory = validCategories[Math.floor(Math.random() * validCategories.length)];
            } else if (validCategories.includes(GameState.selectedCategoryOption)) {
                GameState.currentCategory = GameState.selectedCategoryOption;
            } else {
                UIManager.showToast("선택한 카테고리의 단어가 지금 블록 개수에 들어가지 않습니다. 블록 개수를 늘리거나 '랜덤'을 선택해주세요.", "warn");
                return false;
            }

            GameState.duration = GAME_DURATION;
            GameState.resetForNewGame();
            GameState.resetShuffles();   // 모드 1 은 한 판이 한 게임이다
            GameState.highScore = StorageManager.getHighScore();

            UIManager.syncHud();
            AudioManager.playStart();

            startCountdown();
            generateNewRound();
            return true;
        }

        // '게임 시작' 버튼. 고른 모드에 따라 갈라진다.
        function startGame() {
            if (appMode === 'quiz') {
                openQuizSetup();
                return;
            }
            if (appMode === 'exam') {
                startExamSession();
                return;
            }
            if (VersusManager.active) {
                cancelVersusMatch({ silent: true });
            }
            GameState.mode = 'solo';
            beginPlay();
        }

        /* =========================================================
           시작 화면 — 혼자 / 멀티플레이 고르기
           게임에 들어가기 전 첫 화면이다. 혼자 하기는 이 파일 안에서 그대로 이어지고,
           멀티플레이는 별도 서버(server/, Express + Socket.IO)가 그리는 화면으로 넘어간다.
        ========================================================= */

        /** 시작 화면을 띄운다. 멀티플레이 칸은 접은 상태로 되돌린다. */
        function showStartScreen() {
            dom('startMultiPanel').classList.remove('show');
            dom('startOverlay').classList.add('show');
        }

        /** 혼자 하기 — 시작 화면만 걷어내면 지금까지의 게임 화면이 그대로 나온다. */
        function chooseSolo() {
            dom('startOverlay').classList.remove('show');
            UIManager.showToast("혼자 하기를 골랐어요. '게임 시작'을 눌러 시작하세요!", 'info');
        }

        /** 멀티플레이 — 접속 칸을 펼치고, 서버가 켜져 있는지 미리 확인해 알려 준다. */
        function chooseMultiplayer() {
            const panel = dom('startMultiPanel');
            panel.classList.add('show');
            const input = dom('multiplayerUrlInput');
            input.value = StorageManager.getMultiplayerUrl();
            // 이 화면이 서버를 통해 열렸다면 서버는 이미 켜져 있다. '서버 켜는 방법' 을 보여 주면
            // 인터넷에 올린 주소로 들어온 사람이 [서버 켜기.bat] 을 찾아 헤매게 된다.
            const servedByServer = location.protocol === 'http:' || location.protocol === 'https:';
            dom('startServerGuide').style.display = servedByServer ? 'none' : '';
            if (servedByServer) {
                dom('startMultiPanel').querySelector('.panel-sub').textContent =
                    '이 게임을 열어 준 서버로 그대로 들어갑니다. [접속하기] 를 누르세요.'
                    + ' 다른 PC가 서버라면 그 주소를 적어주세요.';
            }
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            probeMultiplayerServer(input.value);
        }

        function setMultiplayerStatus(message, kind) {
            const el = dom('multiplayerStatus');
            el.className = 'start-server-status' + (kind ? ' ' + kind : '');
            el.textContent = message;
        }

        /**
         * 멀티플레이 서버가 떠 있는지 확인한다.
         *
         * 이 페이지와 서버는 출처(origin)가 달라서 응답 내용을 읽을 수 없다. 그래서 `no-cors` 로
         * 보내고 **요청이 실패했는지 아닌지만** 본다. 서버가 꺼져 있으면 연결 자체가 안 돼 예외가 난다.
         *
         * 어디까지나 미리 알려 주는 용도다. 확인에 실패해도 [접속하기]는 막지 않는다.
         * 브라우저 정책 때문에 확인만 막히는 경우가 있어서, 여기서 길을 막으면 접속할 수 있는데도
         * 못 들어가는 일이 생긴다.
         */
        async function probeMultiplayerServer(url) {
            const target = (url || '').trim().replace(/\/+$/, '');
            if (!target) {
                setMultiplayerStatus('서버 주소를 입력해주세요.', 'warn');
                return;
            }
            setMultiplayerStatus('🔌 서버 상태를 확인하는 중…', '');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 4000);
            // 주소가 'http://<IP>/multi' 처럼 경로를 달고 오므로 그냥 이어 붙이면 '/multi/healthz' 가 된다.
            // 서버 뿌리의 /healthz 를 보도록 주소를 다시 조립한다.
            let healthUrl;
            try {
                healthUrl = new URL('/healthz', target).href;
            } catch (e) {
                healthUrl = target + '/healthz';
            }
            try {
                await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
                setMultiplayerStatus('✅ 서버가 켜져 있어요. [접속하기]를 누르면 이동합니다.', 'ok');
            } catch (e) {
                setMultiplayerStatus(
                    '⚠ 서버 응답이 없어요. 아래 방법으로 서버를 켠 뒤 다시 눌러주세요. (그래도 [접속하기]로 시도해 볼 수 있어요)', 'warn');
            } finally {
                clearTimeout(timer);
            }
        }

        /** 입력한 주소의 멀티플레이 서버로 이동한다. */
        function goMultiplayer() {
            const raw = dom('multiplayerUrlInput').value.trim();
            if (!raw) {
                setMultiplayerStatus('서버 주소를 입력해주세요.', 'warn');
                return;
            }
            // 'localhost:3000' 처럼 앞을 빼먹고 적어도 되게 저장 쪽에서 주소를 채워 준다.
            StorageManager.setMultiplayerUrl(raw);
            const url = StorageManager.getMultiplayerUrl();
            setMultiplayerStatus('🚪 멀티플레이 화면으로 이동합니다…', '');
            // 시작 화면에서 왔다는 표시를 남긴다. 멀티플레이 쪽은 이 표시를 보고
            // [← 처음 화면] 버튼을 띄운다. (이 페이지는 파일로 열려 있을 수 있어서
            //  저쪽에서 돌아올 주소를 만들 수 없고, 뒤로 가기로만 돌아올 수 있다)
            window.location.href = url + (url.indexOf('?') === -1 ? '?' : '&') + 'from=start';
        }

        /** 게임 도중에 처음 화면으로 돌아간다. 진행 중이던 판은 정리하고 연다. */
        function backToStartScreen() {
            if (VersusManager.active) cancelVersusMatch({ silent: true });
            // 열려 있던 모달이 시작 화면 뒤에 남아 있으면, 혼자 하기를 고른 순간 되살아난다.
            ModalManager.hideGameOver();
            clearInterval(timerInterval);
            QuizManager.reset();
            QuizSession.reset();
            closeQuizCategory();
            hideQuizRoundResult();
            hideQuizFinal();
            GameState.mode = 'solo';
            GameState.score = 0;
            GameState.resetForGameEnd();
            UIManager.clearBoard();
            UIManager.syncHud();
            if (appMode === 'quiz') {
                updateQuizRoundDisplay();
                QuizPanelUI.reset();
            }
            if (appMode === 'exam') {
                ExamManager.reset();
                ExamSession.reset();
                hideExamRoundResult();
                Overlay.close('examFinalOverlay');
                updateExamRoundDisplay();
                resetExamPanel();
            }
            showStartScreen();
        }

        /* ---------- 모드 전환 (모드 1: 제시어 맞추기 / 모드 2: AI 스무고개) ---------- */

        /**
         * 모드 버튼을 눌렀을 때. 진행 중이던 판은 정리하고 화면을 새 모드에 맞춘다.
         * @param {'classic'|'quiz'} mode
         */
        function selectMode(mode) {
            const next = (mode === 'quiz' || mode === 'exam') ? mode : 'classic';
            if (next === appMode) return;

            if (VersusManager.active) {
                cancelVersusMatch({ silent: true });
            }
            clearInterval(timerInterval);
            QuizManager.reset();
            QuizSession.reset();
            ExamManager.reset();
            ExamSession.reset();
            closeQuizCategory();
            hideQuizRoundResult();
            hideQuizFinal();
            hideExamRoundResult();
            Overlay.close('examFinalOverlay');
            GameState.mode = 'solo';
            GameState.duration = GAME_DURATION;
            GameState.score = 0;
            GameState.resetForGameEnd();
            board.innerHTML = "";
            UIManager.clearCanvas();

            appMode = next;
            applyModeUI();

            // 세 모드는 점수 폭이 달라서 최고 기록도 따로 관리한다.
            GameState.highScore = StorageManager.getHighScore(next);
            UIManager.syncHud();
            // 랭킹도 모드별이라 상단 챔피언 배너를 새 모드 기준으로 다시 그린다.
            UIManager.updateChampionBanner();

            const MODE_TOAST = {
                quiz: "🤖 모드 2 — AI 힌트 맞히기! '스무고개 시작'을 눌러 카테고리를 정해주세요.",
                exam: `📜 모드 3 — 산업재산권 문제! '문제 시작'을 누르면 한 문제에 ${examTimeLimit()}초씩 진행돼요.`,
                classic: "🍬 모드 1 — 제시어 맞추기로 돌아왔어요."
            };
            UIManager.showToast(MODE_TOAST[next], "info");
        }

        // 모드에 따라 버튼 문구/노출과 안내 배너를 맞춘다.
        function applyModeUI() {
            const isQuiz = appMode === 'quiz';
            const isExam = appMode === 'exam';
            // 모드 2와 모드 3은 같은 화면 틀(옆에 붙는 패널)을 쓴다.
            const usesPanel = isQuiz || isExam;
            document.querySelectorAll('#modeSwitch .mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === appMode);
            });
            // 2인 대결은 모드 1에서만 쓴다.
            dom('versusNavBtn').style.display = usesPanel ? 'none' : '';
            dom('ruleBanner').style.display = usesPanel ? 'none' : '';
            dom('quizRuleBanner').style.display = isQuiz ? 'flex' : 'none';
            dom('examRuleBanner').style.display = isExam ? 'flex' : 'none';
            document.querySelector('#startNavBtn .nav-label').textContent =
                isQuiz ? '스무고개 시작' : (isExam ? '문제 시작' : '게임 시작');
            document.body.classList.toggle('quiz-layout', usesPanel);
            QuizPanelUI.setVisible(usesPanel);
            // 두 모드가 패널 제목을 공유하므로, 지금 고른 모드 쪽만 적어야 서로 덮어쓰지 않는다.
            if (isExam) {
                updateExamRoundDisplay();
            } else {
                updateQuizRoundDisplay();
            }
            if (isQuiz && !QuizManager.active) QuizPanelUI.reset();
            if (isExam && !ExamManager.active) resetExamPanel();
            // 설정 화면은 지금 고른 모드의 항목만 보여 준다. 모드를 바꾸면 그 내용도 함께 바뀐다.
            ModalManager.syncSettingsMode();
        }

        /* ---------- 모드 2: AI(qwen2.5:7b) 스무고개 ---------- */

        // 연결 상태 줄은 [스무고개 시작] 화면과 ⚙️ 게임 설정 두 곳에 있다.
        // 어느 쪽에서 시작했든 같은 내용을 보여줘야 해서 둘 다 갱신한다.
        function setLlmStatus(message, kind) {
            document.querySelectorAll('.llm-status').forEach(el => {
                writeLlmStatus(el, message, kind);
            });
        }

        // 화면을 막 열었을 때의 안내는 그 화면의 상태 줄에만 적는다.
        // 시작 화면과 설정 화면은 눌러야 할 버튼이 서로 달라서 안내 문구도 다르다.
        function writeLlmStatus(el, message, kind) {
            if (!el) return;
            el.className = 'llm-status' + (kind ? ' ' + kind : '');
            el.textContent = message;
        }

        function saveLlmSettingsFromForm() {
            StorageManager.setLlmEndpoint(dom('llmEndpointInput').value);
            StorageManager.setLlmModel(dom('llmModelInput').value);
        }

        // 브라우저에서 로컬 LLM을 부를 때 가장 흔한 실패 원인을 사람 말로 풀어준다.
        function describeLlmError(error) {
            if (error && error.name === 'AbortError') return '응답이 너무 늦어 중단했어요';
            const message = String((error && error.message) || error || '');
            if (message.indexOf('Failed to fetch') !== -1 || message.indexOf('NetworkError') !== -1) {
                return 'Ollama가 꺼져 있거나 CORS(OLLAMA_ORIGINS) 설정이 필요해요';
            }
            return message || '알 수 없는 오류';
        }

        /**
         * AI 연결을 끝까지 맞춰 준다. 서버 확인 → 모델 설치 확인 → 메모리에 올리기.
         * [연결 확인] 버튼과 [스무고개 시작] 버튼이 같은 경로를 쓴다.
         *
         * 연결에 실패해도 예외를 던지지 않는다. 게임은 내장 사전으로 계속 진행되기 때문에,
         * 무엇이 안 됐는지 알려 주고 `false` 를 돌려주는 것으로 충분하다.
         * @returns {Promise<boolean>} AI로 문제를 낼 수 있으면 true
         */
        async function ensureLlmReady() {
            const aiStatus = await AiQuiz.status();
            if (aiStatus.provider === 'gemini') {
                if (aiStatus.ok) {
                    setLlmStatus(`✅ Gemini(${aiStatus.model || 'gemini'}) 사용 준비 완료`, 'ok');
                    return true;
                }
                // API 키 여부·내부 사유는 화면에 보여 주지 않는다. 콘솔에만 남긴다.
                console.warn('[AI] Gemini 사용 불가:', aiStatus.reason || '(사유 없음)');
                setLlmStatus('❌ AI 연결을 사용할 수 없어 내장 힌트로 진행합니다.', 'bad');
                return false;
            }

            // provider === 'ollama' (기본값) — 지금까지의 동작 그대로.
            // [연결 닫기] 로 걸어 둔 잠금을 푼다. 이걸 빼먹으면 닫은 뒤에 다시 연결할 수 없다.
            LlamaClient.reopen();
            const model = LlamaClient.model;
            setLlmStatus(`🔌 ${model} 연결을 확인하는 중…`, '');

            let info = null;
            try {
                info = await LlamaClient.ping();
            } catch (e) {
                if (LlamaClient.closed) return false; // 확인하는 사이에 사용자가 연결을 닫았다
                setLlmStatus(`❌ 연결 실패 (${describeLlmError(e)}). 내장 사전으로 문제를 냅니다.`, 'bad');
                return false;
            }

            if (!info.hasModel) {
                const installed = info.names.length ? info.names.join(', ') : '없음';
                setLlmStatus(
                    `⚠ '${model}' 모델이 없어요. 터미널에서 \`ollama pull ${model}\` 를 실행해주세요. (설치된 모델: ${installed})`, 'warn');
                return false;
            }

            // 연결만 확인하고 끝내면 첫 문제 요청이 모델 로딩에 걸려 시간을 다 써 버린다.
            // 여기서 미리 올려 두고, 그동안 무엇을 기다리는지 화면에 알린다.
            // 콜드 로드는 측정값이 50~120초로 길다. 그동안 화면이 멈춘 것처럼 보이지 않도록
            // 경과 시간을 1초마다 갱신한다. 이미 올라가 있으면 0.1초면 끝나 이 문구는 보이지도 않는다.
            const warmStarted = Date.now();
            const showWarming = () => {
                // 예열 도중에 [연결 닫기]를 누를 수 있다. 그때는 닫기 쪽 안내를 덮어쓰지 않는다.
                if (LlamaClient.closed) return;
                const sec = Math.round((Date.now() - warmStarted) / 1000);
                setLlmStatus(`✅ 연결됨 — ${model} 을(를) 메모리에 올리는 중… ${sec}초 (처음 한 번은 1~2분 걸릴 수 있어요)`, '');
            };
            showWarming();
            const warmTicker = setInterval(showWarming, 1000);
            try {
                await LlamaClient.warmUp();
                if (LlamaClient.closed) return false; // 예열이 끝나기 전에 사용자가 연결을 닫았다
                setLlmStatus(`✅ ${model} 사용 준비 완료`, 'ok');
            } catch (e) {
                // 사용자가 [연결 닫기]로 끊은 것이라면 실패가 아니다. 닫기 쪽 안내를 그대로 둔다.
                if (LlamaClient.closed) return false;
                // 예열에 실패해도 연결 자체는 됐으므로 게임은 그대로 시작할 수 있다.
                setLlmStatus(`✅ 연결됨 — 다만 예열에 실패했어요 (${describeLlmError(e)}). 첫 문제가 느릴 수 있어요.`, 'warn');
            } finally {
                clearInterval(warmTicker);
            }
            return true;
        }

        async function testLlmConnection() {
            saveLlmSettingsFromForm();
            await ensureLlmReady();
        }

        /**
         * 연결을 닫고 모델을 메모리에서 내린다.
         * 예열해 둔 모델은 30분 동안 램을 붙들고 있어서(7B 기준 약 4.4GB),
         * 게임을 그만할 때 직접 돌려줄 수 있어야 한다.
         *
         * 내리는 요청 한 번만 보내면 제대로 닫히지 않는다. 판을 푸는 동안 다음 문제를 미리 받아 두는
         * 요청이 돌고 있어서, 그 요청이 뒤늦게 끝나면서 keep_alive 30분으로 모델을 다시 올려 버린다.
         * 그래서 순서가 중요하다: ① 돌고 있는 요청을 끊고 ② 미리 받기를 버리고 ③ 모델을 내린 뒤
         * ④ /api/ps 로 정말 내려갔는지 확인한다. 확인까지 해야 "닫았다"고 말할 수 있다.
         */
        let llmClosing = false; // 닫는 동안 버튼을 두 번 누르는 것을 막는다

        async function closeLlmConnection() {
            if (llmClosing) return;
            llmClosing = true;
            const btn = dom('llmCloseBtn');
            if (btn) btn.disabled = true;

            if (AiQuiz.provider() === 'gemini') {
                // Gemini는 상태 없는 API라 Ollama처럼 메모리에서 내릴 모델이 없다.
                setLlmStatus('🔌 Gemini는 별도로 닫을 연결이 없어요.', 'ok');
                llmClosing = false;
                if (btn) btn.disabled = false;
                return;
            }

            saveLlmSettingsFromForm();
            const model = LlamaClient.model;
            setLlmStatus('🔌 연결을 닫는 중…', '');

            try {
                // ① 돌고 있는 요청부터 끊는다. 여기서 새 요청도 함께 막힌다.
                const aborted = LlamaClient.abortAll();
                // ② 미리 받아 둔 다음 문제도 버린다. 남겨 두면 다음 라운드가 그걸 기다린다.
                QuizSession.clearPrefetch();

                // ③ 모델을 내린다. 끊긴 요청이 서버 쪽에서 정리될 틈을 조금 준다.
                await new Promise(r => setTimeout(r, 200));
                await LlamaClient.unload();

                // ④ 정말 내려갔는지 확인하고, 아직 남아 있으면 한 번 더 내린다.
                let stillLoaded = await LlamaClient.isLoaded().catch(() => null);
                if (stillLoaded === true) {
                    await new Promise(r => setTimeout(r, 800));
                    await LlamaClient.unload();
                    stillLoaded = await LlamaClient.isLoaded().catch(() => null);
                }

                if (stillLoaded === true) {
                    setLlmStatus(
                        `⚠ ${model} 이(가) 아직 메모리에 남아 있어요. 잠시 뒤 [연결 닫기]를 한 번 더 눌러주세요.`, 'warn');
                } else {
                    const extra = aborted > 0 ? ` (진행 중이던 요청 ${aborted}건도 취소했어요)` : '';
                    // 상태를 확인하지 못했으면(구형 Ollama 등) 내렸다고 단정하지 않는다.
                    const tail = stillLoaded === false ? '메모리에서 내린 것을 확인했어요.' : '메모리에서 내렸습니다.';
                    setLlmStatus(`🔌 연결을 닫았어요 — ${model} 을(를) ${tail}${extra}`, 'ok');
                }
            } catch (e) {
                // 서버가 이미 꺼져 있으면 내릴 것도 없다. 사용자 입장에서는 어차피 닫힌 상태다.
                setLlmStatus(`🔌 연결을 닫았어요. (모델을 내리지는 못했어요: ${describeLlmError(e)})`, 'warn');
            } finally {
                llmClosing = false;
                if (btn) btn.disabled = false;
            }
        }

        /* ----- 1단계: 몇 번 진행할지 정한다 ----- */

        function openQuizSetup() {
            ModalManager.hideGameOver();
            hideQuizRoundResult();
            hideQuizFinal();
            closeQuizCategory();

            // 준비 방법은 항상 접힌 상태로 연다.
            const guide = dom('llmGuide');
            const guideBtn = dom('llmGuideBtn');
            if (guide && guideBtn) {
                guide.style.display = 'none';
                guideBtn.textContent = '준비 방법 ▾';
                guideBtn.setAttribute('aria-expanded', 'false');
            }
            dom('quizSetupRounds').textContent =
                `🔁 스무고개 ${StorageManager.getQuizRounds()}회 · 횟수는 ⚙️ 게임 설정에서 바꿔요`;
            writeLlmStatus(dom('llmStatus'), '[스무고개 시작]을 누르면 AI 연결을 확인합니다.', '');
            Overlay.open('quizSetupOverlay');
        }

        function closeQuizSetup() {
            Overlay.close('quizSetupOverlay');
        }

        /**
         * 스무고개 세션을 연다. 진행 횟수를 확정하고 첫 라운드의 카테고리를 물어본다.
         */
        let quizStarting = false; // 연결하는 동안 [스무고개 시작]을 두 번 누르는 것을 막는다

        async function startQuizSession() {
            if (quizStarting) return;

            // 횟수와 연결 설정은 ⚙️ 게임 설정에서 정한다. 여기서는 저장된 값을 그대로 쓴다.
            const rounds = Math.min(Math.max(StorageManager.getQuizRounds(), 1), QUIZ_MAX_ROUNDS);

            // 시작을 누르면 연결을 자동으로 맞춘다. 시작 화면을 열어 둔 채 진행 상황을 보여 준다.
            // 연결에 실패해도 게임은 내장 사전으로 진행하므로 멈추지 않고, 무엇이 안 됐는지만 알린다.
            quizStarting = true;
            const startBtn = dom('quizStartBtn');
            startBtn.disabled = true;
            let ready = false;
            try {
                ready = await ensureLlmReady();
            } finally {
                startBtn.disabled = false;
                quizStarting = false;
            }
            if (!ready) {
                UIManager.showToast('AI에 연결하지 못해 내장 사전으로 문제를 냅니다.', 'warn');
            }

            closeQuizSetup();

            // 진행 중이던 판을 정리하고 새 세션을 시작한다.
            if (VersusManager.active) {
                cancelVersusMatch({ silent: true });
            }
            clearInterval(timerInterval);
            QuizManager.reset();
            GameState.resetForGameEnd();
            GameState.score = 0;
            UIManager.clearBoard();
            UIManager.syncHud();

            QuizSession.start(rounds);
            updateQuizRoundDisplay();
            QuizPanelUI.setVisible(true);
            QuizPanelUI.reset();
            openQuizRound();
        }

        /* ----- 2단계: 라운드마다 카테고리를 새로 입력받는다 ----- */

        /**
         * 카테고리를 묻는 화면. 세션에서 한 번만 연다.
         * (예전에는 라운드마다 물었지만, 지금은 한 번 고른 카테고리로 끝까지 진행한다.)
         * 문제를 만들지 못했을 때 다시 고를 수 있도록 이 화면을 여는 경로는 남겨 둔다.
         */
        /**
         * 카테고리 드롭다운을 사전에서 채운다.
         *
         * 문제로 낼 낱말이 하나도 없는 카테고리(pickAnswer 가 null)는 아예 빼 둔다.
         * 예전에는 그런 값을 입력하면 [문제 받기] 를 누른 뒤에야 퇴짜를 맞았는데,
         * 목록에 올리지 않으면 고를 수조차 없다.
         * 파일로 추가한 카테고리도 사전에 들어가므로 함께 나온다.
         *
         * @param {string} preferred 되살릴 선택값 (없거나 목록에 없으면 안내 문구가 남는다)
         */
        function populateQuizCategorySelect(preferred) {
            const select = dom('quizCategorySelect');
            const custom = CategoryManager.getCustom();
            select.innerHTML = '';

            const placeholder = makeEl('option', null, '카테고리를 선택하세요');
            placeholder.value = '';
            placeholder.disabled = true;
            select.appendChild(placeholder);

            const usable = Dictionary.getCategories()
                .filter(cat => QuizContent.pickAnswer(cat));
            usable.forEach(cat => {
                const option = makeEl('option', null, (cat in custom) ? `📂 ${cat}` : cat);
                option.value = cat;
                select.appendChild(option);
            });

            select.value = (preferred && usable.indexOf(preferred) !== -1) ? preferred : '';
            if (!select.value) placeholder.selected = true;
            syncQuizStartButton();
        }

        /** 카테고리를 고르기 전에는 [문제 받기] 를 누를 수 없다. */
        function syncQuizStartButton() {
            const select = dom('quizCategorySelect');
            const button = dom('quizRoundStartBtn');
            if (!select || !button) return;
            button.disabled = !select.value;
        }

        function openQuizRound() {
            if (!QuizSession.active) return;
            // 세션 안에서 이 화면을 다시 열 때(문제를 못 만든 경우)는 고른 값을 되살린다.
            // 세션을 새로 시작하면 QuizSession.category 가 비어 있어 안내 문구가 남는다.
            populateQuizCategorySelect(QuizSession.category);
            dom('quizCategoryTitle').textContent = '🗂 카테고리 정하기';
            dom('quizCategorySub').textContent =
                `여기서 고른 카테고리로 ${QuizSession.totalRounds}번 모두 진행해요.`;
            dom('quizCategoryAvailable').textContent = '목록에서 카테고리를 선택하세요.';
            Overlay.open('quizCategoryOverlay');
            setTimeout(() => dom('quizCategorySelect').focus(), 60);
        }

        /* 게임 설명 — 조작법과 모드 1/2/3 차이를 한 화면에 모두 보여준다.
           내용이 모드와 무관하게 고정이라 여는 것은 기존 Overlay 만 그대로 쓴다. */
        function openHowTo() {
            Overlay.open('howToOverlay');
        }

        function closeHowTo() {
            Overlay.close('howToOverlay');
        }

        function closeQuizCategory() {
            Overlay.close('quizCategoryOverlay');
        }

        /**
         * 이번 라운드의 문제를 받아 판을 연다.
         * LLM 호출이 실패하면 내장 사전으로 대체해서, AI가 없어도 세션이 끊기지 않게 한다.
         */
        /**
         * [문제 받기] 버튼. 입력한 카테고리를 확인해 **세션 카테고리로 굳히고** 첫 라운드를 연다.
         * 이후 라운드는 다시 묻지 않고 이 카테고리를 그대로 쓴다.
         */
        async function startQuizRound() {
            if (!QuizSession.active) return;

            const category = dom('quizCategorySelect').value;
            if (!category) {
                UIManager.showToast('목록에서 카테고리를 선택해주세요.', 'warn');
                return;
            }

            // 목록을 사전에서 만들었으므로 여기서 걸릴 일은 없다.
            // 그래도 남겨 둔다 — 파일로 카테고리를 지우거나 바꾼 뒤 이 화면이
            // 열려 있었다면 목록이 낡았을 수 있고, 그때 라운드를 소모하면 안 된다.
            const matched = QuizContent.matchBuiltinCategory(category);
            if (!matched || !QuizContent.pickAnswer(matched)) {
                UIManager.showToast(
                    `'${category}' 로는 낼 문제가 없어요. 다른 카테고리를 골라주세요.`, 'warn');
                populateQuizCategorySelect(null);   // 낡은 목록을 다시 만든다
                return;
            }

            QuizSession.category = category;
            StorageManager.setQuizCategory(category);
            closeQuizCategory();
            await runQuizRound(category);
        }

        /**
         * 라운드 한 판을 실제로 여는 곳. 카테고리는 세션 시작 때 정한 것을 그대로 받는다.
         * 첫 라운드는 startQuizRound 가, 두 번째부터는 nextQuizRound 가 부른다.
         */
        async function runQuizRound(category) {
            if (!QuizSession.active) return;

            // 모드 2 전용 설정을 읽는다. 모드 1의 칸(#blockCount)과는 다른 값이다.
            const blockCount = StorageManager.getQuizBlocks();
            if (!Number.isFinite(blockCount) || blockCount < QUIZ_BLOCKS_MIN) {
                UIManager.showToast('블록 개수는 4개 이상으로 정해주세요. (⚙️ 설정 → 모드 2)', 'warn');
                openQuizRound();
                return;
            }

            clearInterval(timerInterval);
            QuizManager.reset();
            UIManager.clearBoard();
            QuizPanelUI.setVisible(true);
            QuizPanelUI.showMessage('AI가 문제를 만드는 중이에요…');
            UIManager.updateCategoryDisplay();

            // 미리 받아 둔 문제가 있으면 곧바로 쓴다. 그 경우 기다림이 없어 로딩 화면도 뜨지 않는다.
            const prefetched = QuizSession.takePrefetch(category);
            // 로딩 화면은 실제로 기다릴 때만 띄운다. 바로 끝나는데 띄우면 화면만 깜빡인다.
            let loadingTimer = setTimeout(() => showQuizLoading(category), QUIZ_LOADING_DELAY);

            let quiz = null;
            let source = 'llm';
            if (prefetched) quiz = await prefetched; // 미리 받다가 실패했으면 null 이다
            if (!quiz) {
                try {
                    quiz = await AiQuiz.createQuiz(category);
                } catch (e) {
                    console.warn('[AI 스무고개] LLM 호출 실패 — 내장 사전으로 대체합니다.', e);
                }
            }
            if (!quiz) {
                quiz = QuizContent.offlineQuiz(category);
                source = 'offline';
            }
            clearTimeout(loadingTimer);
            hideQuizLoading();

            // 세션이 도중에 취소됐다면 (그만하기 / 모드 전환) 판을 열지 않는다.
            if (!QuizSession.active) return;

            if (!quiz) {
                QuizPanelUI.reset();
                UIManager.showToast('문제를 만들지 못했어요. 다른 카테고리로 다시 시도해주세요.', 'warn');
                openQuizRound();
                return;
            }

            // 마지막 확인: 화면에 띄울 제시어와 정답이 정말 같은 카테고리인지 사전으로 대조한다.
            // 위에서 이미 사전에서 뽑았으므로 통과해야 정상이고, 어긋나면 사전 문제로 다시 만든다.
            if (!QuizContent.answerFitsCategory(quiz.answer, quiz.category)) {
                console.warn('[AI 스무고개] 제시어와 정답이 어긋나 사전 문제로 대체합니다.', quiz.category, quiz.answer);
                quiz = QuizContent.offlineQuiz(quiz.category);
                source = 'offline';
                if (!quiz) {
                    QuizPanelUI.reset();
                    UIManager.showToast('문제를 만들지 못했어요. 다른 카테고리로 다시 시도해주세요.', 'warn');
                    openQuizRound();
                    return;
                }
            }

            beginQuizPlay(category, quiz, source, blockCount);
            // 이번 판을 푸는 동안 다음 판을 미리 만들어 둔다.
            QuizSession.startPrefetch();
        }

        function showQuizLoading(category) {
            // 내장 사전에 있는 카테고리인지에 따라 실제로 하는 일이 달라서, 문구도 그에 맞춘다.
            const builtin = QuizContent.matchBuiltinCategory(category);
            dom('quizLoadingSub').textContent = builtin
                ? `'${builtin}' 정답은 내장 사전에서 고르고, AI가 힌트를 만들고 있어요`
                : `AI가 '${category}' 안에서 정답과 힌트를 고르고 있어요`;
            Overlay.open('quizLoadingOverlay');
        }

        function hideQuizLoading() {
            Overlay.close('quizLoadingOverlay');
        }

        // 모드 2의 판을 실제로 여는 곳. 모드 1의 beginPlay와 짝을 이룬다.
        function beginQuizPlay(requestedCategory, quiz, source, blockCount) {
            AudioManager.ensureContext();

            // 화면에 띄우는 제시어는 사용자가 적은 말이 아니라 **정답이 실제로 나온 카테고리**다.
            // 예전에는 사용자가 적은 말을 그대로 띄웠는데, 내장 사전으로 대체할 때
            // findBuiltinCategory 가 못 찾으면 아무 카테고리나 골라 정답을 뽑기 때문에
            // '바다 생물' 이라고 적었는데 정답이 '회계사' 로 나오는 일이 있었다.
            const category = quiz.category || requestedCategory;
            const swapped = category !== requestedCategory;

            GameState.mode = 'quiz';
            GameState.currentCategory = category;
            // 정답 글자가 모두 보드에 들어가야 하므로 설정값이 작으면 자동으로 늘린다.
            GameState.currentBlockCount = Math.max(blockCount, quiz.answer.length + 2);
            GameState.currentTargetWords = [quiz.answer];
            // 마지막 힌트까지 다 열린 뒤에도 생각할 시간을 남겨 둔다.
            GameState.duration = QUIZ_HINT_INTERVAL * quiz.hints.length + QUIZ_EXTRA_TIME;
            GameState.resetForNewGame();
            // 점수 카드에는 세션 누적 점수를 보여주고, 이번 라운드 몫이 그 위에 더해진다.
            GameState.score = QuizSession.totalScore;
            GameState.highScore = StorageManager.getHighScore('quiz');

            QuizManager.load(category, quiz, source);
            QuizPanelUI.setVisible(true);
            QuizPanelUI.render([], false);
            updateQuizRoundDisplay();

            UIManager.syncHud();
            AudioManager.playStart();

            generateNewRound();
            startCountdown();
            QuizManager.tick(); // 첫 힌트는 10초를 기다리지 않고 바로 연다

            if (source === 'llm') {
                UIManager.showToast(`🤖 AI가 '${category}' 문제를 냈어요!`, 'info');
            } else if (swapped) {
                // 카테고리를 바꿔 낸 것을 숨기지 않는다. 제시어도 바뀐 쪽으로 이미 바뀌어 있다.
                UIManager.showToast(
                    `⚠ '${requestedCategory}' 로는 문제를 만들지 못해 내장 사전의 '${category}' 로 냈어요.`, 'warn');
            } else {
                UIManager.showToast('⚠ AI에 연결하지 못해 내장 사전으로 문제를 냈어요.', 'warn');
            }
        }

        // 배너 칩과 힌트 패널 제목에 '몇 번째 라운드인지'를 반영한다.
        function updateQuizRoundDisplay() {
            const chip = dom('quizRoundChip');
            if (QuizSession.active) {
                chip.textContent = `🤖 ${QuizSession.round} / ${QuizSession.totalRounds} 라운드`;
                QuizPanelUI.setRound(QuizSession.round, QuizSession.totalRounds);
            } else {
                chip.textContent = '🤖 AI 힌트 맞히기';
                QuizPanelUI.setRound(0, 0);
            }
        }

        /* =========================================================
           모드 3 진행 — 문제 내기 / 10초 / 정답 공개 / 다음 문제
           모드 2(스무고개)의 흐름을 그대로 따르되, 문제를 AI가 아니라 파일에서 가져온다.
        ========================================================= */

        /** [문제 시작] — 파일을 읽어 전체 문제로 세션을 연다. */
        async function startExamSession() {
            if (VersusManager.active) cancelVersusMatch({ silent: true });
            clearInterval(timerInterval);
            ExamManager.reset();
            GameState.resetForGameEnd();
            GameState.score = 0;
            UIManager.clearBoard();
            UIManager.syncHud();

            QuizPanelUI.setVisible(true);
            QuizPanelUI.setTitle('📜 산업재산권 문제');
            QuizPanelUI.showMessage('문제를 불러오는 중이에요…');
            QuizPanelUI.updateNext('대기중');
            QuizPanelUI.setFoot('잠시만 기다려주세요');

            try {
                await ExamBank.load();
            } catch (e) {
                // 기본 문제 파일을 못 읽어도, 설정에서 파일로 더 넣어 둔 문제가 있으면 그것만으로 진행한다.
                // (게임 파일을 두 번 눌러 연 경우가 여기 해당한다 — 그때도 파일 추가는 된다)
                if (ExamBank.all().length === 0) {
                    showExamLoadError();
                    return;
                }
                UIManager.showToast('⚠ 기본 문제 파일을 못 읽어서, 추가해 둔 문제로만 진행해요.', 'warn');
            }

            const questions = ExamBank.all();
            ExamSession.start(questions);
            updateExamRoundDisplay();
            UIManager.showToast(`📜 산업재산권 문제 ${questions.length}개! 한 문제에 ${examTimeLimit()}초예요.`, 'info');
            beginExamRound();
        }

        /** 문제 파일을 못 읽었을 때. 왜 안 됐는지에 따라 할 일이 다르다. */
        function showExamLoadError() {
            ExamSession.reset();
            updateExamRoundDisplay();
            if (ExamBank.error === 'file') {
                QuizPanelUI.showMessage(
                    '게임 파일을 두 번 눌러 연 상태에서는 브라우저가 문제 파일을 읽지 못하게 막아요. '
                    + '서버 주소로 들어오거나, ⚙️ 설정의 [문제 파일 추가] 에서 파일을 직접 올려주세요.');
                QuizPanelUI.setFoot('설정에서 파일을 올리면 이 상태에서도 문제를 낼 수 있어요');
                UIManager.showToast('⚠ 문제 파일을 읽지 못했어요. 설정에서 파일을 직접 올릴 수 있어요.', 'warn');
            } else if (ExamBank.error === 'empty') {
                QuizPanelUI.showMessage(`${EXAM_FILE} 에서 문제를 하나도 찾지 못했어요.`);
                QuizPanelUI.setFoot("'문제:' 와 '답:' 두 줄이 한 쌍이어야 해요");
                UIManager.showToast('⚠ 문제 파일에서 문제를 찾지 못했어요.', 'warn');
            } else {
                QuizPanelUI.showMessage(`${EXAM_FILE} 을 불러오지 못했어요.`);
                QuizPanelUI.setFoot('파일이 그 자리에 있는지 확인해주세요');
                UIManager.showToast('⚠ 문제 파일을 불러오지 못했어요.', 'warn');
            }
            QuizPanelUI.updateNext(-1);
        }

        /** 이번 문제의 판을 연다. 보드에는 정답 글자가 모두 들어간다. */
        function beginExamRound() {
            const item = ExamSession.currentQuestion();
            if (!item) {
                finishExamSession();
                return;
            }
            AudioManager.ensureContext();

            ExamManager.load(item);

            GameState.mode = 'exam';
            GameState.currentCategory = '산업재산권';
            GameState.currentTargetWords = ExamManager.answers.slice();
            // 정답 글자가 모두 보드에 들어가야 한다. 정답이 여러 개면 그 글자를 전부 합친 길이가 기준이다.
            // 설정에서 정한 블록 개수를 쓰되, 정답 글자가 다 들어가지 못하면 자동으로 늘린다.
            // (설정을 무시하는 게 아니라, 정답을 만들 수 없는 판이 나오는 것을 막기 위해서다)
            GameState.currentBlockCount = Math.max(
                StorageManager.getExamBlocks(),
                ExamManager.answers.join('').length + EXAM_MIN_SPARE_BLOCKS);
            GameState.duration = examTimeLimit();
            GameState.resetForNewGame();
            // 점수 카드에는 세션 누적을 보여주고, 이번 문제 몫이 그 위에 더해진다.
            GameState.score = ExamSession.totalScore;
            GameState.highScore = StorageManager.getHighScore('exam');

            QuizPanelUI.setVisible(true);
            renderExamQuestion();
            updateExamRoundDisplay();

            UIManager.syncHud();
            AudioManager.playStart();

            generateNewRound();
            startCountdown();
        }

        /** 패널에 문제 문장을 적는다. 정답이 여러 개인 문제는 그 사실도 알려 준다. */
        function renderExamQuestion() {
            QuizPanelUI.render([ExamManager.question], true);
            QuizPanelUI.updateNext(`${GameState.timeLeft}초 남음`);
            QuizPanelUI.setFoot(ExamManager.answers.length > 1
                ? `정답이 ${ExamManager.answers.length}개예요. 그중 하나만 만들어도 정답!`
                : '보드에서 글자를 눌러 정답을 만들어보세요');
        }

        // 배너 칩과 패널 제목에 '몇 번째 문제인지'를 반영한다.
        function updateExamRoundDisplay() {
            const chip = dom('examRoundChip');
            if (!chip) return;
            if (ExamSession.active) {
                chip.textContent = `📜 ${ExamSession.round} / ${ExamSession.totalRounds} 문제`;
                QuizPanelUI.setTitle(`📜 산업재산권 ${ExamSession.round}/${ExamSession.totalRounds}`);
            } else {
                chip.textContent = '📜 산업재산권 문제';
                QuizPanelUI.setTitle('📜 산업재산권 문제');
            }
        }

        /* ----- 문제 결과 -> 다음 문제 or 최종 결과 ----- */

        function showExamRoundResult(info) {
            dom('examRoundResultTitle').textContent = info.cleared ? '🎯 정답!' : '⏰ 시간 종료!';
            dom('examRoundResultSub').textContent = info.cleared
                ? `${examTimeLimit()}초 안에 맞혔어요!`
                : `${examTimeLimit()}초가 다 됐어요…`;

            const answerEl = dom('examRoundAnswer');
            answerEl.textContent = '';
            answerEl.appendChild(document.createTextNode('정답은 '));
            answerEl.appendChild(makeEl('b', null, info.answer || '-'));
            answerEl.appendChild(document.createTextNode(' 였어요'));

            dom('examRoundQuestion').textContent = info.question || '';
            dom('examRoundScore').textContent = `+${info.roundScore}`;
            dom('examRoundProgress').textContent =
                `${ExamSession.round} / ${ExamSession.totalRounds} 문제 · 누적 ${ExamSession.totalScore}점`;

            const isLast = ExamSession.round >= ExamSession.totalRounds;
            dom('examNextLabel').textContent = isLast ? '최종 결과 보기' : '다음 문제';
            dom('examQuitBtn').style.display = isLast ? 'none' : '';

            Overlay.open('examRoundOverlay');
        }

        function hideExamRoundResult() {
            Overlay.close('examRoundOverlay');
        }

        function nextExamRound() {
            hideExamRoundResult();
            if (!ExamSession.active) return;

            if (ExamSession.round >= ExamSession.totalRounds) {
                finishExamSession();
                return;
            }
            ExamSession.next();
            updateExamRoundDisplay();
            beginExamRound();
        }

        function finishExamSession() {
            if (!ExamSession.active) return;
            // 결과창을 띄우기 전에 세션부터 닫는다 (모드 2에서 겪은 문제 — 세션이 살아 있으면 계속 진행된다).
            ExamSession.finish();
            hideExamRoundResult();

            const history = ExamSession.history.slice();
            const total = ExamSession.totalScore;
            const solved = history.filter(entry => entry.cleared).length;

            const isNewRecord = StorageManager.trySetHighScore(total, 'exam');
            GameState.highScore = StorageManager.getHighScore('exam');

            // 이 화면에서 가장 궁금한 것은 '몇 개나 맞혔나'다. 그래서 점수 대신 그 숫자를 크게 띄운다.
            const rate = history.length > 0 ? Math.round((solved / history.length) * 100) : 0;
            dom('examFinalScore').textContent = `${solved} / ${history.length}`;
            dom('examFinalSub').textContent =
                `${history.length}문제 중 ${solved}문제를 맞혔어요 · 정답률 ${rate}%`;
            dom('examFinalPoints').textContent = `⭐ 점수 ${total}점`;
            dom('examFinalHigh').textContent = `최고 점수: ${GameState.highScore}점`;
            dom('examFinalRecordBadge').style.display = isNewRecord ? '' : 'none';
            dom('examFinalTrophy').style.display = (solved === history.length && history.length > 0) ? '' : 'none';

            /* 문제별로 한 줄씩. 어떤 문제를 틀렸는지 알아야 다시 볼 수 있으므로
               **문제 문장까지** 함께 적는다. 정답을 여러 개 적어 둔 문제는 전부 보여 주고,
               맞힌 경우에는 그중 무엇을 만들었는지도 알려 준다. */
            const listEl = dom('examFinalList');
            listEl.innerHTML = '';
            history.forEach((entry) => {
                const body = makeEl('span', 'qr-body');
                const question = entry.question.length > 42
                    ? entry.question.slice(0, 42) + '…'
                    : entry.question;
                body.appendChild(makeEl('span', null, (entry.cleared ? '⭕ ' : '❌ ') + question));

                let detail = `정답: ${entry.answers.join(', ')}`;
                // 정답이 여러 개인 문제는 어느 것으로 맞혔는지가 궁금하다.
                if (entry.cleared && entry.answers.length > 1 && entry.solved) {
                    detail += ` · 내가 만든 답: ${entry.solved}`;
                }
                body.appendChild(makeEl('span', 'qr-cat', detail));

                const row = makeEl('div', 'quiz-round-row' + (entry.cleared ? '' : ' missed'));
                row.appendChild(makeEl('span', 'qr-no', `${entry.round}번`));
                row.appendChild(body);
                row.appendChild(makeEl('span', 'qr-score', `${entry.score}점`));
                listEl.appendChild(row);
            });

            const championResult = LeaderboardManager.submit(currentNickname(), total, 'exam');
            UIManager.updateChampionBanner();
            dom('examFinalChampionBadge').style.display = championResult.isChampion ? '' : 'none';
            const note = dom('examFinalRankNote');
            if (championResult.registered) {
                note.style.display = '';
                note.textContent = championResult.becameChampion
                    ? '👑 새 챔피언이 되었어요!'
                    : '🏅 랭킹에 등록했어요';
            } else {
                note.style.display = 'none';
            }

            ExamManager.reset();
            updateExamRoundDisplay();
            Overlay.open('examFinalOverlay');
        }

        function closeExamFinal() {
            Overlay.close('examFinalOverlay');
            ExamSession.reset();
            updateExamRoundDisplay();
            QuizPanelUI.showMessage(`[문제 시작] 을 누르면 파일에 있는 문제를 처음부터 냅니다. 한 문제에 ${examTimeLimit()}초예요.`);
            QuizPanelUI.updateNext('대기중');
            QuizPanelUI.setFoot('빨리 맞힐수록 점수가 높아요');
        }

        function restartExamSession() {
            Overlay.close('examFinalOverlay');
            startExamSession();
        }

        /** 모드 3 화면을 처음 상태로 되돌린다. */
        function resetExamPanel() {
            QuizPanelUI.setTitle('📜 산업재산권 문제');
            QuizPanelUI.showMessage(`[문제 시작] 을 누르면 파일에 있는 문제를 처음부터 냅니다. 한 문제에 ${examTimeLimit()}초예요.`);
            QuizPanelUI.updateNext('대기중');
            QuizPanelUI.setFoot('빨리 맞힐수록 점수가 높아요');
        }

        /* ----- 3단계: 라운드 결과 -> 다음 라운드 or 최종 결과 ----- */

        function showQuizRoundResult(info) {
            dom('quizRoundResultTitle').textContent =
                info.cleared ? '🎯 정답!' : '⏰ 시간 종료!';
            dom('quizRoundResultSub').textContent = info.cleared
                ? `힌트 ${info.hintsUsed}개만 보고 맞혔어요!`
                : `힌트 ${info.hintsUsed}개가 열렸지만 시간이 다 됐어요…`;

            const answerEl = dom('quizRoundAnswer');
            answerEl.textContent = '';
            answerEl.appendChild(document.createTextNode('정답은 '));
            answerEl.appendChild(makeEl('b', null, info.answer || '-'));
            answerEl.appendChild(document.createTextNode(' 였어요'));

            dom('quizRoundScore').textContent = `+${info.roundScore}`;
            dom('quizRoundProgress').textContent =
                `${QuizSession.round} / ${QuizSession.totalRounds} 라운드 · 누적 ${QuizSession.totalScore}점`;

            const isLast = QuizSession.round >= QuizSession.totalRounds;
            dom('quizNextLabel').textContent = isLast ? '최종 결과 보기' : '다음 라운드';
            // 마지막 라운드에서는 '그만하기'가 '최종 결과 보기'와 같은 동작이라 감춘다.
            dom('quizQuitBtn').style.display = isLast ? 'none' : '';

            Overlay.open('quizRoundOverlay');
        }

        function hideQuizRoundResult() {
            Overlay.close('quizRoundOverlay');
        }

        function nextQuizRound() {
            hideQuizRoundResult();
            if (!QuizSession.active) return;

            if (QuizSession.round >= QuizSession.totalRounds) {
                finishQuizSession();
                return;
            }
            QuizSession.next();
            updateQuizRoundDisplay();
            QuizPanelUI.reset();
            // 카테고리는 세션 시작 때 한 번 정했으므로 다시 묻지 않는다.
            runQuizRound(QuizSession.category);
        }

        // 카테고리 입력 단계에서 그만둘 때: 이미 푼 라운드가 있으면 결과를 보여준다.
        function cancelQuizSession() {
            closeQuizCategory();
            if (QuizSession.history.length > 0) {
                finishQuizSession();
                return;
            }
            QuizSession.reset();
            updateQuizRoundDisplay();
            QuizPanelUI.reset();
            UIManager.updateCategoryDisplay();
            UIManager.showToast('스무고개를 그만뒀어요.', 'info');
        }

        /* ----- 4단계: 최종 결과 ----- */

        function finishQuizSession() {
            // 세션이 이미 닫혔으면 결과창을 두 번 열지 않는다.
            if (!QuizSession.active) return;
            // 결과창을 띄우기 전에 세션부터 닫는다.
            // 이걸 빠뜨려서, 마지막 라운드가 끝나도 세션이 살아 있어 정해 둔 횟수를 넘겨 계속 진행됐다.
            QuizSession.finish();

            hideQuizRoundResult();
            closeQuizCategory();

            const history = QuizSession.history.slice();
            const total = QuizSession.totalScore;
            const isNewRecord = StorageManager.trySetHighScore(total, 'quiz');
            GameState.highScore = StorageManager.getHighScore('quiz');
            UIManager.updateHighScoreDisplay();

            // 스무고개 랭킹에는 세션 총점을 올린다.
            // 이미 랭킹에 올라 있는 내 점수보다 높을 때만 등록된다.
            const championResult = LeaderboardManager.submit(currentNickname(), total, 'quiz');
            UIManager.updateChampionBanner();

            showQuizFinal(history, total, isNewRecord, championResult);
            AudioManager.playWin();
        }

        function showQuizFinal(history, total, isNewRecord, championResult) {
            const clearedCount = history.filter(h => h.cleared).length;
            const allCleared = history.length > 0 && clearedCount === history.length;

            const isChampion = !!(championResult && championResult.isChampion);
            const trophy = dom('quizFinalTrophy');
            trophy.style.display = (allCleared && !isChampion) ? 'block' : 'none';
            dom('quizFinalRecordBadge').style.display = isNewRecord ? 'inline-block' : 'none';
            const clearedText = `${history.length}번 중 ${clearedCount}번 맞혔어요`;
            dom('quizFinalSub').textContent = isChampion
                ? (championResult.becameChampion
                    ? `${clearedText} · 🏅 스무고개 랭킹 1위 등극!`
                    : `${clearedText} · 👑 챔피언 자리를 지켰어요`)
                : clearedText;
            dom('quizFinalScore').textContent = total;
            dom('quizFinalHigh').textContent =
                `최고 점수: ${StorageManager.getHighScore('quiz')}점`;

            dom('quizFinalChampionBadge').style.display = isChampion ? 'block' : 'none';
            ModalManager.describeRankResult(
                dom('quizFinalRankNote'), championResult, total, '스무고개 랭킹');

            const list = dom('quizFinalList');
            list.innerHTML = '';
            history.forEach(entry => {
                const body = makeEl('span', 'qr-body');
                body.appendChild(makeEl('span', null, (entry.cleared ? '⭕ ' : '❌ ') + entry.answer));
                body.appendChild(makeEl('span', 'qr-cat', `${entry.category} · 힌트 ${entry.hintsUsed}개`));

                const row = makeEl('div', 'quiz-round-row' + (entry.cleared ? '' : ' missed'));
                row.appendChild(makeEl('span', 'qr-no', `${entry.round}R`));
                row.appendChild(body);
                row.appendChild(makeEl('span', 'qr-score', `${entry.score}점`));
                list.appendChild(row);
            });

            Overlay.open('quizFinalOverlay');
        }

        function hideQuizFinal() {
            Overlay.close('quizFinalOverlay');
        }

        function closeQuizFinal() {
            hideQuizFinal();
            QuizSession.reset();
            QuizManager.reset();
            updateQuizRoundDisplay();
            QuizPanelUI.reset();
            GameState.score = 0;
            UIManager.updateScoreDisplay();
            UIManager.updateCategoryDisplay();
        }

        function restartQuizSession() {
            hideQuizFinal();
            QuizSession.reset();
            QuizManager.reset();
            updateQuizRoundDisplay();
            openQuizSetup();
        }

        /* ---------- 2인 대결 ---------- */

        function openVersusSetup() {
            ModalManager.hideGameOver();
            ModalManager.hideVersusResult();
            ModalManager.openVersusSetup();
        }

        function closeVersusSetup() {
            ModalManager.closeVersusSetup();
        }

        function beginVersusMatch() {
            let name1 = (dom('versusName1Input').value || '').trim() || '플레이어 1';
            let name2 = (dom('versusName2Input').value || '').trim() || '플레이어 2';
            if (name1 === name2) {
                // 같은 닉네임이면 랭킹에서 기록이 덮어써지므로 구분해준다.
                name2 = `${name2} (2)`;
            }

            clearInterval(timerInterval);
            GameState.resetForGameEnd();
            UIManager.clearBoard();
            UIManager.syncHud();

            VersusManager.start(name1, name2);
            GameState.mode = 'versus';

            ModalManager.closeVersusSetup();
            UIManager.updateVersusBar();
            ModalManager.showVersusTurn(VersusManager.turn, VersusManager.players[VersusManager.turn].name);
        }

        function startVersusTurn() {
            if (!VersusManager.active) return;
            ModalManager.hideVersusTurn();
            GameState.mode = 'versus';

            const started = beginPlay({ forceCategory: VersusManager.lockedCategory });
            if (!started) {
                // 설정이 잘못되어 판을 열 수 없으면 대결을 접고 안내한다.
                cancelVersusMatch({ silent: true });
                UIManager.showToast("설정을 확인한 뒤 대결을 다시 시작해주세요.", "warn");
                return;
            }
            // 첫 차례에 정해진 제시어를 두 번째 차례에도 그대로 쓴다.
            if (!VersusManager.lockedCategory) {
                VersusManager.lockedCategory = GameState.currentCategory;
            }
        }

        function cancelVersusMatch(options) {
            options = options || {};
            clearInterval(timerInterval);
            VersusManager.reset();
            GameState.mode = 'solo';
            GameState.resetForGameEnd();

            ModalManager.hideVersusTurn();
            ModalManager.hideVersusResult();
            UIManager.clearBoard();
            UIManager.syncHud();

            if (!options.silent) {
                UIManager.showToast("대결을 취소했습니다.", "info");
            }
        }

        // 한 플레이어의 차례가 끝났을 때 (대결 모드 전용)
        function finishVersusTurn(finalScore) {
            VersusManager.recordTurn(finalScore);
            LeaderboardManager.submit(VersusManager.players[VersusManager.turn].name, finalScore, 'classic');
            UIManager.updateChampionBanner();
            UIManager.updateVersusBar();

            if (!VersusManager.isLastTurn) {
                VersusManager.turn++;
                UIManager.updateVersusBar();
                ModalManager.showVersusTurn(VersusManager.turn, VersusManager.players[VersusManager.turn].name);
                return;
            }

            const winnerIndex = VersusManager.winnerIndex;
            if (winnerIndex !== -1) {
                UIManager.spawnConfetti();
            }
            ModalManager.showVersusResult(VersusManager.players, winnerIndex);
        }

        function rematchVersus() {
            const [p1, p2] = VersusManager.players;
            const name1 = p1 ? p1.name : '플레이어 1';
            const name2 = p2 ? p2.name : '플레이어 2';

            ModalManager.hideVersusResult();
            VersusManager.start(name1, name2);
            GameState.mode = 'versus';
            UIManager.updateVersusBar();
            ModalManager.showVersusTurn(0, name1);
        }

        function closeVersusResult() {
            ModalManager.hideVersusResult();
            VersusManager.reset();
            GameState.mode = 'solo';
            UIManager.updateVersusBar();
        }

        /* ---------- 랭킹 ---------- */

        // 제시어 카드 클릭: 게임 시작 전에만 정답 목록을 열 수 있다.
        // 모드 2에는 정답 목록이 없으므로 대신 카테고리 입력 화면을 연다.
        function openAnswerList() {
            // 모드 3도 정답 목록이 없다. 진행 중이 아니면 카드를 눌러 바로 시작할 수 있게 한다.
            if (appMode === 'exam') {
                if (GameState.isGameActive) {
                    UIManager.showToast("문제를 푸는 중에는 정답을 미리 볼 수 없어요!", "warn");
                    return;
                }
                startExamSession();
                return;
            }
            if (appMode === 'quiz') {
                if (GameState.isGameActive) {
                    UIManager.showToast("AI 힌트 맞히기에서는 정답을 미리 볼 수 없어요!", "warn");
                    return;
                }
                openQuizSetup();
                return;
            }
            if (GameState.isGameActive) {
                UIManager.showToast("게임 중에는 정답 목록을 볼 수 없어요!", "warn");
                return;
            }
            if (!GameState.answerListUnlocked) {
                UIManager.showToast("정답 목록은 한 판을 마친 뒤에 볼 수 있어요!", "warn");
                return;
            }
            ModalManager.openAnswerList();
        }

        function closeAnswerList() { ModalManager.closeAnswerList(); }

        function openRanking() { ModalManager.openRanking(); }
        function closeRanking() { ModalManager.closeRanking(); }

        // 랭킹 모달의 탭 전환. 모드 1 / 모드 2 기록을 따로 본다.
        function selectRankingBoard(board) { ModalManager.setRankingBoard(board); }

        // 지금 보고 있는 탭의 기록만 지운다. 다른 모드 기록은 건드리지 않는다.
        function clearRanking() {
            const board = ModalManager.currentRankingBoard();
            const label = board === 'quiz' ? 'AI 힌트 맞히기' : '제시어 맞추기';
            if (!confirm(`${label} 랭킹 기록을 모두 지울까요? 되돌릴 수 없습니다.`)) return;
            LeaderboardManager.clear(board);
            ModalManager.renderRanking();
            UIManager.updateChampionBanner();
            UIManager.showToast(`${label} 랭킹 기록을 초기화했습니다.`, "info");
        }

        /* ---------- 배경 선택 ---------- */

        function selectBackground(id) {
            BackgroundManager.apply(id);
            ModalManager.syncBackgroundPicker();
            UIManager.showToast(`${BackgroundManager.label(id)}을(를) 적용했습니다.`, "info");
        }

        /* ---------- 카테고리 파일 추가 ---------- */

        // 설정 모달에서 고른 파일들을 읽어 카테고리로 등록한다.
        function handleCategoryFiles(input) {
            const files = input.files;
            if (!files || files.length === 0) return;

            CategoryManager.importFiles(files).then(result => {
                input.value = ''; // 같은 파일을 다시 골라도 change 이벤트가 발생하도록 초기화
                const first = result.addedCategories[0];
                ModalManager.populateCategorySelect(first || undefined);
                ModalManager.renderCustomCategories();
                UIManager.updateCategoryDisplay();

                if (result.addedCategories.length > 0) {
                    UIManager.showToast(
                        `카테고리 ${result.addedCategories.length}개, 단어 ${result.wordCount}개를 추가했습니다.`, "info");
                } else {
                    UIManager.showToast("추가할 수 있는 카테고리를 찾지 못했습니다. 파일 형식을 확인해주세요.", "warn");
                }
                // 형식 오류/제외된 단어는 하나씩 안내한다 (최대 3개).
                result.warnings.slice(0, 3).forEach((msg, i) => {
                    setTimeout(() => UIManager.showToast(msg, "warn"), 400 * (i + 1));
                });
            });
        }

        // '작성 예시' 버튼: 파일 작성법 설명을 펼치고 접는다.
        // qwen2.5:7b 준비 방법 — 시작 화면이 길어지지 않게 평소에는 접어 둔다.
        function toggleLlmGuide() {
            const guide = dom('llmGuide');
            const button = dom('llmGuideBtn');
            const willShow = guide.style.display === 'none';
            guide.style.display = willShow ? 'block' : 'none';
            button.textContent = willShow ? '준비 방법 ▴' : '준비 방법 ▾';
            button.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        }

        function toggleFormatGuide() {
            const guide = dom('formatGuide');
            const button = dom('formatGuideBtn');
            const willShow = guide.style.display === 'none';
            guide.style.display = willShow ? 'block' : 'none';
            button.textContent = willShow ? '작성 예시 ▴' : '작성 예시 ▾';
            button.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        }

        /* ---------- 모드 3: 문제 파일 내려받기 / 고쳐서 다시 올리기 ---------- */

        function toggleExamGuide() {
            const guide = dom('examGuide');
            const button = dom('examGuideBtn');
            const willShow = guide.style.display === 'none';
            guide.style.display = willShow ? 'block' : 'none';
            button.textContent = willShow ? '작성 예시 ▴' : '작성 예시 ▾';
            button.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        }

        /**
         * 지금 내는 문제 전부(기본 + 추가)를 문제 파일 형식으로 내려받는다.
         * 이 파일 아래에 새 문제를 덧붙여 다시 올리는 것이 문제를 늘리는 방법이다.
         */
        async function downloadExamFile() {
            // 기본 문제를 아직 안 읽었으면 먼저 읽어 둔다. 실패해도 추가분만으로 내려받을 수 있다.
            try {
                await ExamBank.load();
            } catch (e) { /* 추가해 둔 문제만으로 내려받는다 */ }

            if (ExamBank.all().length === 0) {
                UIManager.showToast('내려받을 문제가 없어요. 문제 파일을 먼저 읽을 수 있어야 해요.', 'warn');
                return;
            }

            const header = '# 문제와 답 두 줄이 한 쌍입니다. 아래에 같은 형식으로 덧붙인 뒤 다시 올려주세요.\n'
                + '# 정답이 여러 개면 쉼표로 나눕니다.\n\n';
            // BOM 을 앞에 붙인다. 메모장이 UTF-8 파일을 다른 인코딩으로 잘못 열어 한글이 깨지는 일을 막는다.
            const blob = new Blob(['﻿' + header + ExamBank.toText()],
                { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = '산업재산권_문제.txt';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            UIManager.showToast(
                `문제 ${ExamBank.all().length}개를 내려받았어요. 아래에 새 문제를 적고 다시 올려보세요!`, 'info');
        }

        /** 고른 파일을 읽어 문제를 더한다. 이미 있는 문제는 건너뛴다. */
        function handleExamFiles(input) {
            const files = input.files;
            if (!files || files.length === 0) return;

            // 기본 문제를 먼저 읽어 둬야 '이미 있는 문제'를 걸러낼 수 있다.
            ExamBank.load().catch(() => { /* 못 읽어도 추가는 된다 */ }).then(() => {
                return Promise.all(Array.from(files).map(file => file.text().then(text => ({
                    name: file.name,
                    items: ExamBank.parse(text)
                }))));
            }).then((results) => {
                input.value = '';   // 같은 파일을 다시 골라도 change 가 일어나도록
                let added = 0, skipped = 0;
                const empty = [];
                results.forEach((result) => {
                    if (result.items.length === 0) {
                        empty.push(result.name);
                        return;
                    }
                    const counted = ExamBank.addQuestions(result.items);
                    added += counted.added;
                    skipped += counted.skipped;
                });

                ModalManager.renderExamExtras();

                if (added > 0) {
                    UIManager.showToast(
                        `문제 ${added}개를 추가했어요.` + (skipped > 0 ? ` (이미 있던 ${skipped}개는 건너뜀)` : ''),
                        'info');
                } else if (skipped > 0) {
                    UIManager.showToast(`올린 문제 ${skipped}개는 이미 들어 있어요.`, 'warn');
                } else {
                    UIManager.showToast(
                        '문제를 찾지 못했어요. \'문제:\' 와 \'답:\' 두 줄이 한 쌍인지 확인해주세요.', 'warn');
                }
                empty.slice(0, 3).forEach((name, i) => {
                    setTimeout(() => UIManager.showToast(`${name} 에서 문제를 찾지 못했어요.`, 'warn'), 400 * (i + 1));
                });
            }).catch(() => {
                input.value = '';
                UIManager.showToast('파일을 읽지 못했어요.', 'warn');
            });
        }

        /** 추가한 문제 하나를 지운다. 기본 문제 파일에 있는 문제는 지울 수 없다. */
        function removeExamExtra(index) {
            ExamBank.removeExtra(index);
            ModalManager.renderExamExtras();
            UIManager.showToast('추가한 문제를 지웠어요.', 'info');
        }

        // 사용자가 그대로 고쳐 쓸 수 있는 예시 JSON 파일을 내려받는다.
        function downloadCategorySample() {
            const sample = {
                "우리반 별명": ["햇살", "구름이", "바다별", "달토끼", "산들바람"],
                "학교 과목": ["국어", "수학", "사회", "과학", "체육", "음악"]
            };
            const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = '카테고리_예시.json';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            UIManager.showToast("예시 파일을 내려받았습니다. 내용을 고쳐서 다시 올려보세요!", "info");
        }

        /**
         * [단어변경] — 점수·시간 차감 없이 판만 새로 깐다.
         * 한 게임에 SHUFFLE_MAX(5)번까지만 쓸 수 있다.
         */
        function resetBoard() {
            // 게임 중이 아니거나 정답 연출 중이면 아무것도 하지 않는다.
            if (!GameState.isGameActive || GameState.isResolving) return;
            // 빠르게 두 번 눌러도 한 번만 나간다 (누름 연출이 끝날 때까지 잠근다).
            if (GameState.isShuffling) return;

            if (GameState.shuffleLeft <= 0) {
                UIManager.showToast('단어변경을 모두 썼어요. 새 게임에서 다시 5번 쓸 수 있어요.', 'warn');
                return;
            }

            GameState.isShuffling = true;
            replayAnimation(shuffleFab, 'spin');
            setTimeout(() => {
                shuffleFab.classList.remove('spin');
                GameState.isShuffling = false;
                UIManager.syncHud();
            }, 400);

            ComboManager.reset();
            // 실제로 판이 바뀐 경우에만 횟수를 깎는다.
            if (generateNewRound()) {
                GameState.shuffleLeft -= 1;
            }
            UIManager.syncHud();
        }

        function stopGame() {
            if (VersusManager.active) {
                cancelVersusMatch();
                return;
            }

            clearInterval(timerInterval);
            QuizManager.reset();       // 모드 2의 힌트 진행도 함께 정리한다
            QuizSession.reset();       // 남은 라운드도 취소한다
            ExamManager.reset();       // 모드 3의 문제 진행도 정리한다
            ExamSession.reset();
            closeQuizCategory();
            hideQuizRoundResult();
            hideQuizFinal();
            hideExamRoundResult();
            Overlay.close('examFinalOverlay');
            GameState.mode = 'solo';
            GameState.score = 0;
            GameState.resetForGameEnd();

            UIManager.clearBoard();
            UIManager.syncHud();
            if (appMode === 'quiz') {
                updateQuizRoundDisplay();
                QuizPanelUI.reset();
            }
            if (appMode === 'exam') {
                updateExamRoundDisplay();
                resetExamPanel();
            }

            const STOP_TOAST = {
                quiz: "게임이 종료되었습니다. '스무고개 시작'을 눌러 새 문제를 받으세요.",
                exam: "문제 풀이를 그만뒀어요. '문제 시작'을 누르면 처음부터 다시 냅니다.",
                classic: "게임이 종료되었습니다. '게임 시작'을 눌러 다시 시작하세요."
            };
            UIManager.showToast(STOP_TOAST[appMode] || STOP_TOAST.classic, "info");
        }

        // 라운드 내부 생성 로직 (제시어는 유지됨)
        /**
         * 판을 새로 깐다.
         * @returns {boolean} 실제로 판이 바뀌었으면 true.
         *   [단어변경]은 이 값이 true 일 때만 횟수를 깎는다 —
         *   낼 단어가 없어 못 바꾼 경우까지 횟수를 먹으면 억울하기 때문이다.
         */
        function generateNewRound() {
            // 모드 2: 정답은 AI가 이미 정해 뒀으므로 보드 글자만 다시 깐다 (셔플도 이 경로를 쓴다).
            if (GameState.mode === 'quiz') {
                if (!QuizManager.active) return false;
                UIManager.renderBoard(GameState.currentBlockCount, [QuizManager.answer]);
                return true;
            }

            // 모드 3: 문제에 정해진 정답으로 글자판을 다시 만든다.
            if (GameState.mode === 'exam') {
                if (!ExamManager.active) return false;
                UIManager.renderBoard(GameState.currentBlockCount, ExamManager.answers);
                return true;
            }

            if (!GameState.currentCategory) return false;

            // 이미 맞힌 단어는 제외하고 새 단어를 낸다.
            // 더 낼 단어가 없으면 = 정답을 다 맞힌 것이므로 게임을 끝낸다.
            const round = Dictionary.pickRound(
                GameState.currentCategory, GameState.currentBlockCount, GameState.solvedWords);
            if (!round) {
                if (GameState.solvedWords.length > 0) {
                    endGameByClear();
                } else {
                    UIManager.showToast("현재 블록 개수로 만들 수 있는 단어 조합이 없습니다. 설정을 변경해주세요.", "warn");
                }
                return false;
            }
            GameState.currentTargetWords = round;

            UIManager.renderBoard(GameState.currentBlockCount, GameState.currentTargetWords);
            return true;
        }

        /**
         * 게임 마무리 공통 처리.
         * @param {boolean} cleared 정답을 모두 맞혀서 끝났으면 true, 시간이 다 됐으면 false
         */
        function finishGame(cleared) {
            clearInterval(timerInterval);

            const isQuiz = GameState.mode === 'quiz';
            const isExam = GameState.mode === 'exam';
            const scoreKind = isQuiz ? 'quiz' : (isExam ? 'exam' : 'classic');
            const finalScore = GameState.score;
            const remainSeconds = GameState.timeLeft;
            const elapsedSeconds = GameState.duration - remainSeconds;
            const solvedCount = GameState.solvedWords.length;
            const quizAnswer = QuizManager.answer;
            const quizCategory = QuizManager.category;
            const quizHintsUsed = QuizManager.shown;
            // 점수 카드는 세션 누적을 보여주므로, 이번 라운드 몫만 따로 떼어 낸다.
            const quizRoundScore = isQuiz ? (finalScore - QuizSession.totalScore) : 0;
            // 모드 3도 세션 누적 점수라 이번 문제 몫만 따로 떼어 낸다.
            const examRoundScore = isExam ? (finalScore - ExamSession.totalScore) : 0;
            const examQuestion = ExamManager.question;
            const examAnswers = ExamManager.answers.slice();
            // 모드 2·3의 최고 기록은 판마다가 아니라 세션이 모두 끝났을 때 한 번만 갱신한다.
            const isNewRecord = (isQuiz || isExam) ? false : StorageManager.trySetHighScore(finalScore, scoreKind);
            GameState.highScore = StorageManager.getHighScore(scoreKind);

            if (cleared) {
                UIManager.spawnConfetti();
                UIManager.flashBoard('success');
            }

            // 모드 2: 힌트 공개를 멈추고 패널 맨 아래에 정답을 남겨 둔다.
            if (isQuiz) QuizManager.finish();
            // 모드 3: 시간이 다 됐든 맞혔든, 패널에 정답을 남겨 둔다.
            if (isExam) ExamManager.finish();

            GameState.resetForGameEnd();
            // 한 판이 끝났으므로 이제 정답 목록을 볼 수 있다. (모드 2·3은 정답 목록을 쓰지 않는다)
            if (!isQuiz && !isExam) GameState.answerListUnlocked = true;

            UIManager.resetSelection();
            UIManager.clearBoard();
            UIManager.syncHud();

            if (cleared) {
                AudioManager.playWin();
            } else {
                AudioManager.playGameOver();
            }

            // 모드 2 결과: 라운드 기록을 쌓고, 다음 라운드로 이어질 수 있는 결과 화면을 띄운다.
            if (isQuiz) {
                if (QuizSession.active) {
                    QuizSession.record({
                        round: QuizSession.round,
                        category: quizCategory,
                        answer: quizAnswer,
                        score: quizRoundScore,
                        cleared: cleared,
                        hintsUsed: quizHintsUsed
                    });
                    showQuizRoundResult({
                        cleared: cleared,
                        answer: quizAnswer,
                        hintsUsed: quizHintsUsed,
                        roundScore: quizRoundScore
                    });
                }
                return;
            }

            // 모드 3 결과: 문제 기록을 쌓고, 정답을 보여주는 결과 화면을 띄운다.
            if (isExam) {
                if (ExamSession.active) {
                    ExamSession.record({
                        round: ExamSession.round,
                        question: examQuestion,
                        answers: examAnswers,
                        solved: ExamManager.solved,
                        score: examRoundScore,
                        cleared: cleared
                    });
                    showExamRoundResult({
                        cleared: cleared,
                        question: examQuestion,
                        answer: examAnswers.join(', '),
                        roundScore: examRoundScore
                    });
                }
                return;
            }

            // 대결 모드에서는 개인 결과 모달 대신 다음 차례 / 최종 결과로 넘어간다.
            if (GameState.mode === 'versus' && VersusManager.active) {
                finishVersusTurn(finalScore);
                return;
            }

            const championResult = LeaderboardManager.submit(currentNickname(), finalScore, 'classic');
            UIManager.updateChampionBanner();
            ModalManager.showGameOver(finalScore, GameState.highScore, isNewRecord, championResult,
                { cleared, remainSeconds, elapsedSeconds, solvedCount: solvedCount });
        }

        function endGameByTimeOut() {
            finishGame(false);
        }

        // 제시어의 정답을 모두 맞혔을 때
        function endGameByClear() {
            finishGame(true);
        }

        function restartFromGameOver() {
            ModalManager.hideGameOver();
            startGame(); // 모드 2에서는 startGame이 카테고리 입력 화면을 연다
        }

        function closeGameOverModal() {
            ModalManager.hideGameOver();
        }

        /**
         * 왼쪽 클릭 — 블록을 누른 순서대로 하나씩 고른다.
         * 이미 고른 블록을 다시 누르면 그 블록부터 뒤를 모두 되돌린다.
         * 잘못 누르고도 되돌릴 방법이 없으면 오답을 낼 수밖에 없어서 넣었다.
         */
        function pickBlock(block) {
            if (!GameState.isGameActive || GameState.isResolving) return;

            const already = GameState.selectedBlocks.indexOf(block);
            if (already !== -1) {
                GameState.selectedBlocks.splice(already)
                    .forEach(b => b.classList.remove('selected'));
                UIManager.drawLines();
                // 되돌리고도 남은 선택이 있으면 그 시점부터 다시 2초를 센다.
                // 하나도 안 남았으면 셀 것이 없으니 꺼 둔다.
                if (GameState.selectedBlocks.length > 0) GameState.armDeselectTimer();
                else GameState.disarmDeselectTimer();
                return;
            }

            GameState.selectedBlocks.push(block);
            block.classList.add('selected');
            UIManager.drawLines();
            // 클릭·드래그·터치 어느 경로로 골랐든 pickBlock을 거치므로 여기 한 곳이면 된다.
            GameState.armDeselectTimer();

            // 정답이 완성되는 순간 오른쪽 클릭을 기다리지 않고 곧바로 판정한다.
            // 되돌리기(위 splice)로 우연히 정답 모양이 되는 경우는 일부러 뺐다.
            // 지우는 중에 갑자기 제출돼 버리면 손쓸 방법이 없다.
            if (isAutoSubmittableWord()) submitSelectedWord();
        }

        /**
         * 지금 고른 블록으로 만들어진 낱말이 '점수가 되는 정답' 인지 본다.
         * 자동 제출은 이 조건에서만 걸린다.
         *
         * 이미 맞힌 낱말을 일부러 뺀 이유 — 더 긴 낱말을 만들려고 짧은 낱말을 지나가는 중에
         * 자동으로 제출되면 콤보가 깨진다. 그때는 예전처럼 오른쪽 클릭으로만 확인한다.
         * 오답도 같은 이유로 자동 제출하지 않는다.
         */
        function isAutoSubmittableWord() {
            if (GameState.selectedBlocks.length < 2) return false;

            const formedWord = GameState.selectedBlocks.map(b => b.textContent).join('');
            if (GameState.mode === 'quiz') return QuizManager.isAnswer(formedWord);
            if (GameState.solvedWords.includes(formedWord)) return false;

            return GameState.currentTargetWords.includes(formedWord)
                || Dictionary.hasWord(GameState.currentCategory, formedWord);
        }

        /**
         * 오른쪽 클릭 — 고르기를 끝내고 낱말을 확인한다.
         * 두 글자가 안 되면 실수로 보고 콤보 손해 없이 선택만 푼다.
         */
        function finishSelection() {
            if (!GameState.isGameActive || GameState.isResolving) return;
            if (GameState.selectedBlocks.length === 0) return;
            if (GameState.selectedBlocks.length < 2) {
                UIManager.resetSelection();
                return;
            }
            submitSelectedWord();
        }

        /**
         * 고른 블록으로 만들어진 낱말의 정답/오답/콤보를 판정한다.
         * 예전에는 드래그를 놓는 순간(mouseup)에 불렀고, 지금은 finishSelection() 이 부른다.
         */
        function submitSelectedWord() {
            // 자동 제출과 오른쪽 클릭이 같은 선택을 두 번 내지 않게 막는 마지막 빗장.
            if (GameState.isResolving) return;
            // 정답이든 오답이든 지금부터는 기존 제출 처리가 선택을 책임진다.
            GameState.disarmDeselectTimer();

            const formedWord = GameState.selectedBlocks.map(b => b.textContent).join('');
            const isQuiz = GameState.mode === 'quiz';
            const isExam = GameState.mode === 'exam';

            // 모드 2는 AI가 몰래 고른 낱말 하나만 정답이다.
            // 모드 3은 문제 파일에 적힌 정답이다 (여러 개면 그중 하나만 만들어도 된다).
            // 모드 1은 글자 수 제한 없음: 이번 판의 목표 단어이거나, 같은 카테고리 사전에 있는 단어면 정답.
            const isCorrect = isQuiz
                ? QuizManager.isAnswer(formedWord)
                : isExam
                    ? ExamManager.isAnswer(formedWord)
                    : (GameState.currentTargetWords.includes(formedWord)
                        || Dictionary.hasWord(GameState.currentCategory, formedWord));

            if (isCorrect) {
                // 모드 3: 맞히는 순간 그 문제가 끝난다. 남은 시간이 곧 점수다.
                if (isExam) {
                    clearInterval(timerInterval);
                    GameState.isGameActive = false;

                    const examGained = ExamManager.points();
                    ExamManager.solved = formedWord;
                    GameState.score += examGained;
                    GameState.solvedWords.push(formedWord);
                    UIManager.updateScoreDisplay();
                    UIManager.popSuccessBlocks(GameState.selectedBlocks);
                    UIManager.spawnConfetti();
                    UIManager.flashBoard('success');
                    UIManager.pulseScore();
                    UIManager.spawnFloatText(`🎯 정답! +${examGained}`, "good");
                    AudioManager.playCorrect();

                    setTimeout(endGameByClear, 620);
                    return;
                }

                // 모드 2: 맞히는 순간 판이 끝난다. 본 힌트가 적을수록 점수가 높다.
                if (isQuiz) {
                    clearInterval(timerInterval);   // 연출 도중 시간 초과로 두 번 끝나지 않게 먼저 멈춘다
                    GameState.isGameActive = false;
                    GameState.isResolving = true;

                    const quizGained = QuizManager.points();
                    GameState.score += quizGained;
                    GameState.solvedWords.push(formedWord);
                    UIManager.updateScoreDisplay();
                    UIManager.popSuccessBlocks(GameState.selectedBlocks);
                    UIManager.spawnConfetti();
                    UIManager.flashBoard('success');
                    UIManager.pulseScore();
                    UIManager.spawnFloatText(`🎯 정답! +${quizGained}`, "good");
                    AudioManager.playCorrect();

                    setTimeout(endGameByClear, 620);
                    return;
                }

                if (GameState.solvedWords.includes(formedWord)) {
                    UIManager.spawnFloatText("이미 찾은 단어예요!", "bad");
                    UIManager.shakeAndGlowBlocks(GameState.selectedBlocks);
                    UIManager.flashBoard('error');
                    AudioManager.playWrong();
                    ComboManager.reset();
                    setTimeout(() => UIManager.resetSelection(), 380);
                    return;
                }

                GameState.isResolving = true;   // 연출이 끝날 때까지 다음 제출을 막는다

                const combo = ComboManager.registerCorrect();
                const gained = 1 + combo.bonus;

                UIManager.popSuccessBlocks(GameState.selectedBlocks);
                UIManager.spawnConfetti();
                UIManager.flashBoard('success');
                UIManager.pulseScore();

                GameState.score += gained;
                GameState.solvedWords.push(formedWord);
                UIManager.updateScoreDisplay();

                if (combo.bonus > 0) {
                    UIManager.spawnFloatText(`🔥 ${combo.comboCount} COMBO! +${gained}`, "combo");
                    AudioManager.playCombo();
                } else {
                    const label = GOOD_LABELS[Math.floor(Math.random() * GOOD_LABELS.length)];
                    UIManager.spawnFloatText(`+${gained} ${label}`, "good");
                    AudioManager.playCorrect();
                }

                setTimeout(() => {
                    // 맞히면 곧바로 새 단어 조합의 판으로 교체한다.
                    // 더 이상 낼 단어가 없으면 generateNewRound가 게임을 끝낸다.
                    GameState.isResolving = false;
                    generateNewRound();
                }, 480);
            } else {
                UIManager.spawnFloatText("오답이에요!", "bad");
                UIManager.shakeAndGlowBlocks(GameState.selectedBlocks);
                UIManager.flashBoard('error');
                AudioManager.playWrong();
                ComboManager.reset();
                setTimeout(() => UIManager.resetSelection(), 380);
            }
        }

        /* =========================================================
           초기화 (페이지 로드 시 1회 실행)
        ========================================================= */
        /**
         * 진입점. 카테고리·단어 JSON을 먼저 기다린 뒤(로딩 중이거나 실패했으면 [게임 시작]이
         * 안내만 하고 시작하지 않는다 — beginPlay() 의 dictionaryReady 확인 참고) 나머지
         * 화면과 이벤트를 그대로 초기화한다. loadWordCategories() 는 실패해도 던지지 않으므로
         * 사전과 무관한 모드 2·3, 설정, 배경 같은 화면은 실패 여부와 상관없이 정상적으로 뜬다.
         */
        async function initGame() {
            await loadWordCategories();

            // 모드 1 설정을 저장값으로 되돌린다. 지난번에 정한 블록 개수와 카테고리로 바로 시작할 수 있다.
            // (저장해 둔 카테고리가 지워졌으면 populateCategorySelect 가 '랜덤'으로 되돌린다)
            dom('blockCount').value = StorageManager.getBlockCount();
            ModalManager.populateCategorySelect(StorageManager.getCategoryOption());
            ModalManager.renderCustomCategories();
            GameState.highScore = StorageManager.getHighScore();
            UIManager.updateHighScoreDisplay();
            UIManager.updateCategoryDisplay();
            dom('howToDeselectNote').textContent =
                `글자 선택 후 ${AUTO_DESELECT_MS / 1000}초 동안 추가 선택이 없으면 선택이 자동으로 해제됩니다.`;

            // 저장된 닉네임 / 배경 복원
            dom('nickname').value = StorageManager.getNickname();
            BackgroundManager.apply(StorageManager.getBackground(), false);
            ModalManager.syncBackgroundPicker();

            // 배경 선택 버튼 이벤트 (배경1~4 + 기본)
            dom('bgPicker').addEventListener('click', (e) => {
                const option = e.target.closest('.bg-option');
                if (!option) return;
                selectBackground(option.dataset.bg);
            });

            // 카테고리를 바꾸면 시작 전 제시어 표시도 즉시 따라간다.
            dom('categorySelect').addEventListener('change', () => {
                UIManager.updateCategoryDisplay();
            });

            // 파일로 추가한 카테고리 삭제 버튼
            dom('customCatList').addEventListener('click', (e) => {
                const button = e.target.closest('.cc-del');
                if (!button) return;
                const name = button.dataset.category;
                if (!confirm(`'${name}' 카테고리를 목록에서 지울까요?`)) return;
                CategoryManager.remove(name);
                ModalManager.populateCategorySelect('random');
                ModalManager.renderCustomCategories();
                UIManager.updateCategoryDisplay();
                UIManager.showToast(`'${name}' 카테고리를 삭제했습니다.`, "info");
            });

            // 모드 3에서 파일로 더 넣은 문제의 [삭제]. 위와 같은 이유로 목록 한 곳에서 위임받는다.
            dom('examExtraList').addEventListener('click', (e) => {
                const button = e.target.closest('.cc-del');
                if (!button) return;
                const index = parseInt(button.dataset.examIndex, 10);
                if (!Number.isFinite(index)) return;
                if (!confirm('추가한 이 문제를 목록에서 지울까요?')) return;
                removeExamExtra(index);
            });

            /* 블록은 판마다 새로 만들어지므로 리스너를 블록마다 달지 않고 보드 한 곳에서 위임받는다.
               왼쪽 클릭으로 고르고, 오른쪽 클릭으로 고르기를 끝낸다. */
            board.addEventListener('click', (e) => {
                const block = e.target.closest('.block');
                if (block) pickBlock(block);
            });

            /* 오른쪽 클릭은 브라우저 메뉴 대신 '고르기 끝'으로 쓴다.
               블록 사이 빈틈에서 눌러도 되도록 보드가 아니라 보드 영역 전체에서 받는다.
               다만 힌트 패널 글은 그대로 복사할 수 있게 브라우저 메뉴를 남겨 둔다. */
            boardContainer.addEventListener('contextmenu', (e) => {
                if (e.target.closest('#hintPanel')) return;
                e.preventDefault();
                finishSelection();
            });

            // 창 크기가 바뀌면 캔버스 크기와 블록 좌표를 다시 재서 선이 어긋나지 않게 한다.
            window.addEventListener('resize', () => {
                UIManager.resizeCanvas();
                UIManager.cacheBlockCenters();
                UIManager.drawLines();
            });

            /* 모드 2 카테고리 고르기.
               키보드만으로도 쓸 수 있게 두 가지를 단다 —
               화살표/글자키로 고르면 change 가 나면서 [문제 받기] 가 열리고,
               Enter 로 바로 문제를 받는다. (select 는 폼이 없으면 Enter 가 아무 일도 안 한다) */
            dom('quizCategorySelect').addEventListener('change', syncQuizStartButton);
            dom('quizCategorySelect').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    startQuizRound();
                }
            });

            // 모드 스위치 초기 상태 (기본은 모드 1)
            applyModeUI();

            // 기록 1위 챔피언 뱃지 배너
            UIManager.updateChampionBanner();
            UIManager.updateVersusBar();
        }

        initGame();
