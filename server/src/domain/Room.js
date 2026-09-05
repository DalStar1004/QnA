// Design Ref: §3.1 / §9.4 — Domain 계층 엔티티. 방의 상태와 규칙(정원, 시작 가능 여부, 방장 위임)만 담당한다.
// 이 클래스는 소켓/타이머 API를 직접 호출하지 않는다. `timerHandle`은 Application이 만들어 맡겨 두는
// 불투명한 보관용 값일 뿐이다 (Design §3.1의 Room 인터페이스 정의를 그대로 따름).

const MAX_PLAYERS = 8;
const MIN_PLAYERS_TO_START = 2;
// 게임 시간은 방장이 정한다. 기본값과 허용 범위만 도메인이 들고 있는다.
const GAME_DURATION_SECONDS = 60;
const MIN_GAME_DURATION_SECONDS = 30;
const MAX_GAME_DURATION_SECONDS = 300;

// 이 방에서 무슨 게임을 하는가. 방장이 대기실에서 고른다.
const GameMode = {
    WORD: 'word',   // 제시어 맞추기 — 블록을 이어 카테고리 단어를 만든다
    QUIZ: 'quiz',   // AI 스무고개 — 힌트를 보고 정답 낱말을 맞힌다
    EXAM: 'exam'    // 산업재산권 문제 — 문제 파일에 있는 문제를 순서대로 푼다
};

const MIN_QUIZ_ROUNDS = 1;
const MAX_QUIZ_ROUNDS = 10;

// 모드 3: 한 문제에 주는 시간. 혼자 하기와 같은 기본값·범위를 쓴다.
const EXAM_SECONDS_PER_QUESTION = 10;
const MIN_EXAM_SECONDS = 5;
const MAX_EXAM_SECONDS = 120;

const RoomStatus = {
    WAITING: 'waiting',
    PLAYING: 'playing',
    ENDED: 'ended'
};

class Room {
    constructor(code, hostId) {
        this.code = code;
        this.hostId = hostId;
        this.players = new Map();
        this.status = RoomStatus.WAITING;
        this.mode = GameMode.WORD;
        this.settings = { blockCount: 16, category: 'random', durationSeconds: GAME_DURATION_SECONDS };
        // 스무고개는 시간이 아니라 라운드 수로 끝난다. 그래서 설정을 따로 둔다.
        this.quizSettings = { rounds: 5, blockCount: 16, category: 'random' };
        /* 모드 3도 설정을 따로 둔다. 세 모드는 판의 성격이 달라 알맞은 블록 개수가 서로 다르므로
           (혼자 하기에서 겪은 것과 같은 이유) 값을 나눠 쓰지 않는다.
           문제 수는 방장이 정하지 않는다 — 문제 파일에 있는 것을 처음부터 끝까지 낸다. */
        this.examSettings = { blockCount: 12, secondsPerQuestion: EXAM_SECONDS_PER_QUESTION };
        this.examRound = null;
        this.examQuestions = [];   // 이번 게임에서 낼 문제 목록 (파일에 적힌 순서 그대로)
        // settings.category가 'random'일 수 있으므로, 실제로 뽑힌 카테고리는 따로 보관한다
        this.activeCategory = null;
        this.currentRound = null;
        this.quizRound = null;
        // 다음 라운드 문제를 미리 만들어 두는 Promise (Application 이 맡겨 두는 보관용 값)
        this.prefetch = null;
        // 한 세션 안에서 같은 낱말이 다시 나오지 않게 기억해 둔다
        this.usedAnswers = [];
        // 제시어 맞추기에서 이미 맞힌 낱말 — 다시 제출하면 '중복'으로 되돌려 보낸다
        this.solvedWords = [];
        this.roundIndex = 0;
        this.timerHandle = null;
        this.timeLeft = GAME_DURATION_SECONDS;
        this.createdAt = Date.now();
    }

    addPlayer(player) {
        this.players.set(player.id, player);
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        this.players.delete(playerId);
        return player;
    }

    getPlayer(playerId) {
        return this.players.get(playerId);
    }

    hasPlayer(playerId) {
        return this.players.has(playerId);
    }

    isFull() {
        return this.players.size >= MAX_PLAYERS;
    }

    isEmpty() {
        return this.players.size === 0;
    }

    isPlaying() {
        return this.status === RoomStatus.PLAYING;
    }

    isHost(playerId) {
        return this.hostId === playerId;
    }

    canStart() {
        return this.players.size >= MIN_PLAYERS_TO_START;
    }

    /** 방장이 나갔을 때 남은 참가자 중 첫 번째에게 방장을 위임한다 (Design §6.2) */
    assignNextHost() {
        const nextHost = this.players.keys().next();
        this.hostId = nextHost.done ? null : nextHost.value;
        return this.hostId;
    }

    resetScores() {
        this.players.forEach((player) => player.resetScore());
    }

    playersPayload() {
        return Array.from(this.players.values()).map((player) => player.toJSON());
    }

    /** 점수 내림차순 정렬 — 게임오버 순위표용 (Design §4.2 `game:over`) */
    rankedPlayers() {
        return this.playersPayload().sort((a, b) => b.score - a.score);
    }
}

module.exports = {
    Room,
    RoomStatus,
    GameMode,
    MIN_QUIZ_ROUNDS,
    MAX_QUIZ_ROUNDS,
    EXAM_SECONDS_PER_QUESTION,
    MIN_EXAM_SECONDS,
    MAX_EXAM_SECONDS,
    MAX_PLAYERS,
    MIN_PLAYERS_TO_START,
    GAME_DURATION_SECONDS,
    MIN_GAME_DURATION_SECONDS,
    MAX_GAME_DURATION_SECONDS
};
