const list = document.getElementById('list');
const error = document.getElementById('error');

async function render() {
  const managed = (await chrome.storage.managed.get('allowedOrigins').catch(() => ({}))).allowedOrigins || [];
  const local = (await chrome.storage.local.get('allowedOrigins')).allowedOrigins || [];
  list.textContent = '';
  for (const o of managed) {
    const li = document.createElement('li');
    li.textContent = o;
    const tag = document.createElement('span');
    tag.className = 'muted';
    tag.textContent = 'policy';
    li.append(tag);
    list.append(li);
  }
  for (const o of local) {
    const li = document.createElement('li');
    li.textContent = o;
    const b = document.createElement('button');
    b.textContent = 'Remove';
    b.onclick = async () => {
      await chrome.storage.local.set({ allowedOrigins: local.filter((x) => x !== o) });
      render();
    };
    li.append(b);
    list.append(li);
  }
}

document.getElementById('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  let u;
  try {
    u = new URL(document.getElementById('origin').value.trim());
  } catch {
    error.textContent = 'Enter a full address, e.g. https://pdfwizard.example.mil';
    return;
  }
  if (u.protocol !== 'https:') {
    error.textContent = 'Only https:// sites can be added.';
    return;
  }
  const local = (await chrome.storage.local.get('allowedOrigins')).allowedOrigins || [];
  if (!local.includes(u.origin)) await chrome.storage.local.set({ allowedOrigins: [...local, u.origin] });
  document.getElementById('origin').value = '';
  render();
});

render();
