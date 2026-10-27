#!/usr/bin/env bash
set -euo pipefail

readonly PLUGIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v omp >/dev/null 2>&1; then
  printf 'OMP is required. Install OMP before this plugin.\n' >&2
  exit 1
fi

omp plugin link "${PLUGIN_DIR}"

left_segments="$(omp config get statusLine.leftSegments)"
case "${left_segments}" in
  *'"status"'*)
    ;;
  '[]')
    left_segments='["status"]'
    ;;
  *'"path"'*)
    left_segments="${left_segments/\"path\"/\"status\",\"path\"}"
    ;;
  *)
    left_segments="${left_segments%]},\"status\"]"
    ;;
esac

omp config set statusLine.preset custom
omp config set statusLine.leftSegments "${left_segments}"
omp config set statusLine.showHookStatus false

printf '\nUntitled for OMP is installed. Restart OMP, then select Untitled Auto.\n'
