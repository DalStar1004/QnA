// Design Ref: Gemini API 클라이언트 (시험 구현). Node 서버에서만 호출한다.
// API 키는 이 모듈 안에서만 process.env.GEMINI_API_KEY 를 읽고, 절대 로그·응답·예외 메시지에
// 그대로 싣지 않는다 — 실패해도 "무엇이 잘못됐는지"만 알리고 "무엇을 보냈는지"는 알리지 않는다.
//
// 정답은 언제나 사전(quiz-data/word-categories.json)에서 고른 뒤 이 모듈에는 힌트만 맡긴다.
// OllamaHintGenerator 와 같은 이유·같은 형식이다 (server/src/infrastructure/OllamaHintGenerator.js 참고).

const {
    LLM_HINT_MIN,
    cleanHints
} = require('../domain/quizContent');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT = 20000;
const MAX_ATTEMPTS = 2; // Gemini는 콜드 로드가 없으므로 Ollama보다 적게 재시도한다 (비용 보호)

// Ollama 쪽(LLM_HINT_REQUEST=6, quizContent.js)과 다르다 — 여기서는 responseSchema로
// "정확히 이 개수"를 강제하므로 넉넉히 요청해 걸러내는 방식 대신 딱 맞게 요청한다.
const HINT_COUNT = 3;

// 사용자 메시지에만 "한글로 쓰라"고 적으면 힌트를 통째로 영어로 쓰는 일이 잦다 (Ollama에서 확인한 것과 같은 문제).
const SYSTEM_INSTRUCTION =
    '당신은 한국어 스무고개 출제자입니다. 설명 없이 요청된 JSON 한 개만 출력합니다.\n'
    + '절대 규칙: 출력에 쓸 수 있는 문자는 한글과 숫자와 기본 문장부호뿐입니다. '
    + '영어 알파벳(a-z, A-Z), 한자, 가나, 이모지를 단 한 글자도 쓰지 마십시오. '
    + '영어 단어가 떠오르면 반드시 한글 뜻이나 한글 표기로 바꿔 쓰십시오. '
    + '마크다운 문법(굵게, 목록, 코드블록)도 쓰지 마십시오.';

const HINT_TEMPERATURE = 0.3;

// Gemini의 구조화된 출력(response schema). 최상위는 hints 하나뿐인 객체, hints는
// 문자열 3개짜리 배열로 고정한다 — 모델이 다른 속성을 더 넣거나 개수를 벗어나는 것을
// 스키마 단계에서부터 막는다. (Gemini generateContent API의 OpenAPI 서브셋 Schema 형식)
const HINT_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        hints: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            minItems: HINT_COUNT,
            maxItems: HINT_COUNT
        }
    },
    required: ['hints']
};

function getApiKey() {
    return process.env.GEMINI_API_KEY || '';
}

function getModel() {
    return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function isConfigured() {
    return getApiKey().length > 0;
}

/** 정답이 이미 정해져 있을 때 쓰는 프롬프트. 모델이 낱말을 지어낼 여지를 없앤다. */
function buildHintPrompt(answer, category) {
    return [
        `카테고리: "${category}"`,
        `정답: "${answer}"`,
        '',
        `이 정답을 맞히기 위한 스무고개 힌트를 정확히 ${HINT_COUNT}개 만드세요.`,
        '   - 1번이 가장 막연하고, 뒤로 갈수록 구체적이어야 합니다.',
        `   - 힌트에 "${answer}" 를 그대로 쓰거나 정답의 글자를 그대로 노출하면 안 됩니다.`,
        '   - 각 힌트는 40자 이내의 한국어 한 문장입니다.',
        '   - 사실만 쓰세요. 확실하지 않은 내용은 아예 빼세요.',
        '   - 서로 겹치거나 같은 내용을 반복하는 힌트를 만들지 마세요.',
        '',
        '★ 가장 중요한 규칙: 한글과 숫자만 쓰세요.',
        '  영어 알파벳, 한자, 일본어, 그 밖의 외국 문자를 한 글자라도 섞으면 안 됩니다.'
    ].join('\n');
}

/** ```json ... ``` 처럼 코드펜스로 통째로 감싸 왔을 때만 벗겨낸다. 그 외 잡음은 건드리지 않는다. */
function stripJsonFence(text) {
    const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1] : text;
}

