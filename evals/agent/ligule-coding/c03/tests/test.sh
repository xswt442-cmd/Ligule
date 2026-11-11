#!/bin/bash
set -u

mkdir -p /logs/verifier
if node /tests/verify.mjs /app; then
  printf "1\n" > /logs/verifier/reward.txt
  exit 0
fi

printf "0\n" > /logs/verifier/reward.txt
exit 1
