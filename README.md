# sd_stock_script

Small service that:

- Periodically checks Steam Deck stock using `check_stock.js` / `sd_stock_script.js` logic.
- Runs a Telegram bot (`refresh_cookies.js`) that refreshes session cookies when needed and persists them locally.

This repository is designed to run inside Docker (see `Dockerfile` and `docker-compose.yml`). The container runs the Telegram bot and a periodic checker that attempts auto-login if the session expires.

## Required environment variables

Set these variables in your hosting environment or in a local `.env` (do not commit `.env`):

- `TELEGRAM_BOT_TOKEN` — bot token from BotFather (required).
- `TELEGRAM_CHAT_ID` — chat id where notifications are sent (required).
- `STEAM_USERNAME` and `STEAM_PASSWORD` — Steam credentials for automated login (required for auto-login flows).

Optional / tuning variables:

 - Note: GitHub upload functionality has been removed; cookies are persisted locally in `USER_DATA_DIR` / `COOKIES_FILE`.
- `REFRESH_HEADLESS` — `true|false` run puppeteer headless. For first-run interactive login set `false` and use `USER_DATA_DIR`.
- `REFRESH_TRY_HEADLESS_LOGIN` — `true|false` try stealth headless login.
- `USER_DATA_DIR` — path to persist Chrome profile (recommended; in Docker, mount a volume here).
- `BROWSER_REUSE` — `true|false` keep browser running between checks (reduces cold starts).
- `CHECK_INTERVAL_MINUTES` — minutes between periodic checks (default `5`).
- `DEBUG` — `true|false` enable debug artifacts.
- `LOG_FILE` — optional path for `check_stock.js` logs (default `watch_log.txt`).

## Quick start (recommended: Docker Compose)

1. Ensure `.env` contains the required variables.
2. Create persistent volume for Chrome profile:

```powershell
docker volume create sd_data
```

3. Build and start with Compose (Compose reads `env_file` from `docker-compose.yml`, so you do not need to pass `--env-file` to `docker run`):

```powershell
$env:COMPOSE_BAKE = 'true'
docker compose build --no-cache
docker compose up -d
docker compose logs -f refresh
```

### Rebuild and restart the `refresh` service

If you change code (or the Dockerfile) and need to rebuild the image and restart only the `refresh` service, run:

```powershell
docker compose build refresh
docker compose up -d --no-deps --force-recreate refresh
docker compose logs -f refresh
```

Or a single command that rebuilds and recreates the service:

```powershell
docker compose up -d --build refresh
docker compose logs -f refresh
```

The Compose file mounts `sd_data` to the container's `USER_DATA_DIR` path so the profile persists across restarts.

### Entrypoint note

The container includes an entrypoint script `docker-entrypoint.sh` that runs at startup and removes stale Chromium lock files (e.g. `SingletonLock`, `DevToolsActivePort`) inside the `USER_DATA_DIR` before launching the Node process. This prevents "profile in use" errors after an unclean shutdown.

## Alternate: run the container directly (if not using Compose)

If you prefer `docker run` rather than Compose, pass envs with `--env-file .env` (only necessary for `docker run`; Compose already provides them):

```powershell
docker run -d --name sd_refresh --env-file .env -v sd_data:/usr/src/app/data --restart unless-stopped <your-image>
docker logs -f sd_refresh
```

## Raspberry Pi (Docker) — build and deploy on the Pi

The repository image is ready to be built on a Raspberry Pi. The `Dockerfile` is configured to avoid Puppeteer's automatic download of an x64 Chromium binary and will use the system Chromium package installed in the image.

On the Raspberry Pi itself (or any ARM host), run from the project root:

```bash
# Build the image locally on the Pi (this will use the Pi's architecture).
# By default the image is built with `PUPPETEER_SKIP_DOWNLOAD=1` so Puppeteer
# won't download Chromium at build time (we expect to install system Chromium
# in the image). If you want Puppeteer to download its Chromium during build
# (useful for local testing on x86), override the build-arg:

# Build and let Puppeteer download Chromium (useful on x86 desktop):
docker compose build --build-arg PUPPETEER_SKIP_DOWNLOAD=0 --no-cache

# Or build on the Raspberry Pi (keep skip download = 1 and the image will
# attempt to install system Chromium packages):
docker compose build --no-cache

# Start the refresh service (compose will use the built image)
docker compose up -d refresh

# Follow logs
docker compose logs -f refresh
```

Alternative: build with plain Docker and run the container:

```bash
docker build -t sd_refresh_image:pi .
docker run -d --name sd_refresh --env-file .env -v sd_data:/usr/src/app/data --restart unless-stopped sd_refresh_image:pi
docker logs -f sd_refresh
```

Notes:
- The image sets `PUPPETEER_SKIP_DOWNLOAD=1` so Puppeteer won't attempt to download an x64 Chromium. The container installs the system Chromium package for ARM.
- If building the image on an x86 machine for the Pi, use `docker buildx` and `--platform linux/arm64` (or `linux/arm/v7` for 32-bit Raspberry Pi OS). Building directly on the Pi is simplest.

## Behavior & monitoring

- The container runs a periodic checker that calls `fetchStock()` every `CHECK_INTERVAL_MINUTES`.
 - On detection of a missing session or login failure, the container attempts an automatic login and persists cookies locally in the configured `USER_DATA_DIR` / `COOKIES_FILE`.
- If auto-login fails, the bot notifies `TELEGRAM_CHAT_ID` so you can intervene.

## Security

- Keep `.env` out of source control. Use your platform's secret manager in production.
 - Rotate Telegram tokens if they become exposed.

If you want, I can add a sample `systemd` unit, `fly.toml` for Fly.io, or a GitHub Actions workflow for scheduled checks — tell me which target and I'll create it.

