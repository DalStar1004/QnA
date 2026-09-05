# Design Ref: §11.1 — 단일 앱 컨테이너. 인메모리 저장소만 쓰므로 DB 컨테이너가 필요 없다.
#
# 빌드 컨텍스트는 **저장소 루트**다 (docker-compose.yml 의 context: .. 참고).
# 혼자 하기 화면(word_connection_game.html)과 그 화면이 쓰는 그림이 루트에 있어서,
# 컨텍스트를 server/ 로 두면 이미지에 담을 수가 없기 때문이다.
# 파일을 server/public/ 으로 복사해 두 벌로 관리하면 반드시 한쪽만 고치는 날이 오므로,
# 원본 한 벌을 그대로 두고 빌드할 때만 가져온다. 그래서 아래 경로 앞에 server/ 가 붙는다.
FROM node:20-alpine

WORKDIR /app

# 의존성 레이어를 소스보다 먼저 캐싱해 재빌드를 빠르게 한다
COPY server/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/public ./public

# 혼자 하기 화면과 그 화면이 쓰는 그림들.
# COPY 는 디렉터리 내용을 합쳐 넣으므로, public/assets 의 글꼴·bg1~4.png 는 남고
# 루트 assets 의 아이콘(icon-*.png, champion-badge.png, thumb-bg*.png)과
# 배경(backgrounds/배경1~4.png)이 더해진다.
# 배경도 assets 안으로 들어와서, 한글 파일명을 여기에 적을 일이 없어졌다.
COPY word_connection_game.html ./public/
COPY assets ./public/assets
# 모드 3(산업재산권 문제)이 읽는 문제 파일
COPY quiz-data ./public/quiz-data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# node 프로세스가 PID 1로 시그널을 직접 받도록 exec form 사용 (server.js의 SIGTERM 핸들러와 맞물림)
CMD ["node", "src/server.js"]
