#!/usr/bin/env bash
# Commits whatever the collector wrote and pushes it, retrying if someone pushed meanwhile.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -A state archive runs.log errors 2>/dev/null || git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi

git commit -q -m "collect: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

for attempt in 1 2 3 4; do
  if git push origin HEAD:main; then
    exit 0
  fi
  echo "push failed (attempt $attempt), rebasing on origin/main"
  sleep $((attempt * 10))
  git fetch origin main
  git rebase origin/main || { git rebase --abort; echo "rebase failed"; exit 1; }
done

echo "giving up after 4 attempts"
exit 1
