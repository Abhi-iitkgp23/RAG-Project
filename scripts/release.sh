#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

data_dir="${DATA_DIR:-/data}"
if [ "${INGEST_ON_RELEASE:-}" = "0" ] && [ ! -f "${data_dir}/guidance.db" ] && [ -f deploy/guidance.db ]; then
  mkdir -p "${data_dir}"
  cp deploy/guidance.db "${data_dir}/guidance.db"
fi

node -e "require('better-sqlite3'); console.log('sqlite-ok', process.arch)"
npx tsx scripts/ensureIndex.ts
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
