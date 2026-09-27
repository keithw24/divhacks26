#!/usr/bin/env bash
# Deploys one commit of the Around Me MVP on the droplet, and rolls back if it doesn't come up.
#
# CI runs the copy of this script from the commit being deployed, piped over SSH, so a checkout
# mid-run can't change the script under bash:
#   git fetch -q origin && git show <sha>:mvp/deploy/deploy.sh | bash -s -- <sha>
# By hand, from the repo on the droplet: bash mvp/deploy/deploy.sh <sha>
#
# Migrations are additive and idempotent (mvp/sql), so a rollback keeps them.
set -euo pipefail

SHA="${1:?usage: deploy.sh <git-sha>}"
REPO_DIR="${REPO_DIR:-$HOME/divhacks26}"
HEALTH_TRIES="${HEALTH_TRIES:-36}"   # x HEALTH_WAIT seconds; the first build can take a few minutes
HEALTH_WAIT="${HEALTH_WAIT:-5}"

if [[ ! "$SHA" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "deploy: '$SHA' is not a commit sha" >&2
  exit 2
fi

cd "$REPO_DIR"
[[ -f mvp/.env ]] || { echo "deploy: mvp/.env is missing (see docs/digitalocean-setup.md)" >&2; exit 2; }

# One deploy at a time on this host.
if command -v flock >/dev/null; then
  exec 9>"${TMPDIR:-/tmp}/around-me-deploy.lock"
  flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 1; }
fi

compose() { docker compose -f mvp/compose.yaml "$@"; }

# The version the running agent reports, or nothing if it isn't answering yet.
running_version() {
  compose exec -T agent node -e \
    "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>console.log(j.version)).catch(()=>process.exit(1))" \
    2>/dev/null || true
}

# Check out $1, migrate, rebuild, and wait until the agent reports that exact commit.
release() {
  git -c advice.detachedHead=false checkout --quiet --detach "$1"
  local version
  version="$(git rev-parse --short=12 HEAD)"
  echo "deploy: releasing $version"
  compose --profile tools run --rm migrate
  GIT_SHA="$version" compose up -d --build --remove-orphans
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if [[ "$(running_version)" == "$version" ]]; then
      echo "deploy: $version is healthy"
      return 0
    fi
    sleep "$HEALTH_WAIT"
  done
  echo "deploy: $version did not report healthy in time" >&2
  compose logs --tail 50 agent >&2 || true
  return 1
}

previous="$(git rev-parse HEAD)"
git fetch --quiet origin
git cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "deploy: $SHA is not on origin" >&2; exit 2; }

if release "$SHA"; then
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "deploy: rolling back to $(git rev-parse --short=12 "$previous")" >&2
if release "$previous"; then
  echo "deploy: rolled back; $SHA was not deployed" >&2
else
  echo "deploy: ROLLBACK FAILED; check the droplet" >&2
fi
exit 1
