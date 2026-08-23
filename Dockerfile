# Reel Picks production image. Node 24 is required for the built-in node:sqlite
# to work without an experimental flag.
FROM node:24-slim

WORKDIR /app

# Install production deps only (just express), using the lockfile for a clean build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite database lives on a mounted persistent volume at /data (see DATA_DIR in
# server/db.js). Mount your host volume there.
ENV NODE_ENV=production \
    DATA_DIR=/data

# The platform injects PORT; the app reads process.env.PORT (defaults to 5170).
EXPOSE 5170

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
