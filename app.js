// EarLink — live speech translation into your earbuds. Created by Farhan.
// Phone mic -> 16 kHz PCM -> Gemini Live Translate (WebSocket) -> translated audio -> earbuds.
//
// v13 (2026-10-26):
//  - Two-way simplified: ONE language per earbud ("the language this person speaks and understands").
//    Left = Urdu, Right = English -> left ear hears the other side in Urdu, right ear hears it in English.
// v12 (2026-10-26):
//  - Fix: spoken Urdu that Google writes in English letters ("aap kaise hain") and labels "English" was
//    treated as English -> played back to the Urdu speaker and skipped for the English ear.
//    Now: Urdu/Hindi in English letters is recognised from common words; the actual letters (script)
//    beat a wrong label; and "already in my language" for English-type targets is double-checked by
//    comparing what was said with the translation.
// v11 (2026-10-26):
//  - Two-way rule changed to EXCLUSION: each earbud plays everything EXCEPT its own person's languages
//    (their "Speaks" + "Hears"; Urdu and Hindi count as twins). Mixed English/Urdu speech or a wrong
//    language label from Google no longer gets the speaker's words cancelled for the other person.
//  - Mic is no longer muted for one side while the other earbud plays (people reply quickly; that was
//    throwing away their words). Optional in Settings for anyone who hears echoes.
//  - Mic sensitivity Normal / High / Max (gain + limiter) to pick up quiet or faraway voices.
//  - "Skipped" lines are hidden by default (Settings to show them).
// v10 (2026-10-26):
//  - Two-way is now set up PER EAR. Each ear has "Speaks" and "Hears":
//      LEFT ear plays  : what the RIGHT person speaks, translated into what LEFT hears
//      RIGHT ear plays : what the LEFT person speaks,  translated into what RIGHT hears
//  - Fix: a person could hear their OWN words back (e.g. friend's Chinese in the Chinese ear) when
//    Google was slow to say which language was spoken; the app now waits longer and, if still
//    unsure while specific languages are set, skips instead of playing.
//  - Professional cyberpunk design (dark HUD, neon cyan = left, magenta = right). Light mode removed.
// v9: vibrant glass 3D look. v8: animated intro with Farhan's signature.
// v7: lanes (two translators), loop guard, fresh session after pauses with mic buffering,
//     mic muted for the other lane while one ear plays.

const VERSION = 'v13 · 2026-10-26';
const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';
const LIVE = 'Listening — translating live';
const LIVE_DUO = 'Listening — two-way';

const $ = (id) => document.getElementById(id);
const els = {
  start: $('startBtn'), startLabel: $('startLabel'), status: $('status'), dot: $('statusDot'),
  lag: $('lag'), feed: $('feed'), empty: $('emptyState'), heard: $('heard'),
  settingsBtn: $('settingsBtn'), settings: $('settings'), closeSettings: $('closeSettings'),
  apiKey: $('apiKey'), mic: $('mic'), echo: $('echo'), model: $('model'), noise: $('noise'),
  autoswitch: $('autoswitch'), keyHint: $('keyHint'), rows: $('rows'), voiceBtn: $('voiceBtn'),
  smallerBtn: $('smallerBtn'), biggerBtn: $('biggerBtn'), resetBtn: $('resetBtn'),
  clear: $('clearBtn'), modeSolo: $('modeSolo'), modeDuo: $('modeDuo'),
  version: $('version'), controls: $('controls'), summary: $('summary'), summaryText: $('summaryText'),
  gate: $('gate'), showSkipped: $('showSkipped'), sens: $('sens'),
};
els.version.textContent = VERSION;
const setLevel = (v) => els.start.style.setProperty('--lvl', v.toFixed(3));

// ---------- saved settings (kept only on this phone) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('earlink.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('earlink.' + k, v); } catch {} },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const baseOf = (code) => {
  let b = String(code || '').toLowerCase().split(/[-_]/)[0];
  if (['cmn', 'yue', 'wuu', 'nan', 'hak'].includes(b)) b = 'zh';
  return b;
};

const LANGS = [
  { code: 'en', label: 'English', name: 'English' }, { code: 'zh-Hans', label: '中文', name: 'Chinese' },
  { code: 'ar', label: 'العربية', name: 'Arabic' }, { code: 'ur', label: 'اردو', name: 'Urdu' },
  { code: 'hi', label: 'हिन्दी', name: 'Hindi' }, { code: 'ml', label: 'മലയാളം', name: 'Malayalam' },
  { code: 'ms', label: 'Melayu', name: 'Malay' }, { code: 'ta', label: 'தமிழ்', name: 'Tamil' },
  { code: 'az', label: 'Azərbaycan', name: 'Azerbaijani' },
];
const isLang = (c) => LANGS.some((l) => l.code === c);
const fixCode = (c) => (c === 'zh' ? 'zh-Hans' : c);
const langSet = (raw) => new Set(String(raw || '').split(',').map(fixCode).filter(isLang));
const oneLang = (raw, d) => (isLang(fixCode(raw)) ? fixCode(raw) : d);

// Two-way ear settings. Migrate from v7–v9 ("I speak / Friend speaks / I hear / my ear").
function loadEars() {
  const saved = store.get('ears', '');
  if (saved) {
    try {
      const e = JSON.parse(saved);
      return {
        left: { speak: langSet(e.left.speak.join(',')), hear: oneLang(e.left.hear, 'en') },
        right: { speak: langSet(e.right.speak.join(',')), hear: oneLang(e.right.hear, 'zh-Hans') },
      };
    } catch {}
  }
  const friend = oneLang(store.get('friendLang', 'zh-Hans'), 'zh-Hans');
  const me = { speak: langSet(store.get('iSpeak', 'en')), hear: oneLang(store.get('myHear', 'en'), 'en') };
  const fr = { speak: new Set([friend]), hear: friend };
  return store.get('meEar', 'left') === 'right' ? { left: fr, right: me } : { left: me, right: fr };
}

