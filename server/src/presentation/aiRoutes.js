// Design Ref: 시험 구현 — 혼자 하기(브라우저) 모드 2가 Groq/Gemini를 직접 부르지 않고
// 이 라우트를 거치게 한다. 어느 쪽을 쓸지는 요청의 provider 값('groq'|'gemini')으로 정하고,
// 생략되면 서버의 AI_PROVIDER 기본값을 그대로 쓴다(예전부터 있던 하위 호환 동작).
// AI_PROVIDER가 'ollama'(기본값)인 채로 provider 없이 부르면 예전과 똑같이
// {ok:false, provider:'ollama'} 만 돌려주고, 혼자 하기는 그때 브라우저가 직접 처리한다.
//
// 여기서 받는 값은 provider·카테고리·정답·API 키뿐이고, 카테고리·정답도 서버의 실제 사전에
// 있는지 확인한 뒤에만 AI로 넘긴다 — 클라이언트가 임의의 프롬프트를 만들어 보낼 길을 막는다.
// API 키는 요청 본문에서 그때그때 읽어 해당 provider 객체에 전달할 뿐, 이 파일은 키를
// 로그로 남기거나 응답에 그대로 싣지 않는다(각 provider 구현체 쪽 리댁션 규칙을 그대로 따른다).
//
// 멀티플레이(QuizService/socketHandlers)는 이 라우트를 전혀 쓰지 않는다 — 그쪽은
// server.js가 따로 조립하는 hintGenerator(Ollama 또는 Gemini, AI_PROVIDER로 고정)를 그대로 쓴다.

const { getCategories, hasWord } = require('../domain/dictionary');

const MAX_FIELD_LEN = 20; // 사전 단어·카테고리 이름은 이보다 훨씬 짧다 (여유 있게 잡은 상한)

function isShortString(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LEN;
}

/** 인식하지 못하는 값이거나 생략되면 기본값(서버의 AI_PROVIDER)으로 본다. */
function normalizeProvider(value, fallback) {
    const v = String(value || '').toLowerCase();
    return (v === 'groq' || v === 'gemini') ? v : fallback;
}

/**
 * GroqHintGenerator(클래스 인스턴스)와 GeminiService(함수 모음)는 모양이 다르다.
 * 라우트 핸들러가 둘을 몰라도 되게, 여기서 한 번만 같은 모양으로 감싼다.
 */
function adapterFor(providerName, { geminiService, groqHintGenerator }) {
    if (providerName === 'groq') {
        return {
            label: 'Groq',
            hasApiKey: () => groqHintGenerator.hasApiKey,
            connected: () => groqHintGenerator.connected,
            locked: () => groqHintGenerator.locked,
            model: () => groqHintGenerator.model,
            usage: () => groqHintGenerator.usage,
            managed: () => groqHintGenerator.managed,
            setApiKey: (key) => groqHintGenerator.setApiKey(key),
            connect: () => groqHintGenerator.connect(),
            disconnect: () => groqHintGenerator.disconnect(),
            ensureReady: () => groqHintGenerator.ensureReady(),
            generateHints: (answer, category) => groqHintGenerator.generateHints(answer, category)
        };
    }
    return {
        label: 'Gemini',
        hasApiKey: () => geminiService.hasApiKey(),
        connected: () => geminiService.isConnected(),
        locked: () => geminiService.isLocked(),
        model: () => geminiService.getModel(),
        usage: () => null, // Gemini는 하루 사용량 상한을 따로 두지 않는다
        managed: () => geminiService.isManaged(),
        setApiKey: (key) => geminiService.setApiKey(key),
        connect: () => geminiService.connect(),
        disconnect: () => geminiService.disconnect(),
        ensureReady: () => geminiService.ensureReady(),
        generateHints: (answer, category) => geminiService.generateHints(answer, category)
    };
}

/** 상태만 묻는 경우. 잠겨 있으면(아직 연결 안 함) 시도하지 않고 상태만 알려 준다. */
async function checkAi(adapter) {
    if (adapter.locked()) {
        return {
            ok: false, connected: false, locked: true,
            hasKey: adapter.hasApiKey(), reason: '아직 AI에 연결하지 않았어요'
        };
    }
    const status = await adapter.ensureReady();
    return {
        ok: !!status.ok,
        connected: !!adapter.connected(),
        model: status.model || adapter.model() || null,
        switched: !!status.switched,
        reason: status.reason || null
    };
}

