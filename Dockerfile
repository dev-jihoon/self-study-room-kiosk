# UNO Q(arm64)와 일반 PC(amd64) 모두에서 빌드된다
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY public ./public
COPY server ./server
ENV PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/server.js"]
