// Design Ref: §9.1 — Infrastructure 계층. HintGeneratorPort 의 Groq API 구현체.
// Application 은 이 클래스를 직접 import 하지 않고 server.js(합성 루트)가 주입한다.
//
// 혼자 하기 모드(word_connection_game.html)도 이 서버를 거쳐 힌트를 받는다(/api/ai/*).
// 브라우저가 Groq 를 직접 부르지 않고 **서버가 부르는** 이유는 두 가지다.
//   1. 정답이 서버에만 있어야 한다 (Design §1.2). 힌트를 서버가 만들면 정답이 밖으로 나갈 일이 없다.
//   2. 모두가 **같은 힌트**를 같은 순서로 봐야 공정하다. 각자 부르면 힌트가 제각각이 된다.
// 여기에 한 가지가 더 붙는다.
//   3. API 키가 서버에만 있으면 된다. 참가자 브라우저로 키가 나가지 않는다.
//
// OllamaHintGenerator 와 같은 자리를 대신하며, 바깥에서 보는 모습(ensureReady / generateHints /
// markStale / ping)은 똑같이 맞췄다. 달라진 점은 세 가지다.
//   - 모델을 램에 올리고 내리는 일이 없다. 그래서 예열(warmUp)과 대체 모델 고르기가 사라졌다.
//   - 대신 API 키가 필요하다. 키가 없으면 연결 자체를 시도하지 않는다.
//   - **한 번 연결하면 [연결 끊기] 전까지 유지한다.** 방장이 대기실에서 직접 끊기 전에는
//     스스로 연결을 놓지 않고, 1분마다 살아 있는지만 확인한다.
//
// Groq 에 연결하지 못해도 게임은 굴러가야 하므로, 이 어댑터는 실패를 예외로 올리기만 하고
// 대체 힌트를 만드는 판단은 Application(QuizService)이 한다.

const {
    LLM_HINT_REQUEST,
    LLM_HINT_MIN,
    cleanHints
} = require('../domain/quizContent');

const DEFAULT_API_BASE = 'https://api.groq.com/openai/v1';
/* 기본 모델. Groq 무료 티어에서 **실제로 도는 것**으로 고른다.
   예전 기본값이던 llama-3.1-8b-instant 는 Groq 가 내려서 목록에 없고, 부르면 404 가 난다.
   후보들을 같은 프롬프트로 재 본 결과(정답 '기린'/'김치'로 각각 힌트 6개 요청):
     - qwen/qwen3.8-27b   0.6~0.7초 · 힌트 6개 · 영어 섞임 없음   ← 가장 빠르고 한국어가 자연스럽다
     - groq/compound-mini 1.7~4.9초 · 힌트 6개 · 영어 섞임 없음   (품질은 좋지만 느리다)
     - qwen/qwen3.6-27b   "힌트1, 힌트2…" 처럼 예시를 그대로 돌려줬다
     - openai/gpt-oss-20b · 120b  쓸 만한 힌트를 받지 못했다 */
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

// 클라우드라 로컬 추론보다 훨씬 빠르다. 콜드 로드를 기다릴 일이 없어 시간을 짧게 잡는다.
const PING_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 30000;
const MAX_ATTEMPTS = 3;
// 무료 티어에서 429(요청 과다)를 만났을 때 쉬었다 다시 물어보는 시간.
const RATE_LIMIT_BACKOFF_MS = 1500;
// 연결을 유지하는 동안 살아 있는지 확인하는 간격. 너무 잦으면 쓸데없는 요청이 된다.
const KEEPALIVE_INTERVAL = 60000;

