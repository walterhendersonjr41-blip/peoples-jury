// People's Jury — two sides, the public decides. Static app; shared data lives on free public Nostr relays (no sign-up).
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool, bytesToHex, hexToBytes } from './nostr.bundle.js';

const Q = new URLSearchParams(location.search);
const NS = Q.get('ns') === 'test' ? 'pjtest' : 'pjury1';          // test namespace keeps test data out of the public feed
const DEMO = Q.get('demo') === '1';
const KIND = 30078;
const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub', 'wss://relay.snort.social'];
const APP_URL = location.origin + location.pathname;
const T = s => NS + '-' + s;                                       // tag helper
const now = () => Math.floor(Date.now() / 1000);
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = n => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => a[x % a.length]).join(''); };
async function sha(s) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }

/* ---------------- device identity (one vote per device) ---------------- */
function getCookie(n) { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; }
function idb(op, val) {
  return new Promise(res => {
    try {
      const r = indexedDB.open('pjury', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { try { const tx = r.result.transaction('kv', op ? 'readwrite' : 'readonly'); const st = tx.objectStore('kv');
        if (op) { st.put(val, 'sk'); tx.oncomplete = () => res(val); } else { const g = st.get('sk'); g.onsuccess = () => res(g.result || ''); g.onerror = () => res(''); } } catch (e) { res(''); } };
      r.onerror = () => res('');
    } catch (e) { res(''); }
  });
}
let SK, PK;
async function loadKey() {
  const k = NS + '-sk';
  let hex = localStorage.getItem(k) || getCookie(k) || await idb(0);
  if (!/^[0-9a-f]{64}$/.test(hex || '')) hex = bytesToHex(generateSecretKey());
  localStorage.setItem(k, hex); document.cookie = k + '=' + hex + ';max-age=63072000;path=/;SameSite=Lax'; idb(1, hex);
  SK = hexToBytes(hex); PK = getPublicKey(SK);
}
let FP = '', IPH = '';
async function fingerprint() {
  if (Q.get('ns') === 'test' && Q.get('testfp')) return Q.get('testfp');
  const parts = [navigator.userAgent, navigator.language, (navigator.languages || []).join(','), screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
    devicePixelRatio, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.deviceMemory, navigator.platform, navigator.maxTouchPoints];
  try { const c = document.createElement('canvas'); c.width = 240; c.height = 60; const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20); x.fillStyle = '#069'; x.fillText("People's Jury ⚖️ 1.0", 2, 15);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText("People's Jury ⚖️ 1.0", 4, 17); parts.push(c.toDataURL()); } catch (e) {}
  try { const g = document.createElement('canvas').getContext('webgl'); const d = g.getExtension('WEBGL_debug_renderer_info');
    parts.push(g.getParameter(d.UNMASKED_RENDERER_WEBGL), g.getParameter(d.UNMASKED_VENDOR_WEBGL)); } catch (e) {}
  return (await sha(parts.join('|'))).slice(0, 16);
}
async function ipHash() {
  try { const c = new AbortController(); setTimeout(() => c.abort(), 4000);
    const j = await (await fetch('https://api.ipify.org?format=json', { signal: c.signal })).json();
    const ip = String(j.ip || ''); const net = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.');
    return (await sha('pj|' + net)).slice(0, 6);                     // short hash of the network block (/24): never the IP itself
  } catch (e) { return ''; }
}

/* ---------------- storage layer (pluggable) ---------------- */
function parse(e) { try { e.data = JSON.parse(e.content); } catch (x) { e.data = {}; } e.d = (e.tags.find(t => t[0] === 'd') || [])[1] || ''; return e; }
function dedupe(evs) {
  const byId = new Map(); evs.forEach(e => byId.set(e.id, e));
  const latest = new Map();
  for (const e of byId.values()) { const k = e.pubkey + '|' + e.d; const o = latest.get(k); if (!o || e.created_at > o.created_at) latest.set(k, e); }
  return [...latest.values()];
}
function sign(d, tags, content) {
  return finalizeEvent({ kind: KIND, created_at: now(), tags: [['d', d], ...tags.map(t => ['t', t])], content: JSON.stringify(content) }, SK);
}
const NostrStore = {
  name: 'live', pool: null,
  init() { this.pool = new SimplePool(); },
  async put(d, tags, content) {
    const ev = sign(d, tags, content);
    const rs = await Promise.allSettled(this.pool.publish(RELAYS, ev).map(p => Promise.race([p, sleep(9000).then(() => { throw new Error('timeout'); })])));
    const ok = rs.filter(r => r.status === 'fulfilled').length;
    if (!ok) throw new Error('Could not reach the jury servers. Check your internet and try again.');
    return parse(ev);
  },
  async query(tags, limit) {
    const evs = await this.pool.querySync(RELAYS, { kinds: [KIND], '#t': tags, limit: limit || 500 }, { maxWait: 4500 });
    return dedupe(evs.map(parse));
  }
};
const LocalStore = {                                                 // demo mode: everything stays on this device
  name: 'demo', key: 'pj-demo-events',
  init() {}, all() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } },
  async put(d, tags, content) { const ev = sign(d, tags, content); const a = this.all(); a.push(ev); localStorage.setItem(this.key, JSON.stringify(a)); return parse(ev); },
  async query(tags, limit) { return dedupe(this.all().filter(e => e.tags.some(t => t[0] === 't' && tags.includes(t[1]))).map(parse)).slice(-(limit || 500)); }
};
const Store = DEMO ? LocalStore : NostrStore;

