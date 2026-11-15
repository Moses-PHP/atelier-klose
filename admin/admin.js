// Web admin for the Ateliér Klose portfolio (serverless).
//
// - Login: the password decrypts klic.json (PBKDF2-SHA256 -> AES-256-GCM, see tools/admin-klic.mjs)
//   into {token, owner, repo, branch} of the public Pages repo.
// - Data: data.json is loaded through the GitHub API (its blob sha guards against concurrent
//   publishes); images come from raw.githubusercontent.com.
// - Editing happens on an in-memory copy (`data`) and is compared with what was loaded (`orig`).
// - Publish renders the changed images in the browser exactly like tools/build.py (straighten =
//   rotate about the centre and scale by k so the frame stays filled; covers = square crop of the
//   straightened first photo), uploads them as blobs and makes ONE commit via the Git Data API,
//   deleting img/* and src/* files no longer referenced.
// - photos[0] is always the cover photo (the public site opens the tile into photos[0]).
'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const rnd = (n = 5) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
    del: k => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const PASS_KEY = 'ak-admin-heslo';
  const onPages = location.hostname.endsWith('github.io');

  let cfg = null;          // {token, owner, repo, branch}
  let render = null;       // ../render.json
  let orig = null;         // data.json as loaded/published
  let data = null;         // working copy
  let dataSha = null;      // blob sha of the loaded data.json
  let selId = null;        // selected project id
  let fmt = null;          // {type, ext} output image format (WebP, or JPEG where the browser can't encode WebP)
  let busy = false;
  const local = new Map();   // photo id -> {blob, ext, w, h} new (not yet published) masters
  const localFiles = new Map(); // site path -> objectURL of files published from this session
  const thumbs = new Map();  // key -> objectURL (small renders reflecting unpublished rotation/crop)
  const dims = new Map();    // photo id -> {w, h} of the master

  // ---------- small UI helpers ----------
  let toastT;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
  const modalEl = $('#modal'), modalBox = $('#modal .modal-box');
  let modalClose = null;
  function openModal(html, { wide = false, onClose = null } = {}) {
    modalBox.className = 'modal-box' + (wide ? ' wide' : '');
    modalBox.innerHTML = html; modalEl.hidden = false; modalClose = onClose;
    return modalBox;
  }
  function closeModal() { modalEl.hidden = true; modalBox.innerHTML = ''; const f = modalClose; modalClose = null; f && f(); }
  // custom confirm: resolves true/false
  function ask(title, body, { ok = 'Potvrdit', cancel = 'Zrušit', danger = false } = {}) {
    return new Promise(res => {
      const b = openModal(`<h2>${esc(title)}</h2>${body ? `<div>${body}</div>` : ''}
        <div class="modal-btns"><button class="btn ghost" data-r="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger solid' : 'primary'}" data-r="1">${esc(ok)}</button></div>`, { onClose: () => res(false) });
      b.querySelectorAll('[data-r]').forEach(x => x.onclick = () => { modalClose = null; closeModal(); res(x.dataset.r === '1'); });
      b.querySelector('[data-r="1"]').focus();
    });
  }
  function info(title, body, btn = 'Rozumím') {
    return new Promise(res => {
      const b = openModal(`<h2>${esc(title)}</h2><div>${body}</div><div class="modal-btns"><button class="btn primary">${esc(btn)}</button></div>`, { onClose: res });
      b.querySelector('button').onclick = closeModal;
    });
  }
  modalEl.addEventListener('pointerdown', e => { if (e.target === modalEl && !busy) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modalEl.hidden && !busy) closeModal(); });

  function boot(msg) { $('#boot').hidden = false; $('#bootMsg').innerHTML = msg; $('#login').hidden = true; $('#app').hidden = true; }

  // ---------- crypto / login ----------
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decrypt(klic, pass) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(klic.salt), iterations: klic.iter }, base,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(klic.iv) }, key, unb64(klic.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function start() {
    fetch('../logo.svg').then(r => r.ok ? r.text() : '').then(svg => document.querySelectorAll('[data-logo]').forEach(el => el.innerHTML = svg)).catch(() => {});
    if (!window.crypto?.subtle) return boot('Tento prohlížeč neumí šifrování – otevřete správu přes https v aktuálním prohlížeči.');
    let klic;
    try {
      const r = await fetch('klic.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      klic = await r.json();
    } catch {
      return boot('Správa webu ještě není nastavená: chybí přístupový klíč (<code>admin/klic.json</code>).<br>Ozvěte se prosím správci webu.');
    }
    const saved = ss.get(PASS_KEY);
    if (saved) {
      boot('Přihlašuji…');
      try { cfg = await decrypt(klic, saved); return loggedIn(); } catch { ss.del(PASS_KEY); }
    }
    $('#boot').hidden = true; $('#login').hidden = false; $('#pass').focus();
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const pass = $('#pass').value, msg = $('#loginMsg'), btn = $('#loginForm button');
      msg.textContent = ''; btn.disabled = true; btn.textContent = 'Ověřuji…';
      try { cfg = await decrypt(klic, pass); }
      catch { msg.textContent = 'Nesprávné heslo. Zkuste to prosím znovu.'; btn.disabled = false; btn.textContent = 'Přihlásit'; $('#pass').select(); return; }
      ss.set(PASS_KEY, pass);
      loggedIn();
    };
  }

  // ---------- GitHub ----------
  class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  async function gh(path, { method = 'GET', body, accept } = {}) {
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
        method, cache: 'no-store',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new GhError('Nepodařilo se spojit s GitHubem. Zkontrolujte připojení k internetu.', 0); }
    if (!r.ok) {
      let m = ''; try { m = (await r.json()).message || ''; } catch { /* ignore */ }
      if (r.status === 401) throw new GhError('Přístupový klíč k GitHubu neplatí (vypršel nebo byl zrušen). Ozvěte se správci webu.', 401);
      if (r.status === 403 || r.status === 429) throw new GhError('GitHub dočasně odmítá požadavky (limit). Zkuste to prosím za pár minut.' + (m ? ` (${m})` : ''), r.status);
      throw new GhError(`GitHub vrátil chybu ${r.status}${m ? ': ' + m : ''}`, r.status);
    }
    return accept && accept.includes('raw') ? r.text() : r.json();
  }
  const rawUrl = p => `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${p}`;
  const imgUrl = p => localFiles.get(p) || rawUrl(p);

  async function loadData() {
    const meta = await gh(`/contents/data.json?ref=${encodeURIComponent(cfg.branch)}`);
    let text;
    if (meta.content && meta.encoding === 'base64') text = new TextDecoder().decode(unb64(meta.content.replace(/\s/g, '')));
    else text = await gh(`/contents/data.json?ref=${encodeURIComponent(cfg.branch)}`, { accept: 'application/vnd.github.raw+json' });
    dataSha = meta.sha;
    orig = JSON.parse(text);
    data = clone(orig);
    local.clear();
    if (!data.projects.some(p => p.id === selId)) selId = data.projects[0]?.id ?? null;
  }

  async function loggedIn() {
    boot('Načítám data webu…');
    try {
      const [rj] = await Promise.all([fetch('../render.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json(); }), loadData()]);
      render = rj;
      fmt = await detectFormat();
    } catch (e) {
      return boot(esc(e instanceof GhError ? e.message : 'Data webu se nepodařilo načíst.') + '<br><br><button class="btn" onclick="location.reload()">Zkusit znovu</button>');
    }
    $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false;
    $('#logout').onclick = async () => {
      if (isDirty() && !await ask('Odhlásit se?', '<p>Máte nezveřejněné změny – odhlášením se ztratí.</p>', { ok: 'Odhlásit a zahodit', danger: true })) return;
      ss.del(PASS_KEY); data = orig; location.reload();
    };
    $('#discard').onclick = async () => {
      if (!await ask('Zahodit změny?', '<p>Všechny nezveřejněné úpravy se vrátí do stavu, který je teď na webu.</p>', { ok: 'Zahodit', danger: true })) return;
      data = clone(orig); local.clear();
      if (!data.projects.some(p => p.id === selId)) selId = data.projects[0]?.id ?? null;
      renderAll(); toast('Změny zahozeny');
    };
    $('#publish').onclick = publish;
    $('#addHouse').onclick = addHouse;
    window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
    renderAll();
  }

  // ---------- image pipeline (mirror of tools/build.py) ----------
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2d(c) { const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return x; }
  function free(c) { if (c && c.width) { c.width = 0; c.height = 0; } }
  const kOf = (deg, w, h) => { const t = Math.abs(deg) * Math.PI / 180; return Math.cos(t) + Math.max(w / h, h / w) * Math.sin(t); };

  async function detectFormat() {
    const b = await new Promise(r => canvas(2, 2).toBlob(r, 'image/webp', .8));
    return b && b.type === 'image/webp' ? { type: 'image/webp', ext: 'webp' } : { type: 'image/jpeg', ext: 'jpg' };
  }
  function encode(c, q) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), fmt.type, q));
  }
  // downscale with repeated halving (smooth like INTER_AREA), source = canvas/bitmap/img of size sw x sh
  function resize(src, sw, sh, tw, th) {
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2), n = canvas(nw, nh);
      ctx2d(n).drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      if (cur !== src) free(cur);
      cur = n; cw = nw; ch = nh;
    }
    const out = canvas(tw, th);
    ctx2d(out).drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
    if (cur !== src) free(cur);
    return out;
  }
  // straighten(): rotate by deg (clockwise) about the centre, scale by k, keep w x h
  function straighten(src, w, h, deg, ow = w, oh = h) {
    const c = canvas(ow, oh), x = ctx2d(c);
    let s = src, sw = w, sh = h;
    if (ow < w / 2) { s = resize(src, w, h, Math.round(ow * 1.5), Math.round(oh * 1.5)); sw = s.width; sh = s.height; }   // small output: pre-shrink
    x.translate(ow / 2, oh / 2);
    if (deg) { x.rotate(deg * Math.PI / 180); const k = kOf(deg, w, h); x.scale(k, k); }
    x.drawImage(s, 0, 0, sw, sh, -ow / 2, -oh / 2, ow, oh);
    if (s !== src) free(s);
    return c;
  }
  function squareRect(w, h, crop) {
    const m = Math.min(w, h);
    const c = crop || { x: (w - m) / 2 / w, y: (h - m) / 2 / h, s: 1 };
    const side = Math.round(c.s * m);
    const x0 = Math.min(Math.max(0, Math.round(c.x * w)), w - side);
    const y0 = Math.min(Math.max(0, Math.round(c.y * h)), h - side);
    return { x0, y0, side };
  }
  function cropPos(crop, w, h) {
    if (!crop) return [0.5, 0.5];
    const m = Math.min(w, h), side = crop.s * m;
    const fx = w - side > 1 ? crop.x * w / (w - side) : 0.5, fy = h - side > 1 ? crop.y * h / (h - side) : 0.5;
    const r = v => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
    return [r(fx), r(fy)];
  }
  // save_sizes(): variants for the given widths; returns [{src, w, h, blob}]
  async function sizes(img, w, h, base, widths, q) {
    const out = [];
    for (let tw of widths) {
      if (tw > w && out.length) break;
      tw = Math.min(tw, w);
      const th = Math.round(h * tw / w);
      const c = tw < w ? resize(img, w, h, tw, th) : img;
      const blob = await encode(c, q);
      if (c !== img) free(c);
      out.push({ src: `img/${base}-${tw}.${fmt.ext}`, w: tw, h: th, blob });
    }
    return out;
  }

  // master of a photo as a drawable (cached for the last few photos only: they are big)
  const masterCache = new Map();
  function master(ph) {
    if (masterCache.has(ph.id)) { const v = masterCache.get(ph.id); masterCache.delete(ph.id); masterCache.set(ph.id, v); return v; }
    const p = (async () => {
      const l = local.get(ph.id);
      if (l) return createImageBitmap(l.blob);
      const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.src = imgUrl(ph.master);
      await img.decode().catch(() => { throw new Error('Originál fotky se nepodařilo načíst.'); });
      return img;
    })().then(m => { const w = m.naturalWidth || m.width, h = m.naturalHeight || m.height; dims.set(ph.id, { w, h }); return { img: m, w, h }; });
    p.catch(() => masterCache.delete(ph.id));
    masterCache.set(ph.id, p);
    while (masterCache.size > 4) {
      const [k, v] = masterCache.entries().next().value; masterCache.delete(k);
      v.then(m => m.img.close && m.img.close()).catch(() => {});
    }
    return p;
  }

  // ---------- upload: decode, downscale to the master size, encode ----------
  // HEIC fallback for browsers that can't decode it (Safari can; iOS converts on upload anyway).
  // heic-to bundles a current libheif – heic2any@0.0.4 fails on recent iPhone files ("ERR_LIBHEIF format not supported").
  let heicP = null;
  function heicTo() {
    heicP ||= new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/heic-to@1.1.14/dist/iife/heic-to.js';
      s.onload = () => res(window.HeicTo); s.onerror = () => { heicP = null; rej(new Error('heic')); }; document.head.appendChild(s);
    });
    return heicP;
  }
  const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
  async function decodeFile(f) {
    try { return await createImageBitmap(f, { imageOrientation: 'from-image' }); }
    catch (e) {
      if (!isHeic(f)) throw e;
      const conv = await (await heicTo())({ blob: f, type: 'image/jpeg', quality: .95 });
      return createImageBitmap(conv, { imageOrientation: 'from-image' });
    }
  }
  const slug = s => s.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'foto';

  async function addFiles(files) {
    const p = proj(selId);
    if (!p || busy) return;
    files = [...files].filter(f => f.type.startsWith('image/') || isHeic(f));
    if (!files.length) return toast('Vyberte prosím fotky (JPEG, HEIC, PNG…).');
    busy = true;
    const prog = $('#upProg'), failed = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (prog) prog.textContent = `Zpracovávám fotku ${i + 1} z ${files.length}: ${f.name}…`;
      try {
        const bmp = await decodeFile(f);
        const s = Math.min(1, render.master.max / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
        const c = resize(bmp, bmp.width, bmp.height, w, h);
        bmp.close && bmp.close();
        const blob = await encode(c, render.master.quality / 100);
        free(c);
        const id = `${slug(f.name)}-${rnd(5)}`;
        local.set(id, { blob, ext: fmt.ext, w, h }); dims.set(id, { w, h });
        p.photos.push({ id, sizes: [], ratio: Math.round(w / h * 1e4) / 1e4, rot: 0, master: `src/${id}.${fmt.ext}` });
        renderAll();
      } catch (e) {
        console.error('upload failed', f.name, e?.message || e?.code || JSON.stringify(e)); failed.push(f.name);
      }
    }
    busy = false;
    if (prog) prog.textContent = '';
    renderAll();
    if (failed.length) info('Některé fotky se nepodařilo načíst', `<p>${failed.map(esc).join(', ')}</p><p>Zkuste je prosím uložit jako JPEG a nahrát znovu.</p>`);
    else toast(files.length === 1 ? 'Fotka přidána' : `Přidáno fotek: ${files.length}`);
  }

  // ---------- state / diff ----------
  const proj = id => data.projects.find(p => p.id === id);
  const origProj = id => orig.projects.find(p => p.id === id);
  const origPhoto = (pid, phid) => origProj(pid)?.photos.find(x => x.id === phid);
  const sameCrop = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const photoChanged = (p, ph) => { const o = origPhoto(p.id, ph.id); return !o || o.rot !== ph.rot || local.has(ph.id); };
  function coverChanged(p) {
    const o = origProj(p.id), ph = p.photos[0];
    if (!ph) return false;
    if (!o || !o.cover || o.cover.photo !== ph.id) return true;
    return photoChanged(p, ph) || !sameCrop(o.cover.crop, p.cover?.crop);
  }
  const strip = d => JSON.stringify({ ...d, rev: 0, projects: d.projects.map(p => ({ ...p, order: 0 })) });
  const isDirty = () => !!data && strip(data) !== strip(orig);
  const label = p => p.name ? `‚${p.name}‘` : `‚Bez názvu‘ (${data.projects.indexOf(p) + 1}. dům)`;
  const plural = (n, a, b, c) => `${n} ${n === 1 ? a : n < 5 ? b : c}`;
  const relOrder = (a, b) => { const s = new Set(b); const x = a.filter(i => s.has(i)), t = new Set(a); const y = b.filter(i => t.has(i)); return x.join() !== y.join(); };

  // [{text, n}] in plain Czech
  function changes() {
    const out = [];
    for (const o of orig.projects) if (!proj(o.id)) out.push({ text: `Dům ${o.name ? `‚${o.name}‘` : '‚Bez názvu‘'} smazán`, n: 1 });
    for (const p of data.projects) {
      const o = origProj(p.id), parts = [];
      let n = 0;
      if (!o) {
        out.push({ text: `Nový dům ${label(p)}: ${plural(p.photos.length, 'fotka', 'fotky', 'fotek')}${p.hidden ? ', skrytý' : ''}`, n: 1 + p.photos.length });
        continue;
      }
      if ((p.name || '') !== (o.name || '')) { parts.push(o.name ? `přejmenován z ‚${o.name}‘` : 'pojmenován'); n++; }
      if (!!p.hidden !== !!o.hidden) { parts.push(p.hidden ? 'skryt na webu' : 'znovu zobrazen na webu'); n++; }
      const ids = new Set(o.photos.map(x => x.id)), now = new Set(p.photos.map(x => x.id));
      const added = p.photos.filter(x => !ids.has(x.id)).length, removed = o.photos.filter(x => !now.has(x.id)).length;
      const rotated = p.photos.filter(x => ids.has(x.id) && o.photos.find(y => y.id === x.id).rot !== x.rot).length;
      if (added) { parts.push(plural(added, 'nová fotka', 'nové fotky', 'nových fotek')); n += added; }
      if (removed) { parts.push(plural(removed, 'fotka smazána', 'fotky smazány', 'fotek smazáno')); n += removed; }
      if (rotated) { parts.push(plural(rotated, 'fotka srovnána', 'fotky srovnány', 'fotek srovnáno')); n += rotated; }
      if (p.photos[0] && o.photos[0]?.id !== p.photos[0].id) { parts.push('nová titulní fotka'); n++; }
      else if (p.photos[0] && !sameCrop(o.cover?.crop, p.cover?.crop)) { parts.push('upravený výřez titulní'); n++; }
      if (relOrder(o.photos.map(x => x.id).slice(1), p.photos.map(x => x.id).slice(1)) ) { parts.push('změněno pořadí fotek'); n++; }
      if (!p.photos.length && o.photos.length) parts.push('nemá žádnou fotku – na webu se nezobrazí');
      if (parts.length) out.push({ text: `Dům ${label(p)}: ${parts.join(', ')}`, n });
    }
    if (relOrder(orig.projects.map(p => p.id), data.projects.map(p => p.id))) out.push({ text: 'Změněno pořadí domů', n: 1 });
    if (!out.length && isDirty()) out.push({ text: 'Drobné úpravy', n: 1 });
    return out;
  }

  // ---------- thumbnails reflecting unpublished edits ----------
  const pending = new Set();
  function thumbOf(p, ph) {
    if (!photoChanged(p, ph) && ph.sizes[0]) return imgUrl(ph.sizes[0].src);
    const key = `ph|${ph.id}|${ph.rot}`;
    if (thumbs.has(key)) return thumbs.get(key);
    queueThumb(key, async () => {
      const m = await master(ph), tw = Math.min(480, m.w), th = Math.round(m.h * tw / m.w);
      return straighten(m.img, m.w, m.h, ph.rot, tw, th);
    });
    return '';
  }
  function coverOf(p) {
    const ph = p.photos[0];
    if (!ph) return '';
    if (!coverChanged(p) && p.cover?.sizes?.[0]) return imgUrl(p.cover.sizes[0].src);
    const key = `sq|${ph.id}|${ph.rot}|${JSON.stringify(p.cover?.crop ?? null)}`;
    if (thumbs.has(key)) return thumbs.get(key);
    queueThumb(key, async () => {
      const m = await master(ph), full = straighten(m.img, m.w, m.h, ph.rot);
      const { x0, y0, side } = squareRect(m.w, m.h, p.cover?.crop);
      const sq = canvas(side, side); ctx2d(sq).drawImage(full, x0, y0, side, side, 0, 0, side, side); free(full);
      const r = resize(sq, side, side, 360, 360); free(sq);
      return r;
    });
    return '';
  }
  let thumbChain = Promise.resolve();
  function queueThumb(key, make) {
    if (pending.has(key)) return;
    pending.add(key);
    thumbChain = thumbChain.then(async () => {
      try {
        const c = await make();
        const b = await new Promise(r => c.toBlob(r, 'image/jpeg', .85)); free(c);
        thumbs.set(key, URL.createObjectURL(b));
        document.querySelectorAll(`img[data-key="${CSS.escape(key)}"]`).forEach(i => i.src = thumbs.get(key));
      } catch (e) { console.warn('thumb', key, e); }
      pending.delete(key);
    });
  }
  const thumbKey = (p, ph) => photoChanged(p, ph) ? `ph|${ph.id}|${ph.rot}` : '';
  const coverKey = p => p.photos[0] && coverChanged(p) ? `sq|${p.photos[0].id}|${p.photos[0].rot}|${JSON.stringify(p.cover?.crop ?? null)}` : '';

  // ---------- rendering ----------
  let sortHouses = null, sortPhotos = null;
  function renderAll() { renderBar(); renderList(); renderDetail(); }
  function renderBar() {
    const ch = changes(), n = ch.reduce((a, c) => a + c.n, 0), dirty = isDirty();
    const b = $('#publish');
    b.disabled = !dirty || busy; b.textContent = dirty ? `Zveřejnit změny (${n})` : 'Zveřejnit změny';
    $('#discard').disabled = !dirty || busy;
  }
  function renderList() {
    const ul = $('#houseList');
    ul.innerHTML = data.projects.map(p => {
      const src = coverOf(p);
      return `<li class="house${p.id === selId ? ' sel' : ''}" data-id="${esc(p.id)}">
        <img class="th" alt="" ${src ? `src="${esc(src)}"` : ''} data-key="${esc(coverKey(p))}">
        <span class="txt"><span class="nm${p.name ? '' : ' none'}">${esc(p.name || 'Bez názvu')}</span>
        <span class="sub">${plural(p.photos.length, 'fotka', 'fotky', 'fotek')}${p.hidden ? ' <span class="badge">skrytý</span>' : ''}${!origProj(p.id) ? ' <span class="badge">nový</span>' : ''}</span></span>
        <span class="grip" aria-hidden="true">⋮⋮</span></li>`;
    }).join('');
    ul.querySelectorAll('.house').forEach(li => li.onclick = () => {
      selId = li.dataset.id; renderList(); renderDetail();
      if (matchMedia('(max-width: 760px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    sortHouses?.destroy();
    sortHouses = Sortable.create(ul, { animation: 150, delay: 180, delayOnTouchOnly: true, touchStartThreshold: 5, onEnd: () => {
      const order = [...ul.children].map(li => li.dataset.id);
      data.projects.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      renderAll();
    } });
  }
  function renderDetail() {
    const el = $('#detail'), p = proj(selId);
    sortPhotos?.destroy(); sortPhotos = null;
    if (!p) { el.innerHTML = `<p class="empty">Vyberte dům vlevo, nebo přidejte nový.</p>`; return; }
    const cover = coverOf(p);
    el.innerHTML = `
      <div class="d-head">
        <div class="field"><label for="nm">Název domu (zobrazí se na webu)</label>
          <input id="nm" class="name" type="text" value="${esc(p.name)}" placeholder="Bez názvu" maxlength="80"></div>
        <label class="toggle"><input type="checkbox" id="hid" ${p.hidden ? 'checked' : ''}> Skrýt na webu</label>
      </div>
      <div class="d-cover">
        ${p.photos.length ? `<img class="sq" alt="Titulní fotka" ${cover ? `src="${esc(cover)}"` : ''} data-key="${esc(coverKey(p))}">` : '<div class="sq"></div>'}
        <div class="info"><h3>Titulní dlaždice</h3>
          <span>${p.photos.length ? 'Čtvercový výřez první fotky. Jinou titulní fotku zvolíte tlačítkem „Titulní“ u fotky.' : 'Dům zatím nemá fotky – na webu se nezobrazí.'}</span>
          ${p.photos.length ? '<span><button class="btn" id="crop">Upravit výřez</button></span>' : ''}</div>
      </div>
      <div class="sec-head"><h2>Fotky (${p.photos.length})</h2>
        <label class="btn primary" for="file">+ Nahrát fotky</label>
        <input id="file" type="file" multiple accept="image/*,.heic,.heif" hidden></div>
      <div class="drop" id="drop">Fotky sem můžete i přetáhnout. Pořadí změníte přetažením fotky, první je titulní.</div>
      <p class="progress" id="upProg"></p>
      <div class="photos" id="photos">${p.photos.map((ph, i) => {
        const src = thumbOf(p, ph), o = origPhoto(p.id, ph.id);
        return `<div class="photo" data-id="${esc(ph.id)}">
          <div class="pic"><img alt="" ${src ? `src="${esc(src)}"` : ''} data-key="${esc(thumbKey(p, ph))}">
            ${i === 0 ? '<span class="tag"><span class="badge">Titulní</span></span>' : ''}
            ${ph.rot ? `<span class="rot"><span class="badge">${fmtDeg(ph.rot)}</span></span>` : ''}
            ${!o ? '<span class="new"><span class="badge">nová</span></span>' : ''}</div>
          <div class="acts">
            ${i ? '<button class="btn small" data-a="cover">Titulní</button>' : ''}
            <button class="btn small" data-a="rot">Srovnat</button>
            <button class="btn small danger" data-a="del" aria-label="Smazat fotku">Smazat</button></div></div>`;
      }).join('')}</div>
      <div class="danger-zone"><button class="btn danger" id="delHouse">Smazat dům</button></div>`;

    $('#nm').oninput = e => { p.name = e.target.value; renderBar(); const li = $(`#houseList [data-id="${CSS.escape(p.id)}"] .nm`); if (li) { li.textContent = p.name || 'Bez názvu'; li.classList.toggle('none', !p.name); } };
    $('#nm').onchange = e => { p.name = e.target.value.trim(); e.target.value = p.name; renderAll(); };
    $('#hid').onchange = e => { p.hidden = e.target.checked; renderAll(); };
    $('#file').onchange = e => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); };
    $('#crop') && ($('#crop').onclick = () => cropEditor(p));
    $('#delHouse').onclick = async () => {
      if (!await ask('Smazat dům?', `<p>Dům ${esc(label(p))} i se všemi ${plural(p.photos.length, 'fotkou', 'fotkami', 'fotkami')} zmizí z webu po zveřejnění změn.</p>`, { ok: 'Smazat dům', danger: true })) return;
      const i = data.projects.indexOf(p); data.projects.splice(i, 1);
      selId = data.projects[Math.min(i, data.projects.length - 1)]?.id ?? null; renderAll();
    };
    const drop = $('#drop'), zone = el;
    zone.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } };
    zone.ondragleave = e => { if (!zone.contains(e.relatedTarget)) drop.classList.remove('over'); };
    zone.ondrop = e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };

    const grid = $('#photos');
    grid.querySelectorAll('.photo').forEach(div => {
      const ph = p.photos.find(x => x.id === div.dataset.id);
      div.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        if (b.dataset.a === 'cover') { p.photos.splice(p.photos.indexOf(ph), 1); p.photos.unshift(ph); setCoverPhoto(p); renderAll(); toast('Titulní fotka změněna'); }
        if (b.dataset.a === 'rot') rotEditor(p, ph);
        if (b.dataset.a === 'del') {
          if (!await ask('Smazat fotku?', '<p>Fotka zmizí z webu po zveřejnění změn.</p>', { ok: 'Smazat', danger: true })) return;
          const wasFirst = p.photos[0] === ph;
          p.photos.splice(p.photos.indexOf(ph), 1); local.delete(ph.id);
          if (wasFirst) setCoverPhoto(p);
          renderAll();
        }
      });
    });
    sortPhotos = Sortable.create(grid, { animation: 150, delay: 180, delayOnTouchOnly: true, touchStartThreshold: 5, filter: '.acts', preventOnFilter: false, onEnd: () => {
      const first = p.photos[0]?.id, order = [...grid.children].map(d => d.dataset.id);
      p.photos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      if (p.photos[0]?.id !== first) setCoverPhoto(p);
      renderAll();
    } });
  }
  const fmtDeg = d => `${d > 0 ? '+' : ''}${d.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}°`;
  // photos[0] changed: the crop belongs to the old photo -> centred square (or the published crop if it's the original cover again)
  function setCoverPhoto(p) {
    const o = origProj(p.id), ph = p.photos[0];
    if (!ph) { p.cover = null; return; }
    if (o?.cover && o.cover.photo === ph.id) p.cover = clone(o.cover);
    else p.cover = { ...(p.cover || {}), sizes: p.cover?.sizes || [], pos: [0.5, 0.5], photo: ph.id, crop: null };
  }

  function addHouse() {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const p = { id: `dum-${rnd(6)}`, name: '', place: '', year: '', hidden: false, order: null,
      date: `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`, cover: null, photos: [] };
    data.projects.unshift(p); selId = p.id; renderAll();
    $('#nm')?.focus();
    toast('Nový dům je nahoře v seznamu – pojmenujte ho a nahrajte fotky.', 3500);
  }

  // ---------- straighten editor ----------
  const MAXROT = 15;
  function fitBox(ratio) {
    const mw = Math.min(innerWidth - 60, 1040), mh = Math.max(180, innerHeight - (innerWidth < 760 ? 480 : 420));
    let w = mw, h = w / ratio; if (h > mh) { h = mh; w = h * ratio; }
    return { w: Math.round(w), h: Math.round(h) };
  }
  async function rotEditor(p, ph) {
    let rot = ph.rot || 0, drawing = false;
    const o = origPhoto(p.id, ph.id);
    const box = fitBox(ph.ratio);
    const b = openModal(`<h2>Srovnat fotku</h2>
      <p class="lbl">Posuňte jezdcem, nebo zapněte „Nakreslit čáru“ a táhněte podél hrany, která má být vodorovná nebo svislá.</p>
      <div class="ed-stage"><div class="frame" id="fr" style="width:${box.w}px;height:${box.h}px">
        <div class="loading">Načítám originál…</div><div class="grid"></div><svg id="ln"></svg></div></div>
      <div class="ed-ctrl"><input type="range" id="rr" min="${-MAXROT}" max="${MAXROT}" step="0.1" value="${rot}" aria-label="Úhel"></div>
      <div class="ed-ctrl">
        <button class="btn small" data-d="-1">−1°</button><button class="btn small" data-d="-0.1">−0,1°</button>
        <button class="btn small" data-d="0.1">+0,1°</button><button class="btn small" data-d="1">+1°</button>
        <span><input type="number" id="rn" min="${-MAXROT}" max="${MAXROT}" step="0.1" value="${rot}" aria-label="Úhel ve stupních"> °</span>
      </div>
      <div class="ed-ctrl"><button class="btn" id="draw">Nakreslit čáru</button><button class="btn ghost" id="zero">Vynulovat</button>
        ${o && o.rot !== rot ? '<button class="btn ghost" id="back">Vrátit zveřejněné</button>' : ''}</div>
      <div class="modal-btns"><button class="btn ghost" id="cancel">Zrušit</button><button class="btn primary" id="save">Uložit</button></div>`, { wide: true });
    const fr = $('#fr', b), ln = $('#ln', b);
    let img = null;
    const apply = () => {
      rot = Math.max(-MAXROT, Math.min(MAXROT, Math.round(rot * 10) / 10));
      $('#rr', b).value = rot; $('#rn', b).value = rot;
      if (img) img.style.transform = rot ? `rotate(${rot}deg) scale(${kOf(rot, box.w, box.h)})` : 'none';
    };
    b.querySelectorAll('[data-d]').forEach(x => x.onclick = () => { rot += +x.dataset.d; apply(); });
    $('#rr', b).oninput = e => { rot = +e.target.value; apply(); };
    $('#rn', b).onchange = e => { rot = +String(e.target.value).replace(',', '.') || 0; apply(); };
    $('#zero', b).onclick = () => { rot = 0; apply(); };
    $('#back', b) && ($('#back', b).onclick = () => { rot = o.rot; apply(); });
    $('#draw', b).onclick = () => { drawing = !drawing; $('#draw', b).classList.toggle('on', drawing); fr.classList.toggle('drawing', drawing); };
    $('#cancel', b).onclick = closeModal;
    $('#save', b).onclick = () => { ph.rot = rot; closeModal(); renderAll(); if (rot !== (o?.rot ?? 0)) toast('Srovnání uloženo'); };
    // draw a line: angle on screen -> correction so it becomes level (|a| <= 45°) or plumb
    let st = null;
    fr.onpointerdown = e => {
      if (!drawing) return;
      e.preventDefault(); fr.setPointerCapture(e.pointerId);
      const r = fr.getBoundingClientRect(); st = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    fr.onpointermove = e => {
      if (!st) return;
      const r = fr.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      ln.innerHTML = `<line x1="${st.x}" y1="${st.y}" x2="${x}" y2="${y}" stroke="#ffd34d" stroke-width="2"/><circle cx="${st.x}" cy="${st.y}" r="4" fill="#ffd34d"/>`;
      st.ex = x; st.ey = y;
    };
    fr.onpointerup = fr.onpointercancel = () => {
      if (!st) return;
      const s = st; st = null; ln.innerHTML = '';
      if (s.ex == null || Math.hypot(s.ex - s.x, s.ey - s.y) < 20) return;
      let a = Math.atan2(s.ey - s.y, s.ex - s.x) * 180 / Math.PI;   // screen angle, + = clockwise
      if (a > 90) a -= 180; if (a <= -90) a += 180;                  // (-90, 90]
      const d = Math.abs(a) <= 45 ? a : a > 0 ? a - 90 : a + 90;     // deviation from level / plumb
      const want = rot - d;
      if (Math.abs(want) > MAXROT) toast(`Čára je příliš šikmá – srovnání lze nejvýš o ${MAXROT}°.`);
      rot = want; apply();
      drawing = false; $('#draw', b).classList.remove('on'); fr.classList.remove('drawing');
      toast(Math.abs(a) <= 45 ? 'Srovnáno podle vodorovné čáry' : 'Srovnáno podle svislé čáry');
    };
    try {
      const m = await master(ph);
      if (!b.isConnected || modalBox.querySelector('#fr') !== fr) return;
      img = m.img instanceof HTMLImageElement ? m.img.cloneNode() : null;
      if (!img) { const c = canvas(box.w * 2, Math.round(box.w * 2 * m.h / m.w)); ctx2d(c).drawImage(m.img, 0, 0, c.width, c.height); img = c; }
      img.alt = ''; fr.querySelector('.loading').remove(); fr.prepend(img); apply();
    } catch (e) { fr.querySelector('.loading').textContent = e.message; }
  }

  // ---------- cover crop editor ----------
  async function cropEditor(p) {
    const ph = p.photos[0];
    const box = fitBox(ph.ratio);
    const m0 = Math.min(box.w, box.h);
    let c = p.cover?.crop ? { ...p.cover.crop } : null;
    const cur = () => c || { x: (box.w - m0) / 2 / box.w, y: (box.h - m0) / 2 / box.h, s: 1 };
    const b = openModal(`<h2>Výřez titulní fotky</h2>
      <p class="lbl">Posuňte čtverec tažením, velikost změníte jezdcem. Tento čtverec se ukazuje jako dlaždice na webu.</p>
      <div class="ed-stage"><div class="frame" id="fr" style="width:${box.w}px;height:${box.h}px">
        <div class="loading">Načítám originál…</div><div class="crop-sq" id="sq"></div></div></div>
      <div class="ed-ctrl"><span class="lbl">Přiblížení</span><input type="range" id="zz" min="0.4" max="1" step="0.01"></div>
      <div class="modal-btns"><button class="btn ghost" id="centre">Na střed</button><span style="flex:1"></span>
        <button class="btn ghost" id="cancel">Zrušit</button><button class="btn primary" id="save">Uložit</button></div>`, { wide: true });
    const fr = $('#fr', b), sq = $('#sq', b), zz = $('#zz', b);
    const clamp = v => { const side = v.s * m0; v.x = Math.min(Math.max(0, v.x), (box.w - side) / box.w); v.y = Math.min(Math.max(0, v.y), (box.h - side) / box.h); return v; };
    const draw = () => { const v = cur(), side = v.s * m0; Object.assign(sq.style, { left: v.x * box.w + 'px', top: v.y * box.h + 'px', width: side + 'px', height: side + 'px' }); zz.value = 1.4 - v.s; };
    // slider: right = zoom in (smaller square)
    zz.min = 0.4; zz.max = 1; zz.step = 0.01;
    zz.oninput = () => {
      const v = { ...cur() }, s = Math.round((1.4 - +zz.value) * 100) / 100, cx = v.x * box.w + v.s * m0 / 2, cy = v.y * box.h + v.s * m0 / 2;
      v.s = Math.min(1, Math.max(0.4, s)); v.x = (cx - v.s * m0 / 2) / box.w; v.y = (cy - v.s * m0 / 2) / box.h; c = clamp(v); draw();
    };
    let drag = null;
    fr.onpointerdown = e => {
      e.preventDefault(); fr.setPointerCapture(e.pointerId);
      const v = { ...cur() }, r = fr.getBoundingClientRect(), side = v.s * m0;
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const inside = px >= v.x * box.w && px <= v.x * box.w + side && py >= v.y * box.h && py <= v.y * box.h + side;
      if (!inside) { v.x = (px - side / 2) / box.w; v.y = (py - side / 2) / box.h; c = clamp(v); draw(); }   // tap outside: jump there
      drag = { x: e.clientX, y: e.clientY, v: { ...cur() } };
    };
    fr.onpointermove = e => { if (!drag) return; const v = { ...drag.v }; v.x += (e.clientX - drag.x) / box.w; v.y += (e.clientY - drag.y) / box.h; c = clamp(v); draw(); };
    fr.onpointerup = fr.onpointercancel = () => { drag = null; };
    $('#centre', b).onclick = () => { c = null; draw(); };
    $('#cancel', b).onclick = closeModal;
    $('#save', b).onclick = () => {
      const r4 = v => Math.round(v * 1e4) / 1e4;
      const nc = c ? { x: r4(c.x), y: r4(c.y), s: r4(c.s) } : null;
      const centred = nc && nc.s === 1 && Math.abs(nc.x - r4((box.w - m0) / 2 / box.w)) < 2e-3 && Math.abs(nc.y - r4((box.h - m0) / 2 / box.h)) < 2e-3;
      p.cover = { ...(p.cover || { sizes: [], photo: ph.id }), crop: centred ? null : nc };
      closeModal(); renderAll();
    };
    draw();
    try {
      const m = await master(ph);
      if (modalBox.querySelector('#fr') !== fr) return;
      const cv = straighten(m.img, m.w, m.h, ph.rot, Math.min(m.w, box.w * 2), Math.round(Math.min(m.w, box.w * 2) * m.h / m.w));
      fr.querySelector('.loading').remove(); fr.prepend(cv);
    } catch (e) { fr.querySelector('.loading').textContent = e.message; }
  }

  // ---------- publish ----------
  const blobB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',', 2)[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function pool(items, n, fn) {
    let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  }

  async function publish() {
    if (busy || !isDirty()) return;
    const ch = changes();
    const ok = await ask('Zveřejnit změny na webu?', `<ul>${ch.map(c => `<li>${esc(c.text)}</li>`).join('')}</ul>
      <p class="lbl" style="margin-top:10px">Web se aktualizuje přibližně do minuty.</p>`, { ok: 'Zveřejnit' });
    if (!ok) return;
    busy = true; renderBar();
    const steps = ['Kontrola, že web mezitím nikdo nezměnil', 'Příprava fotek', 'Nahrávání', 'Uložení nové verze', 'Aktualizace webu'];
    const b = openModal(`<h2>Zveřejňuji…</h2><ul class="steps">${steps.map((s, i) => `<li data-s="${i}">${s}</li>`).join('')}</ul>
      <p id="pp" class="lbl"></p><div class="modal-btns" id="pb" hidden><button class="btn primary">Zavřít</button></div>`);
    const pp = $('#pp', b);
    const step = (i, txt = '') => {
      b.querySelectorAll('[data-s]').forEach(li => { const k = +li.dataset.s; li.className = k < i ? 'done' : k === i ? 'cur' : ''; });
      pp.textContent = txt;
    };
    const finish = (title, html, cls = '') => {
      busy = false;
      $('h2', b).textContent = title;
      if (cls) b.querySelector('li.cur')?.classList.replace('cur', cls);
      pp.innerHTML = html; $('#pb', b).hidden = false; $('#pb button', b).onclick = closeModal; renderAll();
    };
    try {
      // 1) fresh state of the repo
      step(0);
      const ref = await gh(`/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
      const head = ref.object.sha;
      const commit = await gh(`/git/commits/${head}`);
      const tree = await gh(`/git/trees/${commit.tree.sha}?recursive=1`);
      const cur = tree.tree.find(t => t.path === 'data.json');
      if (!cur || cur.sha !== dataSha) return conflict(b);

      // 2) render changed images
      const out = clone(data), files = [];   // files: [{path, blob}]
      const work = [];
      for (const p of out.projects) {
        for (const ph of p.photos) if (photoChanged(p, ph)) work.push({ p, ph, gallery: true });
        if (p.photos[0] && coverChanged(p)) {
          const w = work.find(x => x.ph === p.photos[0]);
          if (w) w.cover = true; else work.push({ p, ph: p.photos[0], cover: true });
        }
      }
      for (let i = 0; i < work.length; i++) {
        const { p, ph, gallery, cover } = work[i];
        step(1, `Fotka ${i + 1} z ${work.length}`);
        const m = await master(ph);
        const full = straighten(m.img, m.w, m.h, ph.rot);
        const tok = rnd(4);
        if (gallery) {
          const v = await sizes(full, m.w, m.h, `${ph.id}-${tok}`, render.gallery, render.quality / 100);
          ph.sizes = v.map(({ src, w, h }) => ({ src, w, h }));
          ph.ratio = Math.round(v[v.length - 1].w / v[v.length - 1].h * 1e4) / 1e4;
          v.forEach(x => files.push({ path: x.src, blob: x.blob }));
          if (local.has(ph.id)) files.push({ path: ph.master, blob: local.get(ph.id).blob });
        }
        if (cover) {
          const crop = p.cover?.crop ?? null, { x0, y0, side } = squareRect(m.w, m.h, crop);
          const sq = canvas(side, side); ctx2d(sq).drawImage(full, x0, y0, side, side, 0, 0, side, side);
          const v = await sizes(sq, side, side, `${ph.id}-sq-${tok}`, render.cover, render.quality / 100);
          free(sq);
          v.forEach(x => files.push({ path: x.src, blob: x.blob }));
          p.cover = { ...(p.cover || {}), sizes: v.map(({ src, w, h }) => ({ src, w, h })), pos: cropPos(crop, m.w, m.h), photo: ph.id, crop };
        }
        free(full);
      }
      out.projects.forEach((p, i) => { p.order = i; });
      out.rev = `admin-${new Date().toISOString()}-${rnd(4)}`;
      const json = JSON.stringify(out);

      // 3) upload blobs
      const items = [...files, { path: 'data.json', text: json }];
      const entries = [];
      let done = 0;
      step(2, `0 z ${items.length}`);
      await pool(items, 3, async f => {
        const body = f.text != null ? { content: f.text, encoding: 'utf-8' } : { content: await blobB64(f.blob), encoding: 'base64' };
        const r = await gh('/git/blobs', { method: 'POST', body });
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: r.sha, _f: f });
        step(2, `${++done} z ${items.length}`);
      });

      // 4) tree (+ deletions of unreferenced img/* and src/*), commit, move the branch
      step(3);
      const used = new Set(out.projects.flatMap(p => [...(p.cover?.sizes || []).map(s => s.src), ...p.photos.flatMap(ph => [...ph.sizes.map(s => s.src), ph.master])]));
      const dels = tree.truncated ? [] : tree.tree.filter(t => t.type === 'blob' && /^(img|src)\//.test(t.path) && !used.has(t.path))
        .map(t => ({ path: t.path, mode: '100644', type: 'blob', sha: null }));
      const nt = await gh('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree: [...entries.map(({ _f, ...e }) => e), ...dels] } });
      const msg = 'Admin: ' + shortSummary(ch);
      const nc = await gh('/git/commits', { method: 'POST', body: { message: msg + '\n\n' + ch.map(c => '- ' + c.text).join('\n'), tree: nt.sha, parents: [head] } });
      try { await gh(`/git/refs/heads/${encodeURIComponent(cfg.branch)}`, { method: 'PATCH', body: { sha: nc.sha, force: false } }); }
      catch (e) { if (e.status === 422 || e.status === 409) return conflict(b); throw e; }

      // published: this is the new baseline
      for (const e of entries) if (e._f.blob) localFiles.set(e.path, URL.createObjectURL(e._f.blob));
      dataSha = entries.find(e => e.path === 'data.json').sha;
      for (const [id, l] of local) { const p = out.projects.find(pr => pr.photos.some(x => x.id === id)); if (p) dims.set(id, { w: l.w, h: l.h }); }
      // keep new masters drawable from memory (raw.githubusercontent may lag a moment)
      for (const [id, l] of local) { const ph = out.projects.flatMap(p => p.photos).find(x => x.id === id); if (ph) localFiles.set(ph.master, URL.createObjectURL(l.blob)); }
      local.clear();
      orig = out; data = clone(out);
      renderAll(); busy = true;

      // 5) wait for GitHub Pages
      step(4, 'Web se aktualizuje…');
      if (onPages) {
        const t0 = Date.now();
        while (Date.now() - t0 < 4 * 60e3) {
          await new Promise(r => setTimeout(r, 5000));
          try { const d = await (await fetch(`../data.json?t=${Date.now()}`, { cache: 'no-store' })).json(); if (d.rev === out.rev) { step(5); return finish('Hotovo', 'Změny jsou na webu.'); } } catch { /* keep waiting */ }
          pp.textContent = `Web se aktualizuje… (${Math.round((Date.now() - t0) / 1000)} s)`;
        }
        step(5); return finish('Uloženo', 'Změny jsou uložené, web je ukáže během pár minut.');
      }
      step(5); return finish('Hotovo', 'Změny jsou uložené. Web je ukáže přibližně do minuty.');
    } catch (e) {
      console.error(e);
      finish('Zveřejnění se nepovedlo', `<span class="err">${esc(e.message || String(e))}</span><br>Vaše úpravy zůstaly zachované, můžete to zkusit znovu.`, 'err');
    }
  }
  function conflict(b) {
    busy = false;
    $('h2', b).textContent = 'Web mezitím změnil někdo jiný';
    b.querySelector('li.cur')?.classList.replace('cur', 'err');
    $('#pp', b).innerHTML = 'Někdo jiný (třeba z jiného zařízení) mezitím zveřejnil změny. Aby se nic nepřepsalo, načtěte prosím aktuální stav – <b>vaše nezveřejněné úpravy se tím zahodí</b>.';
    const pb = $('#pb', b); pb.hidden = false;
    pb.innerHTML = '<button class="btn ghost" id="cx">Zavřít</button><button class="btn primary" id="rl">Načíst aktuální stav</button>';
    $('#cx', b).onclick = () => { closeModal(); renderAll(); };
    $('#rl', b).onclick = async () => {
      closeModal(); boot('Načítám data webu…');
      try { await loadData(); } catch (e) { return boot(esc(e.message)); }
      $('#boot').hidden = true; $('#app').hidden = false; renderAll();
    };
    renderAll();
  }
  function shortSummary(ch) {
    const s = ch.map(c => c.text).join('; ');
    return s.length > 90 ? s.slice(0, 87) + '…' : s;
  }

  start();
})();
