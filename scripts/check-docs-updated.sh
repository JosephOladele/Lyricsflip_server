#!/usr/bin/env bash
# Verifies that changes to routes, environment variables or core behavior
# include corresponding documentation updates in README.md or docs/.
set -euo pipefail

BASE_REF="${1:-origin/main}"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  # Fall back to inspecting previous commit if base ref is unavailable locally
  BASE_REF="HEAD~1"
fi

changed_files=$(git diff --name-only "$BASE_REF"...HEAD 2>/dev/null || git diff --name-only HEAD~1 HEAD 2>/dev/null || true)

if [ -z "$changed_files" ]; then
  exit 0
fi

# Check if routes, environment variables, or core behavioral configs changed
sensitive_changes=$(echo "$changed_files" | grep -E '(\.controller\.ts$|\.env\.example$|src/config/env\.validation\.ts$|src/stellar/stellar\.config\.ts$)' || true)

if [ -n "$sensitive_changes" ]; then
  docs_changed=$(echo "$changed_files" | grep -E '(^README\.md$|^docs/)' || true)
  if [ -z "$docs_changed" ]; then
    echo "ERROR: The following routes, environment variables, or behavioral configs were modified:" >&2
    echo "$sensitive_changes" >&2
    echo "" >&2
    echo "Documentation requirement failed: PRs modifying routes, environment variables, or system behavior" >&2
    echo "must update README.md or files in docs/." >&2
    exit 1
  fi
  echo "Documentation updates found in README.md or docs/."
fi
