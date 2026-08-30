// Design Ref: §9.1 — Infrastructure 계층. HintGeneratorPort 의 Ollama 구현체.
// Application 은 이 클래스를 직접 import 하지 않고 server.js(합성 루트)가 주입한다.
//
// 혼자 하기 모드(word_connection_game.html)는 브라우저가 직접 Ollama 를 불렀지만,
// 멀티플레이에서는 **서버가 부른다.** 이유는 두 가지다.
//   1. 정답이 서버에만 있어야 한다 (Design §1.2). 힌트를 서버가 만들면 정답이 밖으로 나갈 일이 없다.
//   2. 모두가 **같은 힌트**를 같은 순서로 봐야 공정하다. 각자 부르면 힌트가 제각각이 된다.
//
// Ollama 가 꺼져 있어도 게임은 굴러가야 하므로, 이 어댑터는 실패를 예외로 올리기만 하고
// 대체 힌트를 만드는 판단은 Application(QuizService)이 한다.

const {
    LLM_HINT_REQUEST,
    LLM_HINT_MIN,
    cleanHints
} = require('../domain/quizContent');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:7b';

// 측정값 기준(혼자 하기 모드에서 확인): qwen2.5:7b 콜드 로드 45초, 콜드 상태 생성까지 115초.
const PING_TIMEOUT = 5000;
const WARMUP_TIMEOUT = 300000;
const REQUEST_TIMEOUT = 120000;
// 예열해 둔 모델이 곧바로 내려가면 의미가 없으므로 기본 5분보다 길게 잡는다.
const KEEP_ALIVE = '30m';
const MAX_ATTEMPTS = 3;
// 설정한 모델이 없을 때 대신 골라 볼 순서. 한국어 품질이 나은 쪽을 앞에 둔다.
const MODEL_PREFERENCE = ['qwen2.5', 'qwen2', 'llama3.2', 'llama3', 'gemma', 'mistral'];

// 사용자 메시지에만 "한글로 쓰라"고 적으면 힌트를 통째로 영어로 쓰는 일이 잦았다.
// 시스템 프롬프트에 절대 규칙으로 못박으니 눈에 띄게 줄었다.
const SYSTEM_PROMPT =
    '당신은 한국어 스무고개 출제자입니다. 설명 없이 요청된 JSON 한 개만 출력합니다.\n'
    + '절대 규칙: 출력에 쓸 수 있는 문자는 한글과 숫자와 기본 문장부호뿐입니다. '
    + '영어 알파벳(a-z, A-Z), 한자, 가나, 이모지를 단 한 글자도 쓰지 마십시오. '
    + '영어 단어가 떠오르면 반드시 한글 뜻이나 한글 표기로 바꿔 쓰십시오.';

// 정답을 사전에서 고르므로 다양성을 온도에 기댈 이유가 없다. 온도가 높으면 영어로 새는 일이 많아진다.
const HINT_TEMPERATURE = 0.3;

class OllamaHintGenerator {
    constructor({ endpoint, model } = {}) {
        this.endpoint = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
        this.model = String(model || DEFAULT_MODEL);
        this.requestedModel = this.model; // 설정에서 받은 원래 이름 (대체 모델을 골랐는지 판단용)
        this.warmed = false;
        this.ready = false;
        this.lastError = null;
        this.connecting = null;
    }

    /**
     * **자동 연결.** 필요할 때마다 이 메서드만 부르면 된다.
     *   ① Ollama 에 연결되는지 확인하고
     *   ② 설정한 모델이 없으면 설치된 모델 중 쓸 만한 것으로 갈아타고
     *   ③ 모델을 메모리에 올려 둔다(예열).
     *
     * 여러 곳에서 동시에 불러도 실제 연결은 한 번만 하도록 진행 중인 약속을 재사용한다.
     * 한 번 성공한 뒤에도 Ollama 가 꺼졌다 켜질 수 있으므로, 실패하면 다음 호출에서 다시 시도한다.
     *
     * @returns {Promise<{ok: boolean, model?: string, switched?: boolean, reason?: string}>}
     */
    ensureReady() {
        if (this.ready) {
            return Promise.resolve({ ok: true, model: this.model, switched: this.model !== this.requestedModel });
        }
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this._connect()
            .catch((error) => {
                this.lastError = error;
                return { ok: false, reason: error.message || '연결할 수 없어요' };
            })
            .finally(() => { this.connecting = null; });
        return this.connecting;
    }