/** [연결하기]. 키가 오면 먼저 반영한 뒤 실제로 이어 본다. */
async function connectAi(adapter, apiKey) {
    if (apiKey && adapter.setApiKey) adapter.setApiKey(apiKey);
    if (!adapter.hasApiKey()) {
        return { ok: false, needsKey: true, connected: false, reason: `${adapter.label} API 키를 넣어주세요` };
    }
    const status = await adapter.connect();
    return {
        ok: !!status.ok,
        connected: !!adapter.connected(),
        model: status.model || adapter.model() || null,
        switched: !!status.switched,
        requested: status.requested || null,
        reason: status.reason || null
    };
}

/** [연결 끊기]. 다음부터는 확정 힌트(글자 수 등)만으로 진행된다. */
function disconnectAi(adapter) {
    adapter.disconnect();
    return { ok: true, connected: false };
}

/**
 * provider가 환경변수로 관리 중일 때 /api/ai/connect·disconnect를 막는 고정 응답.
 * 코드(PROVIDER_MANAGED)는 화면이 그대로 분기에 쓸 수 있게 항상 같은 문자열로 둔다.
 * 키 값은 이 응답 어디에도 없다 — 관리 여부(managed)만 알린다.
 */
function managedBlockResponse(adapter, provider, action) {
    const reason = action === 'disconnect'
        ? `서버에서 관리하는 ${adapter.label} 키라 화면에서 연결을 끊을 수 없어요`
        : `서버에서 이미 연결된 ${adapter.label} 키라 화면에서 바꿀 수 없어요`;
    return { ok: false, code: 'PROVIDER_MANAGED', managed: true, provider, reason };
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   getDefaultProvider: () => string,
 *   geminiService: typeof import('../services/GeminiService'),
 *   groqHintGenerator: import('../infrastructure/GroqHintGenerator').GroqHintGenerator
 * }} deps
 */
