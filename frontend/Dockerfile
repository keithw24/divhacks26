FROM oven/bun:1.2.22 AS build

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .

ARG VITE_AGENT_API_URL=
ARG VITE_AGENT_NUMBER=
ENV VITE_AGENT_API_URL=${VITE_AGENT_API_URL}
ENV VITE_AGENT_NUMBER=${VITE_AGENT_NUMBER}
ENV NITRO_PRESET=node-server
RUN bun run build

FROM oven/bun:1.2.22-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=bun:bun /app/.output ./.output
USER bun

EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
