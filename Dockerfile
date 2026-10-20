# Build stage: Bun installs and builds the TanStack Start app.
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
# Ship only runtime dependencies in the final image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# Runtime stage: slim Node serves the built entrypoint and runs the scanner loop.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scan.cjs ./scan.cjs
COPY --from=build /app/src/server/store.cjs ./src/server/store.cjs
COPY --from=build /app/tools/entrypoint.mjs /app/tools/serve.mjs ./tools/
RUN mkdir -p /app/database && chown -R node:node /app/database

EXPOSE 3000
# Fixed uid/gid 1000 (the image's `node` user) so anything written to the bind-mounted
# data directory is owned by the host user instead of root. The host data directory
# must be writable by this uid; a bind mount overrides the chown above.
USER 1000:1000
CMD ["node", "tools/entrypoint.mjs"]