/**
 * 응답 문자열을 힌트 배열로 바꾼다. 느슨하게 아무 텍스트나 힌트로 받아들이지 않는다.
 *   1) 정상 JSON 객체인지 (필요할 때만 코드펜스를 벗기고 한 번 더 시도)
 *   2) 최상위가 배열이 아닌 객체인지
 *   3) hints 가 배열이고 정확히 HINT_COUNT 개인지
 *   4) 전부 비어 있지 않은 문자열인지, 서로 중복되지 않는지
 * 여기까지 통과한 뒤에야 기존 cleanHints()(정답 노출 방지 등)를 그대로 돌린다.
 * @returns {string[]|null} 통과하면 다듬어진 힌트, 아니면 null(재시도 대상)
 */
function parseHintsJson(content, answer) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return null;

    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        const unfenced = stripJsonFence(trimmed);
        if (unfenced === trimmed) return null;
        try {
            parsed = JSON.parse(unfenced);
        } catch (error2) {
            return null;
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const rawHints = parsed.hints;
    if (!Array.isArray(rawHints) || rawHints.length !== HINT_COUNT) return null;
    if (!rawHints.every((h) => typeof h === 'string' && h.trim().length > 0)) return null;

    const trimmedHints = rawHints.map((h) => h.trim());
    if (new Set(trimmedHints).size !== trimmedHints.length) return null; // 중복 힌트

    const hints = cleanHints(trimmedHints, answer);
    return hints.length >= LLM_HINT_MIN ? hints : null;
}

/**
 * candidates[0].content.parts 에서 **최종 답변 part만** 골라 이어 붙인다.
 * Gemini 3.8 Flash 같은 "사고 과정"(thinking) 모델은 같은 parts 배열 안에
 * thought:true 인 part(속으로 생각한 내용)와 최종 답변 part를 함께 돌려줄 수 있다.
 * thought part를 함께 이어 붙이면 JSON 앞뒤에 딴 텍스트가 섞여 파싱이 깨진다
 * (실제로 겪은 "Gemini 응답 형식이 올바르지 않습니다" 실패의 원인이었다).
 * 사고 과정 내용 자체는 반환하지 않는다 — 로그에도, 화면에도 나가지 않는다.
 */
function extractAnswerText(data) {
    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    if (!candidate) {
        return { text: '', finishReason: null, candidateCount: data && Array.isArray(data.candidates) ? data.candidates.length : 0 };
    }
    const parts = (candidate.content && Array.isArray(candidate.content.parts)) ? candidate.content.parts : [];
    const text = parts
        .filter((part) => part && typeof part.text === 'string' && part.thought !== true)
        .map((part) => part.text)
        .join('');
    return { text, finishReason: candidate.finishReason || null, candidateCount: 1 };
}

/**
 * 응답이 사용량 제한이나 원인 문구에 API 키를 실어 돌려주는 일은 없지만,
 * 혹시 모를 경우까지 방어적으로 키 값을 지우고 짧은 한국어 사유로 바꾼다.
 */
function sanitizeError(error, fallbackMessage) {
    const apiKey = getApiKey();
    let message = String((error && error.message) || fallbackMessage || '알 수 없는 오류');
    if (apiKey && message.includes(apiKey)) {
        message = message.split(apiKey).join('[REDACTED]');
    }
    const safe = new Error(message);
    safe.status = error && error.status;
    return safe;
}

