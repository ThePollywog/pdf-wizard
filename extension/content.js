// PDF Wizard CAC Signing: content script. Inert unless the background worker says this page's origin
// is an allowed PDF Wizard deployment; then it marks <html data-pdfwizard-cac> and relays the page's
// signing requests (window.postMessage, channel "pdfwizard-cac") to the background worker.
(() => {
  const CHANNEL = 'pdfwizard-cac';
  const TYPES = new Set(['status', 'list', 'sign']);
  chrome.runtime.sendMessage({ type: 'hello' }, (r) => {
    if (chrome.runtime.lastError || !r || !r.allowed) return;
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const m = e.data;
      if (!m || m.channel !== CHANNEL || m.dir !== 'request' || typeof m.id !== 'number' || !TYPES.has(m.type)) return;
      const request = { type: m.type };
      if (m.type === 'sign') Object.assign(request, { certId: String(m.certId), digest: String(m.digest), hash: String(m.hash || 'sha256') });
      chrome.runtime.sendMessage({ type: 'native', request }, (res) => {
        const err = chrome.runtime.lastError;
        const reply = err ? { ok: false, error: err.message } : res || { ok: false, error: 'No answer from the extension.' };
        window.postMessage({ channel: CHANNEL, dir: 'response', id: m.id, ok: !!reply.ok, result: reply.result, error: reply.error }, location.origin);
      });
    });
    document.documentElement.dataset.pdfwizardCac = r.version;
  });
})();
