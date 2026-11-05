# KeepHuman tester: drives a bundled headless Chromium against a site behind
# the KeepHuman gate and writes status.html / visits.csv to /data,
# served on port 8080.
# Works with docker and podman; configure it via environment variables.

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    # browsers in a shared location, readable by the unprivileged user
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
# headless Chromium and the system libraries it needs
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080

# healthy while status.html keeps being rewritten
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD node -e "const s=require('fs').statSync('/data/status.html');process.exit(Date.now()-s.mtimeMs<300000?0:1)"

CMD ["node", "src/main.ts"]
