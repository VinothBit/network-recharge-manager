# RLEMS deployment notes

This application uses SQLite, Flask sessions, and APScheduler for expiry reminders. Keep the web process and the one scheduler process on the same host and on the same persistent local filesystem. Do not deploy multiple application hosts against a shared/network SQLite file: SQLite and the file locks used here are not a distributed database/lock service.

## Install and configure

Use a supported Linux Python runtime for the Gunicorn production command. From `backend/`:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Set these values in the hosting platform's secret/configuration manager, or copy `backend/.env.example` to an untracked `backend/.env` for a single-host deployment:

- `APP_ENV=production`
- `FLASK_SECRET_KEY`: a unique random value with at least 32 bytes of entropy; generate it with `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
- `FRONTEND_ORIGINS`: exactly one origin, including scheme and optional port, such as `https://rlems.example.com`; no path, wildcard, or trailing slash.
- `SESSION_COOKIE_SECURE=true`. Use `SESSION_COOKIE_SAMESITE=Lax` for same-site frontend/API hosts. Use `None` only for genuinely cross-site hosts, and only with HTTPS; browsers may still restrict third-party cookies, so a same-site reverse proxy is preferred.
- `RATELIMIT_STORAGE_URI`: a private Redis URL (`rediss://` for TLS). Production refuses in-memory rate-limit storage. Keep credentials in the host secret manager and never in source or example files.
- `DATABASE_PATH`: the absolute path on the persistent volume, for example `/var/lib/rlems/recharge_manager.db`.
- `VITE_API_BASE_URL`: when building the frontend, use `/api` if the frontend reverse proxy forwards that path to Flask; otherwise set the exact HTTPS API base URL.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: needed only when initializing a database with no users. Existing administrator credentials are not overwritten by these variables.
- `TRUSTED_PROXY_HOPS`: set to the exact number of trusted reverse proxies only when the app is behind such a proxy; otherwise leave it `0`. Do not trust client-supplied forwarded headers from an exposed origin.
- `DATABASE_LOCK_TIMEOUT_SECONDS`: optional; defaults to `60`.

The production origin must use HTTPS. Terminate TLS at a trusted reverse proxy and firewall the app port so clients cannot bypass it. Set `VITE_API_BASE_URL` before the Vite production build; Vite embeds that value in the built assets.

## Start the production processes

Run both commands under one process supervisor on the same host, with exactly one scheduler service instance. Run them from `backend/` with the production environment loaded:

```sh
gunicorn --workers 2 --threads 4 --bind 0.0.0.0:${PORT:-8000} app:app
python scheduler_service.py
```

The WSGI import does not start APScheduler. `scheduler_service.py` owns the daily 09:00 `Asia/Kolkata` job and holds a host-local singleton lock for its lifetime. A second scheduler process using the same database path exits without starting. The job has `max_instances=1` and coalesces missed runs. Keep the scheduler service at one instance; do not start it in Gunicorn workers or replicas on different hosts.

### Windows local host (Waitress)

Waitress is installed from `requirements.txt` on Windows. From `backend/` in PowerShell, install dependencies and start the web process with the production environment configured in `.env`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

When `APP_ENV=production`, `python app.py` starts Waitress bound only to `127.0.0.1:5000`; it does not start the scheduler. In a second PowerShell window, activate the same environment and start exactly one scheduler process:

```powershell
.\.venv\Scripts\Activate.ps1
python scheduler_service.py
```

Production mode also requires the configured strong `FLASK_SECRET_KEY`, exact HTTPS `FRONTEND_ORIGINS`, secure cookies, and a private Redis `RATELIMIT_STORAGE_URI` as described above. This stage does not configure a reverse proxy or make the service reachable from the LAN. Keep the separate scheduler process on the same PC and local filesystem as Waitress.

The web processes and scheduler use the same exclusive sidecar operation lock for database work. Restore holds that lock for the complete request, so an in-progress scheduler check finishes before replacement, and subsequent checks wait until restore completes. Reminder checks write matching reminders to `reminder_log`; the existing duplicate checks and uniqueness constraint prevent the same plan/type/expiry reminder from being recorded more than once. The application reads this history for its reminder UI.

All processes must see the same database and lock files on the same host-local persistent filesystem. The lock files are named beside the configured database (`.operations.lock` and `.scheduler.lock` suffixes) and must remain writable. Do not delete lock files while processes are running. This lock design is not safe across hosts or network filesystems. For multi-host deployment, replace it with a database/lock service designed for distributed coordination before scaling out.

