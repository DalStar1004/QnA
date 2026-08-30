// Design Ref: §3.1 / §9.4 — Domain 계층 엔티티. 순수 게임 규칙만 담고 I/O는 하지 않는다.
// Plan SC: 동시 정답 제출 시 정확히 1명만 승자가 되어야 함 → `solved` 플래그가 그 가드 역할을 한다.

const { getWordsFittingBoard, hasWord, randomFillerChar } = require('./dictionary');

// 한 글자짜리는 단어로 보지 않는다 (혼자 하기 모드와 같은 기준)
const MIN_ANSWER_LENGTH = 2;

class Round {
    constructor({ roundIndex, category, targetWords, board }) {
        this.roundIndex = roundIndex;
        this.category = category;
        this.targetWords = targetWords; // 서버 메모리에만 존재 — 클라이언트로 절대 전송하지 않는다 (Design §1.2)
        this.board = board;
        this.solved = false;
    }

    /**
     * Plan SC: 먼저 맞힌 사람만 득점.
     * Node.js는 단일 스레드로 이벤트를 순차 처리하므로, 이 메서드 안에서 `solved`를
     * 확인하고 곧바로 세팅하면 두 제출이 동시에 correct:true를 받을 수 없다.
     *
     * 목표 글자 수 설정을 없앤 뒤로는 **글자 수를 가리지 않는다.** 보드에 깔린 글자로 만들 수 있고
     * 이번 판 카테고리의 단어이기만 하면 정답으로 인정한다(혼자 하기 모드와 같은 규칙).
     * 보드에 심어 둔 목표 단어 2개는 "적어도 두 개는 반드시 만들 수 있다"를 보장하는 장치일 뿐,
     * 정답의 전부가 아니다.
     *
     * @returns {{correct: boolean, alreadySolved: boolean}}
     */
    checkAnswer(word) {
        if (!this.isAcceptableWord(word)) {
            return { correct: false, alreadySolved: false };
        }
        if (this.solved) {
            // 정답 단어이긴 하지만 이미 다른 사람이 먼저 맞힌 경우
            return { correct: false, alreadySolved: true };
        }
        this.solved = true;
        return { correct: true, alreadySolved: false };
    }

    /** 이번 판의 카테고리 단어이면서, 보드에 있는 글자만으로 만들 수 있는가 */
    isAcceptableWord(word) {
        if (typeof word !== 'string' || word.length < MIN_ANSWER_LENGTH) {
            return false;
        }
        if (!hasWord(this.category, word)) {
            return false;
        }
        return canBuildFromBoard(word, this.board);
    }

    /** 클라이언트로 내보내도 안전한 페이로드 (targetWords는 포함하지 않는다) */
    toClientPayload() {
        return {
            board: this.board,
            roundIndex: this.roundIndex
        };
    }
}

function shuffled(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/** 보드에 깔린 글자만으로 그 단어를 만들 수 있는지 확인한다 (같은 글자를 두 번 쓰려면 블록도 2개 필요) */
function canBuildFromBoard(word, board) {
    const remaining = board.slice();
    for (const char of word) {
        const at = remaining.indexOf(char);
        if (at === -1) {
            return false;
        }
        remaining.splice(at, 1);
    }
    return true;
}

/**
 * Design Ref: §2.2 — 보드는 반드시 서버가 1회 생성해 방 전체에 브로드캐스트한다.
 * 정답 단어 2개의 글자를 넣고, 남는 칸은 흔한 음절로 채운 뒤 전체를 섞는다.
 *
 * 목표 글자 수 설정이 사라졌으므로 길이는 서버가 고른다. 보드에 들어갈 수 있는 단어 중에서
 * 무작위로 두 개를 뽑기 때문에 '사과'와 '파인애플'처럼 길이가 서로 달라도 된다.
 */
function createRound({ roundIndex, category, blockCount, exclude }) {
    const used = exclude || [];
    // 이미 맞힌 낱말은 이번 판의 목표로 삼지 않는다. 그 낱말은 중복으로 되돌려 보내므로,
    // 목표로 심어 두면 "보드에 있는데 정답이 아닌" 이상한 판이 된다.
    const fitting = getWordsFittingBoard(category, blockCount);
    const fresh = fitting.filter((word) => used.indexOf(word) === -1);
    const candidates = shuffled(fresh.length >= 2 ? fresh : fitting);
    const targetWords = [candidates[0], candidates[1]];

    let chars = [];
    targetWords.forEach((word) => {
        chars = chars.concat(word.split(''));
    });
    while (chars.length < blockCount) {
        chars.push(randomFillerChar());
    }

    return new Round({
        roundIndex,
        category,
        targetWords,
        board: shuffled(chars)
    });
}

module.exports = { Round, createRound, MIN_ANSWER_LENGTH };
