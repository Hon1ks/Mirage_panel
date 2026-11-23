#!/usr/bin/env bash
# Mirage: установка панели на чистый сервер Ubuntu / Debian одной командой.
#
#   sudo bash scripts/server/install.sh [--domain panel.example.com] [--user mirage]
#        [--port 3001] [--tz Europe/Moscow] [--repo URL] [--branch main]
#
# Что делает (повторный запуск безопасен — уже сделанное пропускается):
#   1. ставит git, сборочные пакеты и Node.js 22;
#   2. добавляет swap, если памяти мало для сборки;
#   3. создаёт пользователя (по умолчанию mirage) — панель работает НЕ от root;
#   4. ставит этому пользователю Claude Code;
#   5. скачивает панель в /home/<user>/mirage-panel, пишет .env, собирает;
#   6. создаёт и запускает службу systemd «mirage» (только 127.0.0.1);
#   7. с --domain — HTTPS через Caddy, но только когда владелец уже зарегистрирован
#      (иначе первый посетитель из интернета стал бы владельцем панели).
set -euo pipefail

REPO_URL="https://github.com/Hon1ks/Mirage_panel.git"
BRANCH="main"
PANEL_USER="mirage"
PORT="3001"
DOMAIN=""
TZ_NAME=""

say()  { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --user)   PANEL_USER="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    --tz)     TZ_NAME="${2:-}"; shift 2 ;;
    --repo)   REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "запустите через sudo: sudo bash $0 $*"
command -v apt-get >/dev/null || die "нужен Ubuntu или Debian (apt-get не найден)"
[[ "$PANEL_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "некорректное имя пользователя: $PANEL_USER"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "некорректный порт: $PORT"
[ "$PANEL_USER" != "root" ] || die "панель не ставится под root — выберите другого пользователя"
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  die "некорректный домен: $DOMAIN"
fi

HOME_DIR="/home/$PANEL_USER"
PANEL_DIR="$HOME_DIR/mirage-panel"
NPM_PREFIX="$HOME_DIR/.npm-global"
export DEBIAN_FRONTEND=noninteractive

as_user() { sudo -u "$PANEL_USER" -H env "PATH=$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin" bash -lc "$1"; }

# ---------------------------------------------------------------- 1. пакеты
say "1/7 Системные пакеты"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates build-essential python3 sudo >/dev/null
ok "git, curl, build-essential, python3"

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
[ "$(node_major)" -ge 22 ] || die "не удалось поставить Node.js 22"
ok "Node.js $(node -v)"

# ---------------------------------------------------------------- 2. swap
say "2/7 Память для сборки"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ $((MEM_MB + SWAP_MB)) -lt 3800 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "добавлен swap 2 ГБ (памяти было ${MEM_MB} МБ)"
else
  ok "памяти достаточно: ${MEM_MB} МБ + swap ${SWAP_MB} МБ"
fi

# ---------------------------------------------------------------- 3. пользователь
say "3/7 Пользователь $PANEL_USER"
if id "$PANEL_USER" >/dev/null 2>&1; then
  ok "уже есть"
else
  adduser --disabled-password --gecos "" "$PANEL_USER" >/dev/null
  ok "создан (без пароля: вход только через sudo -iu $PANEL_USER)"
fi

# ---------------------------------------------------------------- 4. Claude Code
say "4/7 Claude Code"
as_user "npm config set prefix '$NPM_PREFIX' >/dev/null"
grep -q '.npm-global/bin' "$HOME_DIR/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME_DIR/.bashrc"
chown "$PANEL_USER:$PANEL_USER" "$HOME_DIR/.bashrc"
if as_user "command -v claude >/dev/null"; then
  ok "уже установлен: $(as_user 'claude --version' 2>/dev/null | head -1)"
else
  as_user "npm install -g --silent @anthropic-ai/claude-code" >/dev/null
  ok "установлен: $(as_user 'claude --version' 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------- 5. панель
say "5/7 Панель: скачать и собрать (10–20 минут, это нормально)"
if [ -d "$PANEL_DIR/.git" ]; then
  as_user "cd '$PANEL_DIR' && git fetch -q origin '$BRANCH' && git checkout -q '$BRANCH' && git pull -q --ff-only origin '$BRANCH'"
  ok "обновлена из $BRANCH"
else
  as_user "git clone -q --branch '$BRANCH' '$REPO_URL' '$PANEL_DIR'"
  ok "скачана в $PANEL_DIR"
fi

ENV_FILE="$PANEL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "# Создано scripts/server/install.sh. Все настройки — в .env.example."
    echo "SERVER_PORT=$PORT"
    echo "HOST=127.0.0.1"
    [ -n "$TZ_NAME" ] && echo "MIRAGE_TIMEZONE=$TZ_NAME"
  } > "$ENV_FILE"
  chown "$PANEL_USER:$PANEL_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env создан"
else
  ok ".env уже есть — не трогаю"
fi

as_user "cd '$PANEL_DIR' && npm ci --include=dev --no-audit --no-fund --loglevel=error"
ok "зависимости установлены"
as_user "cd '$PANEL_DIR' && NODE_OPTIONS=--max-old-space-size=3072 npm run build --silent" >/dev/null
ok "собрана"

# ---------------------------------------------------------------- 6. служба
say "6/7 Служба systemd «mirage»"
cat > /etc/systemd/system/mirage.service <<EOF
[Unit]
Description=Mirage Cloud Panel
After=network-online.target
Wants=network-online.target

[Service]
User=$PANEL_USER
WorkingDirectory=$PANEL_DIR
Environment=NODE_ENV=production
Environment=PATH=$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node dist-server/server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mirage >/dev/null 2>&1
systemctl restart mirage

for _ in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 2
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/" || die "панель не отвечает на 127.0.0.1:$PORT — смотрите: journalctl -u mirage -n 50"
ok "работает на 127.0.0.1:$PORT"

# ---------------------------------------------------------------- 7. HTTPS
say "7/7 Доступ из интернета"
# The https script comes with the panel, so this works even when install.sh was downloaded alone.
# On a fresh server it stops at «владелец ещё не зарегистрирован» — that is expected (step 2 below).
if [ -n "$DOMAIN" ]; then
  bash "$PANEL_DIR/scripts/server/https.sh" --domain "$DOMAIN" --user "$PANEL_USER" --port "$PORT" || true
else
  ok "пропущено: пока панель видна только через SSH-туннель"
fi

IP=$(curl -fs --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<EOF

────────────────────────────────────────────────────────────────────
 Mirage установлена.

 ДАЛЬШЕ (по порядку):

 1) Войдите в Claude под пользователем панели:
      sudo -iu $PANEL_USER claude
    → в Claude Code наберите /login, откройте ссылку, войдите, вставьте код, потом /exit.

 2) Зарегистрируйте владельца ЧЕРЕЗ SSH-ТУННЕЛЬ (первый посетитель становится владельцем).
    На СВОЁМ компьютере:
      ssh -L $PORT:127.0.0.1:$PORT <ваш-логин>@$IP
    и откройте в браузере http://127.0.0.1:$PORT — придумайте логин и пароль.

 3) Откройте панель в интернет по HTTPS (домен должен указывать на $IP):
      sudo bash $PANEL_DIR/scripts/server/https.sh --domain ${DOMAIN:-panel.example.com}

 4) В панели: Настройки → Аккаунт → включите двухфакторную защиту.

 Обновление:  sudo bash $PANEL_DIR/scripts/server/update.sh
 Логи:        journalctl -u mirage -f
────────────────────────────────────────────────────────────────────
EOF
