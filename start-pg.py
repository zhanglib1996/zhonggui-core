#!/usr/bin/env python3
"""Start PostgreSQL container with password from .env file."""
import subprocess
import sys

# Read password from .env
pg_password = None
with open('/home/zhang/zhonggui-core/.env') as f:
    for line in f:
        if line.startswith('PG_PASSWORD='):
            pg_password = line.strip().split('=', 1)[1]
            break

if not pg_password:
    print("ERROR: PG_PASSWORD not found in .env")
    sys.exit(1)

# Remove old container
subprocess.run(['docker', 'rm', '-f', 'zhonggui-core-postgres'],
               capture_output=True)

# Create new container
result = subprocess.run([
    'docker', 'run', '-d',
    '--name', 'zhonggui-core-postgres',
    '-e', 'POSTGRES_DB=zhonggui_core',
    '-e', 'POSTGRES_USER=zhonggui',
    '-e', f'POSTGRES_PASSWORD={pg_password}',
    '-p', '5433:5432',
    '-v', '/home/zhang/zhonggui-core/init.sql:/docker-entrypoint-initdb.d/init.sql:ro',
    'pgvector/pgvector:pg16',
], capture_output=True, text=True)

if result.returncode == 0:
    print(f"Container created: {result.stdout.strip()[:12]}")
else:
    print(f"ERROR: {result.stderr}")
    sys.exit(1)
