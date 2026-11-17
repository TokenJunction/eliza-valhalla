#!/bin/bash

# ElizaOS Project Starter - Comprehensive Test Runner
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
ALL_TESTS_PASSED=true

run_test_suite() {
    local suite_name=$1
    local command=$2
    echo -e "${YELLOW}Running $suite_name...${NC}"
    echo "Command: $command"
    if eval "$command"; then
        echo -e "${GREEN}Passed: $suite_name${NC}"
    else
        echo -e "${RED}Failed: $suite_name${NC}"
        ALL_TESTS_PASSED=false
    fi
}

run_test_suite "TypeScript checks" "bun run type-check"
run_test_suite "Format checks" "bun run format:check"
run_test_suite "Build" "bun run build"
run_test_suite "Unit tests (Bun)" "bun run test:component"
run_test_suite "Valkyrie skill tests (Node)" "bun run test:skill"
run_test_suite "Clerk toolkit tests" "bun run test:clerk"
run_test_suite "E2E tests (ElizaOS)" "bun run test:e2e"
run_test_suite "Cypress component tests" "bun run cypress:component"

# Match the application port and use a bounded health-check loop.
export SERVER_PORT="${SERVER_PORT:-${PORT:-3000}}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:${SERVER_PORT}/health}"
READINESS_TIMEOUT="${READINESS_TIMEOUT:-60}"
if ! [[ "$READINESS_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    echo "READINESS_TIMEOUT must be a positive integer (seconds)." >&2
    exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
APP_LOG=$(mktemp) || exit 1
APP_PID=
cleanup() {
    if [ -n "$APP_PID" ]; then
        kill "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
    rm -f "$APP_LOG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting application; waiting up to ${READINESS_TIMEOUT}s for $READINESS_URL"
bun start >"$APP_LOG" 2>&1 &
APP_PID=$!
APP_READY=false
DEADLINE=$((SECONDS + READINESS_TIMEOUT))
while (( SECONDS < DEADLINE )); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        echo "Application exited before becoming ready." >&2
        break
    fi
    REMAINING=$((DEADLINE - SECONDS))
    (( REMAINING > 0 )) || break
    REQUEST_TIMEOUT=$REMAINING
    (( REQUEST_TIMEOUT <= 3 )) || REQUEST_TIMEOUT=3
    HTTP_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
        --connect-timeout "$REQUEST_TIMEOUT" --max-time "$REQUEST_TIMEOUT" \
        "$READINESS_URL")
    CURL_STATUS=$?
    if [ "$CURL_STATUS" -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]] && \
        kill -0 "$APP_PID" 2>/dev/null; then
        APP_READY=true
        break
    fi
    (( SECONDS < DEADLINE )) && sleep 1
done

if [ "$APP_READY" = true ]; then
    echo -e "${GREEN}Application health check passed.${NC}"
    run_test_suite "Cypress E2E tests" "bun run cypress:e2e"
else
    echo -e "${RED}Application readiness failed; startup log follows:${NC}" >&2
    ALL_TESTS_PASSED=false
fi
if [ "$ALL_TESTS_PASSED" != true ]; then
    cat "$APP_LOG" >&2
fi

# Report suite status only; test counts belong to the test reporters.
if [ "$ALL_TESTS_PASSED" = true ]; then
    echo "All test commands passed."
    exit 0
else
    echo "Some tests failed. See command output above." >&2
    exit 1
fi
