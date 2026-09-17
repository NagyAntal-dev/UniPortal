#!/bin/sh
# Run manually on the deployed Docker server. Default: rollback-only preview.
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  ''|--dry-run) APPLY=false ;;
  --yes) APPLY=true ;;
  *) echo 'Usage: sh deploy/reset-data.sh [--dry-run|--yes]'; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo 'Too many arguments'; exit 1; }
[ -f .env ] || { echo '[reset] No .env: run this on the deployed server.'; exit 1; }

sql() {
  docker compose run --rm --no-deps -T --entrypoint psql migrate \
    -X -v ON_ERROR_STOP=1 "$@"
}

echo '[reset] Preserving accounts, profiles, avatars, RBAC roles, permissions and groups.'
echo '[reset] Also preserving user attributes and records required by scoped RBAC grants.'
echo '[reset] All other public/echo/dorm table data and non-avatar uploads will be deleted.'
echo '[reset] Schema, bucket definitions, Auth and migration history remain intact.'

if [ "$APPLY" = false ]; then
  sql -v apply=false < deploy/reset-data.sql
  sql -c "select bucket_id, count(*) as files_to_delete from storage.objects where bucket_id <> 'avatars' group by bucket_id order by bucket_id;"
  echo '[reset] Preview only. To delete: sh deploy/reset-data.sh --yes'
  exit 0
fi

# Stop writers while retaining DB, PostgREST (required by Storage), and Storage.
# Only restart services that were already running; never rerun migrations.
RUNNING=$(docker compose ps --services --status running)
PAUSED=''
for service in $RUNNING; do
  case "$service" in
    web|api-gw|auth|functions|realtime|supavisor|studio|meta|migrate)
      PAUSED="$PAUSED $service" ;;
  esac
done
umask 077
OBJECTS=$(mktemp)
cleanup() {
  result=$?
  trap - EXIT
  rm -f "$OBJECTS"
  if [ -n "$PAUSED" ]; then
    docker compose start $PAUSED || { echo '[reset] Restart failed; run docker compose start.'; result=1; }
  fi
  if [ "$result" -ne 0 ]; then
    echo '[reset] Reset failed. Storage deletion is not transactional; inspect the error before retrying.'
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ -z "$PAUSED" ] || docker compose stop $PAUSED

# Validate the complete SQL reset before any irreversible file deletion.
sql -v apply=false < deploy/reset-data.sql
sql -q -t -A -c "select coalesce(json_agg(json_build_object('bucket_id', bucket_id, 'name', name)), '[]'::json) from storage.objects where bucket_id <> 'avatars';" > "$OBJECTS"
docker compose exec -T storage node -e "$(cat deploy/reset-storage.cjs)" < "$OBJECTS"
sql -c "do \$\$ begin if exists (select 1 from storage.objects where bucket_id <> 'avatars') then raise exception 'Non-avatar uploads remain; reset aborted'; end if; end \$\$;"
sql -v apply=true < deploy/reset-data.sql
echo '[reset] Done. Reload open browser tabs to discard cached data.'
