FROM node:20-alpine

WORKDIR /app

COPY server/package*.json server/
COPY client/package*.json client/
COPY shared shared/

RUN npm --prefix server install
RUN npm --prefix client install

COPY server server/
COPY client client/

RUN npm --prefix client run build

ENV NODE_ENV=production
ENV PORT=4000
ENV CLIENT_BUILD_DIR=/app/client/dist
ENV DATA_DIR=/app/data

EXPOSE 4000

CMD ["node", "server/src/index.js"]
