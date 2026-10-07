FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm rebuild argon2
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm rebuild argon2
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
# The embeddable widget is served as a static asset from /widget.js.
COPY public ./public
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
EXPOSE 3001
CMD ["sh", "-c", "DATABASE_URL=$MIGRATION_DATABASE_URL npx prisma migrate deploy && node dist/main"]