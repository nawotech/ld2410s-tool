#!/bin/sh
# Web Serial requires a secure context, so file:// will not work — serve over localhost.
PORT="${1:-8000}"
echo "LD2410S Studio → http://localhost:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$(dirname "$0")"
