#!/usr/bin/env bash
# Smoke test for the release binary. Runs on the dev host (needs a display + libwebkit2gtk-4.1).
#   scripts/smoke-desktop.sh [path-to-binary]     default: ~/rebull-bin/tradermatrix-desktop
# Prints PASS, FAIL, or SKIP (with reason). SKIP is never a pass.
set -u
BIN="${1:-$HOME/rebull-bin/tradermatrix-desktop}"
# The data dir, DB and lock file keep their pre-rename names on purpose (M15): existing vault and layouts must carry over.
DB="${XDG_DATA_HOME:-$HOME/.local/share}/app.rebull.desktop/rebull.db"

skip() { echo "SKIP: $*"; exit 0; }
fail() { echo "FAIL: $*"; exit 1; }

[ -x "$BIN" ] || fail "binary not found or not executable: $BIN"
[ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || skip "no DISPLAY or WAYLAND_DISPLAY"
if ! ldd "$BIN" 2>/dev/null | grep -q 'libwebkit2gtk'; then
  : # statically odd build; fall through to the runtime check
fi
if ldd "$BIN" 2>/dev/null | grep -q 'not found'; then
  skip "missing shared libs: $(ldd "$BIN" | awk '/not found/ {print $1}' | tr '\n' ' ')"
fi

had_db=0; [ -f "$DB" ] && had_db=1
OUT="$(mktemp -t rebull-smoke.XXXXXX)" || fail "mktemp failed"
trap 'rm -f "$OUT"' EXIT

launch_once() {
  # launch, require it to still be alive at 8 s, then stop it (timeout 12 would also stop it)
  timeout 12 "$BIN" >"$OUT" 2>&1 &
  local pid=$!
  sleep 8
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"; local rc=$?
    echo "--- output ---"; head -c 2000 "$OUT"; echo "--------------"
    fail "process exited early (rc=$rc) before 8 s"
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  return 0
}

tables() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" "select name from sqlite_master where type='table'"
  else
    python3 -I - "$DB" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print("\n".join(r[0] for r in c.execute("select name from sqlite_master where type='table'")))
PY
  fi
}

check_db() {
  [ -f "$DB" ] || fail "db not created at $DB"
  local t; t="$(tables)" || fail "could not read db"
  echo "$t" | grep -qx layouts || fail "missing table layouts"
  echo "$t" | grep -qx settings || fail "missing table settings"
  local ic
  if command -v sqlite3 >/dev/null 2>&1; then ic="$(sqlite3 "$DB" 'pragma integrity_check')"
  else ic="$(python3 -I -c 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("pragma integrity_check").fetchone()[0])' "$DB")"; fi
  [ "$ic" = "ok" ] || fail "integrity_check: $ic"
}

launch_once; check_db
launch_once; check_db
echo "PASS: launched twice, alive at 8 s each time, db has layouts+settings, integrity ok (db pre-existed: $had_db)"
