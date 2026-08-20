const $ = (id) => document.getElementById(id);

const els = {
  script: $('script'),
  wordCount: $('wordCount'),
  estimate: $('estimate'),
  avatar: $('avatar'),
  voice: $('voice'),
  preset: $('preset'),
  speed: $('speed'),
  background: $('background'),
  captions: $('captions'),
  generate: $('generate'),
  error: $('error'),
  status: $('status'),
  player: $('player'),
  placeholder: $('placeholder'),
  download: $('download'),
  health: $('health'),
  previewFrame: $('previewFrame'),
};

const WORDS_PER_SECOND = 150 / 60;

async function api(path, options) {
  const res = await fetch(`/api${path}`, options);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

function setStatus(text, variant = 'muted') {
  els.status.textContent = text;
  els.status.className = `pill pill--${variant}`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function updateWordCount() {
  const words = els.script.value.trim() ? els.script.value.trim().split(/\s+/).length : 0;
  els.wordCount.textContent = words;
  els.estimate.textContent = `~${Math.round(words / WORDS_PER_SECOND)}s`;
}

function fillSelect(select, items, { placeholder }) {
  select.innerHTML = '';
  if (!items.length) {
    select.innerHTML = `<option value="">${placeholder}</option>`;
    return;
  }
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    if (item.data) Object.assign(option.dataset, item.data);
    select.append(option);
  }
}

async function loadHealth() {
  try {
    const health = await api('/health');
    if (health.apiKeyConfigured) {
      els.health.textContent = 'API key loaded';
      els.health.className = 'pill pill--ok';
    } else {
      els.health.textContent = 'HEYGEN_API_KEY missing';
      els.health.className = 'pill pill--bad';
    }
  } catch {
    els.health.textContent = 'server unreachable';
    els.health.className = 'pill pill--bad';
  }
}

async function loadPresets() {
  const presets = await api('/presets');
  fillSelect(
    els.preset,
    Object.entries(presets).map(([value, p]) => ({
      value,
      label: p.label,
      data: { width: String(p.width), height: String(p.height) },
    })),
    { placeholder: 'none' },
  );
  applyPresetAspect();
}

function applyPresetAspect() {
  const option = els.preset.selectedOptions[0];
  if (!option?.dataset.width) return;
  els.previewFrame.style.aspectRatio = `${option.dataset.width} / ${option.dataset.height}`;
}

async function loadCatalog() {
  const [{ avatars, talkingPhotos }, voices] = await Promise.all([api('/avatars'), api('/voices')]);

  fillSelect(
    els.avatar,
    [
      ...avatars.map((a) => ({ value: a.id, label: a.name || a.id, data: { kind: 'avatar' } })),
      ...talkingPhotos.map((p) => ({ value: p.id, label: `${p.name || p.id} (photo)`, data: { kind: 'talking_photo' } })),
    ],
    { placeholder: 'no avatars found' },
  );

  fillSelect(
    els.voice,
    voices.map((v) => ({ value: v.id, label: `${v.name} — ${v.language || ''} ${v.gender || ''}`.trim() })),
    { placeholder: 'no voices found' },
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntilReady(videoId) {
  // Renders usually take 1–4 minutes; give up after ~10 to avoid an endless spinner.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(5000);
    const status = await api(`/videos/${videoId}`);
    setStatus(`${status.status}…`, 'busy');
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(status.error?.message || 'HeyGen render failed');
  }
  throw new Error('Timed out waiting for the render. Check the video in the HeyGen dashboard.');
}

async function generate() {
  showError('');
  els.generate.disabled = true;
  els.player.hidden = true;
  els.placeholder.hidden = false;
  els.download.hidden = true;

  try {
    setStatus('submitting…', 'busy');
    const { videoId } = await api('/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: els.script.value,
        avatarId: els.avatar.value,
        characterKind: els.avatar.selectedOptions[0]?.dataset.kind || 'avatar',
        voiceId: els.voice.value,
        preset: els.preset.value,
        speed: Number(els.speed.value) || 1,
        captions: els.captions.checked,
        backgroundColor: els.background.value,
      }),
    });

    setStatus('queued…', 'busy');
    const done = await pollUntilReady(videoId);

    els.player.src = done.videoUrl;
    els.player.hidden = false;
    els.placeholder.hidden = true;
    els.download.href = done.videoUrl;
    els.download.hidden = false;
    setStatus(`ready · ${Math.round(done.duration ?? 0)}s`, 'ok');
  } catch (err) {
    showError(err.message);
    setStatus('failed', 'bad');
  } finally {
    els.generate.disabled = false;
  }
}

els.script.addEventListener('input', updateWordCount);
els.preset.addEventListener('change', applyPresetAspect);
els.generate.addEventListener('click', generate);

updateWordCount();
loadHealth();
loadPresets().catch((err) => showError(err.message));
loadCatalog().catch((err) => showError(`Could not load avatars/voices: ${err.message}`));
