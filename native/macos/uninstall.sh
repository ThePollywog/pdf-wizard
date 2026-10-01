#!/usr/bin/env bash
# Remove the PDF Wizard CAC helper and its browser registrations for the current user.
set -euo pipefail
rm -f "$HOME/Library/Application Support/PDF Wizard/pdfwizard-cac-host"
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; do
  rm -f "$dir/com.pdfwizard.cac.json"
done
echo "PDF Wizard CAC helper removed."