/* 설정한 모델이 계정에 없을 때 대신 골라 볼 순서.
   Groq 는 오래된 모델을 조용히 내린다. 실제로 llama-3.1-8b-instant 가 목록에서 사라져
   힌트 요청이 404 로 떨어지는 일이 있었다. 그때 게임이 통째로 확정 힌트로 주저앉지 않도록,
   목록에 있는 것 중 쓸 만한 것으로 자동으로 갈아탄다.

   순서는 위에서 실제로 재 본 결과 그대로다 — 짐작이 아니라 측정값 순이다.
   한국어 힌트를 제대로 뽑아 준 것이 앞이고, 예시를 되돌려주거나 빈손으로 온 것이 뒤다. */
const MODEL_PREFERENCE = [
    'qwen/qwen3.8-27b',
    'groq/compound-mini',
    'groq/compound',
    'qwen/qwen3.6-27b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b'
];
// 위 목록에 없는 이름이 와도 고를 수 있게, 앞글자로도 찾아본다.
const MODEL_PREFIX_PREFERENCE = ['qwen', 'llama', 'openai/gpt-oss', 'groq/compound'];

/** 계정에서 쓸 수 있는 모델 중 스무고개에 쓸 만한 것을 고른다. 아무것도 없으면 null. */
function pickFallbackModel(models) {
    const names = (models || []).filter((name) => !/whisper|guard|orpheus|tts|embed/i.test(name));
    if (names.length === 0) return null;
    for (const wanted of MODEL_PREFERENCE) {
        if (names.indexOf(wanted) !== -1) return wanted;
    }
    for (const prefix of MODEL_PREFIX_PREFERENCE) {
        const hit = names.find((name) => String(name).toLowerCase().startsWith(prefix));
        if (hit) return hit;
    }
    return names[0];
}

// 사용자 메시지에만 "한글로 쓰라"고 적으면 힌트를 통째로 영어로 쓰는 일이 잦았다.
// 시스템 프롬프트에 절대 규칙으로 못박으니 눈에 띄게 줄었다.
const SYSTEM_PROMPT =
    '당신은 한국어 스무고개 출제자입니다. 설명 없이 요청된 JSON 한 개만 출력합니다.\n'
    + '절대 규칙: 출력에 쓸 수 있는 문자는 한글과 숫자와 기본 문장부호뿐입니다. '
    + '영어 알파벳(a-z, A-Z), 한자, 가나, 이모지를 단 한 글자도 쓰지 마십시오. '
    + '영어 단어가 떠오르면 반드시 한글 뜻이나 한글 표기로 바꿔 쓰십시오.';

// 정답을 사전에서 고르므로 다양성을 온도에 기댈 이유가 없다. 온도가 높으면 영어로 새는 일이 많아진다.
const HINT_TEMPERATURE = 0.3;

class GroqHintGenerator {
    /**
     * @param {Object} deps
     * @param {string} [deps.apiKey] 서버를 켤 때 읽어 둔 키
     * @param {() => string} [deps.keyLoader] 키를 다시 읽는 함수.
     *   키 파일을 나중에 만들어 놓고 [연결하기] 를 누르는 일이 흔해서,
     *   그때 서버를 다시 켜지 않아도 되도록 이 자리에서 파일을 다시 읽는다.
     */
    constructor({ apiKey, model, apiBase, keyLoader } = {}) {
        this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
        this.model = String(model || DEFAULT_MODEL);
        // 설정에서 받은 원래 이름. 대체 모델을 골랐는지 판단하는 데 쓴다.
        this.requestedModel = this.model;
        this.apiKey = String(apiKey || '');
        this.keyLoader = typeof keyLoader === 'function' ? keyLoader : null;

        this.connected = false;
        this.lastError = null;
        this.connecting = null;
        this.keepAliveTimer = null;
        /* 방장이 [연결 끊기] 를 눌렀는지. 이 표시가 있으면 자동 연결이 다시 붙지 않는다.
           이걸 두지 않으면 스무고개를 고를 때마다 도는 자동 연결이 방금 끊은 연결을 되살린다. */
        this.manuallyDisconnected = false;

        /* Groq 는 JSON 강제 출력(response_format)을 지원하지만 모델에 따라 400 을 돌려줄 수 있다.
           한 번 거절당하면 그 뒤로는 빼고 보낸다. 프롬프트가 이미 JSON 만 쓰라고 못박고 있고
           parseHintsJson 이 앞뒤 군더더기를 걷어내므로, 빠져도 힌트는 나온다. */
        this.useJsonMode = true;
    }

