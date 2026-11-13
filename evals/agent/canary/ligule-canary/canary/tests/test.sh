#!/bin/bash
set -u

mkdir -p /logs/verifier
if node /tests/verify.mjs /app; then
  echo 1 > /logs/verifier/reward.txt
  exit 0
fi

echo 0 > /logs/verifier/reward.txt
exit 1
