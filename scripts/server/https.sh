#!/usr/bin/env bash
# Mirage: открыть панель в интернет по HTTPS через Caddy (сертификат Let's Encrypt — сам).
#
#   sudo bash scripts/server/https.sh --domain panel.example.com [--user mirage] [--port 3001]
#
# Перед этим домен (A-запись) должен указывать на IP сервера, а владелец панели —
# быть зарегистрирован (через SSH-туннель). Без владельца скрипт откажется: иначе
# первый посетитель из интернета стал бы владельцем панели.
set -euo pipefail

PANEL_USER="mirage"
PORT="3001"
DOMAIN=""

say()  { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --user)   PANEL_USER="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный параметр: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "запустите через sudo"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "укажите домен: --domain panel.example.com"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "некорректный порт: $PORT"
id "$PANEL_USER" >/dev/null 2>&1 || die "нет пользователя $PANEL_USER — сначала install.sh"

HOME_DIR="/home/$PANEL_USER"
PANEL_DIR="$HOME_DIR/mirage-panel"
ENV_FILE="$PANEL_DIR/.env"
[ -d "$PANEL_DIR" ] || die "панель не найдена в $PANEL_DIR — сначала install.sh"
export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------ владелец уже зарегистрирован?
say "Проверка: владелец панели зарегистрирован"
OWNERS=$(sudo -u "$PANEL_USER" -H bash -c "cd '$PANEL_DIR' && node -e '
  const path = require(\"node:path\");
  const os = require(\"node:os\");
  const fs = require(\"node:fs\");
  // Те же правила, что у сервера: DATABASE_PATH, иначе MIRAGE_DATA_DIR/auth.db, иначе ~/.mirage/auth.db.
  const env = {};
  try {
    for (const line of fs.readFileSync(\".env\", \"utf8\").split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  const dataDir = env.MIRAGE_DATA_DIR || path.join(os.homedir(), \".mirage\");
  const dbPath = env.DATABASE_PATH || path.join(dataDir, \"auth.db\");
  if (!fs.existsSync(dbPath)) { console.log(0); process.exit(0); }
  const db = require(\"better-sqlite3\")(dbPath, { readonly: true, fileMustExist: true });
  try { console.log(db.prepare(\"select count(*) as n from users\").get().n); } catch { console.log(0); }
'" 2>/dev/null || echo 0)

if [ "${OWNERS:-0}" -lt 1 ]; then
  IP=$(curl -fs --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  die "владелец ещё не зарегистрирован. Сначала на СВОЁМ компьютере:
      ssh -L $PORT:127.0.0.1:$PORT <ваш-логин>@$IP
  откройте http://127.0.0.1:$PORT, придумайте логин и пароль — и запустите этот скрипт снова."
fi
ok "владелец есть"

# ------------------------------------------------ DNS
say "Проверка DNS: $DOMAIN"
SERVER_IP=$(curl -fs --max-time 5 https://api.ipify.org || true)
DOMAIN_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if [ -z "$DOMAIN_IP" ]; then
  die "домен $DOMAIN пока не находится. Добавьте у регистратора A-запись на ${SERVER_IP:-IP сервера} и подождите 5–30 минут."
elif [ -n "$SERVER_IP" ] && [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  printf '    \033[33m!\033[0m %s указывает на %s, а у сервера %s — сертификат может не выпуститься\n' "$DOMAIN" "$DOMAIN_IP" "$SERVER_IP"
else
  ok "$DOMAIN → $DOMAIN_IP"
fi

# ------------------------------------------------ Caddy
say "Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
ok "$(caddy version | awk '{print $1}')"

CADDYFILE=/etc/caddy/Caddyfile
BLOCK_START="# >>> mirage $DOMAIN"
BLOCK_END="# <<< mirage $DOMAIN"
[ -f "$CADDYFILE" ] && cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d-%H%M%S)"
# Стоковый Caddyfile (сайт-заглушка на :80) заменяется; чужие сайты остаются, наш блок обновляется.
if [ -f "$CADDYFILE" ] && grep -q '^:80' "$CADDYFILE" && ! grep -q '^[a-z0-9].*{' <(grep -v '^:80' "$CADDYFILE"); then
  : > "$CADDYFILE"
fi
if [ -f "$CADDYFILE" ]; then
  sed -i "/^$(printf '%s' "$BLOCK_START" | sed 's/[.[\*^$/]/\\&/g')\$/,/^$(printf '%s' "$BLOCK_END" | sed 's/[.[\*^$/]/\\&/g')\$/d" "$CADDYFILE"
fi
cat >> "$CADDYFILE" <<EOF
$BLOCK_START
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 200MB
	}
	reverse_proxy 127.0.0.1:$PORT
}
$BLOCK_END
EOF
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || die "Caddyfile не прошёл проверку — копия старого рядом ($CADDYFILE.bak.*)"
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "сайт $DOMAIN → 127.0.0.1:$PORT"

# ------------------------------------------------ файрвол
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ok "ufw: открыты 80 и 443"
fi

# ------------------------------------------------ адрес панели для ссылок (Telegram)
if grep -q '^MIRAGE_PANEL_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^MIRAGE_PANEL_PUBLIC_URL=.*|MIRAGE_PANEL_PUBLIC_URL=https://$DOMAIN|" "$ENV_FILE"
else
  echo "MIRAGE_PANEL_PUBLIC_URL=https://$DOMAIN" >> "$ENV_FILE"
fi
systemctl restart mirage
ok "панель перезапущена с адресом https://$DOMAIN"

say "Проверка HTTPS (сертификат выпускается до минуты)"
for _ in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || true)
  [ "$CODE" = "200" ] && break
  sleep 5
done
if [ "${CODE:-}" = "200" ]; then
  ok "https://$DOMAIN открывается"
  echo
  echo "  Готово. Сразу включите двухфакторную защиту: Настройки → Аккаунт."
else
  echo "    ! https://$DOMAIN пока не ответил (код ${CODE:-нет}). Проверьте: journalctl -u caddy -n 30"
fi
