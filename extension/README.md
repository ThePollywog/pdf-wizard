# PDF Wizard CAC Signing (browser extension)

This is a Manifest V3 extension for Chrome and Edge. It relays signing requests from PDF Wizard pages to
the PDF Wizard CAC helper (`../native`). It does nothing on any other site.

- **Extension ID:** `pcalefniaiaclbiffigjgdlcjigencoa`. It's fixed by the `key` in `manifest.json`.
  The helper's registration only admits this ID.
- **Allowed sites:** `http://localhost` and `http://127.0.0.1` on any port (development) are always
  allowed. HTTPS origins can be added by policy (`allowedOrigins`, see `managed_schema.json`) or by
  the user in the extension's options.
- **Permissions:** `nativeMessaging` and `storage`. The content script is injected everywhere so it
  can check the page's origin, but it stays inert unless the background worker confirms the origin
  is allowed.

## Install for testing

1. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, choose **Load
   unpacked** and pick this folder.
2. Install the helper (`../native/macos/install.sh` or `..\native\windows\install.ps1`).
3. Reload PDF Wizard, open a PDF and choose **Digitally sign (CAC)**.

## Deploy to managed machines

- Pack the extension (`chrome://extensions` › Pack extension) with `pdfwizard-extension-key.pem`. The
  same key keeps the same ID. Keep that file private and out of source control; it's gitignored.
  If you publish through the Chrome Web Store or Edge Add-ons instead, the store assigns the ID:
  set it in the helper installers (`EXTENSION_ID=… install.sh`, `install.ps1 -ExtensionId …`).
- Force-install it with the `ExtensionInstallForcelist` policy. Set the PDF Wizard site(s) through the
  extension's managed storage policy:

```json
{ "allowedOrigins": ["https://pdfwizard.example.mil"] }
```

(Windows registry: `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\pcalefniaiaclbiffigjgdlcjigencoa\policy`,
value `allowedOrigins`. Edge uses `…\Policies\Microsoft\Edge\3rdparty\…`.)

Firefox isn't supported yet. It uses a different native messaging registration and extension format.
