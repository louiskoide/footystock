FROM node:20-alpine
WORKDIR /app

# The worker reads FootyStock_dc.html (crosswalk) and imports ../lib/crosswalk.mjs
# at runtime, so it needs the repo root, not just this directory.
COPY FootyStock_dc.html ./FootyStock_dc.html
COPY scripts/lib ./scripts/lib
COPY scripts/live-worker ./scripts/live-worker

WORKDIR /app/scripts/live-worker
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
