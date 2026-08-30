// Design Ref: §3.3 / §9.1 — Infrastructure 계층. RoomRepositoryPort의 인메모리 구현체.
// Plan §7.2: 영구 저장은 Out of Scope이므로 프로세스 메모리에만 상태를 둔다.
// 서버 재시작 시 모든 방은 사라진다. 훗날 Redis 구현체로 교체하더라도
// Application 계층 코드는 수정할 필요가 없다(Design §9.2 의존성 역전).

class InMemoryRoomRepository {
    constructor() {
        /** @type {Map<string, import('../domain/Room').Room>} */
        this.rooms = new Map();
    }

    save(room) {
        this.rooms.set(room.code, room);
    }

    findByCode(code) {
        return this.rooms.get(code);
    }

    delete(code) {
        this.rooms.delete(code);
    }

    findAll() {
        return Array.from(this.rooms.values());
    }

    size() {
        return this.rooms.size;
    }
}

module.exports = { InMemoryRoomRepository };
