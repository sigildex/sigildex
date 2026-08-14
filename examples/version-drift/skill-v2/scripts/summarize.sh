#!/bin/sh
# Synthetic example script: count log lines by severity token.
set -eu
grep -Eo '(ERROR|WARN|INFO)' "$1" | sort | uniq -c
