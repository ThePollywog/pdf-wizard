# PDF Wizard CAC helper (native messaging host)

This is a small program that Chrome/Edge start when PDF Wizard asks to sign. It lists the certificates
on the smart card and signs a SHA-256 digest with the chosen one. The operating system shows the PIN
prompt. Only keys on hardware tokens are offered.

Protocol: the Chrome native messaging framing (a 4-byte little-endian length, then JSON) with the
requests `status`, `list` and `sign`. It's documented at the top of both sources.

## macOS (`macos/`)

- Uses the built-in PIV support (CryptoTokenKit), so no middleware is needed for a CAC.
- Build and register for the current user (needs the Xcode command line tools):

  ```bash
  native/macos/install.sh      # builds ~/Library/Application Support/PDF Wizard/pdfwizard-cac-host, registers Chrome/Edge/Chromium
  native/macos/uninstall.sh
  ```

- Check what the helper sees, without a PIN: `"$HOME/Library/Application Support/PDF Wizard/pdfwizard-cac-host" --list`
- For fleet deployment, sign and notarize the binary with your organization's Developer ID, and
  install the JSON manifests under `/Library/Google/Chrome/NativeMessagingHosts` (all users).

## Windows (`windows/`)

- Uses the Windows certificate store. It works with the built-in smart card support (CNG smart card
  KSP) and with ActivClient.
- Built from source with the C# compiler that ships with Windows (.NET Framework 4.6+). Nothing to
  download:

  ```powershell
  powershell -ExecutionPolicy Bypass -File native\windows\install.ps1            # current user
  powershell -ExecutionPolicy Bypass -File native\windows\install.ps1 -AllUsers  # all users, as administrator
  native\windows\uninstall.ps1 [-AllUsers]
  ```

- Check what the helper sees: `%LOCALAPPDATA%\PDF Wizard\pdfwizard-cac-host.exe --list`
- **Status: written but not yet run on Windows.** Test it on a CAC workstation before rolling it out.
  For deployment, sign the `.exe` with your code-signing certificate. Environments with application
  allow-listing (e.g. AppLocker) will need it approved.

Both installers take the extension ID (`EXTENSION_ID=…` / `-ExtensionId …`) in case you publish the
extension under a different ID.
