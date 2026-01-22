#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

rm -rf "${ROOT_DIR}/docs"/*
mkdir -p "${ROOT_DIR}/docs"
cp -R "${ROOT_DIR}/public"/* "${ROOT_DIR}/docs/"

if [ ! -f "${ROOT_DIR}/docs/.nojekyll" ]; then
  touch "${ROOT_DIR}/docs/.nojekyll"
fi

echo "Copied public/ -> docs/ for GitHub Pages."
