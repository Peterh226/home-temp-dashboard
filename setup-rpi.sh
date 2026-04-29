#!/usr/bin/env bash
# setup-rpi.sh — one-shot setup for HomeTempDashboard on a fresh Raspberry Pi 4
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_URL="https://github.com/Peterh226/home-temp-dashboard.git"
INSTALL_DIR="$HOME/home-temp-dashboard"
RCLONE_REMOTE="PBH_DropBox"
RCLONE_DEST="HomeTempDashboard"
CRON_LOG="$HOME/rclone-homedash.log"

step()  { echo -e "\n${GREEN}==>${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
info()  { echo -e "${CYAN}    $1${NC}"; }
banner(){ echo -e "\n${CYAN}$1${NC}"; }

# ── 1. System update ────────────────────────────────────────────────────────
step "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# ── 2. Node.js (via nvm — supports armhf and arm64) ────────────────────────
step "Installing Node.js 22 LTS via nvm..."
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
\. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm use --lts
info "Node $(node -v) / npm $(npm -v)"

# ── 3. pm2 ──────────────────────────────────────────────────────────────────
step "Installing pm2..."
npm install -g pm2
info "pm2 $(pm2 -v)"

# ── 4. rclone ───────────────────────────────────────────────────────────────
step "Installing rclone..."
curl https://rclone.org/install.sh | sudo bash
info "rclone $(rclone version | head -1)"

# ── 5. Clone repo ───────────────────────────────────────────────────────────
step "Cloning repository to $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Repo already exists — pulling latest instead."
  git -C "$INSTALL_DIR" pull
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ── 6. pm2: start server ────────────────────────────────────────────────────
step "Starting server with pm2..."
cd "$INSTALL_DIR"

if pm2 list | grep -q "homedash"; then
  warn "pm2 process 'homedash' already exists — restarting."
  pm2 restart homedash
else
  pm2 start server.js --name homedash
fi

pm2 save

# ── 7. pm2: enable on boot ──────────────────────────────────────────────────
# pm2 startup embeds the absolute nvm node path, so boot works without nvm sourced
step "Enabling pm2 on system boot..."
STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo env" || true)
if [ -n "$STARTUP_CMD" ]; then
  info "Running: $STARTUP_CMD"
  eval "$STARTUP_CMD"
  pm2 save
else
  warn "Could not auto-run pm2 startup command. Run 'pm2 startup' manually and execute the printed command."
fi

# ── 8. Nightly rclone cron job ──────────────────────────────────────────────
step "Adding nightly Dropbox backup cron job (2 AM)..."
CRON_JOB="0 2 * * * rclone copy $INSTALL_DIR/data-log.ndjson $RCLONE_REMOTE:$RCLONE_DEST/ --log-file=$CRON_LOG"

# Remove any existing homedash rclone job, then add the new one
( crontab -l 2>/dev/null | grep -v "rclone.*$RCLONE_DEST" ; echo "$CRON_JOB" ) | crontab -
info "Cron job added. Log will write to $CRON_LOG"

# ── Done ────────────────────────────────────────────────────────────────────
banner "============================================================"
banner "  Automated setup complete."
banner "  Complete these manual steps before the server is fully live:"
banner "============================================================"

cat <<EOF

1. Copy config from old server (replace OLD_SERVER_IP):
     scp pi@OLD_SERVER_IP:~/home-temp-dashboard/server-config.json $INSTALL_DIR/

2. Copy data files to preserve history (optional):
     scp pi@OLD_SERVER_IP:~/home-temp-dashboard/data.json         $INSTALL_DIR/
     scp pi@OLD_SERVER_IP:~/home-temp-dashboard/data-log.ndjson   $INSTALL_DIR/
   Then restart so the server reloads the history:
     pm2 restart homedash

3. Set up rclone Dropbox connection — choose one option:

   Option A (copy config from old server — easiest):
     mkdir -p ~/.config/rclone
     scp pi@OLD_SERVER_IP:~/.config/rclone/rclone.conf ~/.config/rclone/rclone.conf

   Option B (re-authorize from scratch):
     rclone config
     # Name the remote: $RCLONE_REMOTE
     # Type: dropbox
     # Leave client_id and client_secret blank
     # Authorize via browser when prompted

   Test it after configuring:
     rclone copy $INSTALL_DIR/data-log.ndjson $RCLONE_REMOTE:$RCLONE_DEST/ -v

4. Assign static IP 192.168.50.143 to this Pi in your router
   (match the old server's IP so NodeMCUs need no re-flash)

5. Verify everything is running:
     pm2 status
     curl http://localhost:3000/rooms

EOF
