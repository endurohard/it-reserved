FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive     PUPPETEER_SKIP_DOWNLOAD=true     PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium + deps
RUN apt-get update && apt-get install -y --no-install-recommends     chromium     ca-certificates     fonts-liberation     libasound2     libatk1.0-0     libatk-bridge2.0-0     libc6     libcairo2     libcups2     libdbus-1-3     libexpat1     libfontconfig1     libgbm1     libglib2.0-0     libgtk-3-0     libnspr4     libnss3     libpango-1.0-0     libx11-6     libx11-xcb1     libxcb1     libxcomposite1     libxcursor1     libxdamage1     libxext6     libxfixes3     libxi6     libxrandr2     libxrender1     libxss1     libxtst6     xdg-utils     && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY ./src ./src
COPY .env ./.env.example

RUN mkdir -p /app/data

CMD ["node", "src/index.js"]
