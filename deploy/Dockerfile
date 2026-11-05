# One image for both web and worker (different start commands).
# Builds natively on the server (ARM on Oracle/Hetzner CAX, x86 elsewhere).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN npm ci
COPY . .
# Build-time placeholder only; the real key comes from the runtime environment.
RUN APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CHROME_PATH=/usr/bin/chromium
# Chromium for filling employer application forms (Debian builds exist for ARM and x86).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini \
    chromium fonts-liberation fonts-noto-core fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app \
 && mkdir -p /data/files && chown app:app /data/files
COPY --from=build --chown=app:app /app /app
USER app
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start", "-w", "@careerflow/web", "--", "-p", "3000", "-H", "0.0.0.0"]
