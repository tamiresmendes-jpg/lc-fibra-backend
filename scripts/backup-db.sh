#!/bin/bash
# Backup diario do banco Postgres do Kronos.
# pg_dump compactado (gzip) + remove automaticamente backups com mais de 30 dias.
set -euo pipefail
DESTINO="/opt/kronos/backups"
ENV_FILE="/opt/kronos/backend/.env"
DATA=$(date +%Y-%m-%d_%H%M)

mkdir -p "$DESTINO"

DATABASE_URL=$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL nao encontrada em $ENV_FILE" >&2
  exit 1
fi

pg_dump "$DATABASE_URL" | gzip > "$DESTINO/kronos-$DATA.sql.gz"

# Mantem so os ultimos 30 dias
find "$DESTINO" -name 'kronos-*.sql.gz' -mtime +30 -delete

echo "Backup concluido: $DESTINO/kronos-$DATA.sql.gz ($(du -h "$DESTINO/kronos-$DATA.sql.gz" | cut -f1))"
