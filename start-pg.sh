#!/bin/bash
PG_PASS=$(python3 -c "
with open('/home/zhang/zhonggui-core/.env') as f:
    for line in f:
        if line.startswith('PG_PASSWORD='):
            print(line.strip().split('=', 1)[1])
            break
")

docker run -d \
  --name zhonggui-core-postgres \
  -e POSTGRES_DB=zhonggui_core \
  -e POSTGRES_USER=zhonggui \
  -e "POSTGRES_PASSWORD=${PG_PASS}" \
  -p 5433:5432 \
  -v /home/zhang/zhonggui-core/init.sql:/docker-entrypoint-initdb.d/init.sql:ro \
  pgvector/pgvector:pg16

echo "Container created with password from .env"
