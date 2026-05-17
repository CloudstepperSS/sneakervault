import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Keys loaded from config.js (never committed to GitHub)
const SUPABASE_URL      = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
// Anthropic key lives only in the Cloudflare Worker — not here

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ─────────────────────────────────────
let user       = null;
let shoes      = [];
let searchQ    = '';
let sortBy     = 'created_desc';
let brandF     = '';
let typeF      = '';
let activeTab  = 'vault';
let photoDataUrl = null;
let editingId  = null;
let cameraStream = null;
let facingMode = 'environment';

// ── Helpers ───────────────────────────────────
const $ = id => document.getElementById(id);

function fmtPrice(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '€' + Number(n).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function calcROI(release, resell) {
  const r = Number(release), s = Number(resell);
  if (!r || !s) return null;
  return Math.round((s - r) / r * 100);
}

function roiDisplay(release, resell) {
  const roi = calcROI(release, resell);
  if (roi === null) return null;
  const profit = Number(resell) - Number(release);
  return { pct: roi, profit, positive: roi >= 0 };
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 2800);
}

// ── Screen switching ──────────────────────────
function showScreen(id) {
  ['auth-screen','main-app','camera-screen','analyzing-screen','review-screen','stats-view']
    .forEach(s => {
      const el = $(s);
      if (el) el.style.display = 'none';
    });
  const target = $(id);
  if (target) target.style.display = id === 'stats-view' ? 'flex' : id === 'main-app' ? 'flex' : 'flex';
}

// ── Auth ──────────────────────────────────────
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { user = session.user; await enterApp(); }
  else showScreen('auth-screen');

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) { user = session.user; enterApp(); }
    else { user = null; showScreen('auth-screen'); }
  });
}

async function enterApp() {
  showScreen('main-app');
  await loadShoes();
}

document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.auth-tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('auth-submit').textContent = t.dataset.tab === 'signup' ? 'Create account' : 'Sign in';
  $('auth-err').textContent = '';
}));

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const isSignup = document.querySelector('.auth-tab.active').dataset.tab === 'signup';
  const email = $('auth-email').value.trim();
  const pass  = $('auth-pass').value;
  const btn   = $('auth-submit');
  btn.disabled = true;
  $('auth-err').textContent = '';
  const { error } = isSignup
    ? await sb.auth.signUp({ email, password: pass })
    : await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { $('auth-err').textContent = error.message; }
  else if (isSignup) {
    $('auth-err').style.color = 'var(--green)';
    $('auth-err').textContent = 'Check your email to confirm your account!';
  }
  btn.disabled = false;
});

$('signout-btn').addEventListener('click', () => sb.auth.signOut());

// ── Data ──────────────────────────────────────
async function loadShoes() {
  const { data, error } = await sb.from('sneakers').select('*').order('created_at', { ascending: false });
  if (error) { toast('Failed to load collection', 'error'); return; }
  shoes = data || [];
  render();
}

async function upsertShoe(shoe) {
  const payload = {
    user_id:       user.id,
    brand:         shoe.brand,
    name:          shoe.name,
    type:          shoe.type || null,
    size:          shoe.size || null,
    color:         shoe.color || null,
    year:          shoe.year ? Number(shoe.year) : null,
    release_price: shoe.release_price ? Number(shoe.release_price) : null,
    resell_price:  shoe.resell_price  ? Number(shoe.resell_price)  : null,
    image_url:     shoe.image_url || null,
  };

  if (shoe.id) {
    const { error } = await sb.from('sneakers').update(payload).eq('id', shoe.id);
    if (error) { toast('Save failed', 'error'); return false; }
    shoes = shoes.map(s => s.id === shoe.id ? { ...s, ...payload, id: shoe.id } : s);
    toast('Sneaker updated ✓', 'success');
  } else {
    const { data, error } = await sb.from('sneakers').insert(payload).select().single();
    if (error) { toast('Save failed', 'error'); return false; }
    shoes = [data, ...shoes];
    toast('Added to vault ✓', 'success');
  }
  render();
  return true;
}