const prefs = {
  mode: store.get('mode', 'solo') === 'duo' ? 'duo' : 'solo',
  // Just me
  target: oneLang(store.get('target', 'en'), 'en'),
  listen: langSet(store.get('listen', '')),
  // Two-way
  ears: loadEars(),
  // mic sensitivity
  sens: ['normal', 'high', 'max'].includes(store.get('sens', 'high')) ? store.get('sens', 'high') : 'high',
  // display
  speak: store.get('speak', '1') === '1',
  fs: clamp(parseInt(store.get('fs', '26'), 10) || 26, 18, 42),
};
// v13: one language per earbud (speaks = hears)
for (const side of ['left', 'right']) prefs.ears[side].speak = new Set([prefs.ears[side].hear]);
const savePrefs = () => {
  store.set('mode', prefs.mode); store.set('target', prefs.target); store.set('listen', [...prefs.listen].join(','));
  store.set('ears', JSON.stringify({
    left: { speak: [...prefs.ears.left.speak], hear: prefs.ears.left.hear },
    right: { speak: [...prefs.ears.right.speak], hear: prefs.ears.right.hear },
  }));
};

els.apiKey.value = store.get('apiKey', '');
els.echo.checked = store.get('echo', '0') === '1';
els.model.value = store.get('model', DEFAULT_MODEL);
els.noise.checked = store.get('noise', '0') === '1';
els.autoswitch.checked = store.get('autoswitch', '1') === '1';
els.gate.checked = store.get('gate', '0') === '1';
els.showSkipped.checked = store.get('showSkipped', '0') === '1';
document.body.classList.toggle('show-skipped', els.showSkipped.checked);

for (const [el, key, kind] of [
  [els.apiKey, 'apiKey', 'value'], [els.model, 'model', 'value'], [els.mic, 'mic', 'value'],
  [els.echo, 'echo', 'check'], [els.noise, 'noise', 'check'], [els.autoswitch, 'autoswitch', 'check'],
  [els.gate, 'gate', 'check'], [els.showSkipped, 'showSkipped', 'check'],
]) {
  el.addEventListener('change', () => {
    store.set(key, kind === 'check' ? (el.checked ? '1' : '0') : el.value.trim());
    if (key === 'showSkipped') document.body.classList.toggle('show-skipped', el.checked);
    if (!running) return;
    if (key === 'apiKey' || key === 'model' || key === 'echo') resetLanes();
    if (key === 'mic' || key === 'noise') restartMic();
    if (key === 'showSkipped') document.body.classList.toggle('show-skipped', el.checked);
  });
}
const openSettings = () => els.settings.showModal();
els.settingsBtn.onclick = openSettings;
els.closeSettings.onclick = () => els.settings.close();

