FROM node:22-bookworm-slim

# ffmpeg (with libass for burned-in subtitles), fonts with æøå, and Python for yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp in its own venv so it can update itself at start-up (YouTube changes often).
ENV YTDLP_VENV=/opt/yt-dlp
RUN python3 -m venv $YTDLP_VENV \
 && $YTDLP_VENV/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]" \
 && ln -s $YTDLP_VENV/bin/yt-dlp /usr/local/bin/yt-dlp \
 && chown -R node:node $YTDLP_VENV

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh

ENV NODE_ENV=production \
    PORT=7000 \
    CACHE_DIR=/data/cache \
    YTDLP_AUTO_UPDATE=1
RUN mkdir -p /data/cache && chown -R node:node /data
VOLUME /data
EXPOSE 7000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.js"]
