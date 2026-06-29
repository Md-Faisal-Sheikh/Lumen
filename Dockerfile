# Single-container build: serves the API + the compiled client on one port.
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install deps (cached on lockfile changes)
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm install

# Build
COPY . .
RUN npm --workspace server run prisma:generate
RUN npm --workspace client run build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "npm --workspace server run prisma:deploy && npm --workspace server run start"]