function registerAiRoutes(app, { getDefaultProvider, geminiService, groqHintGenerator }) {
    const jsonBody = require('express').json({ limit: '1kb' });
    const services = { geminiService, groqHintGenerator };

    // 캐시: 같은 라운드에서 같은 정답으로 두 번 부르는 일(재연결·재시도 등)을 API 호출 없이 넘긴다.
    // provider별로 키를 나눈다 — 같은 정답이라도 Groq·Gemini가 만드는 힌트 문장은 다를 수 있다.
    const hintCache = new Map();
    const HINT_CACHE_MAX = 100;
    function cacheKey(provider, category, answer) { return provider + ' ' + category + ' ' + answer; }
    function rememberHints(key, hints) {
        hintCache.set(key, hints);
        if (hintCache.size > HINT_CACHE_MAX) {
            hintCache.delete(hintCache.keys().next().value); // 가장 오래된 것부터 비운다
        }
    }

    /* ---------- 남이 우리 AI 사용량을 대신 태우지 못하게: IP당 10분에 낼 수 있는 요청 수 ----------
       Groq 브랜치(origin/feature/groq-api-test)에 있던 것과 같은 방식이다. Gemini는 자체 사용량
       상한이 없어서, 이 IP 제한을 Groq·Gemini 모두에 걸어 둔다. Groq의 하루 500회 상한은 이것과
       별개로 GroqHintGenerator 안에 그대로 있다(생성 직전에 셈). */
    const HINT_WINDOW_MS = 10 * 60 * 1000;
    const HINT_PER_IP = Number(process.env.AI_HINTS_PER_IP) || 30;
    const hintHits = new Map();
    function takeIpQuota(ip) {
        const now = Date.now();
        if (hintHits.size > 5000) {
            hintHits.forEach((hit, key) => { if (hit.resetAt <= now) hintHits.delete(key); });
        }
        const hit = hintHits.get(ip);
        if (!hit || hit.resetAt <= now) {
            hintHits.set(ip, { count: 1, resetAt: now + HINT_WINDOW_MS });
            return true;
        }
        if (hit.count >= HINT_PER_IP) return false;
        hit.count += 1;
        return true;
    }

    // 브라우저(혼자 하기)가 지금 고른 provider의 상태를 물어보는 곳.
    app.get('/api/ai/status', async (req, res) => {
        const provider = normalizeProvider(req.query.provider, getDefaultProvider());
        if (provider !== 'groq' && provider !== 'gemini') {
            // AI_PROVIDER가 'ollama'인 배포를 위한 예전 응답 그대로 — 혼자 하기는 이때 직접 Ollama를 부른다.
            res.json({ ok: false, provider: 'ollama', reason: null });
            return;
        }
        const adapter = adapterFor(provider, services);
        try {
            const status = await checkAi(adapter);
            res.json({ ...status, provider, usage: adapter.usage(), managed: adapter.managed() });
        } catch (error) {
            res.json({ ok: false, provider, reason: '연결 상태를 확인할 수 없습니다' });
        }
    });

    // [연결하기]. provider와 (선택) apiKey를 받는다. 키는 응답에도, 로그에도 남기지 않는다.
    app.post('/api/ai/connect', jsonBody, async (req, res) => {
        const body = req.body || {};
        const provider = normalizeProvider(body.provider, getDefaultProvider());
        if (provider !== 'groq' && provider !== 'gemini') {
            res.status(400).json({ ok: false, reason: '지원하지 않는 provider입니다' });
            return;
        }
        const adapter = adapterFor(provider, services);
        if (adapter.managed()) {
            res.status(403).json(managedBlockResponse(adapter, provider, 'connect'));
            return;
        }
        try {
            const status = await connectAi(adapter, body.apiKey);
            res.json({ ...status, provider });
        } catch (error) {
            res.json({ ok: false, provider, reason: '연결하지 못했습니다' });
        }
    });

    // [연결 끊기]. 들고 있던 키도 함께 지운다(각 provider 구현체가 처리).
    app.post('/api/ai/disconnect', jsonBody, (req, res) => {
        const provider = normalizeProvider(req.body && req.body.provider, getDefaultProvider());
        if (provider !== 'groq' && provider !== 'gemini') {
            res.status(400).json({ ok: false, reason: '지원하지 않는 provider입니다' });
            return;
        }
        const adapter = adapterFor(provider, services);
        if (adapter.managed()) {
            res.status(403).json(managedBlockResponse(adapter, provider, 'disconnect'));
            return;
        }
        const status = disconnectAi(adapter);
        res.json({ ...status, provider });
    });

    // 혼자 하기가 실제 힌트를 요청하는 곳. category·answer 둘 다 서버 사전에 실제로 있는 값이어야 한다.
    app.post('/api/ai/hints', jsonBody, async (req, res) => {
        const body = req.body || {};
        const provider = normalizeProvider(body.provider, getDefaultProvider());
        if (provider !== 'groq' && provider !== 'gemini') {
            res.status(400).json({ ok: false, reason: '지원하지 않는 provider입니다' });
            return;
        }
        if (!takeIpQuota(req.ip)) {
            res.status(429).json({
                ok: false,
                rateLimited: true,
                reason: `잠깐 너무 많이 요청했어요 (${HINT_PER_IP}회/10분). 조금 뒤에 다시 해주세요`
            });
            return;
        }

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

        const key = cacheKey(provider, category, answer);
        const cached = hintCache.get(key);
        if (cached) {
            res.json({ ok: true, hints: cached, cached: true });
            return;
        }

        const adapter = adapterFor(provider, services);
        try {
            const hints = await adapter.generateHints(answer, category);
            rememberHints(key, hints);
            res.json({ ok: true, hints, model: adapter.model() });
        } catch (error) {
            // 사용자에게는 내부 사유를 보여 주지 않는다 — 호출부가 실패로 보고 내장 힌트로 넘어간다.
            console.warn(`[ai] ${adapter.label} 힌트 생성 실패 — 내장 힌트로 대체됩니다: ${error.message}`);
            res.status(502).json({ ok: false, reason: 'AI 힌트를 만들지 못했습니다' });
        }
    });
}

module.exports = { registerAiRoutes };
