#!/bin/sh
# Sobe o app deste repositório, roda UM teste de tela e fecha o servidor no fim (o teste fecha o Edge).
# Uso: sh scripts/teste-tela/um-teste.sh <teste.mjs> [argumentos depois da URL]
#      T=1000 sh ... para mudar o tempo máximo do teste (segundos, padrão 480)
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$DIR/../.." && pwd)"
LOG="$(mktemp)"
script="$1"; shift
# Um Edge por vez na máquina toda: várias sessões e worktrees rodam testes ao mesmo tempo, e dois Edge
# headless juntos travaram o PC em 30/10/2026. mkdir é atômico; quem não conseguir espera a vez.
LOCK="${TMPDIR:-${TEMP:-/tmp}}/clurn-edge.lock"
w=0; until mkdir "$LOCK" 2>/dev/null; do
  [ $w -eq 0 ] && echo "outro teste de tela está rodando ($(cat "$LOCK/quem" 2>/dev/null)); esperando a vez…"
  w=$((w+1)); [ $w -ge 1800 ] && { echo "esperei 30 min pela vez; apague $LOCK se nenhum teste estiver rodando"; exit 1; }
  sleep 1
done
echo "$script $(date +%H:%M:%S)" > "$LOCK/quem"
trap 'rm -rf "$LOCK"' EXIT INT TERM
cd "$APP" || exit 1
node src/app/server.ts --sem-navegador > "$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -f "$LOG"; rm -rf "$LOCK"' EXIT INT TERM
i=0; until grep -q "http://127" "$LOG" 2>/dev/null || [ $i -ge 100 ]; do i=$((i+1)); sleep 0.2; done
URL=$(grep -o "http://127[^ ]*" "$LOG" | head -1)
[ -z "$URL" ] && { echo "servidor não subiu"; cat "$LOG"; exit 1; }
cd "$DIR" && timeout ${T:-480} node "$script" "$URL" "$@"