async function callGemini(prompt, timeoutMs) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
    }
    const model = getModel();
    const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            // 키를 URL(쿼리스트링)이 아니라 헤더로 보낸다 — 요청 URL은 로그·프록시에 남기 쉽다.
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: HINT_TEMPERATURE,
                    maxOutputTokens: 400,
                    responseMimeType: 'application/json',
                    responseSchema: HINT_RESPONSE_SCHEMA
                }
            }),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Gemini 응답 시간이 초과됐습니다');
        }
        throw sanitizeError(error, 'Gemini에 연결할 수 없습니다');
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        // 응답 본문은 그대로 노출하지 않는다 — 상태 코드만으로 원인을 구분해 안내한다.
        if (res.status === 401 || res.status === 403) {
            throw new Error(`Gemini 인증에 실패했습니다 (HTTP ${res.status})`);
        }
        if (res.status === 429) {
            throw new Error('Gemini 사용량 제한에 걸렸습니다 (HTTP 429)');
        }
        if (res.status === 404) {
            throw new Error(`'${model}' 모델을 찾을 수 없습니다 (HTTP 404)`);
        }
        throw new Error(`Gemini API 오류 (HTTP ${res.status})`);
    }

    let data;
    try {
        data = await res.json();
    } catch (error) {
        throw new Error('Gemini 응답을 읽지 못했습니다');
    }
    return data;
}

/**
 * 정답이 이미 정해진 상태에서 힌트만 받아 온다. 검사에 걸린 응답은 몇 번 다시 받아 본다.
 * @returns {Promise<string[]>} 다듬어진 힌트 목록 (LLM_HINT_MIN 개 이상)
 */
async function generateHints(answer, category) {
    if (!isConfigured()) {
        throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
    }
    const prompt = buildHintPrompt(answer, category);

    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const data = await callGemini(prompt, REQUEST_TIMEOUT);
            const { text, finishReason, candidateCount } = extractAnswerText(data);

            if (candidateCount === 0) {
                lastError = new Error('Gemini가 응답 후보를 돌려주지 않았습니다');
                continue;
            }
            if (!text) {
                // 사고 과정만 오고 최종 답변 part가 비어 있는 경우 등. finishReason만 참고용으로 남긴다
                // (실제 내용은 절대 로그로 남기지 않는다).
                lastError = finishReason && finishReason !== 'STOP'
                    ? new Error(`Gemini 응답이 완전하지 않습니다 (finishReason: ${finishReason})`)
                    : new Error('Gemini 응답에서 최종 답변을 찾지 못했습니다');
                continue;
            }

            const hints = parseHintsJson(text, answer);
            if (hints) return hints;
            lastError = new Error('Gemini 응답 형식이 올바르지 않습니다');
        } catch (error) {
            lastError = sanitizeError(error);
            // 인증 실패·모델 없음은 다시 시도해도 똑같이 실패하므로 바로 포기한다.
            if (/인증|모델을 찾을 수 없|설정되지 않았습니다/.test(lastError.message)) break;
        }
    }
    throw lastError || new Error('힌트 생성 실패');
}

/**
 * 연결 "확인"이지만 Gemini는 로컬 모델처럼 미리 올려 둘 것이 없는 상태 없는 API이므로,
 * 실제로 호출해 보지 않고 **설정 여부만** 싼값에 확인한다 (쓸데없는 API 비용을 만들지 않는다).
 * 진짜 연결 가능 여부는 generateHints() 가 실제로 부르는 순간 드러난다 — 그때 실패하면
 * 호출부(QuizService/aiRoutes)가 이미 내장 힌트로 넘어가도록 처리한다.
 */
async function ensureReady() {
    if (!isConfigured()) {
        return { ok: false, model: getModel(), reason: 'GEMINI_API_KEY가 설정되지 않았습니다' };
    }
    return { ok: true, model: getModel(), switched: false };
}

module.exports = {
    DEFAULT_MODEL,
    isConfigured,
    getModel,
    generateHints,
    ensureReady
};
