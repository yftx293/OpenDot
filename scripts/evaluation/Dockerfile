FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY container/agent-runner/package.json container/agent-runner/package-lock.json ./container/agent-runner/
RUN npm --prefix container/agent-runner ci --no-audit --no-fund
COPY . .
RUN npm run build && npm --prefix container/agent-runner run build && chown -R node:node /work
USER node
ENV HOME=/tmp/eval-home TMPDIR=/tmp/eval-tmp TZ=UTC CI=1 NODE_ENV=test
ENTRYPOINT ["node", "scripts/evaluation/container-worker.mjs"]
