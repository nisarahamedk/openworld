# OpenWorld runner image: the patched runsc (time skipping) + Node 22 + pnpm + git, and the runner itself.
FROM golang:1.24-bookworm AS runsc
RUN apt-get update && apt-get install -y --no-install-recommends git curl bzip2 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY engine/gvisor /src/engine/gvisor
RUN cd /src/engine/gvisor && OUT=/opt/gvisor WORK=/tmp/gvisor-work ./build.sh && rm -rf /tmp/gvisor-work

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tar && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.15.1 && npm cache clean --force
COPY --from=runsc /opt/gvisor /opt/gvisor
RUN ln -s /opt/gvisor/runsc /usr/local/bin/runsc
WORKDIR /app
COPY runner/package.json runner/package-lock.json runner/
RUN cd runner && npm ci --omit=dev --no-audit --no-fund
COPY runner/src runner/src
COPY worlds worlds
ENV OPENWORLD_DATA=/data OPENWORLD_RUNSC=/opt/gvisor/runsc PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "--no-warnings", "runner/src/server.ts"]