## SQLite persistence and backups

Mount a durable, writable volume before starting either process and set `DATABASE_PATH` to a file on that volume. Preserve the existing live `backend/recharge_manager.db`: do not point production at an empty mount and start the app expecting it to copy existing records. For migration, stop the local app and scheduler, create a verified backup, then copy that backup to the mounted path before the first production start. Keep database and backup files outside all frontend public/build directories and outside any web-server static root.

Use the authenticated **Backup Database** action for an online SQLite-consistent snapshot, then store the downloaded file in private, access-controlled backup storage. The `/backup/database` route creates a private temporary snapshot and is not a static file route. Do not copy the live SQLite file directly while the app is running.

To restore, sign in and use **Restore Database** with a verified `.db` backup. The API validates SQLite integrity and required tables, including the single hashed administrator, creates a timestamped safety backup, and replaces the file while holding the shared operation lock. Temporary uploads are removed after the request. Keep the safety backup and a separate offline copy until the restored application has been checked. Restoring an older backup also restores the administrator credentials and business data from that backup. Do not upload a database backup to a public/static directory.

Backups and the SQLite file are not served as static assets. The download and restore APIs require the authenticated session and CSRF protection; keep the origin firewall and HTTPS reverse proxy enabled.

## Login rate limiting and logs

`POST /login` is limited to 5 attempts per minute and 20 per hour per client address using Flask-Limiter backed by Redis. Production startup rejects memory storage, so all WSGI workers share the configured Redis counters. When using a proxy, configure the trusted proxy hop count correctly so the limiter keys on the client address. Do not expose the origin directly or trust unverified `X-Forwarded-For` headers.

Never log request bodies for `/login` or dump the process environment into logs. Do not print passwords, the Flask secret, or the Redis URL.

## GitHub Pages frontend (project site)

GitHub Pages can publish only the static React/Vite frontend. It does not run Flask, SQLite, or the reminder scheduler. The Flask API and its persistent SQLite storage must be deployed separately on a reachable HTTPS host. The application data and backup/restore endpoints must remain on that backend; do not put database files or secrets in `frontend/public` or the Pages artifact.

The Vite build uses the project-site base path `/network-recharge-manager/`. The manifest, icons, and service worker are base-path aware. The service worker caches only the public HTML/app-shell assets and hashed JavaScript/CSS; API and account requests remain network-only. Offline mode therefore does not expose plans, sessions, CSRF tokens, or reminder history, and the app reports that the server is unavailable.

To enable the automated Pages workflow:

1. In repository **Settings → Pages**, set the publishing source to **GitHub Actions**.
2. In **Settings → Secrets and variables → Actions → Variables**, add `VITE_API_BASE_URL` with the real HTTPS Flask API base URL (for example, the origin/path actually configured on your backend). The build intentionally fails if this variable is absent or does not start with `https://`; `/api` is only the local development proxy and is not a backend for GitHub Pages. This URL is public frontend configuration, not a secret. Never put credentials or tokens in a `VITE_*` variable.
3. Configure the Flask backend CORS allowlist with the exact frontend **origin** `https://vinothbit.github.io` (the repository path is not part of the origin). Keep credentialed CORS restricted to that origin. Since the GitHub Pages and a separately hosted API are generally cross-site, session cookies need HTTPS and `SameSite=None`; browsers or privacy settings may block third-party cookies. A same-site custom domain/reverse proxy is more reliable for session authentication.
4. Push to `master` to build and deploy `frontend/dist`. The workflow deploys only that directory, not the backend, database, environment files, or backups.

GitHub Pages sites are publicly accessible by default, even when the source repository is private where the account plan permits Pages. A public Pages site is not suitable as the access-control boundary for an internal application; keep backend authentication enabled. GitHub Free supports Pages for public repositories; private-repository Pages requires an eligible paid plan (Pro, Team, or Enterprise). Confirm the repository visibility and account/organization plan before enabling publication. Making the repository public also publishes its source, so first review the Git publication checklist and ensure no private data is tracked.

## Local development

Local development keeps the default database path at `backend/recharge_manager.db`, allows the localhost Vite origins, and uses in-memory rate-limit storage. Start Flask from `backend/` with `python app.py`; run `python scheduler_service.py` in a second terminal if local scheduled reminders are needed. The production WSGI command is never replaced by Flask's development server.
