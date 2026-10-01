# PDF Wizard

A PDF viewer and editor for administrative paperwork, with **CAC digital signing**. PDF Wizard runs
entirely in the browser. It has no server, and documents never leave the computer.

- View, fill forms, comment, draw, edit text and images, organize pages, protect and redact.
- **Sign with a CAC.** Sign a form's empty signature fields or draw new ones. Several people can
  sign the same form in turn: each signature is appended to the file as an incremental update, so
  filling in your part and signing doesn't invalidate the signatures already on it.
- **Check signatures** against the bundled DoD PKI (DoD Root CA 3–6 and the issuing CAs).
- Files are kept in this browser's storage (IndexedDB), with the last 10 versions of each.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ — serve it from any web server (S3 + CloudFront, IIS, nginx…)
```

Serve `dist/` over HTTPS in production. Other than that it needs nothing: no database and no API.
Set `BASE_PATH` when the site isn't at the root of its domain (`BASE_PATH=/pdfwizard/ npm run build`).

## Deploy to GitHub Pages

`.github/workflows/deploy-pages.yml` builds and publishes the site on every push to `main`.

1. Push this repository to GitHub.
2. In the repository's **Settings › Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run the workflow from the **Actions** tab. The site goes to
   `https://<user>.github.io/<repo>/`. The workflow picks the base path up from Pages, so a custom
   domain or a `<user>.github.io` repository works too.
4. To sign on the deployed site, add its origin to the extension's allowed sites: either by policy
   (`allowedOrigins`) or in the extension's options. See [extension/README.md](extension/README.md).

**Use a custom domain (or a dedicated GitHub organization) for real use.** Browsers isolate
storage and the extension's allow-list by *origin*, and every Pages site of one account shares the
origin `https://<user>.github.io`. On that shared origin, any other Pages site of the same account
could read the PDF Wizard file library in that browser. Once that origin is allowed in the extension, those
sites could also ask for CAC signatures. The PIN prompt still appears for every signature, but it
doesn't show which document is being signed. With a custom domain (**Settings › Pages › Custom
domain**) PDF Wizard gets an origin of its own.

## CAC signing: what gets installed on each computer

A web page can't reach a smart card by itself, so signing uses two small pieces:

1. **PDF Wizard CAC Signing** (`extension/`), an extension for Chrome and Edge. It passes signing requests
   from allowed PDF Wizard sites to the helper. See [extension/README.md](extension/README.md).
2. **PDF Wizard CAC helper** (`native/`), a native messaging host that signs with the card through the
   operating system's keystore. It uses CryptoTokenKit on macOS and CNG / the card middleware on Windows.
   The OS shows its usual PIN prompt. See [native/README.md](native/README.md).

PDF Wizard never sees the PIN or the private key. The browser hashes the document and sends only a
32-byte digest to the card.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the app is put together (contracts, engine, features)
- [docs/STATUS.md](docs/STATUS.md): what works, known limits, and how to test
