// app.js — CLUE controller
import { db } from './db.js';
import { parseClue, parseLocal, generateInsights, checkTrigger, hasKey } from './ai.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const EMOJI = { food: '🍽️', symptom: '🩹', activity: '🏃', energy: '🔋', sleep: '😴', note: '📝', other: '📝' };
let insightsCache = null;
let insightsDirty = true;
let selectedPattern = null;
let recog = null, recognizing = false;

// ---------------- navigation ----------------
const views = { talk: 'view-talk', reflect: 'view-reflect', insights: 'view-insight', settings: 'view-settings' };
function show(name) {
  Object.values(views).forEach(id => $('#' + id).classList.remove('active'));
  $('#' + (views[name] || views.talk)).classList.add('active');
  const onTalk = name === 'talk';
  $('#dock').style.display = onTalk ? 'flex' : 'none';
  $('#dockFade').style.display = onTalk ? 'block' : 'none';
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name || (name === 'settings' && false)));
  window.scrollTo(0, 0);
  if (name === 'reflect') renderReflect();
  if (name === 'settings') loadSettings();
}
// "Insights" tab shows the Reflect view (patterns live there); tapping a pattern opens its detail.
$$('.nav button').forEach(b => b.addEventListener('click', () => {
  const n = b.dataset.nav;
  show(n === 'insights' ? 'reflect' : n);
}));
$('#toSettings').addEventListener('click', () => show('settings'));
$('#settingsBack').addEventListener('click', () => show('talk'));
$('#insightBack').addEventListener('click', () => show('reflect'));

// ---------------- timeline ----------------
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const same = d.toDateString() === now.toDateString();
  const yest = new Date(now - 864e5).toDateString() === d.toDateString();
  if (same) return 'Today · ' + fmtTime(iso);
  if (yest) return 'Yesterday · ' + fmtTime(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(iso);
}
function esc(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function renderTimeline() {
  const clues = await db.getClues();
  $('#clueCount').textContent = clues.length ? clues.length + ' total' : '';
  $('#talkDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const host = $('#timeline');
  if (!clues.length) {
    host.innerHTML = `<div class="empty"><div class="big">🔎</div>No clues yet.<br>Tap the mic and tell me anything — what you ate, how you feel, a workout, an ache.<br><br><button class="btn" id="seedBtn" style="max-width:220px;margin:0 auto">Load a few examples</button></div>`;
    $('#seedBtn').addEventListener('click', seedExamples);
    return;
  }
  host.innerHTML = clues.slice(0, 60).map(c => cardHTML(c)).join('');
  $$('#timeline .del').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    await db.deleteClue(btn.dataset.id); insightsDirty = true; renderTimeline();
  }));
}
function cardHTML(c) {
  const type = c.type || 'note';
  const tagLabel = c.subtag ? `${type} · ${c.subtag}` : type;
  const flag = c.flag ? `<div class="flagnote"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><span>${esc(c.flag)}</span></div>` : '';
  return `<div class="clue ${c.flag ? 'flagged' : ''}">
    <div class="ic ${type}">${EMOJI[type] || '📝'}</div>
    <div class="body">
      <div class="txt">${esc(c.text)}</div>
      <div class="meta"><span class="tag ${type}">${esc(tagLabel)}</span>${c.intensity != null ? `<span class="tag other">${c.intensity}/10</span>` : ''}<span class="time">${fmtDayLabel(c.createdAt)}</span></div>
      ${flag}
    </div>
    <button class="del" data-id="${c.id}" aria-label="Delete">×</button>
  </div>`;
}

// ---------------- capture ----------------
function openSheet() {
  $('#scrim').classList.add('open'); $('#sheet').classList.add('open');
  $('#capinput').value = ''; $('#parseBtn').disabled = true; $('#readbackHost').innerHTML = '';
  startRecog();
  setTimeout(() => { if (!recognizing) $('#capinput').focus(); }, 350);
}
function closeSheet() {
  stopRecog();
  $('#scrim').classList.remove('open'); $('#sheet').classList.remove('open');
  $('#readbackHost').innerHTML = '';
}
$('#micBtn').addEventListener('click', openSheet);
$('#scrim').addEventListener('click', closeSheet);
$('#cancelCap').addEventListener('click', closeSheet);
$('#capinput').addEventListener('input', e => { $('#parseBtn').disabled = !e.target.value.trim(); });

