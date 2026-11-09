FROM node:22-bookworm-slim

# ffmpeg: yt-dlp remuxes/converts audio. yt-dlp: standalone build (bundles the
# YouTube challenge solver; uses the container's node as JS runtime).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data
VOLUME /data

CMD ["node", "src/index.js"]
