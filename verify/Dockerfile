# No build step by design — this service runs TypeScript directly via tsx
# (see package.json; tsconfig.json sets noEmit: true), the same way `npm
# run dev`/`npm start` already do outside Docker. `npm ci` installs
# devDependencies too (not `--omit=dev`) specifically because tsx and
# typescript are both required at RUNTIME here, not just for local dev.

FROM node:24-alpine
WORKDIR /app

# package*.json first so `npm ci` is its own cached layer, same reasoning
# as api/Dockerfile's dependency:go-offline step.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY vendor ./vendor

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=10s \
  CMD wget -qO- http://localhost:4000/health || exit 1

USER node
CMD ["npm", "start"]