function setListen(state, label) {
  const el = $('#listening');
  el.classList.toggle('idle', state !== 'on');
  $('#listenLabel').textContent = label;
}
function startRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setListen('idle', 'Type your clue below'); return; }
  try {
    recog = new SR();
    recog.lang = navigator.language || 'en-US';
    recog.interimResults = true; recog.continuous = false;
    recog.onstart = () => { recognizing = true; setListen('on', 'Listening…'); };
    recog.onresult = (ev) => {
      let txt = '';
      for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      $('#capinput').value = txt;
      $('#parseBtn').disabled = !txt.trim();
    };
    recog.onerror = () => { setListen('idle', 'Type your clue below'); };
    recog.onend = () => { recognizing = false; setListen('idle', $('#capinput').value.trim() ? 'Got it — review & log' : 'Tap mic on your keyboard, or type'); };
    recog.start();
  } catch (e) { setListen('idle', 'Type your clue below'); }
}
function stopRecog() { try { if (recog) recog.stop(); } catch (e) {} recognizing = false; }

$('#parseBtn').addEventListener('click', async () => {
  const text = $('#capinput').value.trim();
  if (!text) return;
  stopRecog();
  const host = $('#readbackHost');
  const usingAI = await hasKey();
  host.innerHTML = `<div class="readback"><div class="rb-head"><span class="spin"></span> ${usingAI ? 'Reading it back…' : 'Sorting it out…'}</div></div>`;
  let parsed;
  try { parsed = await parseClue(text); } catch (e) { parsed = parseLocal(text); }
  renderReadback(text, parsed);
});

function renderReadback(text, p) {
  const host = $('#readbackHost');
  const typeLabel = p.subtag ? `${p.type} · ${p.subtag}` : p.type;
  host.innerHTML = `<div class="readback">
    <div class="rb-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg> Here's what I caught${p.source === 'ai' ? '' : ''}</div>
    <div class="parsed">
      <div class="prow"><span class="k">Type</span><span class="v" style="text-transform:capitalize">${esc(typeLabel)}</span></div>
      <div class="prow"><span class="k">What</span><span class="v">${esc(p.subject)}</span></div>
      ${p.intensity != null ? `<div class="prow"><span class="k">Intensity</span><span class="v">${p.intensity}/10</span></div>` : ''}
      <div class="prow"><span class="k">When</span><span class="v">Just now · ${fmtTime(new Date().toISOString())}</span></div>
    </div>
    ${p.followup ? `<div class="rb-q">${esc(p.followup)}</div>` : ''}
    <div class="cap-actions">
      <button class="btn ghost" id="editCap">Edit</button>
      <button class="btn primary" id="saveCap">Log it ✓</button>
    </div>
  </div>`;
  $('#editCap').addEventListener('click', () => { $('#readbackHost').innerHTML = ''; $('#capinput').focus(); });
  $('#saveCap').addEventListener('click', () => saveClue(text, p));
}

async function saveClue(text, p) {
  const clue = {
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    createdAt: new Date().toISOString(),
    text,
    type: p.type || 'note',
    subject: p.subject || text,
    intensity: p.intensity ?? null,
    status: p.status || 'event',
    subtag: p.subtag || null,
    tags: p.tags || [],
    source: p.source || 'local',
  };
  if (!insightsCache) insightsCache = await db.getInsights();
  const flag = checkTrigger(clue, insightsCache);
  if (flag) clue.flag = flag;
  await db.addClue(clue);
  insightsDirty = true;
  closeSheet();
  renderTimeline();
  toast(flag ? 'Logged — and flagged a possible trigger' : 'Clue logged');
}

