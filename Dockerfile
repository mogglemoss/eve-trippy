# Build stage: compile TypeScript.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: production deps, compiled JS, the static universe.
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data ./data
RUN mkdir -p /app/.trippy && chown -R node:node /app
USER node
VOLUME ["/app/.trippy"]
CMD ["node", "dist/index.js"]
