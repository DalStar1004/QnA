// Design Ref: §9.1 — Application 계층. 방 생명주기 유스케이스를 담당한다.
// 이 파일은 infrastructure의 구체 클래스를 import하지 않는다(Design §9.3).
// 필요한 구현체는 생성자 주입으로 받는다.

const { Room, RoomStatus } = require('../domain/Room');
const { Player } = require('../domain/Player');
const { getCategories } = require('../domain/dictionary');
const { fail } = require('./ports');

const NICKNAME_MAX_LENGTH = 10;
const ROOM_CODE_LENGTH = 4;

class RoomService {
    /**
     * @param {Object} deps
     * @param {import('./ports').RoomRepositoryPort} deps.roomRepository
     * @param {import('./ports').BroadcasterPort} deps.broadcaster
     * @param {import('./ports').RoomCodeGeneratorPort} deps.codeGenerator
     */
    constructor({ roomRepository, broadcaster, codeGenerator }) {
        this.roomRepository = roomRepository;
        this.broadcaster = broadcaster;
        this.codeGenerator = codeGenerator;
    }

    /** FR-01: 방 생성 — 생성자가 방장이 되고 4자리 방 코드를 발급받는다 */
    createRoom({ playerId, nickname }) {
        const cleanNickname = normalizeNickname(nickname);
        if (!cleanNickname) {
            return fail('INVALID_NICKNAME');
        }

        const code = this.codeGenerator.generate((candidate) => !this.roomRepository.findByCode(candidate));
        const room = new Room(code, playerId);
        room.addPlayer(new Player(playerId, cleanNickname));
        this.roomRepository.save(room);

        return {
            ok: true,
            roomCode: room.code,
            playerId,
            players: room.playersPayload(),
            hostId: room.hostId,
            settings: room.settings,
            // 카테고리 선택칸은 서버 사전이 원본이다 — 방에 들어오는 이 시점에 함께 내려준다
            categories: getCategories()
        };
    }

    /** FR-02: 방 코드로 참가 — 정원(8명)과 진행 상태를 서버가 재검증한다 */
    joinRoom({ playerId, nickname, roomCode }) {
        const cleanNickname = normalizeNickname(nickname);
        if (!cleanNickname) {
            return fail('INVALID_NICKNAME');
        }

        const room = this.roomRepository.findByCode(normalizeRoomCode(roomCode));
        if (!room) {
            return fail('ROOM_NOT_FOUND');
        }
        if (room.isPlaying()) {
            return fail('GAME_ALREADY_STARTED');
        }
        if (room.isFull()) {
            return fail('ROOM_FULL');
        }

        room.addPlayer(new Player(playerId, cleanNickname));
        this.roomRepository.save(room);

        return {
            ok: true,
            roomCode: room.code,
            playerId,
            players: room.playersPayload(),
            hostId: room.hostId,
            settings: room.settings,
            // 카테고리 선택칸은 서버 사전이 원본이다 — 방에 들어오는 이 시점에 함께 내려준다
            categories: getCategories()
        };
    }

    /**
     * FR-07: 참가자/방장 이탈 처리 (Design §6.2).
     * 방장이 나가면 다음 참가자에게 위임하고, 아무도 남지 않으면 방을 저장소에서 제거한다.
     * 타이머 정리는 RoundService.disposeRoom()이 담당하므로, 호출자가 roomClosed를 보고 이어서 처리한다.
     */
    leaveRoom(playerId) {
        const room = this.findRoomByPlayer(playerId);
        if (!room) {
            return { ok: false, room: null, roomClosed: false, hostChanged: false };
        }

        const wasHost = room.isHost(playerId);
        room.removePlayer(playerId);

        if (room.isEmpty()) {
            this.roomRepository.delete(room.code);
            return { ok: true, room, roomClosed: true, hostChanged: false };
        }

        let hostChanged = false;
        if (wasHost) {
            room.assignNextHost();
            hostChanged = true;
        }
        this.roomRepository.save(room);

        return { ok: true, room, roomClosed: false, hostChanged };
    }

    /** Design §3.4의 Port 계약(save/findByCode/delete/findAll)만 사용해 플레이어가 속한 방을 찾는다 */
    findRoomByPlayer(playerId) {
        return this.roomRepository.findAll().find((room) => room.hasPlayer(playerId));
    }

    /** Design §4.2 `room:players` — 참가/퇴장/방장 변경 시마다 방 전체에 갱신을 브로드캐스트 */
    broadcastPlayers(room) {
        this.broadcaster.toRoom(room.code, 'room:players', {
            players: room.playersPayload(),
            hostId: room.hostId
        });
    }
}

function normalizeNickname(nickname) {
    if (typeof nickname !== 'string') {
        return '';
    }
    const trimmed = nickname.trim();
    if (trimmed.length === 0 || trimmed.length > NICKNAME_MAX_LENGTH) {
        return '';
    }
    return trimmed;
}

function normalizeRoomCode(roomCode) {
    if (typeof roomCode !== 'string') {
        return '';
    }
    return roomCode.trim().toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

module.exports = { RoomService, RoomStatus, NICKNAME_MAX_LENGTH };
