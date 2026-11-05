#!/bin/bash
set -u

mkdir -p /logs/verifier

if [ -f /app/answer.txt ] && [ "$(cat /app/answer.txt)" = "LIGULE-CANARY-OK" ]; then
  echo 1 > /logs/verifier/reward.txt
  exit 0
fi

echo "answer.txt missing or mismatched" >&2
echo 0 > /logs/verifier/reward.txt
exit 1
