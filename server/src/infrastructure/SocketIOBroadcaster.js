// Design Ref: §9.1 — Infrastructure 계층. BroadcasterPort의 Socket.IO 구현체.
// Application 계층은 이 클래스를 직접 import하지 않고, server.js(합성 루트)가 주입한다.

class SocketIOBroadcaster {
    /** @param {import('socket.io').Server} io */
    constructor(io) {
        this.io = io;
    }

    /** 방 전체에 브로드캐스트 (Socket.IO room 이름 = 방 코드) */
    toRoom(roomCode, event, payload) {
        this.io.to(roomCode).emit(event, payload);
    }

    /** 특정 플레이어에게만 전송 (Socket.IO는 socket.id를 동명의 room으로 자동 관리한다) */
    toPlayer(playerId, event, payload) {
        this.io.to(playerId).emit(event, payload);
    }
}

module.exports = { SocketIOBroadcaster };
