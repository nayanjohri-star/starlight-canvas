# CozyClay demo GPU worker

The demo worker is an outbound-only poller. It never calls `listen()` and does
not expose an HTTP, TCP, or WebSocket service. It claims one job, runs the
existing local ARDY runner, uploads the resulting `.npz`, and renews the
job-bound lease every 60 seconds while generation is running.

`index.mjs` owns polling/signals, `api-client.mjs` owns signed fetches,
`generate.mjs` supervises the local runner, `sign-core.mjs` is the pure HMAC
module, and `sign.mjs` is its curl-oriented CLI wrapper. The poller waits for
the local generation worker's warm ping before every claim; an idle/cold worker
is re-warmed before polling resumes.

## Install and configure

Install CozyClay and the local ARDY environment on the GPU box, then create an
environment file outside the repository:

```sh
mkdir -p ~/.cozyclay
umask 077
cat >~/.cozyclay/demo-worker.env <<'EOF'
CC_DEMO_API_BASE=https://api.cozyclay.org
CC_WORKER_ID=gpu-box-01
CC_WORKER_SECRET=replace-with-the-value-from-wrangler-secret
EOF
chmod 600 ~/.cozyclay/demo-worker.env
```

The three values above are read from the environment only. Do not commit the
file, put a secret in a command argument, or print request headers. Worker
logs report job ids and status, never `CC_WORKER_SECRET`, signatures, or lease
tokens.

Run it directly:

```sh
set -a
. ~/.cozyclay/demo-worker.env
set +a
node tools/demo-worker/index.mjs
# equivalent package script:
npm run demo:worker
```

Run the signing helper for a curl request (the secret is still taken only from
the environment):

```sh
CC_WORKER_SECRET=... CC_WORKER_ID=gpu-box-01 \
  node tools/demo-worker/sign.mjs --method GET --path /worker/next
```

## launchd (macOS)

Create `~/Library/LaunchAgents/org.cozyclay.demo-worker.plist` with paths
matching the installation:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.cozyclay.demo-worker</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/CozyClay/tools/demo-worker/index.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CC_DEMO_API_BASE</key><string>https://api.cozyclay.org</string>
    <key>CC_WORKER_ID</key><string>gpu-box-01</string>
    <key>CC_WORKER_SECRET</key><string>read-from-a-protected-generated-plist</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/tmp/cozyclay-demo-worker.log</string>
  <key>StandardErrorPath</key><string>/var/tmp/cozyclay-demo-worker.err</string>
</dict></plist>
```

Prefer a generated plist readable only by the service account; do not leave
the real secret in a world-readable file. Load it with:

```sh
chmod 600 ~/Library/LaunchAgents/org.cozyclay.demo-worker.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.cozyclay.demo-worker.plist
```

## systemd (Linux)

Store the env file at `/etc/cozyclay/demo-worker.env` with mode `0600`, then
install `/etc/systemd/system/cozyclay-demo-worker.service`:

```ini
[Unit]
Description=CozyClay outbound demo GPU worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/CozyClay
EnvironmentFile=/etc/cozyclay/demo-worker.env
ExecStart=/usr/bin/node /opt/CozyClay/tools/demo-worker/index.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now cozyclay-demo-worker
```

## Verify inbound surface

Capture listeners before and after starting the worker. The diff should be
empty; an API connection in `ESTABLISHED` state is outbound and is not a
listener:

```sh
lsof -nP -iTCP -sTCP:LISTEN | sort > /tmp/cc-listen-before.txt
set -a; . ~/.cozyclay/demo-worker.env; set +a
npm run demo:worker &
worker_pid=$!
sleep 5
lsof -nP -iTCP -sTCP:LISTEN | sort > /tmp/cc-listen-after.txt
diff /tmp/cc-listen-before.txt /tmp/cc-listen-after.txt
kill -TERM "$worker_pid"
wait "$worker_pid" || true
```

If the diff is non-empty, stop the process and investigate before deployment.

