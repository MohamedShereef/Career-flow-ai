#!/usr/bin/env bash
# Run admin commands inside the worker container, e.g.:
#   deploy/admin.sh reset-password you@example.com
set -euo pipefail
cd "$(dirname "$0")"
exec docker compose --env-file .env exec -T worker npm run admin -- "$@"
