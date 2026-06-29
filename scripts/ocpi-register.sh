#!/usr/bin/env bash
# Walk the OCPI 2.2.1 credentials-registration handshake against a hub.
#
# Required env vars:
#   HUB_BASE         e.g. https://testapiv2.ortaksarjplatformu.com/ocpi
#   TOKEN_A          one-shot CREDENTIALS_TOKEN_A issued by the hub admin
#   MY_VERSIONS_URL  your party's public /ocpi/versions URL
#   MY_TOKEN_B       TOKEN_B the hub should use when calling you
#   COUNTRY_CODE     ISO-3166 alpha-2, e.g. TR
#   PARTY_ID         3-letter party id, e.g. EVY
#
# Optional:
#   MY_ROLE          "EMSP" (default) or "CPO"
#   MY_PARTY_NAME    display name, defaults to "$PARTY_ID"
#
# Prints each request/response so you can see exactly where the handshake fails.

set -u
set -o pipefail

require() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env var: $name" >&2
    exit 2
  fi
}

require HUB_BASE
require TOKEN_A
require MY_VERSIONS_URL
require MY_TOKEN_B
require COUNTRY_CODE
require PARTY_ID

MY_ROLE=${MY_ROLE:-EMSP}
MY_PARTY_NAME=${MY_PARTY_NAME:-$PARTY_ID}

# OCPI 2.2+ requires the token to be base64-encoded in the Authorization header.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

TOKEN_A_B64=$(b64 "$TOKEN_A")
TOKEN_B_B64=$(b64 "$MY_TOKEN_B")

hr() { printf '\n%s\n' "------------------------------------------------------------"; }

# Issues a request and prints status, response headers, and body.
# Body is pretty-printed if it parses as JSON.
call() {
  local method=$1 url=$2 token_b64=$3 body=${4:-}
  hr
  echo "→ $method $url"
  echo "  Authorization: Token ${token_b64:0:12}…(base64)"
  if [[ -n "$body" ]]; then
    echo "  body: $body"
  fi
  local tmp_headers tmp_body status
  tmp_headers=$(mktemp)
  tmp_body=$(mktemp)
  if [[ -n "$body" ]]; then
    status=$(curl -sS -o "$tmp_body" -D "$tmp_headers" -w '%{http_code}' \
      -X "$method" \
      -H "Authorization: Token $token_b64" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data "$body" \
      "$url")
  else
    status=$(curl -sS -o "$tmp_body" -D "$tmp_headers" -w '%{http_code}' \
      -X "$method" \
      -H "Authorization: Token $token_b64" \
      -H "Accept: application/json" \
      "$url")
  fi
  echo "← HTTP $status"
  sed -n '1,10p' "$tmp_headers"
  echo "── body ──"
  if command -v jq >/dev/null 2>&1 && jq -e . "$tmp_body" >/dev/null 2>&1; then
    jq . "$tmp_body"
  else
    cat "$tmp_body"
    echo
  fi
  # Echo body to stdout caller can capture
  LAST_STATUS=$status
  LAST_BODY=$(cat "$tmp_body")
  rm -f "$tmp_headers" "$tmp_body"
  if [[ "$status" -ge 400 ]]; then
    echo "✗ stopped: $method $url returned $status" >&2
    exit 1
  fi
}

# ---------- step 1: GET /versions ----------
VERSIONS_URL="${HUB_BASE%/}/versions"
call GET "$VERSIONS_URL" "$TOKEN_A_B64"

# Pick the highest OCPI version the hub advertises that we know about.
PICK_VERSION_URL=$(printf '%s' "$LAST_BODY" \
  | jq -r '
      (.data // [])
      | map(select(.version == "2.2.1" or .version == "2.2" or .version == "2.1.1"))
      | sort_by(if .version=="2.2.1" then 3 elif .version=="2.2" then 2 else 1 end)
      | last
      | .url // empty
    ')

if [[ -z "$PICK_VERSION_URL" ]]; then
  echo "✗ no supported version (2.1.1 / 2.2 / 2.2.1) advertised by hub" >&2
  exit 1
fi
echo "✔ picked version endpoint: $PICK_VERSION_URL"

# ---------- step 2: GET /versions/{v} (the version detail) ----------
call GET "$PICK_VERSION_URL" "$TOKEN_A_B64"

CREDENTIALS_URL=$(printf '%s' "$LAST_BODY" \
  | jq -r '(.data.endpoints // []) | map(select(.identifier=="credentials")) | first | .url // empty')

if [[ -z "$CREDENTIALS_URL" ]]; then
  echo "✗ hub did not advertise a 'credentials' endpoint" >&2
  exit 1
fi
echo "✔ credentials endpoint: $CREDENTIALS_URL"

# ---------- step 3: POST /credentials ----------
# Body shape is 2.2/2.2.1; for 2.1.1 the 'roles' array is not used (single
# country_code/party_id at top level). Tweak if you're targeting 2.1.1.
CREDENTIALS_BODY=$(jq -n \
  --arg token "$MY_TOKEN_B" \
  --arg url   "$MY_VERSIONS_URL" \
  --arg cc    "$COUNTRY_CODE" \
  --arg pid   "$PARTY_ID" \
  --arg role  "$MY_ROLE" \
  --arg name  "$MY_PARTY_NAME" \
  '{
     token: $token,
     url:   $url,
     roles: [
       {
         country_code: $cc,
         party_id:     $pid,
         role:         $role,
         business_details: { name: $name }
       }
     ]
   }')

# POST with TOKEN_A; hub responds with their CREDENTIALS_TOKEN_C for us to use.
call POST "$CREDENTIALS_URL" "$TOKEN_A_B64" "$CREDENTIALS_BODY"

HUB_TOKEN_C=$(printf '%s' "$LAST_BODY" | jq -r '.data.token // empty')
HUB_VERSIONS_URL=$(printf '%s' "$LAST_BODY" | jq -r '.data.url // empty')

hr
echo "✔ registration complete"
echo "  hub TOKEN_C    : $HUB_TOKEN_C"
echo "  hub /versions  : $HUB_VERSIONS_URL"
echo
echo "Use TOKEN_C (base64-encoded) for all subsequent calls to the hub."
