// Design Ref: 시험 구현 — 혼자 하기(브라우저)가 Gemini를 직접 부르지 않고 이 라우트를 거치게 한다.
// AI_PROVIDER가 'ollama'(기본값)면 혼자 하기는 예전 그대로 브라우저가 Ollama를 직접 부른다 —
// 이 라우트는 그때 쓰이지 않는다. 'gemini'일 때만 실제로 호출된다.
//
// 여기서 받는 값은 카테고리·정답·힌트 개수뿐이고, 그 값도 서버의 실제 사전에 있는지 확인한 뒤에만
// Gemini로 넘긴다 — 클라이언트가 임의의 프롬프트를 만들어 보낼 길을 원천적으로 막는다.

const { getCategories, hasWord } = require('../domain/dictionary');

const MAX_FIELD_LEN = 20; // 사전 단어·카테고리 이름은 이보다 훨씬 짧다 (여유 있게 잡은 상한)

function isShortString(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LEN;
}

/**
 * @param {import('express').Express} app
 * @param {{ getProvider: () => string, geminiService: typeof import('../services/GeminiService') }} deps
 */
function registerAiRoutes(app, { getProvider, geminiService }) {
    // 아주 짧은 요청 본문만 받는다 (카테고리·정답 문자열 두 개뿐). express.json 을 이 라우트에만 건다.
    const jsonBody = require('express').json({ limit: '1kb' });

    // 캐시: 같은 라운드에서 같은 정답으로 두 번 부르는 일(재연결·재시도 등)을 API 호출 없이 넘긴다.
    // 방마다가 아니라 프로세스 전역이라 메모리를 아주 조금만 쓰고, 게임 특성상 정답이 겹쳐도 힌트 내용이
    // 달라질 이유가 없어 안전하다. 오래 쌓이지 않게 개수만 제한한다(라운드 수가 아주 많아도 문제없는 크기).
    const hintCache = new Map();
    const HINT_CACHE_MAX = 100;
    function cacheKey(category, answer) { return category + ' ' + answer; }
    function rememberHints(category, answer, hints) {
        const key = cacheKey(category, answer);
        hintCache.set(key, hints);
        if (hintCache.size > HINT_CACHE_MAX) {
            hintCache.delete(hintCache.keys().next().value); // 가장 오래된 것부터 비운다
        }
    }

    // 브라우저(혼자 하기)가 어느 AI를 쓸지 결정하려고 한 번 물어보는 곳.
    // Gemini 여부와 무관하게 provider 이름은 항상 알려 준다 — 'ollama' 면 클라이언트가 예전 방식(직접 호출)으로 넘어간다.
    app.get('/api/ai/status', async (req, res) => {
        const provider = getProvider();
        if (provider !== 'gemini') {
            res.json({ ok: false, provider, reason: null });
            return;
        }
        try {
            const status = await geminiService.ensureReady();
            res.json({ ok: status.ok, provider, model: status.model, reason: status.reason || null });
        } catch (error) {
            res.json({ ok: false, provider, reason: '연결 상태를 확인할 수 없습니다' });
        }
    });

    // 혼자 하기가 실제 힌트를 요청하는 곳. category·answer 둘 다 서버 사전에 실제로 있는 값이어야 한다.
    app.post('/api/ai/hints', jsonBody, async (req, res) => {
        const provider = getProvider();
        if (provider !== 'gemini') {
            res.status(400).json({ ok: false, reason: 'Gemini 모드가 아닙니다' });
            return;
        }

        const body = req.body || {};
        const category = body.category;
        const answer = body.answer;

        if (!isShortString(category) || !getCategories().includes(category)) {
            res.status(400).json({ ok: false, reason: '지원하지 않는 카테고리입니다' });
            return;
        }
        if (!isShortString(answer) || !hasWord(category, answer)) {
            res.status(400).json({ ok: false, reason: '해당 카테고리의 단어가 아닙니다' });
            return;
        }

        const cached = hintCache.get(cacheKey(category, answer));
        if (cached) {
            res.json({ ok: true, hints: cached, cached: true });
            return;
        }

        try {
            const hints = await geminiService.generateHints(answer, category);
            rememberHints(category, answer, hints);
            res.json({ ok: true, hints });
        } catch (error) {
            // 사용자에게는 내부 사유를 보여 주지 않는다 — 호출부가 실패로 보고 내장 힌트로 넘어간다.
            console.warn(`[ai] Gemini 힌트 생성 실패 — 내장 힌트로 대체됩니다: ${error.message}`);
            res.status(502).json({ ok: false, reason: 'AI 힌트를 만들지 못했습니다' });
        }
    });
}

module.exports = { registerAiRoutes };