async function deleteShoe(id) {
  const { error } = await sb.from('sneakers').delete().eq('id', id);
  if (error) { toast('Delete failed', 'error'); return; }
  shoes = shoes.filter(s => s.id !== id);
  closeSheet();
  toast('Sneaker removed', 'success');
  render();
}

// ── Upload photo to Supabase Storage ─────────
async function uploadPhoto(dataUrl) {
  try {
    const res  = await fetch(dataUrl);
    const blob = await res.blob();
    const ext  = blob.type.includes('png') ? 'png' : 'jpg';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('sneaker-photos').upload(path, blob, { contentType: blob.type });
    if (error) throw error;
    const { data } = sb.storage.from('sneaker-photos').getPublicUrl(path);
    return data.publicUrl;
  } catch {
    // fallback: store data URL directly (for small images)
    return dataUrl;
  }
}

// ── AI identification ─────────────────────────
async function identifyShoe(dataUrl) {
  // Convert dataUrl to base64 payload
  const base64 = dataUrl.split(',')[1];
  const mimeType = dataUrl.split(';')[0].split(':')[1];

  const prompt = `You are a sneaker expert. Analyze this image and identify the sneaker.
Return ONLY a JSON object with these exact keys (use null for anything you cannot determine):
{
  "brand": "e.g. Adidas",
  "name": "e.g. Samba OG",
  "color": "e.g. White / Core Black",
  "type": "one of: Lifestyle, Basketball, Running, Training, Skate, Trail, Collaboration, Limited Edition, Other",
  "release_price": number in EUR or null,
  "resell_price": number in EUR or null,
  "confidence": "high | medium | low"
}
Return only the JSON object, no markdown, no explanation.`;

  // Call our Cloudflare Worker — API key is stored securely there, not in this file
  const response = await fetch(CONFIG.WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!response.ok) throw new Error('API error ' + response.status);
  const json = await response.json();
  const text = json.content[0].text.trim();
  // Strip possible markdown fences
  const clean = text.replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  return JSON.parse(clean);
}

// ── Camera ────────────────────────────────────
async function openCamera() {
  editingId = null;
  photoDataUrl = null;
  showScreen('camera-screen');
  await startCamera();
}

async function startCamera() {
  stopCamera();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    $('cam-video').srcObject = cameraStream;
  } catch {
    toast('Camera not available — choose from gallery', 'error');
  }
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
}

$('cam-cancel').addEventListener('click', () => {
  stopCamera();
  showScreen('main-app');
});

$('cam-shutter').addEventListener('click', () => captureFrame());

$('cam-flip').addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
});

$('gallery-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { photoDataUrl = ev.target.result; stopCamera(); goAnalyze(); };
  reader.readAsDataURL(file);
  e.target.value = '';
});

