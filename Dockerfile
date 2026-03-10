FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libeccodes-tools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
