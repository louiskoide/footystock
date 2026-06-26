FROM node:20-alpine
WORKDIR /app

# The worker reads FootyStock_dc.html (crosswalk) and imports scripts/lib/
# at runtime, so it needs the repo root, not just scripts/live-worker/.
COPY FootyStock_dc.html ./FootyStock_dc.html
COPY scripts/lib ./scripts/lib
COPY scripts/live-worker ./scripts/live-worker

WORKDIR /app/scripts/live-worker
RUN npm install --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