function captureFrame() {
  const video  = $('cam-video');
  const canvas = $('cam-canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0);
  photoDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  stopCamera();
  goAnalyze();
}

// ── Analyze screen ────────────────────────────
async function goAnalyze() {
  showScreen('analyzing-screen');
  $('an-photo').src = photoDataUrl;

  // Reset fields
  $('an-fields').innerHTML = [
    'Brand','Model','Colorway','Type','Release price','Resell value'
  ].map(k => `<div class="an-field"><span class="an-key">${k}</span><span class="an-val-ph"></span></div>`).join('');

  $('an-status').textContent = 'AI reading your photo...';

  let result;
  try {
    result = await identifyShoe(photoDataUrl);
  } catch (err) {
    toast('Could not identify shoe — please fill in manually', 'error');
    result = {};
  }

  // Animate fields appearing
  const fieldData = [
    { key: 'Brand',         val: result.brand },
    { key: 'Model',         val: result.name },
    { key: 'Colorway',      val: result.color },
    { key: 'Type',          val: result.type },
    { key: 'Release price', val: result.release_price ? fmtPrice(result.release_price) : null },
    { key: 'Resell value',  val: result.resell_price  ? fmtPrice(result.resell_price)  : null },
  ];

  const container = $('an-fields');
  container.innerHTML = '';
  for (const [i, { key, val }] of fieldData.entries()) {
    await new Promise(r => setTimeout(r, 180));
    const row = document.createElement('div');
    row.className = 'an-field';
    row.innerHTML = `<span class="an-key">${key}</span>${
      val ? `<span class="an-val">${val}</span>` : `<span class="an-val-ph"></span>`
    }`;
    container.appendChild(row);
  }

  $('an-status').textContent = result.brand
    ? `Identified: ${result.brand} ${result.name || ''}`
    : 'Could not identify — you can fill in manually';

  // Transition to review after short delay
  await new Promise(r => setTimeout(r, 900));
  goReview(result);
}

// ── Review screen ─────────────────────────────
function goReview(aiResult = {}) {
  showScreen('review-screen');
  $('rev-photo').src = photoDataUrl;

  const fields = ['f-brand','f-name','f-color','f-type','f-size','f-release','f-resell','f-year'];
  fields.forEach(id => {
    const el = $(id);
    el.value = '';
    el.classList.remove('ai-filled');
  });

  const set = (id, val) => {
    if (!val && val !== 0) return;
    const el = $(id);
    el.value = val;
    el.classList.add('ai-filled');
  };

  set('f-brand',   aiResult.brand);
  set('f-name',    aiResult.name);
  set('f-color',   aiResult.color);
  set('f-type',    aiResult.type);
  set('f-release', aiResult.release_price);
  set('f-resell',  aiResult.resell_price);

  updateROI();
  $('rev-err').textContent = '';

  // If editing existing shoe, prefill id / size / year from existing record
  if (editingId) {
    const s = shoes.find(x => x.id === editingId);
    if (s) {
      set('f-size', s.size);
      set('f-year', s.year);
    }
  }
}

['f-release','f-resell'].forEach(id => $(id).addEventListener('input', updateROI));

function updateROI() {
  const rel = Number($('f-release').value);
  const res = Number($('f-resell').value);
  const row = $('roi-row');
  if (!rel || !res) { row.style.display = 'none'; return; }
  const roi = calcROI(rel, res);
  const profit = res - rel;
  $('roi-value').textContent = `${roi >= 0 ? '+' : ''}${roi}% · ${profit >= 0 ? '+' : ''}${fmtPrice(profit)}`;
  $('roi-value').className = 'roi-value ' + (roi >= 0 ? 'roi-pos' : 'roi-neg');
  row.style.display = 'flex';
}

$('rev-retake').addEventListener('click', () => {
  if (editingId) { showScreen('main-app'); editingId = null; return; }
  openCamera();
});

$('rev-save').addEventListener('click', async () => {
  const brand = $('f-brand').value.trim();
  const name  = $('f-name').value.trim();
  if (!brand || !name) { $('rev-err').textContent = 'Brand and name are required.'; return; }

  const btn = $('rev-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Upload photo
  let imageUrl = null;
  if (photoDataUrl) {
    imageUrl = await uploadPhoto(photoDataUrl);
  } else if (editingId) {
    const existing = shoes.find(s => s.id === editingId);
    imageUrl = existing?.image_url || null;
  }

  const ok = await upsertShoe({
    id:            editingId || null,
    brand, name,
    type:          $('f-type').value,
    size:          $('f-size').value,
    color:         $('f-color').value.trim(),
    year:          $('f-year').value || null,
    release_price: $('f-release').value || null,
    resell_price:  $('f-resell').value  || null,
    image_url:     imageUrl,
  });

  btn.disabled = false;
  btn.textContent = 'Save';
  if (ok) { editingId = null; photoDataUrl = null; showScreen('main-app'); }
});

// ── Add button (opens camera) ─────────────────
$('add-btn').addEventListener('click', openCamera);

// ── Render ────────────────────────────────────
function render() {
  renderStats();
  renderFilters();
  renderGrid();
}

function renderStats() {
  const cost   = shoes.reduce((s, x) => s + Number(x.release_price || 0), 0);
  const resell = shoes.reduce((s, x) => s + Number(x.resell_price  || 0), 0);
  const roi    = cost > 0 ? Math.round((resell - cost) / cost * 100) : null;
  $('stat-count').textContent  = shoes.length + (shoes.length === 1 ? ' pair' : ' pairs');
  $('stat-cost').textContent   = fmtPrice(cost);
  $('stat-resell').textContent = fmtPrice(resell);
  $('stat-roi').textContent    = roi !== null ? (roi >= 0 ? '+' : '') + roi + '%' : '—';
  $('stat-roi').className      = 'stat-value ' + (roi !== null ? (roi >= 0 ? 'roi-pos' : 'roi-neg') : '');
}

function renderFilters() {
  const brands = [...new Set(shoes.map(s => s.brand))].filter(Boolean).sort();
  const types  = [...new Set(shoes.map(s => s.type))].filter(Boolean).sort();
  const fc = $('filter-chips');
  fc.innerHTML = `
    <button class="filter-chip ${!brandF && !typeF ? 'active' : ''}" data-brand="" data-type="">All</button>
    ${brands.map(b => `<button class="filter-chip ${brandF === b ? 'active' : ''}" data-brand="${b}" data-type="">${b}</button>`).join('')}
    ${types.length ? `<div class="filter-sep"></div>` : ''}
    ${types.map(t => `<button class="filter-chip ${typeF === t ? 'active' : ''}" data-brand="" data-type="${t}">${t}</button>`).join('')}
  `;
  fc.querySelectorAll('.filter-chip').forEach(btn => btn.addEventListener('click', () => {
    brandF = btn.dataset.brand;
    typeF  = btn.dataset.type;
    renderFilters();
    renderGrid();
  }));
}

function getFiltered() {
  const q = searchQ.toLowerCase();
  return shoes
    .filter(s => {
      const hit = !q || [s.brand, s.name, s.color, s.type].some(v => v?.toLowerCase().includes(q));
      return hit && (!brandF || s.brand === brandF) && (!typeF || s.type === typeF);
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'brand_asc':    return (a.brand||'').localeCompare(b.brand||'');
        case 'name_asc':     return (a.name||'').localeCompare(b.name||'');
        case 'year_desc':    return (b.year||0) - (a.year||0);
        case 'resell_desc':  return (b.resell_price||0) - (a.resell_price||0);
        case 'release_desc': return (b.release_price||0) - (a.release_price||0);
        case 'size_asc':     return parseFloat(a.size||0) - parseFloat(b.size||0);
        case 'created_asc':  return new Date(a.created_at) - new Date(b.created_at);
        default:             return new Date(b.created_at) - new Date(a.created_at);
      }
    });
}

function renderGrid() {
  const list = getFiltered();
  const grid = $('shoe-grid');

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">👟</div>
      <h2>${shoes.length === 0 ? 'Vault is empty' : 'No results'}</h2>
      <p>${shoes.length === 0 ? 'Tap + and photograph your first sneaker.' : 'Try adjusting your search or filters.'}</p>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(s => {
    const roi = roiDisplay(s.release_price, s.resell_price);
    return `<div class="shoe-card" data-id="${s.id}">
      <div class="shoe-img-wrap">
        ${s.image_url
          ? `<img src="${s.image_url}" alt="${s.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="shoe-img-ph" style="${s.image_url ? 'display:none' : ''}">👟</div>
        ${s.image_url ? `<div class="shoe-ai-tag">AI</div>` : ''}
      </div>
      <div class="shoe-body">
        <div class="shoe-brand">${s.brand || ''}</div>
        <div class="shoe-name">${s.name}</div>
        <div class="shoe-sub">${[s.type, s.color].filter(Boolean).join(' · ')}</div>
        <div class="shoe-footer">
          <span class="shoe-size">${s.size ? 'EU ' + s.size : ''}</span>
          <div class="shoe-prices">
            <div class="shoe-resell">${fmtPrice(s.resell_price)}</div>
            ${s.release_price ? `<div class="shoe-retail">${fmtPrice(s.release_price)}</div>` : ''}
            ${roi ? `<div class="shoe-roi ${roi.positive ? 'roi-pos' : 'roi-neg'}">${roi.positive ? '+' : ''}${roi.pct}%</div>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.shoe-card').forEach(card =>
    card.addEventListener('click', () => openSheet(card.dataset.id))
  );
}

// ── Detail bottom sheet ───────────────────────
let currentSheetId = null;

function openSheet(id) {
  const s = shoes.find(x => x.id === id);
  if (!s) return;
  currentSheetId = id;

  if (s.image_url) {
    $('sheet-photo').src = s.image_url;
    $('sheet-photo').style.display = 'block';
    $('sheet-photo-ph').style.display = 'none';
  } else {
    $('sheet-photo').style.display = 'none';
    $('sheet-photo-ph').style.display = 'flex';
  }

  $('sheet-brand').textContent   = s.brand || '';
  $('sheet-name').textContent    = s.name;
  $('sheet-sub').textContent     = [s.type, s.color, s.year].filter(Boolean).join(' · ');
  $('sheet-size').textContent    = s.size ? 'EU ' + s.size : '—';
  $('sheet-year').textContent    = s.year || '—';
  $('sheet-release').textContent = fmtPrice(s.release_price);
  $('sheet-resell').textContent  = fmtPrice(s.resell_price);

  const roi = roiDisplay(s.release_price, s.resell_price);
  if (roi) {
    $('sheet-roi').style.display = 'flex';
    $('sheet-roi-val').textContent = `${roi.positive ? '+' : ''}${roi.pct}% · ${roi.positive ? '+' : ''}${fmtPrice(roi.profit)}`;
    $('sheet-roi-val').className = 'roi-value ' + (roi.positive ? 'roi-pos' : 'roi-neg');
  } else {
    $('sheet-roi').style.display = 'none';
  }

  $('sheet-overlay').style.display = 'flex';
}

function closeSheet() {
  $('sheet-overlay').style.display = 'none';
  currentSheetId = null;
}

$('sheet-overlay').addEventListener('click', e => {
  if (e.target === $('sheet-overlay')) closeSheet();
});

$('sheet-delete').addEventListener('click', () => {
  if (!currentSheetId) return;
  if (confirm('Delete this sneaker from your vault?')) deleteShoe(currentSheetId);
});

$('sheet-edit').addEventListener('click', () => {
  if (!currentSheetId) return;
  const s = shoes.find(x => x.id === currentSheetId);
  if (!s) return;
  editingId    = s.id;
  photoDataUrl = s.image_url || null;
  closeSheet();
  // Go straight to review with existing data (no new photo)
  goReview({
    brand:         s.brand,
    name:          s.name,
    color:         s.color,
    type:          s.type,
    release_price: s.release_price,
    resell_price:  s.resell_price,
  });
  // Also pre-fill size and year
  setTimeout(() => {
    if (s.size) { $('f-size').value = s.size; $('f-size').classList.add('ai-filled'); }
    if (s.year) { $('f-year').value = s.year; $('f-year').classList.add('ai-filled'); }
    // Show existing photo
    if (s.image_url) $('rev-photo').src = s.image_url;
  }, 50);
});

// ── Search & sort ─────────────────────────────
$('search-input').addEventListener('input', e => { searchQ = e.target.value; renderGrid(); });
$('sort-select').addEventListener('change', e => { sortBy = e.target.value; renderGrid(); });

// ── Tab bar ───────────────────────────────────
$('tab-vault').addEventListener('click', () => {
  activeTab = 'vault';
  $('tab-vault').classList.add('on');
  $('tab-stats').classList.remove('on');
  $('stats-view').style.display = 'none';
  $('main-app').style.display   = 'flex';
});

$('tab-stats').addEventListener('click', () => {
  activeTab = 'stats';
  $('tab-stats').classList.add('on');
  $('tab-vault').classList.remove('on');
  renderStatsPage();
  $('stats-view').style.display = 'flex';
});

// ── Stats page ────────────────────────────────
function renderStatsPage() {
  const cost   = shoes.reduce((s, x) => s + Number(x.release_price || 0), 0);
  const resell = shoes.reduce((s, x) => s + Number(x.resell_price  || 0), 0);
  const profit = resell - cost;
  const roi    = cost > 0 ? Math.round(profit / cost * 100) : 0;

  const byBrand = {};
  shoes.forEach(s => { byBrand[s.brand] = (byBrand[s.brand] || 0) + 1; });
  const sortedBrands = Object.entries(byBrand).sort((a,b) => b[1]-a[1]);
  const maxBrand = sortedBrands[0]?.[1] || 1;

  const byType = {};
  shoes.forEach(s => { if (s.type) byType[s.type] = (byType[s.type] || 0) + 1; });

  const topResell = [...shoes].sort((a,b) => (b.resell_price||0) - (a.resell_price||0)).slice(0, 3);

  $('stats-page').innerHTML = `
    <div class="stats-heading">Overview</div>
    <div class="stats-card">
      <div class="stats-row"><span class="stats-row-label">Total pairs</span><span class="stats-row-val">${shoes.length}</span></div>
      <div class="stats-row"><span class="stats-row-label">Total cost</span><span class="stats-row-val">${fmtPrice(cost)}</span></div>
      <div class="stats-row"><span class="stats-row-label">Total resell value</span><span class="stats-row-val">${fmtPrice(resell)}</span></div>
      <div class="stats-row"><span class="stats-row-label">Total profit</span><span class="stats-row-val ${profit >= 0 ? 'roi-pos' : 'roi-neg'}">${profit >= 0 ? '+' : ''}${fmtPrice(profit)}</span></div>
      <div class="stats-row"><span class="stats-row-label">Portfolio ROI</span><span class="stats-row-val ${roi >= 0 ? 'roi-pos' : 'roi-neg'}">${roi >= 0 ? '+' : ''}${roi}%</span></div>
    </div>

    <div class="stats-heading">By brand</div>
    <div class="stats-card">
      <div class="brand-bar-wrap">
        ${sortedBrands.map(([brand, count]) => `
          <div class="brand-bar-row">
            <div class="brand-bar-label">${brand}</div>
            <div class="brand-bar-track"><div class="brand-bar-fill" style="width:${Math.round(count/maxBrand*100)}%"></div></div>
            <div class="brand-bar-count">${count}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${topResell.length ? `
    <div class="stats-heading">Top resell value</div>
    <div class="stats-card">
      ${topResell.map(s => `
        <div class="stats-row">
          <span class="stats-row-label">${s.brand} ${s.name}</span>
          <span class="stats-row-val">${fmtPrice(s.resell_price)}</span>
        </div>
      `).join('')}
    </div>` : ''}

    ${Object.keys(byType).length ? `
    <div class="stats-heading">By type</div>
    <div class="stats-card">
      ${Object.entries(byType).sort((a,b) => b[1]-a[1]).map(([type, count]) => `
        <div class="stats-row">
          <span class="stats-row-label">${type}</span>
          <span class="stats-row-val">${count}</span>
        </div>
      `).join('')}
    </div>` : ''}
  `;
}

// ── Boot ──────────────────────────────────────
initAuth();