// ---------- language setup on the main screen ----------
const scrollMem = {};
function chip(label, pressed, onclick) {
  const b = document.createElement('button');
  b.className = 'tchip'; b.textContent = label; b.setAttribute('aria-pressed', String(pressed)); b.onclick = onclick;
  return b;
}
function chipRow(label, key, { items, pressed, onTap, any }) {
  const row = document.createElement('div');
  row.className = 'hearin';
  const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = label;
  const box = document.createElement('div'); box.className = 'chips'; box.dataset.key = key;
  if (any) box.appendChild(chip('Any', any.pressed, any.onTap));
  for (const it of items) box.appendChild(chip(it.label, pressed(it.code), () => onTap(it.code)));
  box.addEventListener('scroll', () => { scrollMem[key] = box.scrollLeft; });
  row.append(lbl, box);
  return row;
}
function changed(restart = true) { savePrefs(); renderRows(); if (running && restart) resetLanes(); }
const labelOf = (c) => (LANGS.find((l) => l.code === c) || { label: c }).label;
const nameOf = (c) => (LANGS.find((l) => l.code === c) || { name: c }).name;
const list = (set) => [...set].map(nameOf).join(' / ');
// A person's own languages = what they speak + what they hear. Urdu and Hindi are twins
// (Google often writes spoken Urdu in Hindi letters and labels it Hindi).
const TWINS = { ur: ['hi'], hi: ['ur'] };
function ownLangs(ear) { return new Set([...ear.speak, ear.hear]); }
function ownBases(ear) {
  const out = new Set();
  for (const c of ownLangs(ear)) { const b = baseOf(c); out.add(b); (TWINS[b] || []).forEach((t) => out.add(t)); }
  return out;
}
function renderSummary() {
  const { left: L, right: R } = prefs.ears;
  els.summaryText.textContent = prefs.mode === 'duo'
    ? `L: ${nameOf(L.hear)}   ⇄   R: ${nameOf(R.hear)}`
    : `${prefs.listen.size ? [...prefs.listen].map(labelOf).join(' / ') : 'Any language'} → ${labelOf(prefs.target)}`;
}
els.summary.onclick = () => {
  const open = els.controls.classList.toggle('open');
  els.summary.setAttribute('aria-expanded', String(open));
};
// One card per earbud: who wears it, what they speak, what they hear.
function earCard(side) {
  const me = prefs.ears[side], other = prefs.ears[side === 'left' ? 'right' : 'left'];
  const card = document.createElement('section');
  card.className = `earcard ${side}`;
  const head = document.createElement('div');
  head.className = 'earhead';
  head.innerHTML = `<span class="eartag">${side === 'left' ? '◀ L' : 'R ▶'}</span><span class="eartitle">${side === 'left' ? 'Left earbud' : 'Right earbud'}</span>`;
  const flow = document.createElement('p');
  flow.className = 'earflow';
  flow.textContent = me.hear === other.hear
    ? `Both sides are ${nameOf(me.hear)} — pick a different language on one side`
    : `Speaks ${nameOf(me.hear)} · hears the other side's ${nameOf(other.hear)} in ${nameOf(me.hear)}`;
  card.append(
    head,
    chipRow('Language', `${side}-lang`, {
      items: LANGS, pressed: (c) => c === me.hear,
      onTap: (c) => { if (c !== me.hear) { me.hear = c; me.speak = new Set([c]); changed(); } },
    }),
    flow,
  );
  return card;
}
function renderRows() {
  renderSummary();
  els.modeSolo.setAttribute('aria-pressed', String(prefs.mode === 'solo'));
  els.modeDuo.setAttribute('aria-pressed', String(prefs.mode === 'duo'));
  els.rows.innerHTML = '';
  if (prefs.mode === 'solo') {
    els.rows.append(
      chipRow('Translate', 'listen', {
        items: LANGS, pressed: (c) => prefs.listen.has(c),
        onTap: (c) => { prefs.listen.has(c) ? prefs.listen.delete(c) : prefs.listen.add(c); changed(); },
        any: { pressed: prefs.listen.size === 0, onTap: () => { prefs.listen.clear(); changed(); } },
      }),
      chipRow('Into', 'target', {
        items: LANGS, pressed: (c) => c === prefs.target,
        onTap: (c) => { if (c !== prefs.target) { prefs.target = c; changed(); } },
      }),
    );
  } else {
    const swap = document.createElement('button');
    swap.className = 'swapbtn';
    swap.textContent = '⇄ Swap left and right';
    swap.onclick = () => { const l = prefs.ears.left; prefs.ears.left = prefs.ears.right; prefs.ears.right = l; changed(); };
    els.rows.append(earCard('left'), earCard('right'), swap);
  }
  els.rows.querySelectorAll('.chips').forEach((b) => {
    if (scrollMem[b.dataset.key] != null) { b.scrollLeft = scrollMem[b.dataset.key]; return; }
    // first time: make sure the selected language is visible
    const on = b.querySelector('[aria-pressed="true"]');
    if (!on) return;
    const bx = b.getBoundingClientRect(), ox = on.getBoundingClientRect();
    if (ox.right > bx.right - 24) b.scrollLeft += ox.left - bx.left - 8;
  });
}
els.modeSolo.onclick = () => { if (prefs.mode !== 'solo') { prefs.mode = 'solo'; changed(); } };
els.modeDuo.onclick = () => { if (prefs.mode !== 'duo') { prefs.mode = 'duo'; changed(); } };

// ---------- quick controls ----------
function renderVoice() { els.voiceBtn.setAttribute('aria-pressed', String(prefs.speak)); }
els.voiceBtn.onclick = () => {
  prefs.speak = !prefs.speak; store.set('speak', prefs.speak ? '1' : '0'); renderVoice();
  if (!prefs.speak) lanes.forEach(stopLanePlayback);
};
function applyFont() { document.documentElement.style.setProperty('--fs', prefs.fs + 'px'); }
els.smallerBtn.onclick = () => { prefs.fs = clamp(prefs.fs - 3, 18, 42); store.set('fs', prefs.fs); applyFont(); };
els.biggerBtn.onclick = () => { prefs.fs = clamp(prefs.fs + 3, 18, 42); store.set('fs', prefs.fs); applyFont(); };
els.resetBtn.onclick = () => { if (running) lanes.forEach((l) => rotate(l, 'manual')); };
els.clear.onclick = () => {
  els.feed.querySelectorAll('.line').forEach((n) => n.remove());
  lanes.forEach((l) => { l.curLine = null; });
  els.empty.hidden = false; heard.clear(); renderHeard();
};
const SENS_GAIN = { normal: 1, high: 3, max: 6 };
function renderSens() {
  els.sens.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === prefs.sens)));
}
els.sens.querySelectorAll('button').forEach((b) => {
  b.onclick = () => { prefs.sens = b.dataset.s; store.set('sens', prefs.sens); renderSens(); applySens(); };
});
renderRows(); renderVoice(); applyFont(); renderSens();

// ---------- status ----------
let flashUntil = 0;
function setStatus(text, state) { els.status.textContent = text; els.dot.dataset.state = state; }
function flash(text) { flashUntil = performance.now() + 2500; setStatus(text, 'live'); setTimeout(updateStatus, 2600); }
function updateStatus() {
  if (!running || performance.now() < flashUntil) return;
  if (lanes.some((l) => l.reconnecting)) { setStatus('Reconnecting…', 'connecting'); return; }
  if (lanes.length && lanes.every((l) => l.everReady)) setStatus(prefs.mode === 'duo' ? LIVE_DUO : LIVE, 'live');
  else setStatus('Connecting…', 'connecting');
}

