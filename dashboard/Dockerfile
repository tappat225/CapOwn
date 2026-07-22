ARG NODE_VERSION=22-alpine
ARG NPM_REGISTRY=""

FROM node:${NODE_VERSION} AS builder
ARG NPM_REGISTRY

WORKDIR /app

RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/out ./out
COPY static-server.mjs ./static-server.mjs

EXPOSE 3000

CMD ["node", "static-server.mjs"]
