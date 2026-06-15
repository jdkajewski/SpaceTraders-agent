#!/bin/bash
# Launch the unified live TUI dashboard (replaces the old mon3 refresh loop and `status.mjs --watch`).
# Pages: 1 Status · 2 Logs · 3 Contracts · 4 Markets · 5 Surveys. Keys: 1-5, arrows/PgUp/PgDn, q to quit.
cd "$(dirname "$0")"
exec node dashboard.mjs "$@"