// ---------- languages: colour + names ----------
const LANG_COLORS = {
  zh: '#ff6b6b', ml: '#4cc9f0', ar: '#f4a261', az: '#8b9bff', ms: '#f2c94c', ta: '#c77dff',
  hi: '#ff8fab', en: '#9aa5b1', ja: '#ff9f1c', ko: '#2ec4b6', id: '#e9c46a', ur: '#90be6d',
  bn: '#f28482', fa: '#84a59d', tr: '#e76f51', th: '#a3c4f3', vi: '#ffadad', te: '#bdb2ff', kn: '#caffbf',
};
const PALETTE = ['#ff6b6b', '#4cc9f0', '#f4a261', '#8b9bff', '#f2c94c', '#c77dff', '#ff8fab', '#90be6d', '#2ec4b6', '#e76f51'];
const langCache = new Map();
function langInfo(code) {
  if (!code) return null;
  const base = baseOf(code);
  if (langCache.has(base)) return langCache.get(base);
  const color = LANG_COLORS[base] || PALETTE[[...base].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
  let en = base.toUpperCase(), native = '';
  try { en = new Intl.DisplayNames(['en'], { type: 'language' }).of(base) || en; } catch {}
  try { native = new Intl.DisplayNames([base], { type: 'language' }).of(base) || ''; } catch {}
  if (native.toLowerCase() === en.toLowerCase()) native = '';
  const info = { base, color, en, native, label: native ? `${native} · ${en}` : en };
  langCache.set(base, info);
  return info;
}
const heard = new Map();
function renderHeard() {
  els.heard.innerHTML = '';
  for (const i of heard.values()) {
    const s = document.createElement('span');
    s.className = 'hchip'; s.style.setProperty('--lc', i.color); s.textContent = i.label;
    els.heard.appendChild(s);
  }
  els.heard.hidden = heard.size === 0;
}

// ---------- microphone ----------
const BT_RE = /bluetooth|headset|hands[- ]?free|baseus|airpods|buds|\bbt\b|sco/i;
async function refreshMics() {
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
  const saved = store.get('mic', '');
  els.mic.innerHTML = '';
  els.mic.add(new Option('Auto (prefer phone mic)', ''));
  devices.forEach((d, i) => {
    const label = d.label || `Microphone ${i + 1}`;
    els.mic.add(new Option(label + (BT_RE.test(label) ? ' — earbuds (lower quality)' : ''), d.deviceId));
  });
  els.mic.value = devices.some((d) => d.deviceId === saved) ? saved : '';
}
function pickPhoneMic(devices) {
  const ins = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return (
    ins.find((d) => /built-?in|bottom|internal|phone|speakerphone/i.test(d.label) && !BT_RE.test(d.label)) ||
    ins.find((d) => d.label && !BT_RE.test(d.label)) || null
  );
}

let running = false;
let runId = 0; // bumps on every Start/Stop so a stale start can't continue after Stop
let micStream = null, captureCtx = null, workletNode = null, sinkNode = null, boostNode = null, limiterNode = null;
function applySens() { if (boostNode) boostNode.gain.value = SENS_GAIN[prefs.sens] || 1; }
let lastLoud = 0;

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const softResume = (ctx) => (ctx ? withTimeout(ctx.resume(), 2500, 'resume').catch(() => {}) : Promise.resolve());
const getMic = (c) => withTimeout(navigator.mediaDevices.getUserMedia({ audio: c }), 10000,
  'The microphone did not respond. Close other apps using the mic, then try again.');

async function startMic(my) {
  // Echo cancellation off on purpose: on Android it forces "call mode", which drops
  // Bluetooth earbuds to low-quality mono headset audio (and would break left/right ears).
  const base = { channelCount: 1, echoCancellation: false, noiseSuppression: els.noise.checked, autoGainControl: true };
  const deviceId = els.mic.value;
  let stream = await getMic(deviceId ? { ...base, deviceId: { exact: deviceId } } : base);
  if (my !== runId) { stream.getTracks().forEach((t) => t.stop()); return; }
  if (!deviceId) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const current = stream.getAudioTracks()[0]?.label || '';
    const phone = pickPhoneMic(devices);
    if (BT_RE.test(current) && phone) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await getMic({ ...base, deviceId: { exact: phone.deviceId } });
    }
    refreshMics();
  }
  if (my !== runId) { stream.getTracks().forEach((t) => t.stop()); return; }
  micStream = stream;
  await withTimeout(captureCtx.audioWorklet.addModule('capture-worklet.js'), 10000,
    'The audio engine did not load. Check your internet and reopen the app.');
  await softResume(captureCtx);
  if (my !== runId) return;
  const src = captureCtx.createMediaStreamSource(micStream);
  // Sensitivity: boost quiet/faraway voices, then a limiter so loud voices don't distort.
  boostNode = captureCtx.createGain();
  limiterNode = captureCtx.createDynamicsCompressor();
  limiterNode.threshold.value = -14; limiterNode.knee.value = 8; limiterNode.ratio.value = 12;
  limiterNode.attack.value = 0.003; limiterNode.release.value = 0.2;
  applySens();
  workletNode = new AudioWorkletNode(captureCtx, 'capture-processor');
  workletNode.port.onmessage = (e) => onPcm(e.data.pcm, e.data.rms);
  sinkNode = captureCtx.createGain();
  sinkNode.gain.value = 0; // keeps the graph running without making sound
  src.connect(boostNode).connect(limiterNode).connect(workletNode).connect(sinkNode).connect(captureCtx.destination);
}
function stopMic() {
  try { workletNode && workletNode.disconnect(); } catch {}
  try { boostNode && boostNode.disconnect(); limiterNode && limiterNode.disconnect(); } catch {}
  try { sinkNode && sinkNode.disconnect(); } catch {}
  micStream && micStream.getTracks().forEach((t) => t.stop());
  micStream = workletNode = sinkNode = null;
}
async function restartMic() {
  const my = runId;
  stopMic();
  try { await startMic(my); } catch (e) { fail('Microphone error: ' + e.message); }
}

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bufferFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