    async _connect() {
        const status = await this.ping();
        let switched = false;

        if (!status.hasModel) {
            const fallback = pickFallbackModel(status.models);
            if (!fallback) {
                this.ready = false;
                return {
                    ok: false,
                    reason: `${this.requestedModel} 모델이 없고, 대신 쓸 모델도 설치돼 있지 않아요`
                };
            }
            // 설정한 모델이 없어도 게임이 되도록 설치된 모델로 자동으로 갈아탄다
            this.model = fallback;
            this.warmed = false;
            switched = true;
        }

        await this.warmUp();
        this.ready = true;
        this.lastError = null;
        return { ok: true, model: this.model, switched };
    }

    /** 연결이 끊긴 것으로 보이면 다음 요청에서 다시 연결하도록 표시한다 */
    markStale() {
        this.ready = false;
        this.warmed = false;
    }

    /** 지금 Ollama 가 떠 있고 쓰려는 모델이 설치돼 있는지 */
    async ping() {
        const data = await this._json('/api/tags', { method: 'GET' }, PING_TIMEOUT);
        const names = ((data && data.models) || []).map((m) => m.name);
        return {
            ok: true,
            model: this.model,
            hasModel: names.some((n) => n === this.model || n.indexOf(this.model + ':') === 0),
            models: names
        };
    }

    /**
     * 모델을 미리 메모리에 올려 둔다. prompt 를 비워 보내면 생성 없이 로드만 한다.
     * 이걸 해 두지 않으면 첫 힌트 요청이 콜드 로드에 걸려 타임아웃을 넘긴다.
     */
    async warmUp() {
        if (this.warmed) return;
        await this._text('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, prompt: '', keep_alive: KEEP_ALIVE })
        }, WARMUP_TIMEOUT);
        this.warmed = true;
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
                // 연결이 끊겨 실패했을 수 있다. 다음 시도 전에 연결부터 다시 잡는다.
                this.markStale();
                const retry = await this.ensureReady();
                if (!retry.ok) break;
            }
        }
        throw lastError || new Error('힌트 생성 실패');
    }

    async _requestOnce(answer, category) {
        const data = await this._json('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                format: 'json',
                keep_alive: KEEP_ALIVE,
                // num_predict 로 출력 길이를 막아 둔다. 드물게 모델이 JSON 을 끝내지 못하고
                // 토큰을 계속 뽑아내다 타임아웃을 통째로 써 버리는 일이 있었다.
                options: { temperature: HINT_TEMPERATURE, top_p: 0.95, num_predict: 400 },
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildHintPrompt(answer, category) }
                ]
            })
        }, REQUEST_TIMEOUT);
        return parseHintsJson(data && data.message ? data.message.content : '', answer);
    }

    async _fetch(path, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(this.endpoint + path, { ...options, signal: controller.signal });
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

    async _text(path, options, timeoutMs) {
        const res = await this._fetch(path, options, timeoutMs);
        // 본문을 읽어 버려야 연결이 제때 정리된다 (스트리밍 응답이라 그냥 두면 열린 채 남는다)
        return res.text();
    }
}

/** 설치된 모델 중 스무고개에 쓸 만한 것을 고른다. 아무것도 없으면 null. */
function pickFallbackModel(models) {
    const names = models || [];
    if (names.length === 0) return null;
    for (const prefix of MODEL_PREFERENCE) {
        const hit = names.find((name) => String(name).toLowerCase().startsWith(prefix));
        if (hit) return hit;
    }
    return names[0];
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

module.exports = { OllamaHintGenerator, DEFAULT_ENDPOINT, DEFAULT_MODEL };
