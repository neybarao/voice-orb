#!/bin/bash
# Double-click on macOS: starts the local Voice Orb server and opens it in the browser.
cd "$(dirname "$0")"
PORT=8765
URL="http://localhost:$PORT/?state=speaking"
if command -v node >/dev/null 2>&1; then
  (sleep 1; open "$URL") &
  exec node serve.mjs
elif [ -x /usr/bin/python3 ] && /usr/bin/xcode-select -p >/dev/null 2>&1; then
  (sleep 1; open "$URL") &
  exec python3 -c "
import http.server, mimetypes
mimetypes.add_type('text/javascript', '.mjs')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self): self.send_header('Cache-Control', 'no-store'); super().end_headers()
print('Voice Orb running at http://localhost:$PORT  (Ctrl+C to stop)')
http.server.ThreadingHTTPServer(('127.0.0.1', $PORT), H).serve_forever()"
else
  echo "Precisa do Node.js (https://nodejs.org) ou do Python 3 para rodar o servidor local."
  read -n 1 -s -r -p "Pressione qualquer tecla para fechar."
fi