const MAX_BUFFER = 50; // 5 s of mic audio kept while a translator (re)connects
function onPcm(pcm, rms) {
  setLevel(Math.min(1, rms * 6));
  if (rms > 0.02) lastLoud = performance.now();
  if (!lanes.length) return;
  const data = b64FromBuffer(pcm);
  for (const lane of lanes) {
    if (isGated(lane)) continue;
    const s = lane.session;
    if (s && s.ready && !s.dead && s.ws.readyState === WebSocket.OPEN) sendAudio(s, data);
    else { lane.buffer.push(data); if (lane.buffer.length > MAX_BUFFER) lane.buffer.shift(); }
  }
}
function sendAudio(s, data) {
  s.ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
}
// Two-way: while the other ear is playing a translation, don't give this translator the mic,
// otherwise the translation itself gets picked up and translated again (a loop).
function isGated(lane) {
  if (prefs.mode !== 'duo' || !playCtx || !els.gate.checked) return false;
  const now = playCtx.currentTime;
  return lanes.some((o) => o !== lane && o.nextTime > 0 && o.nextTime + 0.4 > now);
}

// ---------- playback: each lane to its own ear ----------
let playCtx = null, merger = null;
function playPcm24(lane, b64) {
  if (!prefs.speak || !playCtx || !merger) return;
  const i16 = new Int16Array(bufferFromB64(b64));
  if (!i16.length) return;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  const buffer = playCtx.createBuffer(1, f32.length, 24000);
  buffer.copyToChannel(f32, 0);
  const node = playCtx.createBufferSource();
  node.buffer = buffer;
  const now = playCtx.currentTime;
  if (lane.nextTime < now + 0.05) lane.nextTime = now + 0.25; // small cushion against internet hiccups
  node.playbackRate.value = lane.nextTime - now > 3 ? 1.1 : 1; // gently catch up only if far behind
  if (lane.channel !== 'right') node.connect(merger, 0, 0); // left ear
  if (lane.channel !== 'left') node.connect(merger, 0, 1);  // right ear
  node.start(lane.nextTime);
  lane.nextTime += buffer.duration / node.playbackRate.value;
  lane.live.add(node);
  node.onended = () => { lane.live.delete(node); if (!lane.live.size && playCtx && lane.nextTime <= playCtx.currentTime) lane.nextTime = 0; };
}
function stopLanePlayback(lane) { lane.live.forEach((n) => { try { n.stop(); } catch {} }); lane.live.clear(); lane.nextTime = 0; }
const lanePlaying = (lane) => !!playCtx && lane.nextTime > playCtx.currentTime;
setInterval(() => {
  if (!playCtx || !running) { els.lag.textContent = ''; return; }
  const q = Math.max(0, ...lanes.map((l) => l.nextTime - playCtx.currentTime));
  els.lag.textContent = q > 0.4 ? `${q.toFixed(1)}s behind` : '';
}, 300);

// ---------- subtitles ----------
function line(lane) {
  if (!lane.curLine) {
    els.empty.hidden = true;
    const el = document.createElement('article');
    el.className = 'line';
    el.dataset.lane = lane.id;
    el.innerHTML = '<div class="meta"><span class="chip" hidden></span><span class="lane"></span></div><p class="orig"></p><p class="en"></p>';
    if (prefs.mode === 'duo') {
      el.querySelector('.lane').textContent = lane.channel === 'left' ? '→ left ear' : '→ right ear';
    }
    els.feed.appendChild(el);
    const all = els.feed.querySelectorAll('.line');
    if (all.length > 60) all[0].remove();
    lane.curLine = el;
  }
  return lane.curLine;
}
function appendText(lane, kind, text, lang) {
  if (!text) return lane.curLine;
  const l = line(lane);
  if (kind === 'in') {
    l.querySelector('.orig').textContent += text;
    if (lang && !l.dataset.lang) {
      const info = langInfo(lang);
      if (info) {
        l.dataset.lang = info.base;
        l.style.setProperty('--lc', info.color);
        const chipEl = l.querySelector('.chip');
        chipEl.hidden = false; chipEl.textContent = info.label;
        if (!heard.has(info.base)) { heard.set(info.base, info); renderHeard(); }
      }
    }
  } else {
    l.querySelector('.en').textContent += text;
  }
  els.feed.scrollTop = els.feed.scrollHeight;
  return l;
}
function endLine(lane) { if (lane.curLine) lane.curLine.classList.add('done'); lane.curLine = null; }

// ---------- which speech each translator should translate ----------
// Google's "don't repeat the target language" switch isn't always obeyed, so the app also
// filters each reply itself once it knows what language was spoken.
const SCRIPTS = [
  [/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/, 'arabic'], [/[ഀ-ൿ]/, 'malayalam'],
  [/[㐀-䶿一-鿿]/, 'han'], [/[஀-௿]/, 'tamil'], [/[ऀ-ॿ]/, 'devanagari'],
];
const GROUP = {
  arabic: ['ar', 'ur', 'fa'], malayalam: ['ml'], han: ['zh'], tamil: ['ta'], devanagari: ['hi', 'mr', 'ne'],
  latin: ['en', 'ms', 'az', 'id', 'tr', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'vi', 'fil'],
};
// Urdu/Hindi written in English letters (how Google often transcribes spoken Urdu, labelled "en").
const ROMAN_UR = new Set(('hai hain ho hun hoon kya kia aap ap tum tu mein main mai mera meri mere tera teri ' +
  'tumhara tumhari hamara humara nahi nahin kaise kaisa kaisi kahan kidhar kab kyun kyon acha achha accha ' +
  'theek thik bhai yaar jaan karo karna kar raha rahi rahe tha thi the hum ham yeh ye woh wo kuch sab ' +
  'bohat bahut abhi phir lekin aur ke ka ki ko se ne bhi sun suno bolo bol batao chalo dekho jao aao khana').split(' '));
