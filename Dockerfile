FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && npm cache clean --force

COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod 0755 /usr/local/bin/entrypoint.sh \
    && groupadd -g 10000 webcal \
    && useradd -r -u 10000 -g webcal -d /app -s /usr/sbin/nologin webcal \
    && chown -R 10000:10000 /app

USER 10000:10000

ENV PORT=8000
ENV WEBCAL_DEFAULT_TZ=Europe/Berlin
ENV WEBCAL_CACHE_TTL_SECONDS=300

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
