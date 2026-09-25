#!/usr/bin/env bash
# Replays a frozen context file in the installed plugin and screenshots the
# Workstreams screen at desktop and mobile widths.
#
#   scripts/screenshot.sh FIXTURE.json OUT_DIR [--analyze] [--keep]
#
# FIXTURE is an absolute path (e.g. from `bb workstreams export`, or
# eval/cases.json). Private fixtures and their screenshots belong in private
# storage, never in this repository. --analyze runs a fresh paid analysis
# first; otherwise the fixture's last saved analysis is shown. Replay is
# turned off afterwards unless --keep is given.
set -euo pipefail
fixture=$1 out=$2
shift 2
analyze=0 keep=0
for arg in "$@"; do
  case $arg in
    --analyze) analyze=1 ;;
    --keep) keep=1 ;;
  esac
done
url=${WORKSTREAMS_URL:-http://127.0.0.1:38886/plugins/workstreams/home}
mkdir -p "$out"
bb workstreams fixture "$fixture" >/dev/null
if [[ $analyze == 1 ]]; then
  bb workstreams analyze >/dev/null
  sleep 1
  until bb workstreams list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).progress?1:0))'; do
    sleep 1
  done
  bb workstreams list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(JSON.stringify({error:d.error,stats:d.analysis?.stats}))})'
fi
session=workstreams-shot-$$
shoot() {
  agent-browser --session "$session" set viewport "$1" "$2" >/dev/null
  agent-browser --session "$session" open "$url" >/dev/null
  sleep 4
  agent-browser --session "$session" screenshot "$out/$3.png" >/dev/null
  echo "$out/$3.png"
}
shoot 1440 2200 desktop
shoot 390 2400 mobile
agent-browser --session "$session" close >/dev/null || true
[[ $keep == 1 ]] || bb workstreams fixture off >/dev/null
