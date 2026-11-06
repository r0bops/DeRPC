FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY wrapper/package.json ./wrapper/package.json
COPY payments/package.json ./payments/package.json
COPY patches ./patches
COPY provider/stubs/lodestar-spec-test-util ./provider/stubs/lodestar-spec-test-util
RUN pnpm --filter @derpc/wrapper... install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /app/wrapper
COPY --from=dependencies /app /app
COPY wrapper/src ./src
COPY payments/src /app/payments/src
RUN mkdir -p /var/lib/derpc/payments && chown -R node:node /var/lib/derpc
USER node
CMD ["node", "src/main.ts"]
