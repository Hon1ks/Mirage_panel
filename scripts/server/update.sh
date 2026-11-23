#!/usr/bin/env bash
# Mirage: обновить панель из репозитория и перезапустить.
#
#   sudo bash scripts/server/update.sh [--user mirage] [--branch main]
#
# Берёт новые коммиты (только fast-forward: локальные правки не затираются),
# ставит зависимости, собирает и перезапускает службу. Перед сборкой прежняя
# сборка откладывается: если новая не соберётся, вернётся старая версия, а служба
# так и не будет перезапущена.
set -euo pipefail

PANEL_USER="mirage"
BRANCH="main"

say()  { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user)   PANEL_USER="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный параметр: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "запустите через sudo"
HOME_DIR="/home/$PANEL_USER"
PANEL_DIR="$HOME_DIR/mirage-panel"
NPM_PREFIX="$HOME_DIR/.npm-global"
[ -d "$PANEL_DIR/.git" ] || die "панель не найдена в $PANEL_DIR"

as_user() { sudo -u "$PANEL_USER" -H env "PATH=$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin" bash -lc "$1"; }

say "Новые коммиты"
BEFORE=$(as_user "cd '$PANEL_DIR' && git rev-parse --short HEAD")
as_user "cd '$PANEL_DIR' && git fetch -q origin '$BRANCH' && git pull -q --ff-only origin '$BRANCH'" \
  || die "git pull не прошёл (локальные правки в $PANEL_DIR?). Посмотрите: sudo -iu $PANEL_USER git -C mirage-panel status"
AFTER=$(as_user "cd '$PANEL_DIR' && git rev-parse --short HEAD")
if [ "$BEFORE" = "$AFTER" ]; then
  ok "обновлений нет ($AFTER)"
  exit 0
fi
as_user "cd '$PANEL_DIR' && git log --oneline $BEFORE..$AFTER" | sed 's/^/    /'

say "Сборка (10–20 минут)"
# Прежняя сборка — в запас: при ошибке вернётся, и служба переживёт перезапуск.
as_user "cd '$PANEL_DIR' && rm -rf .prev-build && mkdir .prev-build && cp -a dist dist-server .prev-build/ 2>/dev/null || true"
if as_user "cd '$PANEL_DIR' && npm ci --include=dev --no-audit --no-fund --loglevel=error && NODE_OPTIONS=--max-old-space-size=3072 npm run build --silent" >/dev/null; then
  ok "собрана"
else
  as_user "cd '$PANEL_DIR' && rm -rf dist dist-server && cp -a .prev-build/dist .prev-build/dist-server . && git reset -q --hard $BEFORE"
  die "сборка не удалась — вернул прежнюю версию $BEFORE, служба не перезапускалась"
fi

say "Перезапуск"
systemctl restart mirage
PORT=$(grep -E '^SERVER_PORT=' "$PANEL_DIR/.env" 2>/dev/null | cut -d= -f2)
PORT=${PORT:-3001}
for _ in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 2
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/" || die "после перезапуска панель не отвечает — journalctl -u mirage -n 50"
ok "Mirage обновлена: $BEFORE → $AFTER"
