#!/usr/bin/env bash
# Seed a small, recognisable test chain into a Tripwire instance through its own
# web endpoints (login.php + refresh.php + comments.php), exactly as the client
# does. Meant for a throwaway dev instance, never a real map.
#
#   TW_URL=https://tripwire.example TW_USER=... TW_PASS=... scripts/seed-dev.sh
#
# Every signature is created by the logged-in character, so clean-up is a
# matter of deleting them in the Tripwire UI (or re-running this: Tripwire
# rejects duplicate signature IDs per system, so re-runs are safe but noisy).
#
# The chain (home J121116, mask = the account's corp mask):
#   J121116 C4 ─H900─> J135100 C5 ─Z142 (EOL)─> MHC-R3 NS
#                                └─K162 (type unknown)─> Thera
#   J121116    ─X877 (destab)─> J160225 C4 ─???─> High-Sec (generic)
#                                         └─C247─> J102057 C3 ─U210 (mass crit)─> Jita
#   plus a relic and a gas site at home, and one comment on home.
set -euo pipefail
BASE="${TW_URL:?set TW_URL to the dev Tripwire}"
USER="${TW_USER:?set TW_USER}"
PASS="${TW_PASS:?set TW_PASS}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "login as $USER at $BASE"
curl -sS -c "$JAR" -b "$JAR" -X POST "$BASE/login.php" \
  --data-urlencode mode=login --data-urlencode "username=$USER" --data-urlencode "password=$PASS" \
  | grep -q '"result":"success"' || { echo "login failed (Tripwire allows one login per IP per 30 s)"; exit 1; }

args=(); i=0
hole() { # sigA sysA sigB sysB type parent life mass hours
  local h=$(( $9 * 3600 ))
  args+=(
    --data-urlencode "signatures[add][$i][wormhole][type]=$5" --data-urlencode "signatures[add][$i][wormhole][parent]=$6"
    --data-urlencode "signatures[add][$i][wormhole][life]=$7"  --data-urlencode "signatures[add][$i][wormhole][mass]=$8"
    --data-urlencode "signatures[add][$i][signatures][0][signatureID]=$1" --data-urlencode "signatures[add][$i][signatures][0][systemID]=$2"
    --data-urlencode "signatures[add][$i][signatures][0][type]=wormhole"  --data-urlencode "signatures[add][$i][signatures][0][lifeLength]=$h"
    --data-urlencode "signatures[add][$i][signatures][1][signatureID]=$3" --data-urlencode "signatures[add][$i][signatures][1][systemID]=$4"
    --data-urlencode "signatures[add][$i][signatures][1][type]=wormhole"  --data-urlencode "signatures[add][$i][signatures][1][lifeLength]=$h"
  ); i=$((i+1))
}
site() { # sigID sys type name hours
  args+=(
    --data-urlencode "signatures[add][$i][signatureID]=$1" --data-urlencode "signatures[add][$i][systemID]=$2"
    --data-urlencode "signatures[add][$i][type]=$3"        --data-urlencode "signatures[add][$i][name]=$4"
    --data-urlencode "signatures[add][$i][lifeLength]=$(( $5 * 3600 ))"
  ); i=$((i+1))
}
hole ABC123 31001593 DEF456 31001881 H900 initial   stable   stable   22   # home -> J135100 C5
hole GHI789 31001881 JKL012 30003268 Z142 initial   critical stable   3    # C5 -> MHC-R3 NS, EOL
hole KLM789 31001881 NOP012 31000005 K162 secondary stable   stable   14   # C5 <- Thera, type unknown
hole MNO345 31001593 PQR678 31001375 X877 initial   stable   destab   11   # home -> J160225 C4, destab
hole STU901 31001375 ""     2        ""   ""        stable   stable   16   # J160225 -> generic High-Sec
hole YZA567 31001375 BCD890 31000885 C247 initial   stable   stable   15   # J160225 -> J102057 C3
hole EFG123 31000885 HIJ456 30000142 U210 initial   stable   critical 20   # C3 -> Jita, mass critical
site QRS345 31001593 relic "Forgotten Frontier Quarantine Outpost" 72
site TUV678 31001593 gas   "Ordinary Perimeter Reservoir" 72

echo "adding $i entries"
curl -sS -c "$JAR" -b "$JAR" -X POST "$BASE/refresh.php" \
  --data-urlencode systemID=31001593 --data-urlencode systemName=J121116 \
  --data-urlencode instance=trippy-seed --data-urlencode version=seed "${args[@]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resultSet||[];console.log(r.filter(x=>x.result).length+" ok, "+r.filter(x=>!x.result).map(x=>x.value).join("; "))})'

curl -sS -c "$JAR" -b "$JAR" -X POST "$BASE/comments.php" --data-urlencode mode=save --data-urlencode systemID=31001593 \
  --data-urlencode "comment=Trippy seed: this is home. Statics H900 and X877. The Ministry is merely noting." >/dev/null
echo "comment saved on J121116"
