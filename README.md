# sd_stock_script — refresh_cookies and hosting

This repository contains a Telegram bot (`refresh_cookies.js`) that can re-login to the Steam store, save cookies, and upload them (encrypted) as a GitHub Actions secret.

## Quick configuration

Create a `.env` file in the project root with the following variables:

- `TELEGRAM_BOT_TOKEN` — your bot token
- `TELEGRAM_ADMIN_ID` — numeric Telegram id allowed to run commands (optional)
- `STEAM_USERNAME` and `STEAM_PASSWORD` — Steam credentials used for automated login
- `GITHUB_TOKEN` — a personal access token with `repo` permission (to update secrets)
- `GITHUB_OWNER` and `GITHUB_REPO` — repository that receives the secret
- `GITHUB_SECRET_NAME` — (optional) name of secret to update (default `STEAM_COOKIES`)
- `REFRESH_HEADLESS` — `true` or `false`; whether to run puppeteer headless
- `REFRESH_TRY_HEADLESS_LOGIN` — `true` to attempt stealth headless login (optional)
- `USER_DATA_DIR` — path where Chrome profile is persisted (recommended)
- `BROWSER_REUSE` — `true` (default) to keep a browser open between runs (reduces cold-start)
- `DEBUG` — `true` to enable debug artifacts sending by the bot (screenshots/html)

Notes:
- For reliable headless runs, create a profile once with `REFRESH_HEADLESS=false` and set `USER_DATA_DIR` (or mount a persistent volume) so subsequent headless runs reuse the logged-in profile.
- If `BROWSER_REUSE=true` and `USER_DATA_DIR` is set, the bot will reuse the Chrome instance to reduce startup time.

## Commands

- `/refresh_cookies` — attempts login, saves cookies, uploads secret to GitHub
- `/status` — shows `cookies.json` file status
- `/done` — notify bot you finished an interactive login when running non-headless
- `/help` — help text

## Production optimizations applied

- `BROWSER_REUSE` support: reuse browser between commands to avoid cold starts.
- Graceful shutdown handlers to close browser + stop bot on `SIGINT/SIGTERM`.
- Debug artifacts (screenshots/html) are only sent when `DEBUG=true`.

## Hosting options

You can host this bot in several ways. Pick the one that matches your comfort level.

1) VPS (recommended if you want full control)
- Use a small VM (e.g. Debian/Ubuntu) and run the container or directly run `node`.
- Install Node 18, clone the repo, `npm ci`, and run with environment variables.
- To persist Chrome profile between runs, create a directory and set `USER_DATA_DIR=/path/to/profile` and run the container with `-v /path/to/profile:/path/in/container`.
- Use a process manager such as `systemd` or `pm2` to keep it running.

2) Docker on Render / Fly.io / DigitalOcean App Platform
- Build the included `Dockerfile` and deploy to a container platform.
- Make sure to configure persistent volumes for `USER_DATA_DIR` (or use BROWSER_REUSE carefully).
- Set environment variables/secrets in the platform instead of .env.

3) GitHub Actions (alternative approach)
- Instead of a continuously running bot, you can trigger a workflow or run the refresh script from Actions on-demand.
- The workflow would need the ability to run a headless browser (uses `actions/runner` or a self-hosted runner with Chrome) and must have the repo write permission (or use the same `GITHUB_TOKEN`).
- This approach avoids managing a server but is less interactive (no Telegram bot unless you implement webhooks).

4) PaaS / Serverless
- Serverless platforms generally are not ideal for long-lived headful browsers. If you require them, use a container-based PaaS or a small VM instead.

## Deploy example (Docker + Render)
1. Build locally: `docker build -t sd-stock-bot:latest .`
2. Test/run locally (mount a data folder):
   `docker run --rm -e TELEGRAM_BOT_TOKEN=... -e STEAM_USERNAME=... -e STEAM_PASSWORD=... -e REFRESH_HEADLESS=false -v $(pwd)/data:/data sd-stock-bot:latest`
3. On Render, create a new Web Service / Private Service, push the image or provide Git repo with `Dockerfile`. Add environment variables in the dashboard.

## Security notes
- Keep `GITHUB_TOKEN` scoped only to the repo and rotate it periodically.
- Treat `STEAM_PASSWORD` carefully — use secrets in your hosting provider.
- Use `USER_DATA_DIR` with care: it contains session data.

## Next steps I can implement for you
- Create a `systemd` unit file or `docker-compose.yml` for your chosen host.
- Add a small healthcheck endpoint and metrics (uptime/last-run).
- Add a GitHub Actions workflow to call `/refresh_cookies` via Telegram bot or to run the refresh entirely inside Actions.