// ---------------- reflect ----------------
async function renderReflect() {
  const body = $('#reflectBody');
  const clues = await db.getClues();
  const keyOn = await hasKey();
  if (clues.length < 3) {
    body.innerHTML = `${keyOn ? '' : keyNotice()}<div class="empty"><div class="big">🌱</div>Not enough clues yet to reflect.<br>Log a few more — foods, symptoms, sleep, energy — and your weekly picture will appear here.</div>`;
    return;
  }
  if (insightsDirty || !insightsCache) {
    body.innerHTML = `${keyOn ? '' : keyNotice()}<div class="empty"><div class="big"><span class="spin"></span></div>${keyOn ? 'Thinking about your week…' : 'Finding patterns…'}</div>`;
    const sens = parseInt(await db.getSetting('sensitivity', '1'), 10) || 1;
    insightsCache = await generateInsights(clues, sens);
    await db.saveInsights(insightsCache);
    insightsDirty = false;
  }
  drawReflect(insightsCache, keyOn);
}
function keyNotice() {
  return `<div class="notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg><span>Running on the built-in pattern engine. Add a Claude API key in <a id="noticeSettings">Settings</a> to unlock warmer, smarter insights.</span></div>`;
}
function drawReflect(ins, keyOn) {
  const body = $('#reflectBody');
  const now = new Date();
  const wk = `${new Date(now - 6 * 864e5).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const s = ins.stats || { logged: 0, watched: 0, actionable: 0 };
  let html = keyOn ? '' : keyNotice();
  html += `<div class="reflect-hero">
    <div class="rh-k">${wk} · your body</div>
    <h2>${esc(headline(ins))}</h2>
    <p>${esc(ins.summary || '')}</p>
    <div class="stats">
      <div class="rstat"><div class="n">${s.logged ?? 0}</div><div class="l">clues logged</div></div>
      <div class="rstat"><div class="n">${s.watched ?? (ins.patterns || []).length}</div><div class="l">patterns watched</div></div>
      <div class="rstat"><div class="n">${s.actionable ?? 0}</div><div class="l">worth acting on</div></div>
    </div></div>`;

  if ((ins.patterns || []).length) {
    html += `<div class="section-title">Patterns I'm noticing</div>`;
    ins.patterns.forEach((p, i) => { html += patternCard(p, i); });
  } else {
    html += `<div class="empty">No clear patterns yet — keep logging and I'll surface connections as they build.</div>`;
  }
  if (ins.experiment) {
    html += `<div class="section-title">One small experiment</div>
    <div class="experiment"><div class="e-k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-4.5 7.8A2 2 0 0 0 7.2 20h9.6a2 2 0 0 0 1.7-3.2L14 9V3"/></svg> Give it a try</div><p>${esc(ins.experiment)}</p></div>`;
  }
  html += `<div class="disclaimer">CLUE spots patterns in what you log — it isn't medical advice.</div>`;
  body.innerHTML = html;
  const ns = $('#noticeSettings'); if (ns) ns.addEventListener('click', () => show('settings'));
  $$('#reflectBody .pattern').forEach((el, i) => el.addEventListener('click', () => { selectedPattern = ins.patterns[i]; renderInsight(); show('insights'); }));
}
function headline(ins) {
  const p = (ins.patterns || [])[0];
  if (!p) return 'Building your picture.';
  if (p.confidence >= 0.7) return 'A clear thread worth acting on.';
  if (p.confidence >= 0.45) return 'A calmer week, with one thread to pull.';
  return 'A few early signals to watch.';
}
function confClass(label) { return /likely/i.test(label) ? 'likely' : /watch/i.test(label) ? 'watch' : 'hunch'; }
function confIcon(label) {
  return /likely/i.test(label)
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 1.5"/></svg>';
}
function meter(level) { return `<div class="meter">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= level ? 'on' : ''}"></i>`).join('')}</div>`; }
function patternCard(p, i) {
  return `<div class="pattern">
    <div class="p-top"><div class="conf ${confClass(p.label)}">${confIcon(p.label)} ${esc(p.label)}</div><span class="p-cta">See the evidence ›</span></div>
    <div class="p-link"><span class="a">${esc(p.input)}</span><span class="arw">→</span><span class="b">${esc(p.symptom)}</span></div>
    <div class="p-desc">${esc(p.desc)}</div>
    <div class="p-foot"><span class="p-evi">Based on ${p.matched || (p.evidence ? p.evidence.length : 0)} matched clue${(p.matched || 0) === 1 ? '' : 's'}</span><div style="width:96px">${meter(p.level)}</div></div>
  </div>`;
}

// ---------------- insight detail ----------------
function renderInsight() {
  const p = selectedPattern; if (!p) { show('reflect'); return; }
  const body = $('#insightBody');
  body.innerHTML = `
    <div class="hero-pattern">
      <div class="link-lg"><span class="a">${esc(p.input)}</span><span class="arw">→</span><span class="b">${esc(p.symptom)}</span></div>
      <div class="conf-block">
        <div class="cb-top"><span class="cb-l">Confidence</span><span class="cb-v">${confIcon(p.label)} ${esc(p.label)}${p.matched ? ` (${p.matched} of ${p.evidence ? p.evidence.length : p.matched})` : ''}</span></div>
        ${meter(p.level)}
        <div class="cb-note">${p.confidence >= 0.7 ? 'Strong enough to act on, not proven. I’m treating this as a working theory and still watching for exceptions.' : 'An early pattern — worth noticing, not conclusive. I’ll keep matching new clues before I lean on it.'}</div>
      </div>
    </div>
    <div class="card-lite">
      <h3>THE EVIDENCE · RECENT ${esc((p.symptom || '').toUpperCase())}</h3>
      <div class="legend"><div class="li"><span class="sw" style="background:var(--plum)"></span>${esc(p.input)}</div><div class="li"><span class="sw" style="background:#c96b5c"></span>${esc(p.symptom)}</div></div>
      ${evidenceRows(p)}
      <div class="evi-axis"><span>trigger</span><span>~18h</span><span>~36h</span></div>
      <p style="font-size:12.5px;color:var(--ink-2);line-height:1.5;margin-top:14px">${esc(evidenceNote(p))}</p>
    </div>
    <div class="reco"><div class="r-k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/><path d="M9 21h6M10 17v4M14 17v4"/></svg> What I'd suggest</div><p>${esc(p.recommendation || '')}</p></div>
    <div class="toggle-row"><div><div class="tr-l">Flag ${esc((p.input || '').toLowerCase())} when I log it</div><div class="tr-s">I'll warn you in the moment — discreetly.</div></div><button class="switch ${p.flagOn ? '' : 'off'}" id="flagSwitch"><div class="knob"></div></button></div>
    <div class="disclaimer">CLUE spots patterns in what you log — it isn't medical advice. For anything that worries you, check with a clinician.</div>`;
  $('#flagSwitch').addEventListener('click', e => e.currentTarget.classList.toggle('off'));
}
function evidenceRows(p) {
  const evi = (p.evidence || []).slice(0, 6);
  if (!evi.length) return `<div style="font-size:13px;color:var(--muted)">Evidence will fill in as more ${esc((p.symptom || '').toLowerCase())} clues are logged.</div>`;
  return evi.map(e => {
    const matched = e.matched !== false && (e.lagHours != null);
    const lag = e.lagHours != null ? Math.max(0, Math.min(36, e.lagHours)) : null;
    const inX = 16, symX = matched ? 16 + (lag / 36) * 66 : 40;
    const conn = matched ? `<div class="connect" style="left:${inX}%;width:${symX - inX}%"></div>` : '';
    const inMk = matched ? `<div class="mk" style="left:${inX}%;background:var(--plum)"></div>` : '';
    const symMk = `<div class="mk" style="left:${symX}%;background:#c96b5c"></div>`;
    return `<div class="evi-row"><div class="day">${esc(e.date || '')}</div><div class="track"><div class="grid"></div>${conn}${inMk}${symMk}</div></div>`;
  }).join('');
}
function evidenceNote(p) {
  const evi = p.evidence || [];
  const miss = evi.filter(e => e.matched === false || e.lagHours == null).length;
  const base = `${p.matched || 0} of your recent ${(p.symptom || '').toLowerCase()} trailed ${(p.input || '').toLowerCase()} ${p.windowText || 'within about a day'}.`;
  return miss ? base + ` ${miss} had no ${(p.input || '').toLowerCase()} before — the honest exceptions I'm keeping an eye on.` : base;
}

