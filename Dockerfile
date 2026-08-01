FROM python:3.12-alpine

RUN addgroup -S pulse && adduser -S -G pulse pulse && apk add --no-cache su-exec

WORKDIR /app
COPY server.py index.html app.js style.css agent.sh entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV PORT=8080 \
    PROBE_DATA_DIR=/data
RUN mkdir -p /data && chown pulse:pulse /data /app
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
