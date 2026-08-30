// Design Ref: §9.4 — Domain 계층. 힌트 문장을 만들고 다듬는 순수 함수 모음이며 I/O가 없다.
// word_connection_game.html 의 QuizContent 를 서버로 옮긴 것이다.
// LLM 응답이 있든 없든 이 규칙은 항상 필요하므로, LLM 호출부(infrastructure)와 떼어 두었다.

const { getWords, randomFillerChar } = require('./dictionary');

const HINT_TOTAL = 6;          // 한 라운드에 열어 주는 힌트 수
const LLM_HINT_REQUEST = 6;    // LLM 에는 넉넉히 요청한다 (걸러질 몫까지)
const LLM_HINT_MIN = 2;        // 걸러내고 이만큼도 안 남으면 다시 요청한다

const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/**
 * 힌트에 쓸 수 있는 글자만 추린 화이트리스트.
 * 한글(음절·자모), 숫자, 공백, 흔한 문장부호까지만 허용한다.
 * 작은 로컬 모델은 한국어로만 쓰라고 해도 영어·한자를 섞는 일이 잦은데,
 * 그런 힌트는 고쳐 쓰기보다 통째로 버리는 편이 낫다. 확정 힌트 3개가 항상 뒤에 붙으므로
 * 몇 개가 버려져도 문제는 풀 수 있다.
 */
const HINT_ALLOWED_RE = /^[가-힣ㄱ-ㅎㅏ-ㅣ0-9\s.,!?'"()[\]·…~%-]+$/;

/** '수박' -> 'ㅅ ㅂ' */
function initials(word) {
    return word.split('').map((ch) => {
        const code = ch.charCodeAt(0) - 0xAC00;
        if (code < 0 || code > 11171) return ch;
        return CHOSUNG[Math.floor(code / 588)];
    }).join(' ');
}

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * LLM 이 준 힌트 한 줄을 게임에 쓸 수 있게 다듬는다.
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

/** 힌트 묶음에서 쓸 수 있는 것만 남긴다. 몇 개가 살아남았는지로 재요청을 판단한다. */
function cleanHints(rawHints, answer) {
    return (rawHints || []).map((hint) => sanitizeHint(hint, answer)).filter(Boolean);
}

/** 어떤 힌트가 나오든 마지막에는 반드시 풀 수 있도록 붙이는 확정 힌트 3개 */
function closingHints(answer) {
    return [
        `글자 수는 ${answer.length}글자예요.`,
        `초성은 "${initials(answer)}" 예요.`,
        `첫 글자는 '${answer.charAt(0)}'(으)로 시작해요.`
    ];
}

/**
 * LLM 힌트 + 확정 힌트를 합쳐 최대 HINT_TOTAL개의 목록을 만든다.
 * 확정 힌트는 절대 잘리지 않도록 LLM 힌트 쪽을 먼저 줄인다.
 * LLM 힌트가 하나도 없으면(= AI 연결 실패) 확정 힌트만으로도 게임은 진행된다.
 */
function assembleHints(answer, rawHints) {
    const closing = closingHints(answer);
    const room = Math.max(0, HINT_TOTAL - closing.length);
    return cleanHints(rawHints, answer).slice(0, room).concat(closing);
}

/**
 * 카테고리에서 정답 낱말을 하나 고른다. 정답은 언제나 사전에서 나온다(제시어와 어긋나지 않게).
 * 보드에 정답 글자가 모두 들어가야 하므로 블록 개수보다 긴 낱말은 뺀다.
 */
function pickAnswer(category, blockCount, exclude) {
    const used = exclude || [];
    const fits = getWords(category).filter((word) => word.length <= blockCount);
    const pool = fits.filter((word) => used.indexOf(word) === -1);
    const source = pool.length > 0 ? pool : fits;
    if (source.length === 0) return null;
    return source[Math.floor(Math.random() * source.length)];
}

function shuffled(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * 스무고개 보드를 만든다. 혼자 하기 모드 2와 같은 방식이다 —
 * 정답 글자를 먼저 넣고 남는 칸은 흔한 음절로 채운 뒤 전체를 섞는다.
 * 정답을 **블록을 이어서** 만들어야 하므로 보드에 정답 글자가 반드시 들어 있어야 한다.
 */
function buildQuizBoard(answer, blockCount) {
    const chars = answer.split('');
    while (chars.length < blockCount) {
        chars.push(randomFillerChar());
    }
    return shuffled(chars);
}

module.exports = {
    HINT_TOTAL,
    LLM_HINT_REQUEST,
    LLM_HINT_MIN,
    initials,
    sanitizeHint,
    cleanHints,
    closingHints,
    assembleHints,
    pickAnswer,
    buildQuizBoard
};
