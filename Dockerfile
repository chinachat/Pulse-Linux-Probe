FROM python:3.12-alpine

WORKDIR /app
COPY server.py index.html app.js style.css network.css agent.sh ./

ENV PORT=8080 \
    PROBE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["python", "server.py"]
