// Design Ref: §3.1 / §9.4 — Domain 계층 엔티티. I/O 없음.

class Player {
    constructor(id, nickname) {
        this.id = id;
        this.nickname = nickname;
        this.score = 0;
        this.connected = true;
    }

    addScore(points) {
        this.score += points;
        return this.score;
    }

    resetScore() {
        this.score = 0;
    }

    toJSON() {
        return {
            id: this.id,
            nickname: this.nickname,
            score: this.score,
            connected: this.connected
        };
    }
}

module.exports = { Player };
