// PDF Wizard CAC Signing: background service worker. Forwards requests from allowed PDF Wizard pages to the
// native helper "com.pdfwizard.cac" (native/macos, native/windows), which signs with the smart card.
//
// Allowed origins: http://localhost and http://127.0.0.1 (any port), plus those set by policy
// (chrome.storage.managed "allowedOrigins", see managed_schema.json) or in the options page.
const HOST = 'com.pdfwizard.cac';
const VERSION = chrome.runtime.getManifest().version;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

async function configuredOrigins() {
  const [managed, local] = await Promise.all([
    chrome.storage.managed.get('allowedOrigins').catch(() => ({})),
    chrome.storage.local.get('allowedOrigins').catch(() => ({})),
  ]);
  return [...(managed.allowedOrigins || []), ...(local.allowedOrigins || [])].map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean);
}

async function isAllowed(origin) {
  if (!origin) return false;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return true;
  if (u.protocol !== 'https:') return false;
  return (await configuredOrigins()).includes(u.origin);
}

function native(request) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, request, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // The helper isn't installed (or couldn't start): report it as a status, an error otherwise.
        if (request.type === 'status') resolve({ ok: true, result: { helper: false, error: err.message } });
        else resolve({ ok: false, error: `The PDF Wizard CAC helper isn't available: ${err.message}` });
        return;
      }
      resolve(res && typeof res === 'object' ? res : { ok: false, error: 'The CAC helper sent an invalid reply.' });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own content script, in a top-level tab.
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  (async () => {
    const allowed = await isAllowed(sender.origin);
    if (msg && msg.type === 'hello') return sendResponse({ allowed, version: VERSION });
    if (!allowed) return sendResponse({ ok: false, error: `${sender.origin} isn't allowed to request CAC signatures.` });
    if (msg && msg.type === 'native' && msg.request && ['status', 'list', 'sign'].includes(msg.request.type)) {
      return sendResponse(await native(msg.request));
    }
    sendResponse({ ok: false, error: 'Unknown request.' });
  })();
  return true;
});
