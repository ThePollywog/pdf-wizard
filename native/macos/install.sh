#!/usr/bin/env bash
# Build the PDF Wizard CAC helper and register it with Chrome, Edge and Chromium for the current user.
#   native/macos/install.sh            (extension ID defaults to the one pinned in extension/manifest.json)
#   EXTENSION_ID=<id> native/macos/install.sh
# Needs the Xcode command line tools (swiftc). Uninstall: native/macos/uninstall.sh
set -euo pipefail
cd "$(dirname "$0")"
EXTENSION_ID=${EXTENSION_ID:-pcalefniaiaclbiffigjgdlcjigencoa}
DEST="$HOME/Library/Application Support/PDF Wizard"
BIN="$DEST/pdfwizard-cac-host"
mkdir -p "$DEST"
command -v swiftc >/dev/null || { echo "swiftc not found: run 'xcode-select --install' first" >&2; exit 1; }
swiftc -O -o "$BIN" PdfWizardCacHost.swift
chmod 755 "$BIN"
MANIFEST=$(cat <<JSON
{
  "name": "com.pdfwizard.cac",
  "description": "PDF Wizard CAC signing helper",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
)
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; do
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/com.pdfwizard.cac.json"
  echo "registered: $dir/com.pdfwizard.cac.json"
done
echo "helper: $BIN"
echo "certificates on the card now:"
"$BIN" --list || true