/* ---------------- free AI (Pollinations, no key) ---------------- */
function clean(t) {
  t = String(t || '').split(/\n\s*(?:---+|\*\*Sponsor|🌸)/)[0];
  return t.split('\n').filter(l => !/pollinations\.ai/i.test(l)).join(' ').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>~|]+/g, '').replace(/\s+/g, ' ').trim();
}
async function askAI(system, user) {
  if (Q.get('noai') === '1') return '';
  const body = { model: 'openai', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], private: true, referrer: 'peoples-jury' };
  try {
    const c = new AbortController(); const to = setTimeout(() => c.abort(), 25000);
    const r = await fetch('https://text.pollinations.ai/openai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal });
    clearTimeout(to);
    if (r.ok) { const d = await r.json(); const t = clean(d?.choices?.[0]?.message?.content); if (t) return t; }
  } catch (e) {}
  try {
    const c = new AbortController(); const to = setTimeout(() => c.abort(), 25000);
    const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(user.slice(0, 1500)) + '?model=openai&private=true&referrer=peoples-jury&system=' + encodeURIComponent(system), { signal: c.signal });
    clearTimeout(to);
    if (r.ok) { const t = (await r.text()).trim(); if (t && t[0] !== '{') return clean(t); }
  } catch (e) {}
  return '';
}
const SUM_SYS = "You are a fair, neutral court clerk for a lighthearted public voting app. Summarize BOTH sides of a friendly dispute in 3 short plain-English sentences: one for each person's main point and one stating the question the jury must decide. Never take a side, never judge, no legal advice, no names other than the first names given. Plain text only.";
const VER_SYS = "You announce the result of a lighthearted public vote on a friendly dispute. Write ONE short, warm, playful sentence (max 30 words) announcing who the jury sided with and the vote count. Be kind to the side that lost. Do not add your own opinion. Plain text only.";
function summaryPrompt(c) { return `Dispute: "${c.title}"\n\n${c.nameA}'s side: ${c.sideA}\n\n${c.nameB}'s side: ${c.sideB}`; }

