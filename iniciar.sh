#!/bin/bash
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node server.js
elif command -v python3 >/dev/null 2>&1; then
  (sleep 1; open "http://localhost:5173" 2>/dev/null || xdg-open "http://localhost:5173" 2>/dev/null) &
  python3 -m http.server 5173 --bind 127.0.0.1
else
  echo "Necesitas Node.js o Python 3 instalado."
fi
