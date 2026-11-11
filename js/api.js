/* 예약 연결: live(구글 시트) · preview(이 컴퓨터에서 미리보기, 브라우저에만 저장) · off(연결 전) */
(function () {
  'use strict';
  var CFG = window.KG_CONFIG || {};
  var local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var mode = CFG.endpoint ? 'live' : (local ? 'preview' : 'off');
  var KEY = 'kg-preview-v1', CKEY = 'kg-preview-cache', mem = { db: null, cache: {} };

  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return mem.db; } }
  function save(db) { mem.db = db; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  function loadCache() { try { return JSON.parse(sessionStorage.getItem(CKEY)) || {}; } catch (e) { return mem.cache; } }
  function saveCache(c) { mem.cache = c; try { sessionStorage.setItem(CKEY, JSON.stringify(c)); } catch (e) {} }
  function kst() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, time: o.hour + ':' + o.minute };
  }
  function uid() { return (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, ''); }

  function previewEnv() {
    var db = load() || { bookings: [], closed: [], settings: [], props: {}, mails: [] };
    var cache = loadCache();
    var env = {
      store: {
        read: function (k) { return (db[k] || []).map(function (r) { return Object.assign({}, r); }); },
        write: function (k, rows) { db[k] = rows.map(function (r) { return Object.assign({}, r); }); save(db); },
        append: function (k, r) { (db[k] = db[k] || []).push(Object.assign({}, r)); save(db); }
      },
      today: function () { return kst().date; },
      now: function () { var k = kst(); return k.date + ' ' + k.time; },
      uuid: uid,
      cache: {
        get: function (k) { var c = cache[k]; return c && c.exp > Date.now() ? c.v : null; },
        put: function (k, v, s) { cache[k] = { v: String(v), exp: Date.now() + s * 1000 }; saveCache(cache); },
        remove: function (k) { delete cache[k]; saveCache(cache); }
      },
      props: { get: function (k) { return db.props[k] || null; }, set: function (k, v) { db.props[k] = v; save(db); } },
      hash: function (s) { return 'p:' + s; },
      setPassword: function (pw) { db.props.ADMIN_HASH = 'p:' + pw; save(db); },
      setupCode: function (c) { return c === 'PREVIEW'; },
      mail: function (to, subject, body) { (db.mails = db.mails || []).push({ to: to, subject: subject, body: body }); save(db); if (window.console) console.info('[미리보기] 메일:', to, subject); },
      lock: function (fn) { fn(); },
      ensure: function () {
        if (db.props.READY) return;
        KG.setup(env, { notifyEmail: 'owner@example.com' });
        db.props.READY = '1'; save(db);
      }
    };
    return env;
  }

  function call(action, data) {
    data = data || {};
    if (mode === 'live') {
      var url = CFG.endpoint;
      var req = action === 'public'
        ? fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'action=public&t=' + Date.now(), { redirect: 'follow' })
        : fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ action: action }, data)), redirect: 'follow' });
      return req.then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(function () { return { ok: false, code: 'network', message: '연결이 잠시 원활하지 않아요. 잠시 후 다시 시도해 주세요.' }; });
    }
    if (mode === 'preview') {
      return new Promise(function (res) {
        setTimeout(function () { res(JSON.parse(JSON.stringify(KG.handle(Object.assign({ action: action }, data), previewEnv())))); }, 180);
      });
    }
    return Promise.resolve({ ok: false, code: 'off', message: '온라인 예약이 아직 연결되지 않았어요.' });
  }

  window.KGApi = {
    mode: mode, call: call, config: CFG, kstToday: function () { return kst().date; },
    previewMails: function () { var d = load(); return (d && d.mails) || []; },
    resetPreview: function () { mem = { db: null, cache: {} }; try { localStorage.removeItem(KEY); sessionStorage.removeItem(CKEY); } catch (e) {} }
  };
})();