/* ---------------- safety checks ---------------- */
const PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const ADDR = /\b\d{1,6}\s+(?:[A-Za-z]+\s){1,4}(?:st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|way|hwy|highway|pkwy|parkway|pl|place|cir|circle|ter|terrace)\b/i;
const CRIME = /\b(rape|raped|murder|murdered|assault|assaulted|molest\w*|abuse[ds]?|lawsuit|sued|suing|arrest(ed)?|police report|restraining order|stabbed|shot (him|her|me)|overdose|custody)\b/i;
function checkText(t) {
  if (PHONE.test(t)) return 'Please remove phone numbers.';
  if (EMAIL.test(t)) return 'Please remove email addresses.';
  if (ADDR.test(t)) return 'Please remove street addresses.';
  if (CRIME.test(t)) return "Real crimes and legal matters aren't allowed here. This is for friendly, everyday disagreements.";
  return '';
}
function checkName(n) { return /^[A-Za-z][A-Za-z'\-]{0,19}$/.test(n) ? '' : 'Use a first name only (one word, letters).'; }

/* ---------------- case model ---------------- */
async function loadCase(id) {
  const evs = await Store.query([T('c-' + id)], 5000);
  return buildCase(id, evs);
}
async function buildCase(id, evs) {
  const caseEv = evs.filter(e => e.data.type === 'case' && e.data.id === id && e.d === 'pj:case:' + id).sort((a, b) => a.created_at - b.created_at)[0];
  if (!caseEv) return null;
  const a = caseEv.data;
  const c = { id, title: a.title, nameA: a.nameA, sideA: a.sideA, deadline: 0, dlSecs: +a.dlSecs || 0, created: caseEv.created_at, pkA: caseEv.pubkey,
    fpA: a.fp + '|' + a.ip, audioA: !!a.audio, secretHash: a.secretHash };
  const bs = evs.filter(e => e.data.type === 'b' && e.data.id === id && e.pubkey !== c.pkA).sort((x, y) => x.created_at - y.created_at);
  for (const e of bs) { if (e.data.secret && await sha(e.data.secret) === c.secretHash) { Object.assign(c, { nameB: e.data.nameB, sideB: e.data.sideB, pkB: e.pubkey, fpB: e.data.fp + '|' + e.data.ip, audioB: !!e.data.audio, summary: e.data.summary || '', opened: e.created_at }); break; } }
  c.ready = !!c.pkB;
  if (c.ready && c.dlSecs > 0) c.deadline = c.opened + c.dlSecs;     // the voting clock starts once both sides are in
  const party = pk => pk === c.pkA || pk === c.pkB;
  const sum = evs.filter(e => e.data.type === 'sum' && party(e.pubkey) && e.data.text).sort((x, y) => x.created_at - y.created_at)[0];
  if (!c.summary && sum) c.summary = sum.data.text;
  const ver = evs.filter(e => e.data.type === 'verdict' && party(e.pubkey) && e.data.text).sort((x, y) => x.created_at - y.created_at)[0];
  c.verdictLine = ver ? ver.data.text : '';
  // reports
  const rep = new Set(evs.filter(e => e.data.type === 'report').map(e => e.pubkey));
  c.reports = rep.size; c.hidden = rep.size >= 3;
  // votes: one per device key, then collapse same fingerprint+network, and never count the two parties
  const partyFp = new Set([c.fpA, c.fpB].filter(x => x && x !== '|'));
  const votes = evs.filter(e => e.data.type === 'vote' && e.d === 'pj:vote:' + id && (e.data.choice === 1 || e.data.choice === 2)
    && !party(e.pubkey) && !partyFp.has(e.data.fp + '|' + e.data.ip) && (!c.deadline || e.created_at <= c.deadline + 60))
    .sort((x, y) => x.created_at - y.created_at);
  const seen = new Set(); c.v1 = 0; c.v2 = 0; c.myVote = 0;
  for (const v of votes) {
    const k = v.data.fp ? v.data.fp + '|' + v.data.ip : v.pubkey;
    if (seen.has(k)) continue; seen.add(k);
    v.data.choice === 1 ? c.v1++ : c.v2++;
  }
  const mine = evs.find(e => e.data.type === 'vote' && e.pubkey === PK && e.d === 'pj:vote:' + id);
  const fpMatch = votes.find(e => FP && e.data.fp === FP && e.data.ip === IPH);
  c.myVote = mine ? mine.data.choice : fpMatch ? fpMatch.data.choice : (+localStorage.getItem(NS + '-voted-' + id) || 0);
  c.iAmParty = party(PK) || partyFp.has(FP + '|' + IPH) || !!localStorage.getItem(NS + '-mine-' + id);
  c.closed = !!(c.deadline && now() > c.deadline);
  c.total = c.v1 + c.v2;
  return c;
}

/* ---------------- audio (stored in small chunks) ---------------- */
const CHUNK = 40000;
function blobToB64(b) { return new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1]); f.readAsDataURL(b); }); }
async function saveAudio(id, side, rec) {
  if (!rec) return false;
  const b64 = await blobToB64(rec.blob);
  if (b64.length > 4 * CHUNK) return false;
  const n = Math.ceil(b64.length / CHUNK);
  for (let i = 0; i < n; i++) await Store.put(`pj:audio:${id}:${side}:${i}`, [T('a-' + id)], { type: 'audio', id, side, n: i, total: n, mime: rec.mime, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
  return true;
}
async function playAudio(c, side, btn) {
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const pk = side === 'A' ? c.pkA : c.pkB;
    const evs = (await Store.query([T('a-' + c.id)], 50)).filter(e => e.pubkey === pk && e.data.side === side).sort((x, y) => x.data.n - y.data.n);
    if (!evs.length || evs.length !== evs[0].data.total) throw new Error('missing');
    const bin = atob(evs.map(e => e.data.data).join(''));
    const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const audio = new Audio(URL.createObjectURL(new Blob([u8], { type: evs[0].data.mime })));
    await audio.play(); btn.textContent = '🔊 Playing…'; audio.onended = () => { btn.textContent = '▶ Play recording'; btn.disabled = false; };
  } catch (e) { btn.textContent = 'Recording not available'; }
}

/* ---------------- recorder widget ---------------- */
function recorderWidget(textarea, holder) {
  const state = { rec: null };
  if (!navigator.mediaDevices || !window.MediaRecorder) return state;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  holder.innerHTML = `<button type="button" class="btn light" id="recbtn">🎙️ Record my side (up to 1 minute)</button><div class="muted small" id="recnote">${SR ? 'Your words are typed in for you as you talk. You can fix them after.' : 'Your recording is saved with your side.'}</div><div id="recplay"></div>`;
  const btn = holder.querySelector('#recbtn'); const note = holder.querySelector('#recnote');
  let mr, chunks = [], stream, sr, timer, startText = '';
  btn.onclick = async () => {
    if (mr && mr.state === 'recording') { mr.stop(); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { note.textContent = 'Microphone not allowed. You can type your side instead.'; return; }
    let mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 12000 } : { audioBitsPerSecond: 12000 });
    chunks = []; mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); try { sr && sr.stop(); } catch (e) {}
      const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
      state.rec = { blob, mime: blob.type };
      btn.textContent = '🎙️ Record again'; btn.classList.remove('rec');
      holder.querySelector('#recplay').innerHTML = `<audio controls src="${URL.createObjectURL(blob)}" style="width:100%;margin-top:8px"></audio>`;
      note.textContent = blob.size > 110000 ? 'That recording is long, so only the typed words will be saved.' : 'Recording saved. It will be posted with your side.';
    };
    mr.start(1000); btn.textContent = '⏹ Stop recording'; btn.classList.add('rec');
    timer = setTimeout(() => mr.state === 'recording' && mr.stop(), 60000);
    if (SR) { try { sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = navigator.language || 'en-US';
      startText = textarea.value ? textarea.value.trim() + ' ' : '';
      sr.onresult = ev => { let t = ''; for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; textarea.value = startText + t; };
      sr.start(); } catch (e) {} }
  };
  return state;
}

