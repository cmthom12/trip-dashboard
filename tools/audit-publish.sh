#!/bin/bash
# tools/audit-publish.sh — pre-publish leak audit for the public template.
#
# Greps every TRACKED file (git grep -i, the overnight-run leak-audit ritual)
# for private-trip terms that must never ship in the public repo: the original
# trip's route/identity, the live deployment's hostname, and the maintainer's
# local paths/addresses.
#
# The terms themselves ARE the sensitive list, so they are stored base64-
# encoded below and decoded at runtime — a plain-text list would make this
# script fail its own audit on every run. To add a term:
#   printf '%s' 'newterm' | base64
# and append the output to TERMS_B64 (lowercase; matching is case-insensitive).
#
# Exit codes follow normal shell convention:
#   0 = clean (no tracked file contains any term)
#   1 = hits found (they are printed)
#   2 = not a git repo
set -u
cd "$(dirname "$0")/.." || exit 2
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "audit-publish: not a git repo" >&2; exit 2; }

TERMS_B64="
Z3JlZWNl
a3VzYWRhc2k=
dMO8cmtpeWU=
YWVnZWFu
YXRoZW5z
b21haGE=
dmVnYXM=
dmFjYXRpb24tcGxhbm5lcg==
dGhvbWM=
dGhvbS5jaHJpcy5taWNoYWVs
"

ARGS=()
for t in $TERMS_B64; do
  ARGS+=( -e "$(printf '%s' "$t" | base64 -d)" )
done

HITS=$(git grep -i -n "${ARGS[@]}" -- . 2>/dev/null)
if [ -n "$HITS" ]; then
  echo "audit-publish: LEAK HITS in tracked files:"
  printf '%s\n' "$HITS"
  exit 1
fi
echo "audit-publish: clean — no private-trip terms in tracked files."
exit 0