// ---------------- settings ----------------
async function loadSettings() {
  $('#apiKey').value = (await db.getSetting('apiKey')) || '';
  $('#model').value = (await db.getSetting('model')) || '';
  const sens = parseInt(await db.getSetting('sensitivity', '1'), 10) || 1;
  $('#sensitivity').value = sens; updateSensLabel(sens);
  await refreshKeyStatus();
  const clues = await db.getClues();
  $('#dataStats').textContent = `${clues.length} clue${clues.length === 1 ? '' : 's'} stored privately on this device.`;
}
async function refreshKeyStatus() {
  const on = await hasKey();
  $('#keyStatus').innerHTML = on
    ? `<span class="status-pill ok">✓ AI insights on</span>`
    : `<span class="status-pill no">Using built-in engine</span>`;
}
function updateSensLabel(v) { $('#sensLabel').textContent = ['Cautious', 'Balanced', 'Eager'][v] || 'Balanced'; }
let keyTimer;
$('#apiKey').addEventListener('input', e => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(async () => {
    const v = e.target.value.trim();
    await db.setSetting('apiKey', v);
    insightsDirty = true; insightsCache = null;
    await refreshKeyStatus();
  }, 500);
});
$('#model').addEventListener('input', e => { clearTimeout(keyTimer); keyTimer = setTimeout(() => db.setSetting('model', e.target.value.trim()), 500); });
$('#sensitivity').addEventListener('input', async e => {
  const v = parseInt(e.target.value, 10);
  updateSensLabel(v); await db.setSetting('sensitivity', String(v)); insightsDirty = true;
});
$('#exportBtn').addEventListener('click', async () => {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clue-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('Backup downloaded');
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = await db.importAll(data);
    insightsDirty = true; insightsCache = null;
    toast(`Imported ${n} clues`); renderTimeline(); loadSettings();
  } catch (err) { toast('Could not read that backup'); }
  e.target.value = '';
});
$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL your clues and insights from this device? This cannot be undone.')) return;
  await db.clearClues(); await db.clearInsights();
  insightsCache = null; insightsDirty = true;
  renderTimeline(); loadSettings(); toast('All data deleted');
});
$('#refreshInsights').addEventListener('click', () => { insightsDirty = true; renderReflect(); });

