FROM node:20-alpine
WORKDIR /app

COPY ./typescript ./
RUN npm install
RUN npm install -g tsx

CMD ["tsx", "index.ts"]