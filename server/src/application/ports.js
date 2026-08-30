// Design Ref: §3.4 / §9.2 — Application 계층이 정의하는 추상 계약(Port).
// Application은 이 계약에만 의존하고, 구체 구현(Socket.IO, 메모리 저장소)은 알지 못한다.
// 실제 구현체는 infrastructure/ 에 있으며 server.js(합성 루트)가 주입한다.

/**
 * @typedef {Object} RoomRepositoryPort
 * @property {(room: import('../domain/Room').Room) => void} save
 * @property {(code: string) => (import('../domain/Room').Room | undefined)} findByCode
 * @property {(code: string) => void} delete
 * @property {() => import('../domain/Room').Room[]} findAll
 */

/**
 * @typedef {Object} BroadcasterPort
 * @property {(roomCode: string, event: string, payload: any) => void} toRoom
 * @property {(playerId: string, event: string, payload: any) => void} toPlayer
 */

/**
 * @typedef {Object} RoomCodeGeneratorPort
 * @property {(isAvailable: (code: string) => boolean) => string} generate
 */

/**
 * 스무고개 힌트를 만들어 주는 Port. 지금 구현체는 Ollama(로컬 LLM)다.
 * 이 Port 가 실패해도 게임은 확정 힌트만으로 계속돼야 한다 (QuizService 가 그렇게 처리한다).
 *
 * @typedef {Object} HintGeneratorPort
 * @property {(answer: string, category: string) => Promise<string[]>} generateHints
 * @property {() => Promise<void>} [warmUp]
 * @property {() => Promise<{ok: boolean, model: string, hasModel: boolean, models: string[]}>} [ping]
 */

/**
 * Design Ref: §6.1 — 에러 코드 카탈로그. 계약의 일부이므로 Port와 함께 둔다.
 * Application 계층은 예외를 throw하지 않고 항상 결과 객체를 반환한다(Design §10.4).
 */
const ERROR_CODES = {
    ROOM_NOT_FOUND: '존재하지 않는 방 코드예요',
    ROOM_FULL: '방이 가득 찼어요 (최대 8명)',
    GAME_ALREADY_STARTED: '이미 게임이 진행 중인 방이에요',
    NOT_HOST: '방장만 할 수 있어요',
    NOT_ENOUGH_PLAYERS: '최소 2명 이상이어야 시작할 수 있어요',
    INVALID_NICKNAME: '닉네임을 입력해주세요 (1~10자)',
    INVALID_SETTINGS: '게임 설정 값이 올바르지 않아요',
    NO_VALID_CATEGORY: '해당 글자 수의 단어가 충분한 카테고리가 없어요',
    INVALID_MODE: '고를 수 없는 게임 종류예요'
};

function fail(code) {
    return { ok: false, error: { code, message: ERROR_CODES[code] || '알 수 없는 오류' } };
}

module.exports = { ERROR_CODES, fail };
