// Design Ref: §3.1 / §9.4 — Domain 계층 엔티티. 모드 3(산업재산권 문제) 한 문제의 상태만 담는다.
// Design Ref: §1.2 — 정답은 서버에만 있고 클라이언트로 나가지 않는다 (toClientPayload 참고).
// QuizRound 와 나란한 위치이며, 다른 점은 힌트가 없고 정답이 여러 개일 수 있다는 것뿐이다.

class ExamRound {
    /**
     * @param {Object} params
     * @param {number} params.roundIndex 1부터 시작하는 문제 번호
     * @param {string} params.question 문제 문장
     * @param {string[]} params.answers 정답 목록 (파일에 쉼표로 나눠 적은 것)
     * @param {string[]} params.board 블록에 깔 글자 (정답 글자 + 채움 글자, 섞은 것)
     */
    constructor({ roundIndex, question, answers, board }) {
        this.roundIndex = roundIndex;
        this.question = question;
        this.answers = answers;
        this.board = board;
        this.solved = false;
    }

    /**
     * 정답 판정. 공백 차이는 무시한다.
     *
     * **정답이 여러 개인 문제는 그중 하나만 만들어도 맞은 것으로 본다.**
     * 짧은 제한 시간 안에 블록으로 여러 낱말을 잇달아 만드는 것은 사실상 불가능해서다
     * (혼자 하기 모드 3과 같은 규칙). 결과 화면에서는 정답을 전부 보여 준다.
     *
     * 먼저 맞힌 한 명만 득점하도록 `solved` 를 이 안에서 세운다.
     * @returns {{correct: boolean, alreadySolved: boolean}}
     */
    checkAnswer(word) {
        const guess = normalize(word);
        if (!guess || !this.answers.some((answer) => normalize(answer) === guess)) {
            return { correct: false, alreadySolved: false };
        }
        if (this.solved) {
            return { correct: false, alreadySolved: true };
        }
        this.solved = true;
        return { correct: true, alreadySolved: false };
    }

    /** 결과 화면에 보여 줄 정답 문자열 (여러 개면 쉼표로 잇는다) */
    answerText() {
        return this.answers.join(', ');
    }

    /** 클라이언트로 내보내도 안전한 페이로드 — 정답은 빼고 문제와 보드만 보낸다 */
    toClientPayload(totalRounds) {
        return {
            roundIndex: this.roundIndex,
            totalRounds,
            question: this.question,
            // 정답이 몇 개인지는 알려 준다. 정답 자체가 아니라 '몇 개를 낼 수 있나'라는 안내다.
            answerCount: this.answers.length,
            board: this.board
        };
    }
}

function normalize(word) {
    return String(word == null ? '' : word).replace(/\s+/g, '');
}

module.exports = { ExamRound };
