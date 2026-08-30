// Design Ref: §9.1 — Infrastructure 계층. RoomCodeGeneratorPort 구현체.

// 혼동하기 쉬운 문자(0/O, 1/I)는 제외해 구두로 방 코드를 불러줄 때의 실수를 줄인다.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_ATTEMPTS = 200;

function randomCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return code;
}

const roomCodeGenerator = {
    /**
     * @param {(code: string) => boolean} isAvailable 이미 사용 중인 코드인지 확인하는 콜백
     * @returns {string}
     */
    generate(isAvailable) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const code = randomCode();
            if (!isAvailable || isAvailable(code)) {
                return code;
            }
        }
        // 극단적으로 방이 많아 충돌이 계속될 경우의 마지막 수단 (실질적으로 도달하지 않음)
        return `${randomCode()}${Date.now().toString(36).slice(-2).toUpperCase()}`;
    }
};

module.exports = { roomCodeGenerator, CODE_LENGTH };
