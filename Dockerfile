FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN cd node_modules/better-sqlite3 \
  && npx --yes node-gyp clean \
  && npx --yes node-gyp rebuild --release --force_build=1 \
  && cp build/Release/better_sqlite3.node prebuilds/linux-$(node -p process.arch).node \
  && node -e "require('better-sqlite3'); console.log('sqlite-build-ok', process.arch)"

RUN npm run build

ENV NODE_ENV=production

CMD ["sh", "scripts/release.sh"]
