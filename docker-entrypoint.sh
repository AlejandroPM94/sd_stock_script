#!/bin/sh
set -e

# Entry point: clean Chromium lock files in the persistent profile (if any)
# then exec the container command (node refresh_cookies.js by default).

DIR=${USER_DATA_DIR:-/usr/src/app/data}

# If CHROME_PATH is not set or points to a non-executable, try to detect a system
# Chromium binary (common locations) and export a working path.
if [ -z "$CHROME_PATH" ] || [ ! -x "$CHROME_PATH" ]; then
  if [ -n "$CHROME_PATH" ] && [ ! -x "$CHROME_PATH" ]; then
    echo "[entrypoint] CHROME_PATH is set to '$CHROME_PATH' but it's not executable. Attempting auto-detect..."
  fi
  if [ -x "/usr/bin/chromium-browser" ]; then
    export CHROME_PATH=/usr/bin/chromium-browser
  elif [ -x "/usr/bin/chromium" ]; then
    export CHROME_PATH=/usr/bin/chromium
  elif [ -x "/snap/bin/chromium" ]; then
    export CHROME_PATH=/snap/bin/chromium
  else
    echo "[entrypoint] Warning: Chromium binary not found in standard locations; ensure CHROME_PATH is set if needed."
  fi
fi
echo "[entrypoint] Using CHROME_PATH=${CHROME_PATH:-'(not set)'}"

if [ -d "$DIR" ]; then
  echo "[entrypoint] Cleaning Chromium lock files in $DIR"
  # Find common lock/socket names and remove them (only files or symlinks).
  find "$DIR" -maxdepth 6 \( -type l -iname 'singleton*' -o -type f -iname '*lock*' -o -type f -iname 'Singleton*' \) -print -exec rm -vf {} \; || true
fi

# Also remove leftover DevToolsActivePort files (sometimes left by crash)
if [ -f "$DIR/DevToolsActivePort" ]; then
  echo "[entrypoint] Removing DevToolsActivePort"
  rm -f "$DIR/DevToolsActivePort" || true
fi

echo "[entrypoint] Starting command: $@"
# If USE_XVFB=true, run the command under a virtual X server to avoid headless detection
if [ "${USE_XVFB}" = "true" ]; then
  echo "[entrypoint] USE_XVFB=true — ejecutando comando con xvfb-run"
  exec xvfb-run -a "$@"
else
  exec "$@"
fi