/* ---------------- share helpers ---------------- */
function shareBlock(url, text, label) {
  const enc = encodeURIComponent;
  const smsSep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? '&' : '?';
  return `<div class="share">
    ${navigator.share ? `<button class="btn" data-share>📤 ${esc(label || 'Share')}</button>` : ''}
    <div class="row"><a class="btn light" href="sms:${smsSep}body=${enc(text + ' ' + url)}">💬 Text</a>
    <a class="btn light" href="mailto:?subject=${enc("People's Jury")}&body=${enc(text + '\n\n' + url)}">✉️ Email</a></div>
    <button class="btn light" data-copy>🔗 Copy link</button>
    <div class="linkbox">${esc(url)}</div></div>`;
}
function wireShare(root, url, text) {
  root.querySelectorAll('[data-share]').forEach(b => b.onclick = () => navigator.share({ title: "People's Jury", text, url }).catch(() => {}));
  root.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(url); } catch (e) { const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); } b.textContent = '✅ Link copied'; setTimeout(() => b.textContent = '🔗 Copy link', 2500); });
}
const caseUrl = id => APP_URL + (location.search || '') + '#/c/' + id;
const inviteUrl = (id, secret) => APP_URL + (location.search || '') + '#/c/' + id + '/' + secret;

/* ---------------- views ---------------- */
const RULES = `<ul class="rules">
<li>First names only. No last names, addresses, phone numbers, or emails.</li>
<li>Friendly, everyday disagreements only. No real crimes, legal matters, or anything hurtful.</li>
<li>Both people agree their sides will be public.</li>
<li>One vote per device. The two people in a case can't vote on it.</li>
<li>Verdicts are for fun, not a legal ruling.</li></ul>`;
const DISCLAIMER = `<div class="disclaimer">⚖️ For fun, not a legal ruling.</div>`;
function banner() { return DEMO ? `<div class="notice warn">Demo mode: cases are saved on this device only.</div>` : ''; }
function timeLeft(c) {
  if (!c.deadline) return 'Voting stays open';
  const s = c.deadline - now(); if (s <= 0) return 'Voting closed';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return 'Voting closes in ' + (h >= 48 ? Math.round(h / 24) + ' days' : h >= 1 ? h + 'h ' + m + 'm' : Math.max(1, m) + ' min');
}

