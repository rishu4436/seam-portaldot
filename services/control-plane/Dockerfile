FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services/control-plane/package.json ./services/control-plane/package.json
RUN npm ci --no-audit --no-fund
RUN npm run build -w @seam/compiler && npm run build -w @seam/policy && npm run build -w @seam/chain && npm run build -w @seam/sdk
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production SEAM_DATA_DIR=/data PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY services/control-plane ./services/control-plane
EXPOSE 8080
CMD ["node", "services/control-plane/src/main.mjs"]
