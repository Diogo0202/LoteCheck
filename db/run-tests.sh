#!/usr/bin/env bash
# Recria um banco descartável, aplica as migrações e roda os testes de regra.
set -euo pipefail
DB=${DB:-pontobsa_test}
dropdb --if-exists "$DB" && createdb "$DB"
for f in db/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
psql -q -t -v ON_ERROR_STOP=1 -d "$DB" -f db/tests/001_regras.sql | grep -v '^\s*$'