let HOME = { tab: 'hot', cases: [] };
async function viewHome() {
  app.innerHTML = `${banner()}<section class="hero card">
    <div class="logo-big">${LOGO}</div>
    <h1>Got a disagreement?<br>Let the people decide.</h1>
    <p class="muted">Two people tell their side. Everyone votes.</p>
    <a class="btn big" href="#/new">Start a case</a></section>
    <div class="tabs" role="tablist"><button data-tab="hot">🔥 Hottest</button><button data-tab="new">🆕 Newest</button><button data-tab="verdicts">⚖️ Verdicts</button></div>
    <div id="feed"><div class="card center muted">Finding cases…</div></div>
    <a class="btn light" href="#/rules">How it works</a>`;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { HOME.tab = b.dataset.tab; drawFeed(); });
  drawTabs();
  await refreshFeed(); drawFeed();
  clearInterval(window.__pjHome);
  window.__pjHome = setInterval(async () => { if (location.hash && location.hash !== '#/') return clearInterval(window.__pjHome); await refreshFeed(); drawFeed(true); }, 15000);
}
async function refreshFeed() {
  try {
    const bs = await Store.query([T('b')], 120);
    const ids = [...new Set(bs.map(e => e.data.id).filter(x => /^[a-z0-9]{6,16}$/.test(x || '')))].slice(0, 60);
    if (!ids.length) { HOME.cases = []; HOME.err = ''; return; }
    const evs = await Store.query(ids.map(i => T('c-' + i)), 5000);
    HOME.cases = (await Promise.all(ids.map(i => buildCase(i, evs.filter(e => e.tags.some(t => t[1] === T('c-' + i))))))).filter(c => c && c.ready && !c.hidden);
    HOME.err = '';
  } catch (e) { HOME.err = "Couldn't load cases. Check your internet and refresh."; }
}
function drawTabs() { app.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === HOME.tab)); }
function drawFeed(quiet) {
  const feed = $('#feed'); if (!feed) return; drawTabs();
  if (HOME.err) { feed.innerHTML = `<div class="card center muted">${HOME.err}</div>`; return; }
  const open = HOME.cases.filter(c => !c.closed), closed = HOME.cases.filter(c => c.closed);
  let list;
  if (HOME.tab === 'verdicts') list = closed.sort((a, b) => b.deadline - a.deadline);
  else if (HOME.tab === 'new') list = open.sort((a, b) => b.opened - a.opened);
  else list = open.sort((a, b) => (b.total - a.total) || (b.opened - a.opened));
  if (!list.length) { feed.innerHTML = `<div class="card center"><h2>${HOME.tab === 'verdicts' ? 'No verdicts yet' : 'No open cases yet'}</h2><p class="muted">Be the first. Start a case and send the link to the other person.</p></div>`; return; }
  const short = t => { t = String(t || ''); return t.length > 150 ? t.slice(0, 147).replace(/\s+\S*$/, '') + '…' : t; };
  feed.innerHTML = list.map((c, i) => {
    const lead = c.v1 === c.v2 ? '' : c.v1 > c.v2 ? c.nameA : c.nameB;
    return `<div class="card feeditem ${!quiet ? 'rise' : ''}" style="animation-delay:${Math.min(i, 8) * 50}ms">
      ${HOME.tab === 'hot' && i === 0 ? '<div class="kicker">⭐ Case of the day</div>' : ''}
      ${HOME.tab === 'verdicts' ? `<div class="kicker">${c.total ? (lead ? '🏆 ' + esc(lead) + ' wins' : "🤝 Tie") : 'No votes'}</div>` : ''}
      <a class="t" href="#/c/${c.id}">${esc(c.title)}</a><div class="muted">${esc(c.nameA)} vs. ${esc(c.nameB)}</div>
      <p class="sum">${esc(short(c.summary || (c.nameA + ': ' + c.sideA)))}</p>
      <div class="tally small"><span>1 · ${esc(c.nameA)} <b>${c.v1}</b></span><span><b>${c.v2}</b> ${esc(c.nameB)} · 2</span></div>
      ${miniBar(c)}
      <div class="meta"><span class="pill">${c.total} vote${c.total === 1 ? '' : 's'}</span><span class="pill">${esc(timeLeft(c))}</span></div>
      ${!c.closed && !c.myVote && !c.iAmParty ? `<div class="row"><button class="btn vote a sm" data-fv="1" data-id="${c.id}"><b>1</b>${esc(c.nameA)}</button><button class="btn vote b sm" data-fv="2" data-id="${c.id}"><b>2</b>${esc(c.nameB)}</button></div>
        <a class="btn light" href="#/c/${c.id}">Read both sides</a>` :
      `<a class="btn ${c.closed ? '' : 'light'}" href="#/c/${c.id}">${c.closed ? 'See the verdict' : c.myVote ? '✅ You voted · See case' : 'Your case · See votes'}</a>`}</div>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => feed.querySelectorAll('.mini [data-w]').forEach(d => d.style.width = d.dataset.w)));
  feed.querySelectorAll('[data-fv]').forEach(b => b.onclick = async () => {
    const c = HOME.cases.find(x => x.id === b.dataset.id); if (!c) return;
    b.parentElement.querySelectorAll('button').forEach(x => x.disabled = true);
    try { await postVote(c, +b.dataset.fv); drawFeed(true); } catch (e) { alert(e.message); b.parentElement.querySelectorAll('button').forEach(x => x.disabled = false); }
  });
}
function miniBar(c) {
  const pa = c.total ? Math.round(c.v1 / c.total * 100) : 50;
  return `<div class="bar mini"><div class="ba" data-w="${pa}%" style="width:50%"></div><div class="bb" data-w="${100 - pa}%" style="width:50%"></div></div>`;
}

function viewRules() {
  app.innerHTML = `<div class="card"><h1>How it works</h1>
  <ol class="steps"><li><b>Start a case.</b> Type or record your side.</li><li><b>Send the private link</b> to the other person. They add their side.</li>
  <li><b>The case goes public</b> with a fair summary of both sides.</li><li><b>Everyone votes</b> 1 or 2. When time is up, the jury's verdict is in.</li></ol>
  <h2>Rules</h2>${RULES}${DISCLAIMER}<a class="btn" href="#/new">Start a case</a></div>`;
}

function sideForm(who) {
  return `<label for="name">Your first name</label><input type="text" id="name" maxlength="20" autocomplete="given-name" placeholder="First name only">
  <label for="side">${who}</label><div id="recholder"></div><textarea id="side" maxlength="1200" placeholder="Tell it in your own words. Keep it friendly."></textarea>
  <label class="check"><input type="checkbox" id="agree"> <span>I agree my side will be public, I used first names only, and this is not a real crime or legal matter. For fun, not a legal ruling.</span></label>
  <div id="err" class="notice warn hidden"></div>`;
}
function showErr(m) { const e = $('#err'); e.textContent = m; e.classList.remove('hidden'); e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

function viewNew() {
  app.innerHTML = `${banner()}<div class="card"><h1>Start a case</h1>
  <label for="title">What's it about?</label><input type="text" id="title" maxlength="80" placeholder="Example: Who ate the last slice of pizza?">
  ${sideForm('Your side of the story')}
  <label for="dl">Voting time</label><select id="dl"><option value="3600">1 hour</option><option value="86400" selected>1 day</option><option value="259200">3 days</option><option value="604800">1 week</option><option value="0">No time limit</option>${NS === 'pjtest' ? '<option value="45">45 seconds (test)</option>' : ''}</select>
  <button class="btn big" id="go">Create case</button></div>`;
  const rec = recorderWidget($('#side'), $('#recholder'));
  $('#go').onclick = async () => {
    const title = $('#title').value.trim(), nameA = $('#name').value.trim(), sideA = $('#side').value.trim();
    if (title.length < 4) return showErr('Please add a short title.');
    let m = checkName(nameA) || checkText(title) || checkText(sideA); if (m) return showErr(m);
    if (sideA.length < 10 && !rec.rec) return showErr('Please tell your side (type it or record it).');
    if (!$('#agree').checked) return showErr('Please check the box to agree to the rules.');
    const b = $('#go'); b.disabled = true; b.textContent = 'Creating…';
    try {
      const id = rid(10), secret = rid(16), dl = +$('#dl').value;
      const audio = rec.rec ? await saveAudio(id, 'A', rec.rec) : false;
      await Store.put('pj:case:' + id, [NS, T('case'), T('c-' + id)], { type: 'case', v: 1, id, title, nameA, sideA: sideA || '(recorded side)', deadline: 0, dlSecs: dl,
        secretHash: await sha(secret), fp: FP, ip: IPH, audio });
      localStorage.setItem(NS + '-mine-' + id, secret);
      location.hash = '#/sent/' + id;
    } catch (e) { b.disabled = false; b.textContent = 'Create case'; showErr(e.message); }
  };
}

function viewSent(id) {
  const secret = localStorage.getItem(NS + '-mine-' + id);
  if (!secret) { location.hash = '#/c/' + id; return; }
  const url = inviteUrl(id, secret);
  app.innerHTML = `<div class="card pop"><div class="check-big">✅</div><h1>Your case is started!</h1>
  <p>Now send this <b>private link</b> to the other person so they can tell their side. The case goes public for voting once both sides are in.</p>
  ${shareBlock(url, "I started a case on People's Jury. Tell your side here:", 'Send the link')}
  <a class="btn light" href="#/c/${id}">See my case</a></div>`;
  wireShare(app, url, "I started a case on People's Jury. Tell your side here:");
}

async function viewCase(id, secret) {
  app.innerHTML = `<div class="card center muted">Opening case…</div>`;
  let c;
  try { c = await loadCase(id); } catch (e) { c = undefined; }
  if (c === undefined) { app.innerHTML = `<div class="card center">Couldn't load this case. Check your internet and refresh.</div>`; return; }
  if (!c) { app.innerHTML = `<div class="card center"><h2>Case not found</h2><p class="muted">It may still be on its way. Wait a moment and refresh.</p><a class="btn" href="#/">Home</a></div>`; return; }
  if (!c.ready) {
    const mySecret = localStorage.getItem(NS + '-mine-' + id);
    if (secret && await sha(secret) === c.secretHash && c.pkA !== PK && !mySecret) return viewSideB(c, secret);
    if (mySecret) { app.innerHTML = `<div class="card"><h1>${esc(c.title)}</h1><p>Waiting for the other person to add their side. Send them the private link again:</p>${shareBlock(inviteUrl(id, mySecret), "Tell your side of our case on People's Jury:", 'Send the link')}</div>`; wireShare(app, inviteUrl(id, mySecret), "Tell your side of our case on People's Jury:"); return; }
    app.innerHTML = `<div class="card center"><h2>This case isn't open yet</h2><p class="muted">It opens for voting once both people have told their side.</p><a class="btn" href="#/">See open cases</a></div>`; return;
  }
  renderCase(c);
  // AI summary fallback + parties publish it once so everyone sees the same one
  if (!c.summary) {
    const t = await askAI(SUM_SYS, summaryPrompt(c));
    if (t) { c.summary = t; const el = $('#summary'); if (el) { el.textContent = t; el.parentElement.classList.remove('hidden'); }
      if (c.pkA === PK || c.pkB === PK) Store.put('pj:sum:' + id, [T('c-' + id)], { type: 'sum', id, text: t }).catch(() => {}); }
  }
  if (c.closed) ensureVerdict(c);
  // live refresh of the tally
  clearInterval(window.__pjTimer);
  window.__pjTimer = setInterval(async () => {
    if (!location.hash.startsWith('#/c/' + id)) return clearInterval(window.__pjTimer);
    try { const n = await loadCase(id); if (n) { const was = c.closed; Object.assign(c, n, { summary: c.summary || n.summary, verdictLine: n.verdictLine || c.verdictLine }); updateTally(c); if (!was && c.closed) { renderCase(c); ensureVerdict(c); } } } catch (e) {}
  }, 8000);
}

function viewSideB(c, secret) {
  app.innerHTML = `${banner()}<div class="card"><div class="kicker">You've been called to the stand</div><h1>${esc(c.title)}</h1>
  <div class="side a"><h3>${esc(c.nameA)}'s side</h3><p>${esc(c.sideA)}</p>${c.audioA ? '<button class="btn light" data-play="A">▶ Play recording</button>' : ''}</div></div>
  <div class="card"><h2>Now tell your side</h2>${sideForm('Your side of the story')}<button class="btn big" id="go">Submit my side</button>
  <p class="muted small">When you submit, the case goes public and people can start voting.</p></div>`;
  app.querySelectorAll('[data-play]').forEach(b => b.onclick = () => playAudio(c, b.dataset.play, b));
  const rec = recorderWidget($('#side'), $('#recholder'));
  $('#go').onclick = async () => {
    const nameB = $('#name').value.trim(), sideB = $('#side').value.trim();
    let m = checkName(nameB) || checkText(sideB); if (m) return showErr(m);
    if (sideB.length < 10 && !rec.rec) return showErr('Please tell your side (type it or record it).');
    if (!$('#agree').checked) return showErr('Please check the box to agree to the rules.');
    const b = $('#go'); b.disabled = true; b.textContent = 'Writing a fair summary…';
    try {
      const summary = await askAI(SUM_SYS, summaryPrompt({ ...c, nameB, sideB }));
      b.textContent = 'Submitting…';
      const audio = rec.rec ? await saveAudio(c.id, 'B', rec.rec) : false;
      // the voting clock starts when both sides are in
      const ev = await Store.put('pj:b:' + c.id, [T('b'), T('c-' + c.id)], { type: 'b', id: c.id, nameB, sideB: sideB || '(recorded side)', secret, summary, fp: FP, ip: IPH, audio });
      localStorage.setItem(NS + '-mine-' + c.id, 'b');
      location.hash = '#/c/' + c.id;
    } catch (e) { b.disabled = false; b.textContent = 'Submit my side'; showErr(e.message); }
  };
}

function renderCase(c) {
  if (c.hidden) { app.innerHTML = `<div class="card center"><h2>This case was hidden</h2><p class="muted">People reported it, so it's no longer shown.</p><a class="btn" href="#/">Home</a></div>`; return; }
  const url = caseUrl(c.id);
  const lead = c.v1 === c.v2 ? '' : c.v1 > c.v2 ? c.nameA : c.nameB;
  app.innerHTML = `${banner()}
  ${c.closed ? `<div class="card verdict pop"><div class="kicker">The jury has spoken</div><div class="big">${c.total ? (lead ? '🏆 ' + esc(lead) + ' wins' : "🤝 It's a tie") : 'No votes were cast'}</div>
    <div class="muted">${c.v1} – ${c.v2}</div><p id="verline" class="verline">${esc(c.verdictLine || '')}</p>
    <button class="btn" id="card">🖼️ Share verdict card</button></div>` : ''}
  <div class="card"><h1>${esc(c.title)}</h1><div class="muted">${esc(c.nameA)} vs. ${esc(c.nameB)} · ${esc(timeLeft(c))}</div>
  <div class="summary ${c.summary ? '' : 'hidden'}"><div class="kicker">Fair summary</div><p id="summary">${esc(c.summary)}</p></div>
  <div class="side a"><h3><span class="num">1</span> ${esc(c.nameA)}'s side</h3><p>${esc(c.sideA)}</p>${c.audioA ? '<button class="btn light" data-play="A">▶ Play recording</button>' : ''}</div>
  <div class="side b"><h3><span class="num">2</span> ${esc(c.nameB)}'s side</h3><p>${esc(c.sideB)}</p>${c.audioB ? '<button class="btn light" data-play="B">▶ Play recording</button>' : ''}</div>
  ${DISCLAIMER}</div>
  <div class="card" id="votecard"><h2 class="center" id="votehead"></h2>
  <div class="row" id="votebtns"><button class="btn vote a" data-v="1"><b>1</b>${esc(c.nameA)}</button><button class="btn vote b" data-v="2"><b>2</b>${esc(c.nameB)}</button></div>
  <div class="tally"><span>${esc(c.nameA)}: <span id="n1">0</span></span><span>${esc(c.nameB)}: <span id="n2">0</span></span></div>
  <div class="bar"><div class="ba" id="ba" style="width:50%"></div><div class="bb" id="bb" style="width:50%"></div></div>
  <div class="center muted small" id="totals"></div></div>
  <div class="card"><h2>Share this case</h2>${shareBlock(url, `Whose side are you on? "${c.title}" — vote on People's Jury:`, 'Share this case')}</div>
  <div class="center"><button class="linkbtn" id="report">🚩 Report this case</button></div>`;
  app.querySelectorAll('[data-play]').forEach(b => b.onclick = () => playAudio(c, b.dataset.play, b));
  wireShare(app, url, `Whose side are you on? "${c.title}" — vote on People's Jury:`);
  app.querySelectorAll('[data-v]').forEach(b => b.onclick = () => castVote(c, +b.dataset.v));
  $('#report').onclick = () => report(c);
  if ($('#card')) $('#card').onclick = () => shareVerdictCard(c);
  c._shown = { n1: 0, n2: 0 };
  updateTally(c);
}

function countUp(el, from, to) {
  const t0 = performance.now(), d = 700;
  const step = t => { const p = Math.min(1, (t - t0) / d); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function updateTally(c) {
  if (!$('#votecard')) return;
  const n1 = $('#n1'), n2 = $('#n2');
  if (c._shown.n1 !== c.v1) { countUp(n1, c._shown.n1, c.v1); c._shown.n1 = c.v1; }
  if (c._shown.n2 !== c.v2) { countUp(n2, c._shown.n2, c.v2); c._shown.n2 = c.v2; }
  const pa = c.total ? c.v1 / c.total * 100 : 50;
  requestAnimationFrame(() => { $('#ba').style.width = pa + '%'; $('#bb').style.width = (100 - pa) + '%'; });
  $('#totals').textContent = `${c.total} vote${c.total === 1 ? '' : 's'} · ${timeLeft(c)}`;
  const head = $('#votehead'), btns = $('#votebtns');
  if (c.closed) { head.textContent = 'Final tally'; btns.classList.add('hidden'); }
  else if (c.iAmParty) { head.textContent = "You're in this case, so you can't vote. Share it to get votes!"; btns.classList.add('hidden'); }
  else if (c.myVote) { head.textContent = `✅ You voted for ${c.myVote === 1 ? c.nameA : c.nameB}`; btns.classList.add('hidden'); }
  else { head.textContent = 'Whose side are you on?'; btns.classList.remove('hidden'); }
}
async function castVote(c, choice) {
  if (c.myVote || c.iAmParty || c.closed) return;
  if (localStorage.getItem(NS + '-voted-' + c.id)) { c.myVote = +localStorage.getItem(NS + '-voted-' + c.id); return updateTally(c); }
  app.querySelectorAll('[data-v]').forEach(b => b.disabled = true);
  try {
    await postVote(c, choice);
    updateTally(c); $('#votecard').classList.add('pop');
  } catch (e) { app.querySelectorAll('[data-v]').forEach(b => b.disabled = false); alert(e.message); }
}
async function postVote(c, choice) {
  if (c.myVote || c.iAmParty || c.closed || localStorage.getItem(NS + '-voted-' + c.id)) throw new Error('This device already voted on this case.');
  await Store.put('pj:vote:' + c.id, [T('c-' + c.id), T('vote')], { type: 'vote', id: c.id, choice, fp: FP, ip: IPH });
  localStorage.setItem(NS + '-voted-' + c.id, String(choice));
  c.myVote = choice; choice === 1 ? c.v1++ : c.v2++; c.total++;
}
async function report(c) {
  if (!confirm('Report this case for breaking the rules?')) return;
  try { await Store.put('pj:report:' + c.id, [T('c-' + c.id)], { type: 'report', id: c.id, fp: FP, ip: IPH }); $('#report').textContent = 'Thanks. Reported.'; $('#report').disabled = true; }
  catch (e) { alert(e.message); }
}
async function ensureVerdict(c) {
  if (c.verdictLine || !c.total) return;
  const lead = c.v1 === c.v2 ? 'a tie' : (c.v1 > c.v2 ? c.nameA : c.nameB);
  const t = await askAI(VER_SYS, `Dispute: "${c.title}". ${c.nameA} got ${c.v1} votes, ${c.nameB} got ${c.v2} votes. Result: ${lead}.`);
  if (!t) return;
  c.verdictLine = t; const el = $('#verline'); if (el) el.textContent = t;
  if (c.pkA === PK || c.pkB === PK) Store.put('pj:verdict:' + c.id, [T('c-' + c.id)], { type: 'verdict', id: c.id, text: t }).catch(() => {});
}

/* ---------------- verdict card image ---------------- */
function wrap(x, text, maxW) { const words = String(text).split(' '); const lines = []; let l = ''; for (const w of words) { const t = l ? l + ' ' + w : w; if (x.measureText(t).width > maxW && l) { lines.push(l); l = w; } else l = t; } if (l) lines.push(l); return lines; }
async function verdictCanvas(c) {
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f1b3d'); g.addColorStop(1, '#2a1650'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#f5c542'; x.font = '800 54px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText("⚖️  PEOPLE'S JURY", W / 2, 120);
  x.fillStyle = 'rgba(255,255,255,.75)'; x.font = '500 38px system-ui, sans-serif'; x.fillText('THE JURY HAS SPOKEN', W / 2, 200);
  x.fillStyle = '#fff'; x.font = '800 64px system-ui, sans-serif'; let y = 320;
  for (const l of wrap(x, '“' + c.title + '”', W - 140).slice(0, 3)) { x.fillText(l, W / 2, y); y += 78; }
  const lead = c.v1 === c.v2 ? '' : c.v1 > c.v2 ? c.nameA : c.nameB;
  y += 40; x.fillStyle = '#f5c542'; x.font = '900 96px system-ui, sans-serif'; x.fillText(lead ? '🏆 ' + lead + ' wins' : "🤝 It's a tie", W / 2, y + 60);
  y += 150; const bw = W - 160, pa = c.total ? c.v1 / c.total : .5;
  const rr = (X, Y, w, h, r, col) => { x.fillStyle = col; x.beginPath(); x.roundRect ? x.roundRect(X, Y, w, h, r) : x.rect(X, Y, w, h); x.fill(); };
  rr(80, y, bw, 70, 35, '#b45309'); if (pa > 0) rr(80, y, Math.max(70, bw * pa), 70, 35, '#2563eb');
  y += 130; x.font = '800 48px system-ui, sans-serif'; x.textAlign = 'left'; x.fillStyle = '#93b4ff'; x.fillText(`${c.nameA}  ${c.v1}`, 80, y);
  x.textAlign = 'right'; x.fillStyle = '#f7b267'; x.fillText(`${c.v2}  ${c.nameB}`, W - 80, y);
  x.textAlign = 'center'; x.fillStyle = 'rgba(255,255,255,.9)'; x.font = 'italic 500 40px system-ui, sans-serif'; y += 110;
  for (const l of wrap(x, c.verdictLine || '', W - 160).slice(0, 4)) { x.fillText(l, W / 2, y); y += 54; }
  x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '500 34px system-ui, sans-serif'; x.fillText('For fun, not a legal ruling · Start your own case:', W / 2, H - 110);
  x.fillStyle = '#fff'; x.font = '700 36px system-ui, sans-serif'; x.fillText(APP_URL.replace(/^https?:\/\//, ''), W / 2, H - 60);
  return cv;
}
async function shareVerdictCard(c) {
  const cv = await verdictCanvas(c);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const file = new File([blob], 'peoples-jury-verdict.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "People's Jury verdict", text: caseUrl(c.id) }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'peoples-jury-verdict.png'; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- logo + router ---------------- */
const LOGO = `<svg viewBox="0 0 120 120" width="88" height="88" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect width="120" height="120" rx="28" fill="url(#lg)"/><g fill="none" stroke="#f5c542" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M60 26v62M38 92h44M30 40h60"/><path d="M30 40l-12 26h24zM90 40l-12 26h24z"/></g><circle cx="60" cy="26" r="6" fill="#f5c542"/><path d="M18 66a12 7 0 0 0 24 0M78 66a12 7 0 0 0 24 0" fill="#f5c542"/></svg>`;
window.PJ = { buildCase, loadCase, verdictCanvas, Store, NS, get PK() { return PK; }, get FP() { return FP; }, get IPH() { return IPH; } };              // test hook
async function route() {
  window.scrollTo(0, 0);
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 'new') return viewNew();
  if (h[0] === 'rules') return viewRules();
  if (h[0] === 'sent' && h[1]) return viewSent(h[1]);
  if (h[0] === 'c' && h[1]) return viewCase(h[1], h[2]);
  return viewHome();
}
(async () => {
  Store.init(); await loadKey();
  [FP, IPH] = await Promise.all([fingerprint(), ipHash()]);
  addEventListener('hashchange', route); route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
