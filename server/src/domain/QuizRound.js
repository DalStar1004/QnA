// Design Ref: §3.1 / §9.4 — Domain 계층 엔티티. 스무고개 한 라운드의 상태와 규칙만 담는다.
// Design Ref: §1.2 — 정답(answer)과 아직 열지 않은 힌트는 서버에만 있고 클라이언트로 나가지 않는다.
// 단어 연결(Round)과 마찬가지로 `solved` 플래그가 "먼저 맞힌 한 명만 득점" 을 보장한다.

class QuizRound {
    /**
     * @param {Object} params
     * @param {number} params.roundIndex 1부터 시작하는 라운드 번호
     * @param {string} params.category 이번 판의 카테고리
     * @param {string} params.answer 정답 낱말 (사전에서 고른다)
     * @param {string[]} params.hints 열어 줄 힌트 목록 (막연한 것부터 순서대로)
     * @param {string[]} params.board 블록에 깔 글자 (정답 글자 + 채움 글자, 섞은 것)
     * @param {boolean} params.aiGenerated LLM 힌트가 섞여 있는지 (없으면 확정 힌트만)
     */
    constructor({ roundIndex, category, answer, hints, board, aiGenerated }) {
        this.roundIndex = roundIndex;
        this.category = category;
        this.answer = answer;
        this.hints = hints;
        this.board = board;
        this.aiGenerated = Boolean(aiGenerated);
        this.shown = 0;      // 지금까지 열어 준 힌트 수
        this.solved = false;
    }

    /**
     * 지금 맞히면 몇 점인가. 혼자 하기 모드 2와 같은 계산이다 —
     * **힌트를 적게 보고 맞힐수록 높은 점수.** 첫 힌트만 보고 맞히면 만점(힌트 수만큼)이다.
     */
    points() {
        const used = Math.max(1, this.shown);
        return Math.max(1, this.hints.length + 1 - used);
    }

    /** 아직 열지 않은 힌트가 남아 있는가 */
    hasMoreHints() {
        return this.shown < this.hints.length;
    }

    /**
     * 힌트를 하나 연다.
     * @returns {{index: number, total: number, text: string}|null} 더 열 것이 없으면 null
     */
    revealNextHint() {
        if (!this.hasMoreHints()) return null;
        const text = this.hints[this.shown];
        this.shown += 1;
        return { index: this.shown, total: this.hints.length, text };
    }

    /**
     * 정답 판정. 공백과 대소문자 차이는 무시하고, 낱말이 정확히 같을 때만 인정한다.
     * 먼저 맞힌 사람만 득점하도록 `solved` 를 이 안에서 세운다(Round.checkAnswer 와 같은 방식).
     *
     * @returns {{correct: boolean, alreadySolved: boolean}}
     */
    checkAnswer(word) {
        const guess = normalize(word);
        if (!guess || guess !== normalize(this.answer)) {
            return { correct: false, alreadySolved: false };
        }
        if (this.solved) {
            return { correct: false, alreadySolved: true };
        }
        this.solved = true;
        return { correct: true, alreadySolved: false };
    }

    /** 클라이언트로 내보내도 안전한 페이로드 (정답과 아직 안 연 힌트는 빼고 보낸다) */
    toClientPayload(totalRounds) {
        return {
            roundIndex: this.roundIndex,
            totalRounds,
            category: this.category,
            hintTotal: this.hints.length,
            board: this.board,
            aiGenerated: this.aiGenerated
        };
    }
}

function normalize(word) {
    return String(word == null ? '' : word).replace(/\s+/g, '');
}

module.exports = { QuizRound };
