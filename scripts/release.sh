#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npx tsx scripts/ensureIndex.ts
exec npx next start
