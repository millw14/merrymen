#!/usr/bin/env bash
# READ-ONLY. For every orchestrator deployment, pull the log lines that match a
# filter token and write them per-deployment. No writes, no deploys, no restarts.
#   $1 = filter string, $2 = output prefix
set -u
SC="C:/Users/1/AppData/Local/Temp/claude/C--Users-1-Documents-milla-projects/6042837b-fc09-4d49-881b-472d0a87cf43/scratchpad"
FILTER="$1"
PREFIX="$2"
mkdir -p "$SC/sb"
i=0
while IFS=$'\t' read -r id at status commit msg; do
  [ -z "$id" ] && continue
  i=$((i+1))
  out="$SC/sb/${PREFIX}-${id}.json"
  if [ -s "$out" ]; then echo "skip $i $id (cached)"; continue; fi
  timeout 120 railway logs "$id" --service orchestrator --json --lines 5000 --filter "$FILTER" > "$out" 2>"$out.err"
  n=$(wc -l < "$out" 2>/dev/null || echo 0)
  echo "$i $id $at $commit lines=$n"
done < "$SC/sb-deps.tsv"
echo "DONE $i deployments"