// ---------------- examples ----------------
async function seedExamples() {
  const now = Date.now();
  const H = 3600000;
  const ex = [
    ['Iced latte with regular milk and a croissant', 'food', 'dairy', null, now - 4 * H],
    ['Small breakout on my chin this morning', 'symptom', 'breakout', null, now - 2 * H],
    ['Energy feels low and foggy today', 'energy', 'low', 3, now - 2.5 * H],
    ['Slept badly, woke up at 3am', 'sleep', 'poor', null, now - 8 * H],
    ['Had cheese and crackers last night', 'food', 'dairy', null, now - 30 * H],
    ['Another breakout, cheek this time', 'symptom', 'breakout', null, now - 6 * H],
    ['Skipped my run, no motivation', 'activity', 'skipped', null, now - 26 * H],
    ['Yogurt bowl for breakfast', 'food', 'dairy', null, now - 52 * H],
    ['Skin flared up again', 'symptom', 'breakout', null, now - 30 * H],
    ['Left ankle a little sore, maybe 4/10', 'symptom', 'ankle', 4, now - 27 * H],
    ['Slept only 5 hours', 'sleep', 'poor', null, now - 32 * H],
    ['Really low energy, couldn’t focus', 'energy', 'low', 2, now - 31 * H],
  ];
  for (const [text, type, subtag, intensity, ts] of ex) {
    await db.addClue({ id: 'c_' + ts + Math.random().toString(36).slice(2, 6), createdAt: new Date(ts).toISOString(), text, type, subtag, intensity, status: 'event', tags: [], source: 'example' });
  }
  insightsDirty = true; insightsCache = null;
  renderTimeline(); toast('Added example clues — check Reflect');
}

// ---------------- misc ----------------
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }

// service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// init
(async function init() {
  await loadSettings();
  await renderTimeline();
  insightsCache = await db.getInsights();
  show('talk');
})();
