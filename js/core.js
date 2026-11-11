/* 국악작업실K 예약 처리.
   같은 코드가 두 곳에서 돕니다: 이 컴퓨터 미리보기(브라우저)와 구글 Apps Script(실제 운영).
   고칠 때는 이 파일을 고친 뒤 booking-backend/build.sh 로 구글 쪽 파일을 다시 만드세요. */
var KG = (function () {
  'use strict';
  var PRICE = { A: 50000, B: 100000 };
  var NAME = { A: 'Gugak Concert & Korean Tea (1 hour)', B: 'Gugak Concert & Play-It-Yourself (2 hours)' };
  var NAME_KO = { A: 'A 공연+다과 (1시간)', B: 'B 공연+악기체험 (2시간)' };
  var STUDIO = 'K Gugak Studio (국악작업실K)';
  var STATUSES = ['HOLD', 'PAID', 'CANCELLED'];
  var CHANNELS = ['홈페이지', '에어비앤비', '전화·문자', '인스타그램', '현장', '기타'];
  var SCHEMA = {
    bookings: ['id', 'createdAt', 'status', 'experience', 'date', 'time', 'guests', 'total', 'name', 'email', 'note', 'lang', 'channel', 'holdUntil', 'paidAt', 'memo'],
    closed: ['date', 'time', 'memo'],
    settings: ['key', 'value']
  };
  var DEFAULTS = {
    accepting: '예', slotsA: '11:00,14:00,16:00', slotsB: '11:00,14:00,16:00', capacity: '10',
    holdHours: '48', minLeadDays: '1', maxMonths: '3', openWeekdays: '0,1,2,3,4,5,6',
    notifyEmail: '', bankName: '', bankSwift: '', bankAccount: '', bankHolder: '', confirmNote: ''
  };

  function str(v) { return v == null ? '' : String(v); }
  /* 시트에서 수식으로 읽히지 않게 맨 앞의 = + - @ 를 떼고 길이를 자릅니다 */
  function clean(v, max) { return str(v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/^[=+\-@\s]+/, '').trim().slice(0, max || 200); }
  function yes(v) { var s = str(v).trim().toLowerCase(); return v === true || s === '예' || s === 'true' || s === 'y' || s === 'yes' || s === '1'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fail(code, message, extra) { var o = { ok: false, code: code, message: message }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s; }
  function isTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function isEmail(s) { return /^[^@\s=+\-][^@\s]*@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 120; }
  function toUTC(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function fromUTC(t) { return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
  function addDays(s, n) { var t = toUTC(s); t.setUTCDate(t.getUTCDate() + n); return fromUTC(t); }
  function addMonths(s, n) {
    var p = s.split('-'), t = new Date(Date.UTC(+p[0], +p[1] - 1 + n, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(+p[2], last)); return fromUTC(t);
  }
  function weekdayNum(s) { return toUTC(s).getUTCDay(); }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  /* 'yyyy-MM-dd HH:mm' 에 시간을 더합니다 (한국 시간 문자열끼리 계산) */
  function addHours(stamp, h) {
    var d = stamp.slice(0, 10).split('-'), t = stamp.slice(11).split(':');
    var x = new Date(Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0] + h, +t[1]));
    return fromUTC(x) + ' ' + pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes());
  }
  function won(n) { return '₩' + str(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- 설정 ---------- */
  function readSettings(env) {
    var raw = {}, k;
    for (k in DEFAULTS) raw[k] = DEFAULTS[k];
    env.store.read('settings').forEach(function (r) { if (r.key in DEFAULTS) raw[r.key] = str(r.value); });
    return parseSettings(raw);
  }
  function parseSlots(v) {
    var seen = {}, out = [];
    str(v).split(/[,\s]+/).forEach(function (x) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(x.trim()); if (!m) return;
      var t = pad(+m[1]) + ':' + m[2]; if (isTime(t) && !seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out.sort().slice(0, 8);
  }
  function parseSettings(raw) {
    function num(v, lo, hi, def) { var n = parseInt(str(v).replace(/[^\d]/g, ''), 10); if (isNaN(n)) n = def; return Math.max(lo, Math.min(hi, n)); }
    var days = str(raw.openWeekdays).split(',').map(function (x) { return parseInt(x, 10); }).filter(function (n, i, a) { return n >= 0 && n <= 6 && a.indexOf(n) === i; }).sort();
    var mail = str(raw.notifyEmail).trim();
    return {
      accepting: yes(raw.accepting),
      slots: { A: parseSlots(raw.slotsA), B: parseSlots(raw.slotsB) },
      capacity: num(raw.capacity, 1, 50, 10), holdHours: num(raw.holdHours, 1, 240, 48),
      minLeadDays: num(raw.minLeadDays, 0, 30, 1), maxMonths: num(raw.maxMonths, 1, 12, 3),
      openWeekdays: days, notifyEmail: isEmail(mail) ? mail : '',
      bank: { name: clean(raw.bankName, 80), swift: clean(raw.bankSwift, 20), account: clean(raw.bankAccount, 40), holder: clean(raw.bankHolder, 80) },
      confirmNote: str(raw.confirmNote).replace(/^[=+@]+/, '').slice(0, 1500)
    };
  }
  function flatSettings(s) {
    return { accepting: s.accepting ? '예' : '아니오', slotsA: s.slots.A.join(','), slotsB: s.slots.B.join(','), capacity: str(s.capacity),
      holdHours: str(s.holdHours), minLeadDays: str(s.minLeadDays), maxMonths: str(s.maxMonths), openWeekdays: s.openWeekdays.join(','),
      notifyEmail: s.notifyEmail, bankName: s.bank.name, bankSwift: s.bank.swift, bankAccount: s.bank.account, bankHolder: s.bank.holder, confirmNote: s.confirmNote };
  }
  function publicSettings(s) {
    return { accepting: s.accepting, slots: s.slots, capacity: s.capacity, holdHours: s.holdHours, minLeadDays: s.minLeadDays, maxMonths: s.maxMonths, openWeekdays: s.openWeekdays, bank: s.bank, price: PRICE };
  }

  /* ---------- 예약 읽기 ---------- */
  function toBooking(r) {
    var st = str(r.status).trim().toUpperCase();
    return { id: str(r.id).trim(), createdAt: str(r.createdAt), status: STATUSES.indexOf(st) < 0 ? 'HOLD' : st,
      experience: str(r.experience).trim() === 'B' ? 'B' : 'A', date: str(r.date).trim().slice(0, 10), time: str(r.time).trim().slice(0, 5),
      guests: Math.max(0, parseInt(r.guests, 10) || 0), total: Math.max(0, parseInt(str(r.total).replace(/[^\d]/g, ''), 10) || 0),
      name: str(r.name), email: str(r.email), note: str(r.note), lang: str(r.lang), channel: str(r.channel) || '홈페이지',
      holdUntil: str(r.holdUntil), paidAt: str(r.paidAt), memo: str(r.memo) };
  }
  function fromBooking(b) { var o = {}; SCHEMA.bookings.forEach(function (c) { o[c] = str(b[c]); }); return o; }
  function readBookings(env) { return env.store.read('bookings').map(toBooking).filter(function (b) { return b.id; }); }
  function readClosed(env) {
    return env.store.read('closed').map(function (r) { return { date: str(r.date).trim().slice(0, 10), time: str(r.time).trim().slice(0, 5), memo: str(r.memo) }; })
      .filter(function (c) { return isDate(c.date); });
  }
  /* 자리를 차지하는 예약: 확정, 또는 입금 대기 시간이 안 지난 예약 */
  function isLive(b, now) { return b.status === 'PAID' || (b.status === 'HOLD' && (!b.holdUntil || b.holdUntil > now)); }
  function seatMap(bookings, now, from) {
    var m = {};
    bookings.forEach(function (b) {
      if (!isLive(b, now) || (from && b.date < from)) return;
      (m[b.date] = m[b.date] || {})[b.time] = ((m[b.date] || {})[b.time] || 0) + b.guests;
    });
    return m;
  }

  /* 날짜 하나의 상태. d = { today, now, settings, seats, closed }
     past 지난 날 · off 예약 중단 · soon 너무 임박 · far 너무 먼 날 · closed 쉬는 날 · full 마감 · few 얼마 안 남음 · open 예약 가능 */
  function dayInfo(date, exp, d) {
    var s = d.settings, booked = d.seats[date] || {}, nowTime = str(d.now).slice(11), allDay = false, byTime = {};
    d.closed.forEach(function (c) { if (c.date !== date) return; if (!c.time) allDay = true; else byTime[c.time] = 1; });
    var slots = (s.slots[exp] || []).map(function (t) {
      return { time: t, left: Math.max(0, s.capacity - (booked[t] || 0)), closed: allDay || !!byTime[t] || (date === d.today && t <= nowTime) };
    });
    var open = slots.filter(function (x) { return !x.closed && x.left > 0; }), st;
    if (date < d.today) st = 'past';
    else if (!s.accepting) st = 'off';
    else if (date < addDays(d.today, s.minLeadDays)) st = 'soon';
    else if (date > addMonths(d.today, s.maxMonths)) st = 'far';
    else if (allDay || s.openWeekdays.indexOf(weekdayNum(date)) < 0 || !slots.some(function (x) { return !x.closed; })) st = 'closed';
    else if (!open.length) st = 'full';
    else st = Math.max.apply(null, open.map(function (x) { return x.left; })) <= 3 ? 'few' : 'open';
    return { status: st, slots: slots, bookable: st === 'open' || st === 'few' };
  }

  /* ---------- 요청 처리 ---------- */
  function handle(req, env) {
    try {
      req = req || {};
      var a = str(req.action || 'public');
      env.ensure();
      if (a === 'public') return publicData(env);
      if (a === 'status') return { ok: true, claimed: !!env.props.get('ADMIN_HASH') };
      if (a === 'book') return book(req, env);
      if (a === 'login') return login(req, env);
      if (a === 'claim') return claim(req, env);
      if (!auth(req, env)) return fail('auth', '다시 로그인해 주세요.');
      switch (a) {
        case 'admin': return adminData(env);
        case 'saveBooking': return saveBooking(req, env);
        case 'addBooking': return addBooking(req, env);
        case 'deleteBooking': return deleteBooking(req, env);
        case 'setClosed': return setClosed(req, env);
        case 'saveSettings': return saveSettings(req, env);
        case 'changePassword': return changePassword(req, env);
        case 'logout': env.cache.remove('tok:' + str(req.token)); return { ok: true };
      }
      return fail('action', '알 수 없는 요청입니다.');
    } catch (e) {
      return fail('error', '잠시 후 다시 시도해 주세요.', { detail: str(e && e.message ? e.message : e).slice(0, 300) });
    }
  }

  function snapshot(env) {
    var today = env.today();
    return { today: today, now: env.now(), settings: readSettings(env), seats: seatMap(readBookings(env), env.now(), today),
      closed: readClosed(env).filter(function (c) { return c.date >= today; }).map(function (c) { return { date: c.date, time: c.time }; }) };
  }
  function publicData(env) {
    var hit = env.cache.get('public');
    if (hit) { try { var c = JSON.parse(hit); if (c.today === env.today()) return c; } catch (e) {} }
    var d = snapshot(env);
    var out = { ok: true, today: d.today, now: d.now, settings: publicSettings(d.settings), seats: d.seats, closed: d.closed };
    try { env.cache.put('public', JSON.stringify(out), 30); } catch (e) {}
    return out;
  }
  function dirty(env) { try { env.cache.remove('public'); } catch (e) {} }
  function newCode(env, bookings) {
    for (var i = 0; i < 20; i++) {
      var c = 'KG-' + env.uuid().replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
      if (c.length === 9 && !bookings.some(function (b) { return b.id === c; })) return c;
    }
    throw new Error('code');
  }

  function book(req, env) {
    if (str(req.website)) return { ok: true, code: 'KG-000000' };                 // 스팸 함정
    var count = +(env.cache.get('book-count') || 0);
    if (count >= 40) return fail('busy', 'Too many requests right now. Please try again in a few minutes.');
    var exp = str(req.experience), date = str(req.date), time = str(req.time), guests = parseInt(req.guests, 10);
    var name = clean(req.name, 80), email = str(req.email).trim(), note = clean(req.note, 500), lang = clean(req.lang, 5);
    if (!PRICE[exp] || !isDate(date) || !isTime(time) || !(guests >= 1) || !name || !isEmail(email)) return fail('invalid', 'Please check the form.');
    var res = null, rec = null, s = null;
    env.lock(function () {
      var d = snapshot(env), info = dayInfo(date, exp, d); s = d.settings;
      if (!s.accepting) { res = fail('off', 'Online booking is paused.'); return; }
      var slot = info.slots.filter(function (x) { return x.time === time; })[0];
      if (!info.bookable || !slot || slot.closed) { res = fail('date', 'That date or time is not available.', { status: info.status }); return; }
      if (guests > slot.left) { res = fail('full', 'Not enough seats.', { left: slot.left }); return; }
      var now = env.now();
      rec = { id: newCode(env, readBookings(env)), createdAt: now, status: 'HOLD', experience: exp, date: date, time: time, guests: guests,
        total: PRICE[exp] * guests, name: name, email: email, note: note, lang: lang, channel: '홈페이지', holdUntil: addHours(now, s.holdHours), paidAt: '', memo: '' };
      env.store.append('bookings', fromBooking(rec));
    });
    if (res) return res;
    env.cache.put('book-count', String(count + 1), 600);
    dirty(env);
    var mailed = true;
    try { env.mail(email, 'Your booking request ' + rec.id + ' — ' + STUDIO, guestBookedMail(rec, s), s.notifyEmail); } catch (e) { mailed = false; }
    if (s.notifyEmail) {
      try {
        env.mail(s.notifyEmail, '[새 예약] ' + rec.id + ' · ' + rec.date + ' ' + rec.time + ' · ' + rec.guests + '명 · ' + won(rec.total), ownerMail(rec, mailed), email);
      } catch (e) {}
    }
    return { ok: true, code: rec.id, total: rec.total, holdUntil: rec.holdUntil, bank: s.bank };
  }

  function summary(b) {
    return 'Booking code: ' + b.id + '\nExperience: ' + NAME[b.experience] + '\nDate & time: ' + b.date + ' ' + b.time + ' (Korea time)\nGuests: ' + b.guests + '\nAmount: ' + won(b.total);
  }
  function bankText(s) {
    var b = s.bank;
    if (!b.account) return 'We will send the bank details in a separate email shortly.';
    return [b.name && 'Bank: ' + b.name, b.swift && 'SWIFT: ' + b.swift, 'Account: ' + b.account, b.holder && 'Name: ' + b.holder].filter(Boolean).join('\n');
  }
  function guestBookedMail(b, s) {
    return 'Hello ' + b.name + ',\n\nThank you for booking. Your seats are held for ' + s.holdHours + ' hours.\n\n' + summary(b) +
      '\n\nTo confirm, please transfer ' + won(b.total) + ' (KRW) and write your booking code as the reference.\n\n' + bankText(s) +
      '\n\nPlease cover any sending fees so the full amount arrives. Once the transfer is received we will email your confirmation and directions.\n\n' + STUDIO;
  }
  function guestPaidMail(b, s) {
    return 'Hello ' + b.name + ',\n\nWe have received your payment. Your booking is confirmed.\n\n' + summary(b) +
      (s.confirmNote ? '\n\n' + s.confirmNote : '') + '\n\nIf your plans change, just reply to this email.\n\nSee you soon,\n' + STUDIO;
  }
  function guestCancelMail(b) {
    return 'Hello ' + b.name + ',\n\nYour booking ' + b.id + ' (' + b.date + ' ' + b.time + ') has been cancelled.\n\nIf this is a mistake, or you would like another date, just reply to this email.\n\n' + STUDIO;
  }
  function ownerMail(b, mailed) {
    return '홈페이지에서 새 예약이 들어왔습니다.\n\n예약번호: ' + b.id + '\n체험: ' + NAME_KO[b.experience] + '\n날짜·시간: ' + b.date + ' ' + b.time + '\n인원: ' + b.guests + '명\n입금 받을 금액: ' + won(b.total) +
      '\n입금 기한: ' + b.holdUntil + '\n\n이름: ' + b.name + '\n이메일: ' + b.email + '\n언어: ' + (b.lang || '-') + '\n요청 사항: ' + (b.note || '-') +
      (mailed ? '' : '\n\n※ 손님에게 가는 안내 메일이 실패했습니다. 이메일 주소를 확인하고 직접 연락해 주세요.') +
      '\n\n입금을 확인하면 관리자 페이지에서 "입금 확인"을 눌러 주세요. 손님에게 확정 메일이 갑니다.\n이 메일에 답장하면 손님에게 바로 전달됩니다.';
  }

  /* ---------- 관리자 로그인 ---------- */
  function login(req, env) {
    var fails = +(env.cache.get('login-fail') || 0);
    if (fails >= 8) return fail('locked', '비밀번호를 여러 번 틀려서 15분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.');
    var h = env.props.get('ADMIN_HASH');
    if (!h) return fail('claim', '처음 한 번, 설정 코드로 관리자 비밀번호를 만들어 주세요.');
    if (env.hash(str(req.password)) !== h) {
      env.cache.put('login-fail', String(fails + 1), 900);
      return fail('password', '비밀번호가 맞지 않아요.');
    }
    return { ok: true, token: newToken(env) };
  }
  function claim(req, env) {
    if (env.props.get('ADMIN_HASH')) return fail('claimed', '이미 관리자 비밀번호가 있어요. 로그인해 주세요.');
    var fails = +(env.cache.get('claim-fail') || 0);
    if (fails >= 8) return fail('locked', '설정 코드를 여러 번 틀려서 15분 동안 잠겼어요.');
    if (!env.setupCode || !env.setupCode(str(req.code).trim())) {
      env.cache.put('claim-fail', String(fails + 1), 900);
      return fail('code', '설정 코드가 맞지 않아요.');
    }
    if (str(req.password).length < 8) return fail('invalid', '비밀번호는 8자 이상으로 해 주세요.');
    env.setPassword(str(req.password));
    return { ok: true, token: newToken(env) };
  }
  function newToken(env) { var t = env.uuid() + env.uuid(); env.cache.put('tok:' + t, '1', 21600); return t; }
  function auth(req, env) { var t = str(req.token); return t.length >= 32 && !!env.cache.get('tok:' + t); }
  function changePassword(req, env) {
    if (env.hash(str(req.current)) !== env.props.get('ADMIN_HASH')) return fail('password', '지금 비밀번호가 맞지 않아요.');
    if (str(req.next).length < 8) return fail('invalid', '새 비밀번호는 8자 이상으로 해 주세요.');
    env.setPassword(str(req.next));
    return { ok: true };
  }

  /* ---------- 관리자 기능 ---------- */
  function adminData(env) {
    var list = readBookings(env).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    return { ok: true, today: env.today(), now: env.now(), bookings: list, closed: readClosed(env), settings: flatSettings(readSettings(env)) };
  }
  function saveBooking(req, env) {
    var id = str(req.id), done = null, before = null, miss = null;
    env.lock(function () {
      var rows = readBookings(env), i, b;
      for (i = 0; i < rows.length; i++) if (rows[i].id === id) b = rows[i];
      if (!b) return;
      before = b.status;
      if (req.status != null && STATUSES.indexOf(str(req.status)) >= 0) b.status = str(req.status);
      if (req.memo != null) b.memo = clean(req.memo, 500);
      if (req.date != null) { if (!isDate(str(req.date))) { miss = '날짜를 확인해 주세요.'; return; } b.date = str(req.date); }
      if (req.time != null) { if (!isTime(str(req.time))) { miss = '시간을 확인해 주세요.'; return; } b.time = str(req.time); }
      if (req.guests != null) { var g = parseInt(req.guests, 10); if (!(g >= 1 && g <= 50)) { miss = '인원을 확인해 주세요.'; return; } b.guests = g; b.total = PRICE[b.experience] * g; }
      if (b.status === 'PAID' && before !== 'PAID') b.paidAt = env.now();
      if (b.status === 'HOLD' && before !== 'HOLD') b.holdUntil = addHours(env.now(), readSettings(env).holdHours);
      env.store.write('bookings', rows.map(fromBooking));
      done = b;
    });
    if (miss) return fail('invalid', miss);
    if (!done) return fail('missing', '예약을 찾을 수 없어요. 새로고침해 주세요.');
    dirty(env);
    var mailed = null;
    if (yes(req.notify) && done.status !== before && isEmail(done.email)) {
      var s = readSettings(env);
      try {
        if (done.status === 'PAID') { env.mail(done.email, 'Booking confirmed ' + done.id + ' — ' + STUDIO, guestPaidMail(done, s), s.notifyEmail); mailed = true; }
        else if (done.status === 'CANCELLED') { env.mail(done.email, 'Booking cancelled ' + done.id + ' — ' + STUDIO, guestCancelMail(done), s.notifyEmail); mailed = true; }
      } catch (e) { mailed = false; }
    }
    return { ok: true, booking: done, mailed: mailed };
  }
  function addBooking(req, env) {
    var exp = str(req.experience) === 'B' ? 'B' : 'A', date = str(req.date), time = str(req.time), guests = parseInt(req.guests, 10);
    if (!isDate(date)) return fail('invalid', '날짜를 골라 주세요.');
    if (!isTime(time)) return fail('invalid', '시간을 골라 주세요.');
    if (!(guests >= 1 && guests <= 50)) return fail('invalid', '인원을 적어 주세요.');
    var email = str(req.email).trim(), ch = str(req.channel), rec = null;
    if (email && !isEmail(email)) return fail('invalid', '이메일 주소를 확인해 주세요.');
    env.lock(function () {
      var now = env.now(), st = str(req.status) === 'HOLD' ? 'HOLD' : 'PAID';
      rec = { id: newCode(env, readBookings(env)), createdAt: now, status: st, experience: exp, date: date, time: time, guests: guests, total: PRICE[exp] * guests,
        name: clean(req.name, 80) || '(이름 없음)', email: email, note: '', lang: '', channel: CHANNELS.indexOf(ch) < 0 ? '기타' : ch,
        holdUntil: st === 'HOLD' ? addHours(now, readSettings(env).holdHours) : '', paidAt: st === 'PAID' ? now : '', memo: clean(req.memo, 500) };
      env.store.append('bookings', fromBooking(rec));
    });
    dirty(env);
    return { ok: true, booking: rec };
  }
  function deleteBooking(req, env) {
    var id = str(req.id);
    env.lock(function () { env.store.write('bookings', readBookings(env).filter(function (b) { return b.id !== id; }).map(fromBooking)); });
    dirty(env);
    return { ok: true };
  }
  /* 날짜 전체(time 비움) 또는 한 회차를 닫거나 다시 엽니다 */
  function setClosed(req, env) {
    var date = str(req.date), time = str(req.time), shut = yes(req.closed);
    if (!isDate(date) || (time && !isTime(time))) return fail('invalid', '날짜를 확인해 주세요.');
    env.lock(function () {
      var rows = readClosed(env).filter(function (c) { return !(c.date === date && c.time === time); });
      if (shut) rows.push({ date: date, time: time, memo: clean(req.memo, 120) });
      rows.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
      env.store.write('closed', rows);
    });
    dirty(env);
    return { ok: true, closed: readClosed(env) };
  }
  function saveSettings(req, env) {
    var inp = req.settings || {}, raw = flatSettings(readSettings(env)), k;
    for (k in DEFAULTS) if (inp[k] != null) raw[k] = str(inp[k]);
    if (str(raw.notifyEmail).trim() && !isEmail(str(raw.notifyEmail).trim())) return fail('invalid', '알림 받을 이메일 주소를 확인해 주세요.');
    var s = parseSettings(raw);
    if (!s.slots.A.length || !s.slots.B.length) return fail('invalid', '시작 시간을 11:00 처럼 한 개 이상 적어 주세요.');
    if (!s.openWeekdays.length) return fail('invalid', '예약 받는 요일을 하루 이상 골라 주세요.');
    var flat = flatSettings(s);
    env.lock(function () { env.store.write('settings', Object.keys(flat).map(function (key) { return { key: key, value: flat[key] }; })); });
    dirty(env);
    return { ok: true, settings: flat };
  }

  /* 처음 한 번: 표를 만들고 기본 설정을 넣습니다 */
  function setup(env, opt) {
    opt = opt || {};
    if (!env.store.read('settings').length) {
      var raw = {}, k; for (k in DEFAULTS) raw[k] = DEFAULTS[k];
      if (opt.notifyEmail) raw.notifyEmail = opt.notifyEmail;
      env.store.write('settings', Object.keys(raw).map(function (key) { return { key: key, value: raw[key] }; }));
    }
  }

  return { handle: handle, setup: setup, dayInfo: dayInfo, isLive: isLive, seatMap: seatMap, parseSettings: parseSettings,
    addDays: addDays, addMonths: addMonths, monthStart: monthStart, weekdayNum: weekdayNum, won: won,
    PRICE: PRICE, NAME: NAME, NAME_KO: NAME_KO, SCHEMA: SCHEMA, DEFAULTS: DEFAULTS, CHANNELS: CHANNELS, STATUSES: STATUSES };
})();