    /** 키가 준비돼 있는지 (서버를 켤 때 안내 문구를 고르는 데 쓴다) */
    get hasApiKey() {
        return !!this.apiKey;
    }

    /**
     * 키를 다시 읽어 온다. 없던 키가 생겼으면 그것으로 갈아탄다.
     * @returns {boolean} 읽고 난 뒤 키가 있는지
     */
    refreshKey() {
        if (!this.keyLoader) return !!this.apiKey;
        try {
            const fresh = String(this.keyLoader() || '').trim();
            if (fresh && fresh !== this.apiKey) {
                this.apiKey = fresh;
                this.connected = false;   // 키가 바뀌었으니 다시 확인해야 한다
                this.model = this.requestedModel;   // 계정이 바뀌면 모델도 다시 골라야 한다
            } else if (!fresh) {
                this.apiKey = '';
            }
        } catch (error) {
            // 파일을 읽지 못하면 들고 있던 키를 그대로 쓴다
        }
        return !!this.apiKey;
    }

    /**
     * **자동 연결.** 필요할 때마다 이 메서드만 부르면 된다.
     * 이미 연결돼 있으면 그대로 쓴다 — 한 번 연결하면 [연결 끊기] 전까지 유지하는 것이 약속이다.
     *
     * 여러 곳에서 동시에 불러도 실제 연결은 한 번만 하도록 진행 중인 약속을 재사용한다.
     * @returns {Promise<{ok: boolean, model?: string, reason?: string}>}
     */
    ensureReady() {
        if (this.connected) {
            return Promise.resolve({
                ok: true,
                model: this.model,
                switched: this.model !== this.requestedModel,
                requested: this.requestedModel
            });
        }
        if (this.manuallyDisconnected) {
            return Promise.resolve({ ok: false, reason: '방장이 AI 연결을 꺼 두었어요' });
        }
        // 키가 없으면 파일을 한 번 더 본다. 서버를 켠 뒤에 키 파일을 만든 경우가 흔하다.
        if (!this.apiKey && !this.refreshKey()) {
            return Promise.resolve({
                ok: false,
                reason: 'Groq API 키가 없어요 (GROQ_API_KEY 환경변수 또는 server/groq-key.txt)'
            });
        }
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this._connect()
            .catch((error) => {
                this.lastError = error;
                return { ok: false, reason: describeError(error) };
            })
            .finally(() => { this.connecting = null; });
        return this.connecting;
    }

    /**
     * [연결하기] 를 눌렀을 때. 꺼 두었던 표시를 지우고 다시 잇는다.
     * 누를 때마다 키 파일을 다시 읽으므로, 키를 새로 넣거나 바꿔도 서버를 다시 켜지 않아도 된다.
     */
    connect() {
        this.manuallyDisconnected = false;
        this.refreshKey();
        return this.ensureReady();
    }

    /**
     * 방장이 [연결 끊기] 를 눌렀을 때.
     * 다음 판부터는 확정 힌트(글자 수·초성·첫 글자)만으로 진행된다.
     */
    disconnect() {
        this.connected = false;
        this.manuallyDisconnected = true;
        this.lastError = null;
        this._stopKeepAlive();
        return { ok: true };
    }

    /** 연결이 끊긴 것으로 보이면 다음 요청에서 다시 연결하도록 표시한다 */
    markStale() {
        this.connected = false;
    }

