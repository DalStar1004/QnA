# Design Ref: §11.1 — 단일 앱 컨테이너. 인메모리 저장소만 쓰므로 DB 컨테이너가 필요 없다.
FROM node:20-alpine

WORKDIR /app

# 의존성 레이어를 소스보다 먼저 캐싱해 재빌드를 빠르게 한다
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# node 프로세스가 PID 1로 시그널을 직접 받도록 exec form 사용 (server.js의 SIGTERM 핸들러와 맞물림)
CMD ["node", "src/server.js"]
