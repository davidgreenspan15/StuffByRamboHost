#!/usr/bin/env bash
# Read-only SEC-002 probes. Sends anonymous GET/HEAD requests only; no
# credentials, no writes. Usage: probe_headers.sh [expect-on|expect-off]
set -euo pipefail
MODE="${1:-expect-on}"
case "$MODE" in expect-on|expect-off) ;; *) echo "Expected expect-on or expect-off" >&2; exit 2;; esac
HOST="${2:-all}"
case "$HOST" in all) HOSTS=(stuffbyrambo.com www.stuffbyrambo.com);; stuffbyrambo.com|www.stuffbyrambo.com) HOSTS=("$HOST");; *) echo "Unexpected host" >&2; exit 2;; esac
FAIL=0
probe() {
    local url="$1" want="$2" headers
    headers="$(/usr/bin/curl -sS -D - -o /dev/null --max-time 15 "$url" | tr -d '\r')"
    local status csp
    status="$(printf '%s\n' "$headers" | awk 'NR==1{print $2}')"
    csp="$(printf '%s\n' "$headers" | grep -i '^content-security-policy:' || true)"
    if [[ "$want" == "on" ]]; then
        case "$status" in 200|301|308) ;; *) echo "UNAVAILABLE commerce page $url ($status)"; FAIL=1;; esac
        for h in content-security-policy strict-transport-security x-frame-options \
                 x-content-type-options referrer-policy permissions-policy; do
            printf '%s\n' "$headers" | grep -qi "^$h:" || { echo "MISSING $h $url ($status)"; FAIL=1; }
        done
        [[ "$csp" == *"frame-ancestors 'none'"* ]] || { echo "NO frame-ancestors $url"; FAIL=1; }
        printf '%s\n' "$headers" | grep -i '^strict-transport-security:' | grep -qiE 'includesubdomains|preload' \
            && { echo "HSTS too broad $url"; FAIL=1; }
    else
        # GitHub's generic 404 already has its own CSP. Detect our commerce
        # policy leaking onto unrelated routes rather than rejecting origin CSP.
        [[ "$csp" != *"https://licenses.stuffbyrambo.com"* ]] || { echo "UNEXPECTED commerce CSP $url"; FAIL=1; }
    fi
    echo "$status $want $url"
}
COMMERCE=(/gesture-flow /gesture-flow/ /gesture-flow/success.html /gesture-flow/canceled.html
          /gesture-flow/compatibility.html /license /license/ /legal/terms.html
          /legal/privacy.html /legal/refunds.html)
UNRELATED=(/ /index.html /assets/storefront.css /assets/storefront.js /CNAME /does-not-exist)
for host in "${HOSTS[@]}"; do
    for path in "${COMMERCE[@]}"; do
        probe "https://$host$path" "$([[ "$MODE" == expect-on ]] && echo on || echo off)"
    done
    for path in "${UNRELATED[@]}"; do probe "https://$host$path" off; done
done
exit "$FAIL"
