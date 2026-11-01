#!/bin/bash
# Creates the limited application user that the API connects with.
#
# When does this run? The Postgres image runs every script in
# /docker-entrypoint-initdb.d/ ONCE, the first time the container starts with
# an empty data directory. It never runs again on later starts. To re-run it,
# reset the database (make reset-db), which deletes all data.
#
# The "20-" prefix makes it run after the PostGIS image's own 10_postgis.sh.
#
# Roles:
#   POSTGRES_USER  superuser (admin). Owns the database and every table,
#                  because the migrate service connects as this user.
#   APP_DB_USER    the API. Can read and write rows, cannot change the schema.

set -euo pipefail

# Fail early with a clear message if .env is missing these.
: "${APP_DB_USER:?APP_DB_USER must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

# The values go to psql as variables (-v) rather than being pasted into the
# SQL text. psql then quotes them safely: :"x" as an identifier (a name),
# :'x' as a string literal. A password containing quotes cannot break the SQL.
# The heredoc delimiter is quoted ('SQL') so bash leaves the text untouched.
psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v app_user="$APP_DB_USER" \
    -v app_password="$APP_DB_PASSWORD" \
    -v admin_user="$POSTGRES_USER" \
    -v db_name="$POSTGRES_DB" \
    <<'SQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password';

-- Allow the app user to connect to this database and see the public schema.
-- (Since Postgres 15, ordinary users cannot CREATE in public by default, which
-- is exactly what we want: only the admin/migrate service creates tables.)
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";

-- Default privileges: rules applied automatically to tables and sequences
-- that the admin creates IN THE FUTURE (i.e. every table a migration adds).
-- Without this, each new table would be unreadable by the API until someone
-- remembered to GRANT on it by hand.
--   FOR ROLE admin_user: applies to objects created by the admin, which is
--                        the user the migrate service runs as.
--   SEQUENCES / USAGE:   lets the API insert rows into tables with an
--                        auto-increment (identity/serial) id.
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO :"app_user";
SQL

echo "Created application user '$APP_DB_USER' with default privileges on schema public."
