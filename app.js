// Ateliér Klose – grid of square covers; a click moves the other tiles away and
// grows the chosen one into a gallery of the house in original aspect ratios.
//
// Motion (curves and durations are the tokens in app.css):
// - .fly covers the viewport and shows what is inside its frame. The frame is four numbers
//   (--fx/--fy/--fw/--fh, registered in app.css) that additive animations send from rect to rect:
//   a change of mind (Escape while opening, next while stepping) starts a new move on top of the
//   running one, so the frame keeps its momentum and turns around instead of stopping dead.
//   Nothing is laid out along the way – the frame is a clip-path and the photos move by transform –
//   so no frame is rounded to whole pixels. The tiles and the strip are sent the same way.
// - Photos are layers that sit at their final place in the viewer and add up (mix-blend-mode:
//   plus-lighter): one fades to 1 and the rest to 0 on one clock, which is a true dissolve at any
//   moment. A layer rides the frame: app.css transforms it so that it covers the frame, cropped like
//   the tile (cover at cover.pos), so tile <-> viewer is one registered image opening up. For a step
//   the layers are let go (each keeps its own copy of the frame and finishes its own way) and the
//   frame only reshapes around them.
// - Nothing waits for a timer: clean-up follows the animations themselves.
(() => {
  const $ = s => document.querySelector(s);
  const root = document.documentElement, body = document.body;
  const grid = $('#grid'), viewer = $('#viewer'), strip = $('#strip'), meta = $('#vmeta');
  const css = getComputedStyle(root);
  const token = name => css.getPropertyValue(name).trim();
  const ms = name => { const v = token(name); return parseFloat(v) * (v.endsWith('ms') ? 1 : 1000); };
  const now = () => performance.now();
  const srcset = sizes => sizes.map(s => `${s.src} ${s.w}w`).join(', ');
  const pick = (sizes, px) => (sizes.find(s => s.w >= px) || sizes[sizes.length - 1]).src;
  const done = el => Promise.allSettled(el.getAnimations({ subtree: true }).map(a => a.finished));
  let projects = [], cur = null, pushed = false, held = false, shut = -1e9;
  // old browsers that cannot add up animations of registered properties get the end states without the way between
  const probe = body.animate({ '--fw': [2, 4] }, { duration: 1000, composite: 'add' });
  probe.pause(); probe.currentTime = 500;
  const additive = probe.effect.composite === 'add' && getComputedStyle(body).getPropertyValue('--fw').trim() === '3';
  probe.cancel();

  // deep link: start in the viewer state, nothing flies
  if (location.hash.length > 1) { root.classList.add('instant'); body.classList.add('open'); viewer.classList.add('on'); }

  fetch('logo.svg').then(r => r.text()).then(svg => { $('.logo').innerHTML = svg; });
  const kBtn = $('#kontaktBtn'), kBox = $('#kontakt');
  kBtn.onclick = () => {
    const open = kBtn.getAttribute('aria-expanded') !== 'true';
    kBtn.setAttribute('aria-expanded', String(open));
    kBox.classList.toggle('open', open);
  };

  fetch('data.json', { cache: 'no-cache' }).then(r => r.json()).then(d => {
    projects = d.projects.filter(p => !p.hidden && p.photos.length);
    const start = projects.findIndex(p => p.id === decodeURIComponent(location.hash.slice(1)));
    held = start >= 0;   // deep link: the covers are hidden anyway, they load after the photo (release)
    projects.forEach((p, n) => {
      const li = document.createElement('li'), a = held ? 'data-' : '';
      li.className = 'tile';
      const label = p.name || `Stavba ${n + 1}`;
      li.innerHTML = `<button aria-label="${label} – fotky (${p.photos.length})">
        <img ${a}src="${pick(p.cover.sizes, 800)}" ${a}srcset="${srcset(p.cover.sizes)}"
             sizes="(min-width:1240px) 17vw, (min-width:700px) 22vw, 33vw"
             alt="" ${n > 7 ? 'loading="lazy"' : ''} decoding="async">
        ${p.name ? `<span class="cap">${p.name}</span>` : ''}</button>`;
      const btn = li.querySelector('button');
      // not the second click of a double click, and not while the tiles are only just coming back
      btn.onclick = e => { if (e.detail < 2 && now() - shut > Math.min(500, ms('--t') * .3 + ms('--t-in'))) open(n); };
      // get the first photo ready before the click lands
      const warm = () => load(photoSrc(p.photos[0], target(p.photos[0].ratio).w));
      btn.addEventListener('pointerenter', warm); btn.addEventListener('focus', warm);
      grid.append(li);
    });
    if (held) return open(start, true);
    body.classList.remove('open'); viewer.classList.remove('on');
    requestAnimationFrame(() => root.classList.remove('instant'));
    warmAll();
  });
  function release() {
    if (!held) return;
    held = false;
    for (const img of grid.querySelectorAll('img[data-src]')) { img.srcset = img.dataset.srcset; img.src = img.dataset.src; }
    warmAll();
  }
  // once the covers are in and the browser is idle: the small variant of every first photo, one at a time.
  // A click then flies the whole photo from its first frame, also on touch where no hover announces it.
  async function warmAll() {
    if (navigator.connection?.saveData) return;
    await Promise.all([...grid.querySelectorAll('img')].slice(0, 8).map(i => i.complete || new Promise(r => { i.onload = i.onerror = r; })));
    await new Promise(r => (window.requestIdleCallback || setTimeout)(r));
    for (const p of projects) await load(p.photos[0].sizes[0].src, 'low').ready;
  }

  // where a photo of the given aspect ratio sits in the viewer (measured on the viewer itself):
  // whole even pixels around one shared centre, so layers of
  // different photos never drift apart
  function target(ratio) {
    const mob = innerWidth < 560, vw = viewer.clientWidth;
    const stripH = parseFloat(css.getPropertyValue('--strip-h'));
    const mx = mob ? 0 : 84, top = mob ? 56 : 28, bottom = stripH + (mob ? 6 : 14);
    const aw = vw - 2 * mx, ah = viewer.clientHeight - top - bottom;
    let w = aw, h = w / ratio;
    if (h > ah) { h = ah; w = h * ratio; }
    w = 2 * Math.floor(w / 2); h = 2 * Math.floor(h / 2);
    return { x: Math.round(vw / 2) - w / 2, y: Math.round(top + ah / 2) - h / 2, w, h };
  }
  // where the tile is painted: its box snapped to device pixels, like the browser does
  function tileRect(btn) {
    const r = btn.getBoundingClientRect(), d = devicePixelRatio || 1, s = v => Math.round(v * d) / d;
    const x = s(r.left), y = s(r.top);
    return { x, y, w: s(r.right) - x, h: s(r.bottom) - y };
  }
  // A frame (the one of .fly, or a layer's own copy) is where it should be at once in style; the way
  // from the previous rect is played as an offset that runs out – offsets of overlapping moves add up.
  const KEYS = ['x', 'y', 'w', 'h'];
  const place = (el, st, r) => { st.rect = r; for (const k of KEYS) el.style.setProperty('--f' + k, r[k]); };
  function move(el, st, r, dur) {
    const a = st.rect;
    place(el, st, r);
    if (!additive || KEYS.every(k => a[k] === r[k])) return;
    const kf = {}, opt = { duration: dur, easing: token('--ease'), composite: 'add' };
    for (const k of KEYS) kf['--f' + k] = [a[k] - r[k], 0];
    Object.assign(el.animate(kf, opt), { id: 'move', kf, opt });
  }
  const moves = el => el.getAnimations().filter(a => a.id === 'move');
  const snap = (el, st, r) => { moves(el).forEach(a => a.cancel()); place(el, st, r); };
  const drop = l => { l.getAnimations().forEach(a => a.cancel()); l.remove(); };   // a removed layer takes its fade along: its image may return as a new layer
  const photoSrc = (ph, w) => pick(ph.sizes, w * Math.min(devicePixelRatio || 1, 2));

  // images are fetched and decoded off-screen; a layer is only ever made from a ready one
  const cache = new Map();
  function load(src, priority = 'high') {
    let e = cache.get(src);
    if (!e) {
      const img = new Image();
      img.alt = ''; img.draggable = false; img.fetchPriority = priority; img.src = src;
      e = { img, ok: false };
      e.ready = img.decode().then(() => { e.ok = true; }, () => { cache.delete(src); });
      cache.set(src, e);
    } else if (priority === 'high' && !e.ok) e.img.fetchPriority = 'high';
    return e;
  }
  const take = e => e.img.isConnected ? e.img.cloneNode() : e.img;
  function preload(i) {
    const ph = projects[cur.n].photos, n = ph.length, p = ph[(i + n) % n];
    load(photoSrc(p, target(p.ratio).w), 'low');
  }

  // --- photo layers inside the flying frame ---
  const shape = new WeakMap();   // layer -> { i: photo, sq: square cover, rect: its own frame once it is let go }
  // a layer of photo i sits at the photo's place in the viewer; app.css moves it from there while it rides a frame.
  // sq: the tile's square cover standing in for a photo that is still loading – the part of the photo it shows.
  function layer(c, img, i, sq) {
    img.getAnimations().forEach(a => a.cancel());
    img.removeAttribute('style');
    shape.set(img, { i, sq, rect: null });
    home(c, img);
    return img;
  }
  function home(c, img) {
    const { i, sq } = shape.get(img), p = projects[c.n], t = target(p.photos[i].ratio), pos = i ? [.5, .5] : p.cover.pos;
    const s = Math.min(t.w, t.h), ox = sq ? (t.w - s) * pos[0] : 0, oy = sq ? (t.h - s) * pos[1] : 0;
    Object.assign(img.style, { left: t.x + ox + 'px', top: t.y + oy + 'px', width: (sq ? s : t.w) + 'px', height: (sq ? s : t.h) + 'px' });
    for (const [k, v] of Object.entries({ X: t.x, Y: t.y, W: t.w, H: t.h, cx: pos[0], cy: pos[1], ox, oy })) img.style.setProperty('--' + k, v);
  }
  const cover = timg => Object.assign(new Image(), { src: timg.currentSrc || timg.src || timg.dataset.src, alt: '', draggable: false });
  // the first photo for the way tile <-> viewer: sharp, else small, else the tile's own cover
  function first(c) {
    const ph = projects[c.n].photos[0], hi = load(photoSrc(ph, target(ph.ratio).w)), lo = load(ph.sizes[0].src), e = hi.ok ? hi : lo.ok ? lo : null;
    return e ? layer(c, take(e), 0) : layer(c, cover(c.btn.querySelector('img')), 0, true);
  }
  // let go of every layer that rides the frame: it gets the frame's rest rect and running moves as
  // its own and finishes its way, whatever the frame does next
  function letGo(c) {
    for (const l of c.box.children) {
      const s = shape.get(l);
      if (s.rect) continue;
      place(l, s, c.rect);
      for (const a of moves(c.fly)) {
        const b = Object.assign(l.animate(a.kf, a.opt), { id: 'move', kf: a.kf, opt: a.opt });
        if (a.startTime == null) b.currentTime = a.currentTime; else b.startTime = a.startTime;
      }
    }
  }
  function ride(l) {
    moves(l).forEach(a => a.cancel());
    shape.get(l).rect = null;
    for (const k of KEYS) l.style.removeProperty('--f' + k);
  }
  // c.top fades to 1, every other layer to 0, all from their current value on one clock
  function dissolve(c, dur, easing) {
    const all = [...c.box.children];
    const o = new Map(all.map(l => [l, +getComputedStyle(l).opacity]));
    all.sort((a, b) => o.get(b) - o.get(a));   // drop what has faded away; under a burst of steps keep the 8 strongest
    all.forEach((l, k) => { if (l !== c.top && (o.get(l) < .02 || k > 7)) drop(l); });
    for (const l of c.box.children) {
      const from = getComputedStyle(l).opacity, to = l === c.top ? 1 : 0;
      l.getAnimations().forEach(a => a.id !== 'move' && a.cancel());
      l.style.opacity = to;
      l.animate({ opacity: [from, to] }, { duration: dur, easing });
    }
  }
  // when everything in the frame has come to rest (and nothing newer started): one layer, riding the frame
  async function settle(c, g) {
    await done(c.fly);
    if (c.gen !== g) return;
    [...c.box.children].forEach(l => l !== c.top && drop(l));
    if (c.top) ride(c.top);
    c.loose = false;
  }
  // bring image e of photo i on top; the frame reshapes if it is another photo
  function put(c, e, i) {
    if (c.at === i && c.top.src === e.img.src) return;
    const tr = target(projects[c.n].photos[i].ratio), img = layer(c, take(e), i);
    const hurry = c.loose && c.at !== i;   // a step cutting into a step dissolves faster: quick browsing keeps up
    if (c.at !== i) { letGo(c); c.loose = true; move(c.fly, c, tr, ms('--t-step')); }
    if (c.loose) place(img, shape.get(img), tr);   // at home from the start; the frame comes to it
    img.style.opacity = 0;
    c.box.append(img);
    c.at = i; c.top = img;
    dissolve(c, ms('--t-fade') * (hurry ? .6 : 1), 'linear');
    settle(c, ++c.gen);
  }
  // show photo c.i as soon as an image of it is ready: the small one (shared with the strip) if the
  // sharp one is late, then the sharp one over it – same place and size, so that is only a sharpening.
  // Everything else is fetched once this one is in.
  async function present(c) {
    const i = c.i, ph = projects[c.n].photos[i], lo = load(ph.sizes[0].src);
    const live = () => cur === c && c.i === i && !c.closing;
    if (c.deep && !c.top && !lo.ok) await lo.ready;   // deep link, nothing to look at yet: the small file goes first, alone
    const hi = load(photoSrc(ph, target(ph.ratio).w));
    if (!hi.ok && !lo.ok) await Promise.race([hi.ready, lo.ready]);
    if (!hi.ok && lo.ok && live()) put(c, lo, i);
    await hi.ready;
    if (!live()) return;
    if (hi.ok) put(c, hi, i);
    release();
    preload(i + 1); preload(i - 1);
    if (!c.fed) { c.fed = true; feed(c); feed(c); }
  }
  // thumbnails come two at a time, the ones next to the current photo first, so a photo that is asked
  // for meanwhile does not queue behind the whole strip (they are the small variants: a step finds them ready)
  async function feed(c) {
    while (cur === c) {
      const all = thumbs(), n = all.length, far = k => Math.min((k - c.i + n) % n, (c.i - k + n) % n);
      const t = all.map((b, k) => [far(k), b.firstChild]).filter(x => x[1].dataset.src).sort((a, b) => a[0] - b[0])[0]?.[1];
      if (!t) return;
      const src = t.dataset.src;
      delete t.dataset.src;
      await load(src, 'low').ready;
      t.src = src;
    }
  }

  // the other tiles move away from the chosen one, the far ones farther (the gaps between them only open);
  // on the way back the near ones start first
  const at = new WeakMap(), lag = new WeakMap();   // tile -> [x, y] it is shifted by, its delay on the way back
  function slide(t, x, y, delay) {
    const [ox, oy] = at.get(t) || [0, 0];
    if (!additive || (ox === x && oy === y)) return;
    at.set(t, [x, y]);
    t.style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
    t.animate({ transform: [`translate(${ox - x}px, ${oy - y}px)`, 'translate(0px, 0px)'] }, { duration: ms('--t'), easing: token('--ease'), delay, fill: 'backwards', composite: 'add' });
  }
  function scatter(li) {
    const mid = t => [t.offsetLeft + t.offsetWidth / 2, t.offsetTop + t.offsetHeight / 2];
    const [cx, cy] = mid(li), far = Math.min(Math.max(innerWidth, innerHeight) * .2, 280);
    const all = [...grid.children].filter(t => t !== li).map(t => { const [x, y] = mid(t); return { t, dx: x - cx, dy: y - cy, len: Math.hypot(x - cx, y - cy) || 1 }; });
    const max = Math.max(...all.map(a => a.len));
    for (const { t, dx, dy, len } of all) {
      const by = far * (.7 + .3 * len / max) / len;
      lag.set(t, Math.min(Math.round(len / li.offsetWidth - 1) * 30, 90));
      slide(t, dx * by, dy * by, 0);
      t.classList.add('away');
    }
  }
  function gather(turn) {
    for (const t of grid.children) {
      const d = turn ? 0 : lag.get(t) || 0;
      t.style.setProperty('--d', d + 'ms');
      slide(t, 0, 0, d);
      t.classList.remove('away');
    }
  }

  function open(n, instant, keep) {   // keep: the history entry is already there (forward)
    if (cur) { if (!cur.closing) return; retire(cur); }   // another house picked while one is flying home
    const p = projects[n], li = grid.children[n], btn = li.querySelector('button'), tr = target(p.photos[0].ratio);
    const fly = document.createElement('div'), box = document.createElement('div');
    fly.className = 'fly'; box.className = 'in';
    fly.append(box);
    const c = cur = { n, i: 0, fly, box, li, btn, gen: 0, at: null, top: null, loose: false, closing: false, deep: !!instant, t0: now() };
    if (instant) {
      li.scrollIntoView({ block: 'center' });
      place(fly, c, tr);
    } else {
      place(fly, c, tileRect(btn));
      box.style.transform = getComputedStyle(btn.querySelector('img')).transform;   // take over the hover zoom
      c.top = first(c);
      c.at = 0;
      box.append(c.top);
    }
    body.append(fly);
    li.classList.add('hide');
    buildStrip(p);
    scatter(li);
    body.classList.remove('turn');
    body.classList.add('locked', 'open');
    viewer.classList.add('on'); viewer.classList.toggle('ui', !instant);
    viewer.setAttribute('aria-hidden', 'false');
    fly.offsetWidth;   // commit the start state, then let go
    move(fly, c, tr, ms('--t'));
    box.style.transform = 'none';
    settle(c, ++c.gen);
    markStrip(true); updateMeta(); present(c);
    if (keep) pushed = true;
    else if (!instant || !location.hash) { history.pushState({ v: 1 }, '', '#' + encodeURIComponent(p.id)); pushed = true; }
    if (instant) requestAnimationFrame(() => { root.classList.remove('instant'); viewer.classList.add('ui'); });
  }

  const thumbs = () => [...(strip.firstChild?.children || [])];
  function buildStrip(p) {
    strip.innerHTML = '<div class="row"></div>';
    p.photos.forEach((ph, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', `Fotka ${i + 1}`);
      b.style.aspectRatio = ph.ratio;   // the row has its final layout before any thumbnail arrives
      b.innerHTML = `<img data-src="${ph.sizes[0].src}" alt="">`;   // src: once the photo itself is in (feed)
      b.firstChild.onload = e => e.target.classList.add('in');
      b.onclick = () => show(i);
      strip.firstChild.append(b);
    });
  }
  // the current thumbnail goes to the middle: the strip is scrolled there at once and the row plays the
  // difference as an offset that runs out, like the frame (jump: no way to play, the strip was just built)
  function markStrip(jump) {
    const all = thumbs(), b = all[cur.i], from = strip.scrollLeft;
    all.forEach((t, i) => t.setAttribute('aria-current', i === cur.i ? 'true' : 'false'));
    if (!b) return;
    strip.scrollLeft = b.offsetLeft + b.offsetWidth / 2 - strip.clientWidth / 2;
    const by = strip.scrollLeft - from;
    if (by && !jump && additive) strip.firstChild.animate({ transform: [`translateX(${by}px)`, 'translateX(0px)'] }, { duration: ms('--t-step'), easing: token('--ease'), composite: 'add' });
  }
  function updateMeta() {
    const p = projects[cur.n];
    meta.textContent = `${p.name ? p.name + ' · ' : ''}${cur.i + 1} / ${p.photos.length}`;
  }

  function show(i) {
    const c = cur;
    if (!c || c.closing) return;
    const n = projects[c.n].photos.length;
    i = (i + n) % n;
    if (i === c.i) return;
    c.i = i;
    markStrip(); updateMeta(); present(c);
  }

  async function close(fromHistory) {
    const c = cur;
    if (!c || c.closing || (c.leaving && !fromHistory)) return;
    if (pushed && !fromHistory) { c.leaving = true; history.back(); return; }   // popstate calls close(true)
    pushed = false;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    release();
    c.closing = true; c.i = 0;
    shut = now();
    const tile = tileRect(c.btn), dur = ms('--t'), turn = shut - c.t0 < dur;   // turn: closed while still opening
    // land as the first photo cropped like the tile; from another photo it dissolves in on the frame's own clock
    if (c.at !== 0) {
      c.top = first(c);
      c.top.style.opacity = 0;
      c.box.append(c.top);
      c.at = 0;
    }
    for (const l of c.box.children) { const s = shape.get(l); if (s.rect) move(l, s, tile, dur); }   // layers let go for a step shrink to the tile along with the frame
    if (c.box.children.length > 1) dissolve(c, dur, token('--ease'));
    c.loose = false;
    c.fly.style.pointerEvents = 'none';
    move(c.fly, c, tile, dur);
    body.classList.toggle('turn', turn);   // the page comes back without the usual wait
    gather(turn);
    body.classList.remove('open');
    viewer.classList.remove('on', 'ui');
    const g = ++c.gen;
    await done(c.fly);
    if (c.gen !== g) return;   // replaced meanwhile
    c.li.classList.remove('hide');
    viewer.setAttribute('aria-hidden', 'true');
    body.classList.remove('locked', 'turn');
    cur = null;
    c.li.classList.add('calm');   // no hover zoom until the pointer moves again
    addEventListener('pointermove', () => c.li.classList.remove('calm'), { once: true });
    c.btn.focus({ preventScroll: true });
    c.fly.style.opacity = 0;   // the tile is back underneath: the photo fades off it instead of being swapped for it
    await done(c.fly);
    c.fly.remove();
  }
  // another house was picked while this one was still flying home: let it fade out on its way
  function retire(c) {
    c.gen++;
    c.fly.style.opacity = 0;
    c.li.classList.remove('hide');   // its tile returns with the others, under the fading photo
    done(c.fly).then(() => c.fly.remove());
    cur = null;
  }

  addEventListener('popstate', () => {
    const n = projects.findIndex(p => p.id === decodeURIComponent(location.hash.slice(1)));
    if (n < 0) { if (cur) close(true); }
    else if (!cur || cur.closing) open(n, false, true);   // forward again
  });
  $('#vclose').onclick = () => close();
  $('#vprev').onclick = () => cur && show(cur.i - 1);
  $('#vnext').onclick = () => cur && show(cur.i + 1);
  viewer.querySelector('.backdrop').onclick = () => close();
  let lastKey = 0;
  addEventListener('keydown', e => {
    if (!cur) return;
    if (e.key === 'Escape') return close();
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (e.repeat && e.timeStamp - lastKey < 160) return;   // a held key walks, it does not race
    lastKey = e.timeStamp;
    show(cur.i + (e.key === 'ArrowRight' ? 1 : -1));
  });
  // swipe / tap on the photo
  let down = null;
  addEventListener('pointerdown', e => { down = cur && e.target.closest('.fly') ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
  addEventListener('pointercancel', () => { down = null; });   // the browser took the gesture (pinch zoom)
  addEventListener('pointerup', e => {
    if (!down || !cur || e.pointerId !== down.id) { down = null; return; }
    const dx = e.clientX - down.x, dy = e.clientY - down.y; down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(cur.i + (dx < 0 ? 1 : -1));
    else if (Math.abs(dy) > 80 && dy > 0) close();
    // a tap is "next" – but not the second half of the double click that opened the house
    else if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && now() - cur.t0 > Math.max(ms('--t'), 500)) show(cur.i + 1);
  });
  addEventListener('resize', () => {
    const c = cur;
    if (!c) return;
    // snap: one layer riding the frame; a frame on its way home lands at once
    [...c.box.children].forEach(l => l !== c.top && drop(l));
    if (c.top) { home(c, c.top); ride(c.top); }
    c.loose = false;
    if (c.closing) return snap(c.fly, c, tileRect(c.btn));
    snap(c.fly, c, target(projects[c.n].photos[c.at ?? c.i].ratio));
    scatter(c.li);
    markStrip(true);
  });
})();
