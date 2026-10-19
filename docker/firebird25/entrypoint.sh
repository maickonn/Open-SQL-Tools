#!/bin/bash
# Starts Firebird 2.5 in the foreground, sets the SYSDBA password and creates
# $FIREBIRD_DATABASE on first start (mirrors the official image's variables).
set -e
FB=/opt/firebird
PASSWORD="${FIREBIRD_ROOT_PASSWORD:-masterkey}"
DATA_DIR=/var/lib/firebird/data
DB_NAME="${FIREBIRD_DATABASE:-testdb.fdb}"
CHARSET="${FIREBIRD_DATABASE_DEFAULT_CHARSET:-UTF8}"

# The release buildroot ships security2.fdb with SYSDBA/masterkey.
CURRENT=masterkey

$FB/bin/fbserver &
SERVER_PID=$!

for i in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/3050) 2>/dev/null && break
  sleep 1
done

if [ "$CURRENT" != "$PASSWORD" ]; then
  $FB/bin/gsec -user SYSDBA -password "$CURRENT" -modify SYSDBA -pw "$PASSWORD"
fi

if [ ! -f "$DATA_DIR/$DB_NAME" ]; then
  echo "CREATE DATABASE 'localhost:$DATA_DIR/$DB_NAME' USER 'SYSDBA' PASSWORD '$PASSWORD' PAGE_SIZE 16384 DEFAULT CHARACTER SET $CHARSET;" \
    | $FB/bin/isql -q
fi

wait $SERVER_PID
