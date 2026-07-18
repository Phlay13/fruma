# Fruma — Northflank / any container host
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
# state + shadow-log live in /app/data — attach a Northflank volume here to persist
CMD ["npx", "ts-node", "src/engine.ts"]
