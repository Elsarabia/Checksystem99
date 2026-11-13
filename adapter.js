/*
  Check System · conexión con Supabase.
  Da a la app la misma interfaz de datos que tenía en Claude (db, room, user, downloads),
  pero guardando todo en el proyecto "Check System" de Supabase. También maneja las cuentas:
  la primera que se registra es la del administrador y las demás esperan su aprobación.
*/
(function () {
  'use strict';
  const SUPABASE_URL = 'https://kaxtkjplcqcedmdmitrd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_2Ks7W4BPwbJ0MhHQttCusA_zxaGU9i6'; // llave pública: es seguro que esté aquí
  const LIVE_TOPIC = 'check-system-live';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const appUrl = () => location.origin + location.pathname;
  const clientId = Math.random().toString(36).slice(2, 12);
  let me = null, signedInOnce = false, authResolve;
  const authReady = new Promise(r => { authResolve = r; });

  const sb = window.supabase && window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'checksystem-auth' }
  });

  function toErr(error) {
    const msg = String((error && error.message) || error || '');
    if (/fetch|network|Load failed|NetworkError/i.test(msg)) return { code: 'unavailable', message: 'Sin conexión a internet' };
    if (error && (error.code === 'P0002' || error.code === '42501' || error.code === '23514')) return { code: 'invalid_argument', message: msg };
    if (error && (error.status === 401 || error.code === 'PGRST301')) return { code: 'not_granted', message: 'Tu sesión terminó' };
    return { code: 'invalid_argument', message: msg || 'Algo salió mal' };
  }
  async function run(promise) {
    let r;
    try { r = await promise; } catch (e) { throw toErr(e); }
    if (r.error) throw toErr(r.error);
    return r.data;
  }

  /* ======================= datos (misma interfaz que en Claude) ======================= */
  const cache = new Map(), collSubs = new Map(), docSubs = new Map(), loadedColls = new Set();
  const collOf = p => p.split('/').slice(0, -1).join('/');
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  function docSnap(p) { const e = cache.get(p); return { id: p.split('/').pop(), exists: !!e, data: () => (e ? e.data : undefined), metadata: META }; }
  function pathsIn(coll) { const out = []; cache.forEach((_, p) => { if (collOf(p) === coll) out.push(p); }); return out; }
  function notify(p) {
    const cs = collSubs.get(collOf(p)); if (cs) cs.forEach(s => s.fire());
    const ds = docSubs.get(p); if (ds) ds.forEach(f => f());
  }
  function applyChange(p, data, v) {
    const cur = cache.get(p);
    if (data == null) { if (!cur) return; cache.delete(p); }
    else { if (cur && v && cur.v > v) return; cache.set(p, { data, v: v || 0 }); }
    notify(p);
  }
  async function loadColl(coll) {
    const rows = await run(sb.from('docs').select('path,data,v').eq('coll', coll));
    pathsIn(coll).forEach(p => cache.delete(p));
    rows.forEach(r => cache.set(r.path, { data: r.data, v: r.v }));
    loadedColls.add(coll);
    const cs = collSubs.get(coll); if (cs) cs.forEach(s => s.fire());
  }
  async function loadDoc(p) {
    const row = await run(sb.from('docs').select('data,v').eq('path', p).maybeSingle());
    if (row) cache.set(p, { data: row.data, v: row.v }); else cache.delete(p);
    const ds = docSubs.get(p); if (ds) ds.forEach(f => f());
  }
  function keepTrying(fn, err) {
    authReady.then(fn).catch(e => {
      if (e && e.code === 'unavailable') setTimeout(() => keepTrying(fn, err), 5000);
      else if (err && e && e.code !== 'not_granted') err(e);
    });
  }
  function makeQuery(coll, o) {
    const build = () => {
      let docs = pathsIn(coll).map(docSnap);
      if (o.f) {
        const f = o.f, s = o.dir === 'desc' ? -1 : 1;
        docs.sort((a, b) => { const x = a.data()[f], y = b.data()[f]; return x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : (x < y ? -s : s); });
      } else docs.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (o.n) docs = docs.slice(0, o.n);
      return { docs, size: docs.length, empty: !docs.length, metadata: META, docChanges: () => [] };
    };
    const query = {
      path: coll,
      where() { return query; },
      orderBy(f, dir) { return makeQuery(coll, Object.assign({}, o, { f, dir: dir || 'asc' })); },
      limit(n) { return makeQuery(coll, Object.assign({}, o, { n })); },
      async get() { await authReady; await loadColl(coll); return build(); },
      onSnapshot(next, err) {
        const sub = { fire: () => { if (loadedColls.has(coll)) { try { next(build()); } catch (e) { console.error(e); } } } };
        if (!collSubs.has(coll)) collSubs.set(coll, new Set());
        collSubs.get(coll).add(sub);
        keepTrying(() => loadColl(coll), err);
        return () => { const s = collSubs.get(coll); if (s) s.delete(sub); };
      }
    };
    return query;
  }
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      async get() { await authReady; await loadDoc(p); return docSnap(p); },
      async set(data) { await authReady; const r = await run(sb.rpc('doc_set', { p, d: data })); applyChange(p, r.data, r.v); },
      async update(data) { await authReady; const r = await run(sb.rpc('doc_update', { p, d: data })); applyChange(p, r.data, r.v); },
      async delete() { await authReady; await run(sb.from('docs').delete().eq('path', p)); applyChange(p, null); },
      async acquire() { return { acquired: true }; },
      onSnapshot(next, err) {
        const f = () => { try { next(docSnap(p)); } catch (e) { console.error(e); } };
        if (!docSubs.has(p)) docSubs.set(p, new Set());
        docSubs.get(p).add(f);
        keepTrying(() => loadDoc(p), err);
        return () => { const s = docSubs.get(p); if (s) s.delete(f); };
      },
      collection(sub) { return collection(p + '/' + sub); }
    };
  }
  function collection(c) {
    return Object.assign(makeQuery(c, {}), {
      doc: id => docRef(c + '/' + (id || newId())),
      async add(data) { const r = docRef(c + '/' + newId()); await r.set(data); return r; }
    });
  }
  const DB = Object.freeze({ doc: docRef, collection });

  /* ---- tiempo real ---- */
  const roomHandlers = new Map(), peersHandlers = new Set();
  let docsChannel = null, live = null;
  function resync() {
    collSubs.forEach((subs, coll) => { if (subs.size) loadColl(coll).catch(() => {}); });
    docSubs.forEach((subs, p) => { if (subs.size) loadDoc(p).catch(() => {}); });
  }
  async function openRealtime() {
    try { await sb.realtime.setAuth(); } catch (e) {}
    docsChannel = sb.channel('docs-cambios')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, pl => {
        if (pl.eventType === 'DELETE') { if (pl.old && pl.old.path) applyChange(pl.old.path, null); }
        else if (pl.new && pl.new.path) applyChange(pl.new.path, pl.new.data, pl.new.v);
      })
      .subscribe(st => { if (st === 'SUBSCRIBED') resync(); });
    live = sb.channel(LIVE_TOPIC, { config: { private: true, broadcast: { self: false }, presence: { key: clientId } } })
      .on('broadcast', { event: 'emit' }, ({ payload }) => {
        if (!payload || typeof payload.topic !== 'string') return;
        const hs = roomHandlers.get(payload.topic); if (!hs) return;
        const msg = { topic: payload.topic, data: payload.data, peer: payload.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false };
        hs.forEach(h => { try { h(msg); } catch (e) { console.error(e); } });
      })
      .on('presence', { event: 'sync' }, () => {
        const n = Math.max(1, Object.keys(live.presenceState()).length);
        const peers = Array.from({ length: n }, (_, i) => ({ peer: 'p' + i, kind: 'viewer', presence: {}, isMe: i === 0, sameTab: i === 0, by: null, guest: false, updatedAt: Date.now() }));
        peersHandlers.forEach(h => { try { h({ peers, joined: [], left: [], updated: [] }); } catch (e) {} });
      })
      .subscribe(async st => { if (st === 'SUBSCRIBED') { try { await live.track({ desde: Date.now() }); } catch (e) {} } });
  }
  const ROOM = Object.freeze({
    emit: (topic, data) => authReady.then(() => (live ? live.send({ type: 'broadcast', event: 'emit', payload: { topic, data, from: clientId } }) : null)).then(() => {}),
    on(topic, h) { if (!roomHandlers.has(topic)) roomHandlers.set(topic, new Set()); roomHandlers.get(topic).add(h); return () => roomHandlers.get(topic).delete(h); },
    onPeers(h) { peersHandlers.add(h); return () => peersHandlers.delete(h); },
    presence: async () => {}, peers: () => [], connected: () => !!live
  });
  const writer = () => !!me && (me.role === 'admin' || me.role === 'profe');
  const USER = Object.freeze({
    isOwner: async () => !!me && me.role === 'admin',
    canEdit: async () => writer(),
    can: async c => (c === 'data.write' ? writer() : null),
    id: async () => (me ? me.id : null),
    me: async () => ({ id: me ? me.id : null, name: me ? me.name : '', avatarUrl: '', color: '', email: me ? me.email : null, isOwner: !!me && me.role === 'admin', canEdit: writer() }),
    profiles: async () => ({})
  });
  function saveFile(filename, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }
  const DOWNLOADS = Object.freeze({ save: async ({ filename, data }) => { saveFile(filename, data); return { status: 'saved' }; } });
  const CAPS = { db: DB, room: ROOM, user: USER, downloads: DOWNLOADS };
  window.claude = Object.freeze({ use: name => (name in CAPS && sb ? authReady.then(() => CAPS[name]) : Promise.resolve(null)) });

  /* ======================= pantalla de acceso ======================= */
  const style = document.createElement('style');
  style.textContent = `
    .auth{position:fixed;inset:0;z-index:80;background:var(--ink);display:flex;align-items:center;justify-content:center;overflow:auto;padding-block:max(24px,env(safe-area-inset-top,0px)) max(24px,env(safe-area-inset-bottom,0px));padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
    .auth::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(200,16,46,.22),transparent 60%);pointer-events:none}
    .auth-card{position:relative;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
    .auth-card .badge{width:84px;height:84px;border-radius:18px;margin-bottom:6px}
    .auth-card .badge img{height:62px}
    .auth-card h1{margin:0;font:900 44px/.9 var(--f-display);text-transform:uppercase;letter-spacing:.01em}
    .auth-card p{margin:0;color:var(--ash)}
    .auth-card .btn{min-height:50px;font-size:16px}
    .auth-links{display:flex;flex-wrap:wrap;gap:6px 16px}
    .auth-links button{border:0;background:none;padding:4px 0;color:var(--gold);font:600 14px/1.3 var(--f-label);letter-spacing:.04em;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
    .auth-ok{color:var(--calm);font:600 14px/1.4 var(--f-label)}
    .team-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 12px;background:var(--slab-2);border-radius:10px}
    .team-row b{display:block;font:700 16px/1.2 var(--f-label);overflow-wrap:anywhere}
    .team-row span{font-size:13px;color:var(--ash);overflow-wrap:anywhere}
    .team-row.pend{outline:1px dashed var(--gold)}
    .team-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    #acctBtn{position:relative}
    #acctBtn .dot{position:absolute;top:-4px;right:-4px;width:12px;height:12px;border-radius:50%;background:var(--gold);border:2px solid var(--ink)}
  `;
  document.head.appendChild(style);

  const auth = document.createElement('div');
  auth.className = 'auth'; auth.id = 'auth'; auth.hidden = true;
  auth.innerHTML = '<form class="auth-card" id="authForm" novalidate><div class="badge"><img alt="99 Jiu-Jitsu México"></div>' +
    '<h1>Check System</h1><p id="authMsg"></p><div id="authFields" style="display:contents"></div>' +
    '<div class="err" id="authErr" hidden></div><p class="auth-ok" id="authOk" hidden></p>' +
    '<button class="btn primary" type="submit" id="authGo">Entrar</button>' +
    '<div class="auth-links" id="authLinks"></div></form>';
  document.body.appendChild(auth);
  const brand = $('#brandLogo');
  if (brand) $('img', auth).src = brand.src;

  let mode = 'login';
  const field = (id, label, type, extra) => '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + type + '" ' + (extra || '') + '></div>';
  const link = (m, t) => '<button type="button" data-m="' + m + '">' + t + '</button>';
  function showAuth(m, okMsg) {
    mode = m;
    auth.hidden = false;
    $('#authErr').hidden = true;
    const ok = $('#authOk'); ok.hidden = !okMsg; ok.textContent = okMsg || '';
    const go = $('#authGo'); go.hidden = false;
    let msg = '', fields = '', links = '';
    if (m === 'signup') {
      msg = 'Crea tu cuenta del gym. La primera cuenta es la del administrador; las demás esperan su aprobación.';
      fields = field('auName', 'Tu nombre', 'text', 'autocomplete="name" maxlength="60" autofocus') + field('auEmail', 'Correo', 'email', 'autocomplete="email" autocapitalize="none"') +
        field('auPass', 'Contraseña (6 o más)', 'password', 'autocomplete="new-password"') + field('auPass2', 'Repite la contraseña', 'password', 'autocomplete="new-password"');
      go.textContent = 'Crear cuenta';
      links = link('login', 'Ya tengo cuenta');
    } else if (m === 'forgot') {
      msg = 'Escribe tu correo y te mandamos un enlace para poner una contraseña nueva.';
      fields = field('auEmail', 'Correo', 'email', 'autocomplete="email" autocapitalize="none" autofocus');
      go.textContent = 'Mandar enlace';
      links = link('login', 'Volver');
    } else if (m === 'recovery') {
      msg = 'Escribe tu contraseña nueva.';
      fields = field('auPass', 'Contraseña nueva (6 o más)', 'password', 'autocomplete="new-password" autofocus');
      go.textContent = 'Guardar y entrar';
    } else if (m === 'pending') {
      msg = 'Tu cuenta ya está creada. Falta que el administrador del gym la apruebe; cuando lo haga, toca el botón para entrar.';
      go.textContent = 'Ya me aprobaron, entrar';
      links = link('logout', 'Cerrar sesión');
    } else if (m === 'offline') {
      msg = 'No hay conexión a internet. El cronómetro y el marcador funcionan igual; la asistencia y los pagos vuelven en cuanto haya conexión.';
      go.textContent = 'Reintentar';
      links = link('local', 'Usar solo cronómetro y marcador');
    } else if (m === 'setup') {
      msg = 'Falta conectar la app con Supabase.';
      go.hidden = true;
    } else {
      msg = 'Inicia sesión con tu cuenta del gym.';
      fields = field('auEmail', 'Correo', 'email', 'autocomplete="email" autocapitalize="none" autofocus') + field('auPass', 'Contraseña', 'password', 'autocomplete="current-password"');
      go.textContent = 'Entrar';
      links = link('signup', 'Crear cuenta') + link('forgot', 'Olvidé mi contraseña') + link('local', 'Solo cronómetro y marcador');
    }
    $('#authMsg').textContent = msg;
    $('#authFields').innerHTML = fields;
    $('#authLinks').innerHTML = links;
    setTimeout(() => { const f = $('#authFields [autofocus]'); if (f) f.focus(); }, 50);
  }
  function authError(msg) { const e = $('#authErr'); e.hidden = false; e.textContent = msg; $('#authOk').hidden = true; }
  function authMsgFor(err) {
    const m = String((err && err.message) || '');
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Primero confirma tu correo: revisa tu bandeja de entrada y spam.';
    if (/already registered|already been registered/i.test(m)) return 'Ese correo ya tiene cuenta. Inicia sesión o usa "Olvidé mi contraseña".';
    if (/Password should be at least/i.test(m)) return 'La contraseña debe tener al menos 6 caracteres.';
    if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
    if (/fetch|network|Load failed/i.test(m)) return 'No hay conexión a internet.';
    return m || 'No se pudo completar.';
  }
  $('#authLinks').addEventListener('click', async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = b.dataset.m;
    if (m === 'local') { auth.hidden = true; return; }
    if (m === 'logout') { try { await sb.auth.signOut(); } catch (_) {} showAuth('login'); return; }
    showAuth(m);
  });
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const go = $('#authGo');
    const val = id => (($('#' + id) || {}).value || '').trim();
    if (mode === 'offline' || mode === 'pending') { boot(); return; }
    go.disabled = true;
    try {
      if (mode === 'login') {
        if (!val('auEmail') || !$('#auPass').value) throw { message: 'Escribe tu correo y contraseña.' };
        const { error } = await sb.auth.signInWithPassword({ email: val('auEmail'), password: $('#auPass').value });
        if (error) throw error;
        await afterSession();
      } else if (mode === 'signup') {
        if (!val('auName')) throw { message: 'Escribe tu nombre.' };
        if ($('#auPass').value.length < 6) throw { message: 'La contraseña debe tener al menos 6 caracteres.' };
        if ($('#auPass').value !== $('#auPass2').value) throw { message: 'Las contraseñas no coinciden.' };
        const { data, error } = await sb.auth.signUp({ email: val('auEmail'), password: $('#auPass').value, options: { data: { nombre: val('auName') }, emailRedirectTo: appUrl() } });
        if (error) throw error;
        if (data.session) await afterSession();
        else showAuth('login', 'Te mandamos un correo para confirmar tu cuenta. Ábrelo y después inicia sesión aquí.');
      } else if (mode === 'forgot') {
        if (!val('auEmail')) throw { message: 'Escribe tu correo.' };
        const { error } = await sb.auth.resetPasswordForEmail(val('auEmail'), { redirectTo: appUrl() });
        if (error) throw error;
        showAuth('login', 'Listo: revisa tu correo y abre el enlace para poner tu contraseña nueva.');
      } else if (mode === 'recovery') {
        if ($('#auPass').value.length < 6) throw { message: 'La contraseña debe tener al menos 6 caracteres.' };
        const { error } = await sb.auth.updateUser({ password: $('#auPass').value });
        if (error) throw error;
        recovering = false;
        await afterSession();
      }
    } catch (err) { authError(authMsgFor(err)); }
    finally { go.disabled = false; }
  });

  async function loadMe() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const row = await run(sb.from('miembros').select('user_id,nombre,email,rol').eq('user_id', session.user.id).maybeSingle());
    return { id: session.user.id, email: session.user.email, name: row ? row.nombre : '', role: row ? row.rol : 'pendiente' };
  }
  async function afterSession() {
    let m;
    try { m = await loadMe(); } catch (e) { showAuth(e.code === 'unavailable' ? 'offline' : 'login'); return; }
    if (!m) { showAuth('login'); return; }
    if (m.role === 'pendiente') { me = m; showAuth('pending'); return; }
    me = m;
    signedIn();
  }
  function signedIn() {
    if (signedInOnce) { location.reload(); return; }
    signedInOnce = true;
    auth.hidden = true;
    acctBtn.hidden = false;
    openRealtime();
    authResolve();
    if (me.role === 'admin') checkPending();
  }
  let recovering = false;
  async function boot() {
    if (!sb) { showAuth('setup'); return; }
    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch (e) {} // también termina de leer el enlace del correo
    if (/[?&](code|error|error_description)=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
    if (recovering) return;
    if (!session) { showAuth(navigator.onLine === false ? 'offline' : 'login'); return; }
    await afterSession();
  }
  if (sb) sb.auth.onAuthStateChange(event => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; showAuth('recovery'); return; }
    if (event === 'SIGNED_OUT' && signedInOnce) location.reload();
  });

  /* ======================= cuenta y equipo ======================= */
  const tools = $('.top-tools');
  const acctBtn = document.createElement('button');
  acctBtn.className = 'icon-btn'; acctBtn.id = 'acctBtn'; acctBtn.hidden = true;
  acctBtn.title = 'Cuenta y equipo'; acctBtn.setAttribute('aria-label', 'Cuenta y equipo');
  acctBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>';
  if (tools) tools.insertBefore(acctBtn, tools.firstChild);

  const scrim = document.createElement('div');
  scrim.className = 'scrim'; scrim.hidden = true; scrim.style.zIndex = '70';
  scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" id="acctSheet"></div>';
  document.body.appendChild(scrim);
  const sheet = $('#acctSheet', scrim);
  scrim.addEventListener('click', e => { if (e.target === scrim) scrim.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !scrim.hidden) { scrim.hidden = true; e.stopImmediatePropagation(); } }, true);
  const ROLES = { admin: 'Administrador', profe: 'Profe', pantalla: 'Pantalla (solo ver)', pendiente: 'Esperando aprobación' };

  async function checkPending() {
    try {
      const rows = await run(sb.from('miembros').select('user_id').eq('rol', 'pendiente'));
      const old = $('.dot', acctBtn); if (old) old.remove();
      if (rows.length) { const d = document.createElement('span'); d.className = 'dot'; acctBtn.appendChild(d); acctBtn.title = rows.length + (rows.length === 1 ? ' cuenta espera' : ' cuentas esperan') + ' aprobación'; }
    } catch (e) {}
  }
  function acctView() {
    sheet.innerHTML = '<h2>Tu cuenta</h2><p><strong>' + esc(me.name) + '</strong> · ' + esc(me.email) + ' · ' + esc(ROLES[me.role]) + '</p>' +
      (me.role === 'admin' ? '<div class="sheet-actions" style="justify-content:flex-start"><button class="btn" data-a="team">Equipo y cuentas</button><button class="btn" data-a="backup">Descargar respaldo</button></div>' : '') +
      '<div class="sheet-actions" style="justify-content:flex-start"><button class="btn ghost" data-a="pass">Cambiar mi contraseña</button><button class="btn danger" data-a="logout">Cerrar sesión</button><span class="spacer"></span><button class="btn primary" data-a="close">Listo</button></div>';
    scrim.hidden = false;
  }
  function passView() {
    sheet.innerHTML = '<h2>Cambiar contraseña</h2>' + field('cpNew', 'Contraseña nueva (6 o más)', 'password', 'autocomplete="new-password" autofocus') +
      '<div class="err" id="cpErr" hidden></div><div class="sheet-actions"><button class="btn ghost" data-a="acct">Volver</button><button class="btn primary" data-a="passSave">Guardar</button></div>';
  }
  async function teamView(msg) {
    sheet.innerHTML = '<h2>Equipo</h2><p>Cargando cuentas…</p>';
    let rows = [];
    try { rows = await run(sb.from('miembros').select('user_id,nombre,email,rol,creado').order('creado')); }
    catch (e) { sheet.innerHTML = '<h2>Equipo</h2><p>' + esc(e.message) + '</p><div class="sheet-actions"><button class="btn" data-a="acct">Volver</button></div>'; return; }
    rows.sort((a, b) => (a.rol === 'pendiente' ? 0 : 1) - (b.rol === 'pendiente' ? 0 : 1));
    const opt = (u, r, t) => '<button class="btn small' + (u.rol === r ? ' primary' : '') + '" data-a="rol" data-r="' + r + '" data-id="' + u.user_id + '">' + t + '</button>';
    sheet.innerHTML = '<h2>Equipo</h2><p>Para sumar a alguien: que abra la app, toque <strong>Crear cuenta</strong> y tú le das acceso aquí. Profe: asistencia, cobros y marcador. Pantalla: solo ver, para las teles.</p>' +
      (msg ? '<p class="auth-ok">' + esc(msg) + '</p>' : '') +
      rows.map(u => '<div class="team-row' + (u.rol === 'pendiente' ? ' pend' : '') + '"><div><b>' + esc(u.nombre || u.email) + '</b><span>' + esc(u.email) + ' · ' + esc(ROLES[u.rol]) + '</span></div><div class="team-acts">' +
        (u.user_id === me.id ? '<span>Tú</span>' : opt(u, 'profe', 'Profe') + opt(u, 'pantalla', 'Pantalla') + opt(u, 'admin', 'Admin') + (u.rol === 'pendiente' ? '' : '<button class="btn small danger" data-a="rol" data-r="pendiente" data-id="' + u.user_id + '">Quitar acceso</button>')) +
        '</div></div>').join('') +
      '<div class="err" id="tmErr" hidden></div><div class="sheet-actions"><button class="btn ghost" data-a="acct">Volver</button></div>';
  }
  acctBtn.addEventListener('click', () => { if (me) acctView(); });
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    const showErr = (id, m) => { const el = $('#' + id, sheet); if (el) { el.hidden = false; el.textContent = m; } };
    try {
      if (a === 'close') scrim.hidden = true;
      else if (a === 'acct') acctView();
      else if (a === 'pass') passView();
      else if (a === 'team') teamView();
      else if (a === 'logout') { await sb.auth.signOut(); location.reload(); }
      else if (a === 'backup') {
        const rows = await run(sb.from('docs').select('path,data,v,actualizado').order('path'));
        const d = new Date();
        saveFile('check-system-respaldo-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.json',
          JSON.stringify({ app: 'Check System', fecha: d.toISOString(), docs: rows }, null, 1), 'application/json');
      }
      else if (a === 'passSave') {
        const pw = $('#cpNew', sheet).value;
        if (pw.length < 6) { showErr('cpErr', 'La contraseña debe tener al menos 6 caracteres.'); return; }
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) { showErr('cpErr', authMsgFor(error)); return; }
        acctView();
      }
      else if (a === 'rol') {
        if (b.dataset.r === 'pendiente' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro? Toca otra vez'; return; }
        await run(sb.from('miembros').update({ rol: b.dataset.r }).eq('user_id', b.dataset.id));
        await teamView(b.dataset.r === 'pendiente' ? 'Acceso quitado.' : 'Listo: ahora es ' + ROLES[b.dataset.r].toLowerCase() + '. Que toque "Ya me aprobaron, entrar".');
        checkPending();
      }
    } catch (ex) { showErr('tmErr', ex.message || 'No se pudo completar'); if (a !== 'rol') { const p = document.createElement('p'); p.className = 'err'; p.textContent = ex.message || 'No se pudo completar'; sheet.appendChild(p); } }
  });

  boot();
})();
