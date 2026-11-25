#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www/static
cp ../static/index.html www/index.html
cp ../static/style.css www/static/style.css
cp ../static/i18n.js www/static/i18n.js
cp ../static/qr.js www/static/qr.js
cp ../static/local-engine.js www/static/local-engine.js
cp ../static/e2ee-sync.js www/static/e2ee-sync.js
cp ../static/app.js www/static/app.js
cp ../static/icon.svg www/icon.svg
cp ../static/apple-touch-icon.png www/apple-touch-icon.png
cp ../static/icon-192.png www/icon-192.png
cp ../static/icon-512.png www/icon-512.png
cp ../static/manifest.webmanifest www/manifest.webmanifest
echo "Synced ../static -> mobile/www"
