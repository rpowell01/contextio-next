#!/usr/bin/env bash
set -euo pipefail

BASE="https://contextio-next.sslip.mywire.org"
UA="curl-test/1.0"

echo "=== Testing API endpoints against ${BASE} ==="
echo

now_ms() { date +%s%N; }
code() { echo; echo "HTTP $1 | ${2:-}"; }

test_endpoint() {
  local label="$1"
  local url="$2"
  local extra="${3:-}"
  local start end elapsed http_code body

  start=$(now_ms)
  echo "→ ${label}"
  echo "  ${url}"
  set +e
  http_code=$(curl -sS -o /tmp/api_test_body.$$ -w "%{http_code}" \
    -H "User-Agent: ${UA}" -H "Accept: application/json" \
    --max-time 15 \
    ${extra} \
    "${url}" 2>/tmp/api_test_err.$$)
  local rc=$?
  set -e
  end=$(now_ms)
  elapsed=$(( (end - start) / 1000000 ))
  body=$(wc -c </tmp/api_test_body.$$)

  echo "  HTTP ${http_code} | ${elapsed} ms | ${body} bytes"
  if [ -s /tmp/api_test_err.$$ ]; then
    echo "  STDERR: $(cat /tmp/api_test_err.$$)"
  fi
  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
    echo "  BODY (first 500 bytes):"
    head -c 500 /tmp/api_test_body.$$ | sed 's/</\\</g' | fold -s -w 80 | sed 's/^/    /'
  fi
  echo
}

# 1. Root
test_endpoint "GET /" "${BASE}/" 

# 2. Redactions (summary used by homepage)
test_endpoint "GET /api/redactions" "${BASE}/api/redactions"

# 3. Metrics
test_endpoint "GET /api/metrics" "${BASE}/api/metrics"

# 4. Sessions list (ungrouped)
test_endpoint "GET /api/sessions" "${BASE}/api/sessions"

# 5. Sessions grouped (used by /sessions page)
test_endpoint "GET /api/sessions?groupBySourceDest=true" "${BASE}/api/sessions?groupBySourceDest=true"

# 6. First known session id (replace once you know one; placeholder keeps script runnable)
if [ -n "${SAMPLE_SESSION_ID:-}" ]; then
  test_endpoint "GET /api/sessions/${SAMPLE_SESSION_ID}" "${BASE}/api/sessions/${SAMPLE_SESSION_ID}"
else
  echo "→ Skipping /api/sessions/<id> (set SAMPLE_SESSION_ID to test)"
  echo
fi

rm -f /tmp/api_test_body.$$ /tmp/api_test_err.$$
