# KeepHuman tester

Long-running load test for a site behind the KeepHuman middleware. Simulated
clients visit the site with a bundled headless Chromium on a schedule. Each
visit goes through the gate as a real visitor would: the challenge page
solves its puzzles in the browser, submits them and reloads into the
application. The tester records what happened and keeps an overview in
`status.html`, a page that refreshes itself, served on port 8080.

## Run it

With docker or podman, from this directory:

```bash
# edit compose.yaml (at least TARGET_URL), then
docker compose up -d          # or: podman compose up -d
docker compose logs -f tester # one line per visit
```

Then open <http://localhost:8080/> (or the test machine's address) for the
status page. It reloads every `STATUS_INTERVAL_SECONDS` and shows how old
its data is, turning red when the tester has stopped updating it.

The image is built for `linux/amd64` and `linux/arm64` by the repository's
GitHub workflow (`ghcr.io/robinnaumann/keephuman-middleware-tester`). To
build it on the test machine instead, replace `image:` with `build: .` in
`compose.yaml`.

### Example `compose.yaml`

A minimal setup with two clients and a WebSocket check; every setting not
listed keeps its default (see [Configuration](#configuration)). The
`compose.yaml` in this directory lists all of them.

```yaml
services:
  tester:
    image: ghcr.io/robinnaumann/keephuman-tester:latest
    restart: unless-stopped
    environment:
      TARGET_URL: https://app.example.com # site behind the KeepHuman gate
      TARGET_PATHS: /,/dashboard
      WEBSOCKET_PATH: /ws
      CLIENTS: 2
      INTERVAL_SECONDS: 60
      DURATION_HOURS: 24
    ports:
      - "8080:8080" # status page
    volumes:
      - tester-data:/data
    cpus: 2 # limit the load of the puzzle solving

volumes:
  tester-data:
```

Quote values that YAML would otherwise read as booleans, e.g.
`SEND_CLIENT_ID: "false"`.

### With podman

The image runs rootless and needs no extra privileges, so plain podman
works. On macOS and Windows, start the VM first (`podman machine init`
once, then `podman machine start`).

`podman compose` hands the file to an installed compose provider, either
`podman-compose` (`pip install podman-compose`, or your distribution's
package) or `docker-compose`:

```bash
podman compose up -d             # status page on http://localhost:8080/
podman compose logs -f tester
podman compose down            # stop; the tester-data volume is kept
```

Without a compose provider, the same container with `podman run`:

```bash
podman volume create tester-data
podman run -d --name keephuman-tester --restart always \
  -e TARGET_URL=https://app.example.com \
  -e CLIENTS=2 \
  --cpus 2 \
  -p 8080:8080 \
  -v tester-data:/data \
  ghcr.io/robinnaumann/keephuman-middleware-tester:latest

podman logs -f keephuman-tester  # status page on http://localhost:8080/
```

Podman has no daemon, so the restart policy only covers crashes of the
tester itself. To start it again after a reboot of a Linux host, use
`restart: always` (`--restart always`) and enable podman's restart service
for your user:

```bash
systemctl --user enable --now podman-restart.service
loginctl enable-linger "$USER"   # run user services without a login
```

If the package on ghcr.io is private, log in first with
`podman login ghcr.io` (a GitHub token with `read:packages`).

Without containers (Node.js 24 or newer):

```bash
npm ci && npx playwright install chromium
TARGET_URL=https://app.example.com CLIENTS=2 node src/main.ts
```

## Configuration

All settings are environment variables, set in `compose.yaml`:

| variable                  | default       |                                                                                                                                |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TARGET_URL`              | (required)    | origin of the site behind the gate                                                                                             |
| `TARGET_PATHS`            | `/`           | comma-separated paths, visited in turn                                                                                         |
| `CLIENTS`                 | `1`           | simulated clients visiting in parallel                                                                                         |
| `INTERVAL_SECONDS`        | `60`          | per client, between the starts of two visits                                                                                   |
| `JITTER`                  | `0.2`         | random variation of the interval (±20 %)                                                                                       |
| `NEW_SESSION_EVERY`       | `0`           | a client starts a fresh session (cookies, client id) after this many visits; `0` = never                                       |
| `SEND_CLIENT_ID`          | `true`        | send `X-Client-ID: <prefix>-<n>`, so the gate tells the clients apart (otherwise they share one session, as they share one IP) |
| `CLIENT_ID_PREFIX`        | `tester`      |                                                                                                                                |
| `VISIT_TIMEOUT_SECONDS`   | `300`         | a visit still on the gate after this long counts as `timeout`                                                                  |
| `WEBSOCKET_PATH`          | (empty)       | after passing, open a WebSocket to this path and count whether it connects                                                     |
| `GATE_PREFIX`             | `/_keephuman` | the gate's `PATH_PREFIX`                                                                                                       |
| `DURATION_HOURS`          | `0`           | stop after this long; `0` = run until stopped                                                                                  |
| `MAX_VISITS`              | `0`           | stop after this many visits; `0` = no limit                                                                                    |
| `EXIT_WHEN_DONE`          | `false`       | when a limit is reached: `false` idles (so `restart: unless-stopped` doesn't start over), `true` exits                         |
| `STATUS_INTERVAL_SECONDS` | `30`          | how often `status.html` is rewritten and the page reloads                                                                      |
| `STATUS_PORT`             | `8080`        | port of the status page server; `0` = off                                                                                      |
| `RESUME`                  | `true`        | keep counting from the previous run's totals                                                                                   |

The load is roughly `CLIENTS × 3600 / INTERVAL_SECONDS` visits per hour; a
visit that takes longer than the interval delays that client's next one.
Each client solves its puzzles with all CPU cores the browser sees, so set
`cpus:` in `compose.yaml` to limit the load on the test machine.

## Output (in the `/data` volume)

- `status.html`: overview, rewritten every `STATUS_INTERVAL_SECONDS`:
  visits by outcome, challenges received, submissions accepted and rejected,
  times the gate had no challenge, tasks by provider, solve and visit times
  (median, p95, max; overall and last hour), HTTP statuses, WebSocket
  checks, per-client counts and the latest problems. The tester serves it
  on `STATUS_PORT` (with `visits.csv` at `/visits.csv`); it also works
  opened straight from the file.
- `visits.csv`: one line per visit, for later analysis.
- `state.json`: totals, so a restart continues counting (`RESUME`).

Visit outcomes:

| outcome           |                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `passed`          | reached the application after solving one or more challenges                             |
| `passed_directly` | reached the application without a challenge (the session was still trusted)              |
| `rejected`        | the gate rejected a submission                                                           |
| `timeout`         | still on the gate after `VISIT_TIMEOUT_SECONDS` (e.g. the gate had no challenge to give) |
| `app_error`       | the application answered with HTTP 4xx/5xx                                               |
| `error`           | the page couldn't be loaded at all (connection refused, DNS, browser crash)              |

To copy the files out of the volume:

```bash
docker compose cp tester:/data ./tester-data
```

To write them to a host directory instead, mount one, e.g.
`./data:/data:U` with podman (`:U` hands the directory to the container
user), or with docker `./data:/data` plus `user: "1000:1000"` on the
service, using your own ids from `id -u` and `id -g`, so the container can
write there and the files belong to you.

## Notes

- `SEND_CLIENT_ID` relies on the gate accepting `X-Client-ID` as the client
  identity (the trivial trust strategy does). Without it, all clients of
  one tester share one session, because the gate tells clients apart by IP.
- Chromium runs without its sandbox (Playwright's default in containers) and
  with `--disable-dev-shm-usage`, so no extra container privileges or
  `shm_size` are needed, rootless podman included.