    async _connect() {
        const status = await this.ping();
        let switched = false;

        /* 설정한 모델이 계정에 없으면 쓸 수 있는 것으로 갈아탄다.
           예전에는 그냥 연결만 열어 두었는데, 그러면 '연결됨'이라고 해 놓고 첫 힌트 요청이
           404 로 떨어져 매번 확정 힌트만 나왔다. 여기서 갈아타면 게임이 그대로 굴러간다. */
        if (!status.hasModel) {
            const fallback = pickFallbackModel(status.models);
            if (fallback) {
                this.model = fallback;
                switched = true;
            }
        }

        this.connected = true;
        this.lastError = null;
        this._startKeepAlive();
        return { ok: true, model: this.model, switched, requested: this.requestedModel };
    }

    /* 연결을 유지하는 동안 주기적으로 확인한다.
       확인에 실패해도 **스스로 끊지 않는다** — 끊는 것은 방장이 [연결 끊기] 를 누를 때뿐이다.
       (인터넷이 잠깐 끊겼다고 연결이 없던 일이 되면, 다음 판에서 다시 붙는 시간만 낭비된다) */
    _startKeepAlive() {
        this._stopKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (!this.connected) return;
            this.ping()
                .then(() => { this.lastError = null; })
                .catch((error) => { this.lastError = error; });
        }, KEEPALIVE_INTERVAL);
        // 이 타이머 하나 때문에 서버가 종료되지 못하는 일이 없게 한다.
        if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
    }

    _stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    /** 지금 키가 살아 있고 쓰려는 모델이 목록에 있는지 */
    async ping() {
        const data = await this._json('/models', { method: 'GET' }, PING_TIMEOUT);
        const names = ((data && data.data) || []).map((m) => m.id);
        return {
            ok: true,
            model: this.model,
            hasModel: names.indexOf(this.model) !== -1,
            models: names
        };
    }

    /**
     * 정답이 이미 정해진 상태에서 힌트만 받아 온다.
     * 검사에 걸린 응답은 몇 번 다시 받아 본다.
     * @returns {Promise<string[]>} 다듬어진 힌트 목록 (LLM_HINT_MIN 개 이상)
     */
    async generateHints(answer, category) {
        // 부르는 쪽이 잊더라도 여기서 한 번 더 확인한다 — "실행하면 알아서 연결" 을 보장하는 지점이다.
        const connection = await this.ensureReady();
        if (!connection.ok) {
            throw new Error(connection.reason);
        }

        let lastError = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const hints = await this._requestOnce(answer, category);
                if (hints) return hints;
                lastError = new Error('쓸 만한 힌트를 받지 못했습니다');
            } catch (error) {
                lastError = error;
                // 방장이 꺼 둔 것이라면 다시 물어봐야 소용이 없다.
                if (this.manuallyDisconnected) break;

                /* 무료 티어는 분당 요청 수가 정해져 있어서, 판이 몰리면 429 가 난다.
                   그때는 곧바로 다시 물어봐야 또 429 다. 잠깐 쉬었다가 한 번 더 해 본다.
                   (연결이 끊긴 것은 아니므로 여기서는 연결을 다시 잡지 않는다) */
                if (String(error.message || '').indexOf('HTTP 429') !== -1) {
                    await sleep(RATE_LIMIT_BACKOFF_MS);
                    continue;
                }

                // 연결이 끊겨 실패했을 수 있다. 다음 시도 전에 연결부터 다시 잡는다.
                this.markStale();
                const retry = await this.ensureReady();
                if (!retry.ok) break;
            }
        }
        throw lastError || new Error('힌트 생성 실패');
    }

    async _requestOnce(answer, category) {
        const body = {
            model: this.model,
            stream: false,
            temperature: HINT_TEMPERATURE,
            top_p: 0.95,
            // 출력 길이를 막아 둔다. 드물게 모델이 JSON 을 끝내지 못하고 토큰을 계속 뽑아낸다.
            max_tokens: 400,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildHintPrompt(answer, category) }
            ]
        };
        if (this.useJsonMode) body.response_format = { type: 'json_object' };

        let data;
        try {
            data = await this._json('/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, REQUEST_TIMEOUT);
        } catch (error) {
            // JSON 강제 출력을 거절당한 것이라면, 그 옵션만 빼고 한 번 더 보낸다.
            if (this.useJsonMode && String(error.message || '').indexOf('HTTP 400') !== -1) {
                this.useJsonMode = false;
                return this._requestOnce(answer, category);
            }
            throw error;
        }
        const message = data && data.choices && data.choices[0] && data.choices[0].message;
        return parseHintsJson(message ? message.content : '', answer);
    }

    async _fetch(path, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = Object.assign(
                { Authorization: 'Bearer ' + this.apiKey },
                (options && options.headers) || {}
            );
            const res = await fetch(this.apiBase + path, { ...options, headers, signal: controller.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res;
        } finally {
            clearTimeout(timer);
        }
    }

    async _json(path, options, timeoutMs) {
        const res = await this._fetch(path, options, timeoutMs);
        return res.json();
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Groq 를 부를 때 가장 흔한 실패 원인을 사람 말로 풀어준다. */
function describeError(error) {
    if (error && error.name === 'AbortError') return '응답이 너무 늦어 중단했어요';
    const message = String((error && error.message) || error || '');
    if (message.indexOf('HTTP 401') !== -1) return 'API 키가 올바르지 않아요 (401)';
    if (message.indexOf('HTTP 403') !== -1) return '이 키로는 쓸 수 없는 요청이에요 (403)';
    if (message.indexOf('HTTP 429') !== -1) return '잠시 요청이 너무 많았어요 (429)';
    if (message.indexOf('HTTP 5') !== -1) return `Groq 쪽에서 오류가 났어요 (${message})`;
    if (message.indexOf('fetch failed') !== -1 || message.indexOf('ENOTFOUND') !== -1) {
        return '인터넷에 닿지 못했어요 (Groq API 는 인터넷 연결이 필요해요)';
    }
    return message || '연결할 수 없어요';
}

/** 정답이 이미 정해져 있을 때 쓰는 프롬프트. 모델이 낱말을 지어낼 여지를 없앤다. */
function buildHintPrompt(answer, category) {
    return [
        `카테고리: "${category}"`,
        `정답: "${answer}"`,
        '',
        `이 정답을 맞히기 위한 스무고개 힌트 ${LLM_HINT_REQUEST}개를 만드세요.`,
        '   - 1번이 가장 막연하고, 뒤로 갈수록 구체적이어야 합니다.',
        `   - 힌트에 "${answer}" 를 그대로 쓰면 안 됩니다.`,
        '   - 각 힌트는 40자 이내의 한국어 한 문장입니다.',
        '   - 사실만 쓰세요. 확실하지 않은 내용은 아예 빼세요.',
        '',
        '★ 가장 중요한 규칙: 한글과 숫자만 쓰세요.',
        '  영어 알파벳, 한자, 일본어, 그 밖의 외국 문자를 한 글자라도 섞으면 안 됩니다.',
        '  예를 들어 "big cat", "FOOTBALL", "圆形" 같은 표기는 금지입니다.',
        '  외래어를 쓰려면 "빅캣", "풋볼" 처럼 한글로 적으세요.',
        '',
        '아래 형식의 JSON만 출력하세요.',
        '{"hints":["힌트1","힌트2","힌트3"]}'
    ].join('\n');
}

/** 응답에서 힌트를 꺼내 다듬는다. 걸러내고 남은 것이 모자라면 null 을 돌려 재요청하게 한다. */
function parseHintsJson(content, answer) {
    const text = String(content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;

    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        return null;
    }
    const hints = cleanHints(Array.isArray(parsed.hints) ? parsed.hints : [], answer);
    return hints.length >= LLM_HINT_MIN ? hints : null;
}

module.exports = { GroqHintGenerator, DEFAULT_API_BASE, DEFAULT_MODEL };
