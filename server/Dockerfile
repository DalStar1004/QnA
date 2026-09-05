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
# 루트 assets 의 아이콘(icon-*.png, champion-badge.png, thumb-bg*.png)이 더해진다.
COPY word_connection_game.html ./public/
COPY assets ./public/assets

# 배경 그림(배경1~4.png). 파일 이름이 한글이라 여기에 직접 적으면 빌드 환경의 문자 인코딩에 따라
# 못 찾을 수 있어서, 이름을 적지 않고 *.png 로 받는다. 루트의 나머지 png(아이콘·우승·챔피언 뱃지)는
# .dockerignore 에서 빼 두었으므로 실제로 들어오는 것은 배경 4장뿐이다.
# → 루트에 새 png 를 두면 여기로 딸려 들어온다. 그럴 때는 .dockerignore 에 한 줄 추가할 것.
COPY *.png ./public/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# node 프로세스가 PID 1로 시그널을 직접 받도록 exec form 사용 (server.js의 SIGTERM 핸들러와 맞물림)
CMD ["node", "src/server.js"]