function looksRomanUrdu(text) {
  const w = String(text).toLowerCase().match(/[a-z']+/g) || [];
  if (w.length < 2) return false;
  const hits = w.filter((x) => ROMAN_UR.has(x)).length;
  return hits >= 2 && hits / w.length >= 0.25;
}
function scriptGroupOf(base) { for (const g in GROUP) if (GROUP[g].includes(base)) return g; return null; }
// What language was spoken? The letters beat Google's label when they disagree.
function detect(code, text) {
  const g = scriptOf(text || '');
  const b = code ? baseOf(code) : null;
  if (g && g !== 'latin') return b && (GROUP[g] || []).includes(b) ? { base: b } : { group: g };
  if (g === 'latin' && looksRomanUrdu(text)) return { base: 'ur' };
  if (b) return { base: b };
  return g ? { group: g } : null;
}
const wantedFor = (lane, d) => (d ? (d.base ? isWanted(lane, d.base) : isWanted(lane, null, d.group)) : null);
function scriptOf(text) {
  for (const [re, g] of SCRIPTS) if (re.test(text)) return g;
  return /[A-Za-z]/.test(text) ? 'latin' : null;
}
// true = translate it, false = skip it, null = can't tell yet (compare with the translation)
function isWanted(lane, base, group) {
  const own = baseOf(lane.target);
  const echoOK = els.echo.checked;
  const listen = lane.listenBases;
  const ex = lane.excludeBases;
  if (ex && ex.size) { // two-way: everything except this earbud's own person's languages
    if (base) {
      if (base === own) return echoOK ? true : (scriptGroupOf(own) === 'latin' ? null : false); // Latin: verify by echo
      return !ex.has(base);
    }
    const members = GROUP[group] || [];
    if (!members.some((m) => ex.has(m))) return true;
    return group === 'latin' ? null : false; // e.g. English vs Malay can't be told apart by letters alone
  }
  if (base) {
    if (base === own && !echoOK) return false;
    return listen.size === 0 || listen.has(base);
  }
  const members = GROUP[group] || [];
  const ownHere = members.includes(own) && !echoOK;
  if (listen.size) {
    if (!members.some((m) => listen.has(m))) return false;
    return ownHere ? null : true;
  }
  return ownHere ? null : true;
}
const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// If the "translation" is the same words as what was said, it's an echo of the target language.
function isEcho(t) {
  const a = norm(t.inText), b = norm(t.outText);
  const k = Math.min(a.length, b.length, 24);
  if (k < 4) return null;
  return a.slice(0, k) === b.slice(0, k);
}

// ---------- loop guard ----------
const LOOP_WINDOW_MS = 15000;
function isLooping(lane, t) {
  const n = norm(t.outText);
  // (a) the same phrase repeated back-to-back inside one reply
  for (let L = 10; L <= Math.min(120, Math.floor(n.length / 2)); L++) {
    if (n.slice(-L) === n.slice(-2 * L, -L)) return true;
  }
  // (b) the same sentence as a recent reply
  if (n.length >= 12) {
    const now = performance.now();
    const k = Math.min(n.length, 30);
    if (lane.recent.some((r) => now - r.at < LOOP_WINDOW_MS && r.text.length >= 12 && r.text.slice(0, k) === n.slice(0, k))) return true;
  }
  return false;
}
function breakLoop(lane, s, t) {
  t.loop = true; t.allow = false;
  clearTimeout(t.timer); t.pending = [];
  stopLanePlayback(lane);
  if (t.line) t.line.classList.add('ignored', 'loop');
  lane.loops++;
  flash('Stopped a repeating sentence');
  rotate(lane, 'loop');
}

function decideTurn(lane, s, t, allow) {
  if (t.allow !== null) return;
  t.allow = allow;
  clearTimeout(t.timer);
  if (allow) {
    for (const d of t.pending) playPcm24(lane, d);
    if (t.pending.length) markOutput(s);
  } else if (t.line) {
    t.line.classList.add('ignored');
  }
  t.pending = [];
}
// Google sometimes says which language was spoken a little late. Wait for it; if it still hasn't
// come and this translator only listens to specific languages, skip rather than risk playing
// someone's own words back to them (v10 fix).
const UNSURE_WAIT_MS = 2200;
function unsureDefault(lane, t) {
  if (t.inText) { const w = wantedFor(lane, detect(t.code, t.inText)); if (w !== null) return w; }
  if ((lane.listenBases.size || lane.excludeBases.size) && layoutIdx <= 2) return false; // transcripts expected but never said who spoke
  return true;
}
function markOutput(s) { s.hadOutput = true; s.lastContent = performance.now(); }
function finishTurn(lane, s) {
  const t = s.turn;
  if (!t) return;
  if (t.allow === null) decideTurn(lane, s, t, true);
  if (t.allow === true && !t.loop) {
    const n = norm(t.outText);
    if (n) { lane.recent.push({ text: n, at: performance.now() }); if (lane.recent.length > 8) lane.recent.shift(); }
  }
  s.turn = null;
}

function handleContent(lane, s, c) {
  if (!c) return;
  if (!s.turn) s.turn = { allow: null, pending: [], timer: null, line: null, inText: '', outText: '', loop: false, code: null };
  const t = s.turn;
  if (c.inputTranscription) {
    const text = c.inputTranscription.text || '';
    const code = c.inputTranscription.languageCode;
    t.inText += text;
    t.line = appendText(lane, 'in', text, code) || t.line;
    s.lastContent = performance.now();
    if (code) t.code = code;
    if (t.allow === null) {
      // English-letter text needs a few words before we can tell English from Urdu-in-English-letters.
      const words = (t.inText.match(/[\p{L}\p{N}]+/gu) || []).length;
      const wanted = scriptOf(t.inText) === 'latin' && words < 3 ? null : wantedFor(lane, detect(t.code, t.inText));
      if (wanted !== null) decideTurn(lane, s, t, wanted);
    }
  }
  if (c.outputTranscription) t.outText += c.outputTranscription.text || '';
  if (t.allow === null && !els.echo.checked) {
    const echo = isEcho(t);
    if (echo === true) decideTurn(lane, s, t, false);
    else if (echo === false && t.inText) {
      // A real translation happened -> play it, unless it was this earbud's own person speaking.
      decideTurn(lane, s, t, wantedFor(lane, detect(t.code, t.inText)) !== false);
    }
  }
  if (c.outputTranscription && t.allow !== false) {
    t.line = appendText(lane, 'out', c.outputTranscription.text) || t.line;
    if (t.allow === true) markOutput(s);
    if (isLooping(lane, t)) { breakLoop(lane, s, t); return; }
  }
  for (const p of c.modelTurn?.parts || []) {
    const d = p.inlineData?.data;
    if (!d || t.loop) continue;
    if (t.allow === true) { playPcm24(lane, d); markOutput(s); }
    else if (t.allow === null) {
      // Language not known yet: hold the audio briefly instead of playing your own voice back.
      t.pending.push(d);
      if (!t.timer) t.timer = setTimeout(() => decideTurn(lane, s, t, unsureDefault(lane, t)), UNSURE_WAIT_MS);
    }
  }
  if (c.turnComplete) { finishTurn(lane, s); endLine(lane); }
}

// ---------- translators ("lanes") and their Gemini sessions ----------
// Google's docs and the live server have disagreed about where some setup fields go;
// try each known layout and remember the one the server accepts.
const LAYOUTS = [
  (m, t) => ({ model: m, generationConfig: { responseModalities: ['AUDIO'], translationConfig: t }, inputAudioTranscription: {}, outputAudioTranscription: {} }),
  (m, t) => ({ model: m, generationConfig: { responseModalities: ['AUDIO'], inputAudioTranscription: {}, outputAudioTranscription: {}, translationConfig: t } }),
  (m, t) => ({ model: m, generationConfig: { responseModalities: ['AUDIO'] }, translationConfig: t, inputAudioTranscription: {}, outputAudioTranscription: {} }),
  (m, t) => ({ model: m, generationConfig: { responseModalities: ['AUDIO'], translationConfig: t } }),
  (m, t) => ({ model: m, translationConfig: t }),
];
let layoutIdx = clamp(parseInt(store.get('layout', '0'), 10) || 0, 0, LAYOUTS.length - 1);
const isPayloadError = (r) => /invalid json|unknown name|cannot find field|invalid value|payload/i.test(r || '');

let lanes = [];
function laneConfigs() {
  if (prefs.mode === 'duo') {
    // Left ear hears what the RIGHT person speaks (in left's language), and vice versa.
    // Each earbud plays everything EXCEPT its own person's languages (v11).
    const { left: L, right: R } = prefs.ears;
    return [
      { id: 'L', target: L.hear, listen: [], exclude: [...ownBases(L)], channel: 'left' },
      { id: 'R', target: R.hear, listen: [], exclude: [...ownBases(R)], channel: 'right' },
    ];
  }
  return [{ id: 'me', target: prefs.target, listen: [...prefs.listen], channel: 'both' }];
}
function makeLane(cfg) {
  return {
    ...cfg, listenBases: new Set(cfg.listen.map(baseOf)), excludeBases: new Set((cfg.exclude || []).map(baseOf)),
    session: null, buffer: [], nextTime: 0, live: new Set(), curLine: null, recent: [],
    failStreak: 0, loops: 0, everReady: false, reconnecting: false, reconnectTimer: null,
  };
}

function openSession(lane) {
  const s = { ws: null, ready: false, dead: false, tries: 0, hadOutput: false, lastContent: 0, turn: null };
  const key = els.apiKey.value.trim();
  const model = (els.model.value.trim() || DEFAULT_MODEL).replace(/^models\//, '');
  const go = () => {
    const sock = new WebSocket(`${WS_BASE}?key=${encodeURIComponent(key)}`);
    s.ws = sock;
    sock.onopen = () => {
      const translation = { targetLanguageCode: lane.target, echoTargetLanguage: els.echo.checked };
      sock.send(JSON.stringify({ setup: LAYOUTS[layoutIdx](`models/${model}`, translation) }));
    };
    sock.onmessage = async (ev) => {
      if (s.dead || sock !== s.ws) return;
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch { return; }
      if (msg.setupComplete) {
        s.ready = true;
        store.set('layout', String(layoutIdx));
        if (s === lane.session) {
          lane.failStreak = 0; lane.everReady = true; lane.reconnecting = false;
          for (const d of lane.buffer) sendAudio(s, d); // what was said while connecting
          lane.buffer = [];
          updateStatus();
        }
        return;
      }
      if (msg.goAway) { if (s === lane.session) rotate(lane, 'goaway'); return; }
      if (s === lane.session) handleContent(lane, s, msg.serverContent);
    };
    sock.onclose = (ev) => {
      if (s.dead || sock !== s.ws) return;
      if (!s.ready && isPayloadError(ev.reason) && s.tries < LAYOUTS.length - 1) {
        s.tries++;
        layoutIdx = (layoutIdx + 1) % LAYOUTS.length;
        setStatus(`Connecting… (trying setup ${s.tries + 1}/${LAYOUTS.length})`, 'connecting');
        setTimeout(() => { if (!s.dead) go(); }, 150);
        return;
      }
      s.dead = true;
      if (!running || s !== lane.session) return;
      onSessionLost(lane, s, ev);
    };
  };
  go();
  return s;
}
function killSession(s) { if (!s) return; s.dead = true; clearTimeout(s.turn?.timer); try { s.ws && s.ws.close(); } catch {} }

// Swap a lane to a brand-new session (fresh language detection / breaks loops).
// The mic is buffered until the new one is ready, so nothing said is lost.
function rotate(lane, why) {
  const old = lane.session;
  if (old && old.turn) finishTurn(lane, old);
  endLine(lane);
  lane.buffer = [];
  lane.session = openSession(lane);
  lane.rotations = (lane.rotations || 0) + 1;
  setTimeout(() => killSession(old), why === 'loop' ? 0 : 300);
}
function onSessionLost(lane, s, ev) {
  if (!s.ready) {
    lane.failStreak++;
    if (lane.failStreak >= 2 || ev.code === 1007 || ev.code === 1008) { fail(explainClose(ev)); return; }
  }
  endLine(lane);
  lane.reconnecting = true;
  updateStatus();
  clearTimeout(lane.reconnectTimer);
  lane.reconnectTimer = setTimeout(() => { if (running && lane.session === s) lane.session = openSession(lane); }, s.ready ? 200 : 1500);
}
function startLanes() {
  lanes = laneConfigs().map(makeLane);
  for (const lane of lanes) lane.session = openSession(lane);
  updateStatus();
}
function stopLanes() {
  for (const lane of lanes) {
    clearTimeout(lane.reconnectTimer);
    killSession(lane.session);
    stopLanePlayback(lane);
    endLine(lane);
  }
  lanes = [];
}
function resetLanes() {
  if (!running) return;
  stopLanes();
  setStatus('Connecting…', 'connecting');
  startLanes();
}
function explainClose(ev) {
  const r = ev.reason || '';
  if (/api key|API_KEY|permission|unauth|credential/i.test(r)) return 'Google rejected the API key. Check it in Settings.';
  if (/model|not found|not supported/i.test(r)) return 'Model not available: ' + r + ' — check the model name in Settings.';
  if (/quota|exhaust|rate/i.test(r)) return 'Out of free quota for now. Try again later. (' + r + ')';
  return 'Could not connect' + (r ? ': ' + r : ` (code ${ev.code}). Check your internet and API key.`);
}

// Auto-switch: after a pause, give each lane a fresh session so a new speaker's language is
// picked up instead of the session staying locked on the first language it heard.
setInterval(() => {
  if (!running || !els.autoswitch.checked) return;
  const now = performance.now();
  for (const lane of lanes) {
    const s = lane.session;
    if (!s || !s.ready || !s.hadOutput || lanePlaying(lane) || s.turn?.allow === null) continue;
    const quietOut = now - s.lastContent;
    // a) translation finished and the room went quiet, or
    // b) people are talking but this session has produced nothing for a while (stuck)
    if ((quietOut > 1200 && now - lastLoud > 700) || quietOut > 4000) rotate(lane, 'auto');
  }
}, 200);

// ---------- keep the screen awake ----------
let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

// ---------- start / stop ----------
async function start() {
  if (!els.apiKey.value.trim()) { els.keyHint.hidden = false; openSettings(); els.apiKey.focus(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices) {
    fail('The microphone needs HTTPS. Open the app from its https:// link, not a file.');
    return;
  }
  const my = ++runId;
  running = true;
  document.body.classList.add('running');
  els.startLabel.textContent = 'Stop';
  els.controls.classList.remove('open'); els.summary.setAttribute('aria-expanded', 'false');
  setStatus('Starting microphone…', 'connecting');
  closeAudio(); // fresh audio engines every time, created inside the tap so phones allow them
  try {
    playCtx = new AudioContext({ latencyHint: 'playback' });
    merger = playCtx.createChannelMerger(2); // input 0 = left ear, input 1 = right ear
    merger.connect(playCtx.destination);
    captureCtx = new AudioContext();
  } catch (e) { fail('Audio error: ' + e.message); return; }
  try {
    await Promise.all([softResume(playCtx), softResume(captureCtx)]);
    if (my !== runId) return;
    await startMic(my);
    if (my !== runId) return;
  } catch (e) {
    if (my !== runId) return;
    fail(e.name === 'NotAllowedError' ? 'Microphone permission was blocked. Allow it in the browser settings.' :
      e.name === 'NotReadableError' ? 'The microphone is busy (another app or a call is using it). Close it and try again.' :
      'Microphone error: ' + e.message);
    return;
  }
  keepAwake();
  setStatus('Connecting…', 'connecting');
  startLanes();
}
function closeAudio() {
  for (const ctx of [captureCtx, playCtx]) { try { ctx && ctx.close(); } catch {} }
  captureCtx = playCtx = merger = null;
}
function stop(msg) {
  runId++;
  running = false;
  document.body.classList.remove('running');
  els.startLabel.textContent = 'Start';
  stopLanes();
  stopMic();
  closeAudio();
  try { wakeLock && wakeLock.release(); } catch {}
  setLevel(0);
  els.controls.classList.remove('open'); els.summary.setAttribute('aria-expanded', 'false');
  setStatus(msg || 'Stopped', msg ? 'error' : 'idle');
}
function fail(msg) { stop(msg); }

els.start.onclick = () => (running ? stop() : start());
els.apiKey.addEventListener('input', () => { els.keyHint.hidden = true; });
refreshMics();
navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
setStatus(els.apiKey.value ? 'Ready — tap Start' : 'Add your Gemini API key in Settings', 'idle');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
