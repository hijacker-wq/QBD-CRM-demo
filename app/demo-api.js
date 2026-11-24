/* QBD CRM demo: an in-browser stand-in for the clinic API.
 * Every /api/ request the CRM makes is answered here from demo-data.json (synthetic records only).
 * Changes live in memory for this browser tab and are gone after a reload.
 * Dates in the data are moved so that "today" in the data is the visitor's today. */
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const DAY = 86400000;
  let DB = null;
  const ready = realFetch(new URL('demo-data.json', document.baseURI).toString())
    .then((r) => r.json())
    .then((d) => { DB = init(d); })
    .catch((e) => console.error('demo data failed to load', e));

  // ---------- helpers ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const nowIso = () => new Date().toISOString();
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const NO_SHIFT = new Set(['birth_date', 'consent_version', 'valid_until_fixed']);
  function cairoToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return new Date(d.getTime() + n * DAY).toISOString().slice(0, 10);
  }
  function shift(v, days, key) {
    if (Array.isArray(v)) return v.map((x) => shift(x, days, key));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = shift(v[k], days, k);
      return o;
    }
    if (typeof v === 'string' && !NO_SHIFT.has(key)) {
      if (isoRe.test(v)) return new Date(new Date(v).getTime() + days * DAY).toISOString();
      if (dateRe.test(v)) return addDays(v, days);
    }
    return v;
  }
  const OFFSET = '+02:00';
  const OFF_MIN = 120;
  function localOf(iso) {
    const d = new Date(new Date(iso).getTime() + OFF_MIN * 60000);
    return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
  }
  function utcFromLocal(date, hm) {
    return new Date(Date.parse(date + 'T' + hm + ':00Z') - OFF_MIN * 60000).toISOString();
  }
  function dayRange(date, days) {
    return [utcFromLocal(date, '00:00'), utcFromLocal(addDays(date, days), '00:00')];
  }
  function weekStart(date) {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
    const back = (dow - 6 + 7) % 7; // weeks start on Saturday
    return addDays(date, -back);
  }

  // ---------- state ----------
  function init(raw) {
    const S = raw.S;
    const days = Math.round((Date.parse(cairoToday()) - Date.parse(raw.recorded_on)) / DAY);
    const get = (k) => (S[k] ? shift(clone(S[k].b), days) : null);
    const db = { days, signedIn: true, verified: true, seq: { patient: 1000, appt: 1000, event: 1 } };
    db.me = get('/api/auth/me');
    db.access = get('/api/v1/me/access');
    db.resources = { main: get('/api/v1/scheduling/resources?branch=main'), north: get('/api/v1/scheduling/resources?branch=north') };
    db.assignees = get('/api/v1/booking-requests/assignees');
    db.users = {};
    for (const a of db.assignees.data) db.users[a.id] = { id: a.id, display_name: a.display_name };
    for (const b of ['main', 'north']) for (const d of db.resources[b].data.doctors) db.users[d.id] = { id: d.id, display_name: d.display_name };
    db.branches = {};
    for (const b of ['main', 'north']) db.branches[b] = db.resources[b].data.branch;
    // booking requests (detail objects; list items are derived)
    db.requests = {};
    for (const k of Object.keys(S)) {
      const m = k.match(/^\/api\/v1\/booking-requests\/(\d+)$/);
      if (m) db.requests[m[1]] = get(k);
    }
    // patients (full detail objects)
    db.patients = {};
    db.timelines = {};
    for (const k of Object.keys(S)) {
      let m = k.match(/^\/api\/v1\/patients\/(\d+)$/);
      if (m) db.patients[m[1]] = get(k).data;
      m = k.match(/^\/api\/v1\/patients\/(\d+)\/timeline$/);
      if (m) db.timelines[m[1]] = get(k);
    }
    // appointments (detail objects) and their event history from the recorded timelines
    db.appts = {};
    db.events = {};
    for (const k of Object.keys(S)) {
      const m = k.match(/^\/api\/v1\/appointments\/(\d+)$/);
      if (m) db.appts[m[1]] = get(k).data;
    }
    for (const pid of Object.keys(db.timelines)) {
      for (const item of db.timelines[pid].data) db.events[item.appointment.id] = item.events;
    }
    for (const id of Object.keys(db.appts)) {
      db.seq.appt = Math.max(db.seq.appt, +id + 1);
      const q = db.appts[id].queue;
      if (q && q.priority === undefined) q.priority = 'normal';
    }
    for (const id of Object.keys(db.patients)) db.seq.patient = Math.max(db.seq.patient, +id + 1);
    db.queueNo = {};
    for (const a of Object.values(db.appts)) {
      if (a.queue) {
        const key = a.branch.code + ':' + a.queue.day;
        db.queueNo[key] = Math.max(db.queueNo[key] || 0, a.queue.number);
      }
    }
    db.leads = {};
    db.leadOrder = {};
    for (const k of Object.keys(S)) {
      const m = k.match(/^\/api\/v1\/leads\/(\d+)$/);
      if (m) db.leads[m[1]] = get(k).data;
      const t = k.match(/^\/api\/v1\/leads\?tab=([a-z_]+)/);
      if (t && S[k].b && S[k].b.data) db.leadOrder[t[1]] = S[k].b.data.map((x) => x.id);
    }
    db.leadAssignees = { main: get('/api/v1/leads/assignees?branch=main'), north: get('/api/v1/leads/assignees?branch=north') };
    for (const b of ['main', 'north']) for (const a of ((db.leadAssignees[b] || {}).data || [])) if (!db.users[a.id]) db.users[a.id] = { id: a.id, display_name: a.display_name };
    // index of recorded GETs by path, for replay with other query strings
    db.byPath = {};
    for (const k of Object.keys(S)) {
      if (!S[k] || S[k].s >= 400) continue;
      const p = k.split('?')[0];
      (db.byPath[p] = db.byPath[p] || []).push(k);
    }
    db.rawStatus = (k) => (S[k] ? S[k].s : null);
    db.raw = (k) => get(k);
    db.photo = raw.photo_bytes || {};
    return db;
  }

  // ---------- responses ----------
  function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }
  const ok = (data, meta) => json(200, meta ? { data, meta } : { data });
  const err = (status, code, extra) => json(status, Object.assign({ error: code }, extra || {}));
  function demoOnly() {
    toast();
    return err(403, 'demo_read_only');
  }
  let toastTimer = null;
  function toast() {
    const ar = (document.documentElement.lang || 'ar').startsWith('ar');
    let el = document.getElementById('demo-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;background:#3d2b25;color:#fff;padding:10px 18px;border-radius:10px;font:14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:90vw;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = ar
      ? 'نسخة تجريبية: الحفظ هنا غير متاح. جرّب المواعيد والمرضى وطلبات الحجز والعملاء المحتملين.'
      : 'Demo version: saving is not available here. Try appointments, patients, booking requests and leads.';
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ---------- appointments ----------
  function actionsFor(a) {
    switch (a.status) {
      case 'booked': return ['confirm', 'check_in', 'reschedule', 'cancel', 'no_show', 'edit_note'];
      case 'confirmed': return ['check_in', 'reschedule', 'cancel', 'no_show', 'edit_note'];
      case 'checked_in': return ['start', 'undo_check_in', 'cancel', a.queue && a.queue.priority === 'urgent' ? 'clear_urgent' : 'set_urgent', 'edit_note'];
      case 'in_service': return ['complete', 'edit_note'];
      default: return [];
    }
  }
  function apptDetail(a) {
    a.allowed_actions = actionsFor(a);
    const p = DB.patients[a.patient.id];
    a.has_alert = !!(p && p.has_alert);
    if (p) a.patient = { id: p.id, ref: p.ref, name: p.name, phone: p.phone };
    return clone(a);
  }
  function apptItem(a) {
    const d = apptDetail(a);
    delete d.note;
    delete d.patient.phone;
    return d;
  }
  function touch(a, type, extra) {
    a.version = (a.version || 1) + 1;
    a.updated_at = nowIso();
    (DB.events[a.id] = DB.events[a.id] || []).push(Object.assign({
      type, from_status: null, to_status: null, reason_code: null, changes: null,
      actor: { id: DB.me.user.id, display_name: DB.me.user.display_name }, occurred_at: nowIso(),
    }, extra || {}));
  }
  function setTimes(a, startsAt, durationMin) {
    a.starts_at = new Date(startsAt).toISOString();
    a.duration_min = durationMin || a.duration_min || 30;
    a.ends_at = new Date(Date.parse(a.starts_at) + a.duration_min * 60000).toISOString();
    const s = localOf(a.starts_at);
    const e = localOf(a.ends_at);
    a.local = { date: s.date, start: s.hm, end: e.hm, utc_offset: OFFSET };
  }
  function findIn(list, id) { return (list || []).find((x) => +x.id === +id) || null; }
  function applyResources(a, body, branch) {
    const res = DB.resources[branch].data;
    if (body.doctor_id !== undefined) {
      const d = findIn(res.doctors, body.doctor_id);
      a.doctor = d ? { id: d.id, display_name: d.display_name } : a.doctor;
    }
    if (body.room_id !== undefined) {
      const r = findIn(res.rooms, body.room_id);
      a.room = r ? { id: r.id, code: r.code, name_ar: r.name_ar, name_en: r.name_en, is_placeholder: r.is_placeholder } : null;
    }
    if (body.equipment_ids !== undefined) {
      a.equipment = (body.equipment_ids || []).map((id) => findIn(res.equipment, id)).filter(Boolean)
        .map((e) => ({ id: e.id, code: e.code, name_ar: e.name_ar, name_en: e.name_en, is_placeholder: e.is_placeholder }));
    }
    if (body.service_id !== undefined) {
      const s = findIn(res.services, body.service_id);
      a.service = s ? { id: s.id, code: s.code, name_ar: s.name_ar, name_en: s.name_en, specialty: s.specialty } : null;
      a.specialty = s ? s.specialty : (a.doctor && DB.users[a.doctor.id] ? a.specialty : null);
    }
  }
  function createAppt(body, source) {
    const branch = body.branch || 'main';
    const p = DB.patients[body.patient_id];
    if (!p) return null;
    const id = DB.seq.appt++;
    const a = {
      id, branch: clone(DB.branches[branch]), patient: { id: p.id, ref: p.ref, name: p.name },
      doctor: null, room: null, equipment: [], service: null, specialty: null,
      status: 'booked', cancel_reason: null, source: source || 'staff', booking_reference: null, queue: null,
      note: body.note || null, has_alert: !!p.has_alert, allowed_actions: [], version: 1, created_at: nowIso(), updated_at: nowIso(),
    };
    applyResources(a, body, branch);
    setTimes(a, body.starts_at, body.duration_min);
    DB.appts[id] = a;
    DB.events[id] = [];
    touch(a, 'created');
    a.version = 1;
    return a;
  }
  function busy(branch, fromIso, toIso, doctorId, roomId, exceptId) {
    const out = [];
    for (const a of Object.values(DB.appts)) {
      if (a.branch.code !== branch || +a.id === +exceptId) continue;
      if (['cancelled', 'no_show'].includes(a.status)) continue;
      if (a.ends_at <= fromIso || a.starts_at >= toIso) continue;
      if ((doctorId && a.doctor && +a.doctor.id === +doctorId) || (roomId && a.room && +a.room.id === +roomId)) out.push(a);
    }
    return out;
  }

  function appointmentsRoutes(m, path, q, body) {
    let r;
    if (m === 'GET' && path === '/api/v1/appointments') {
      const branch = q.get('branch') || 'main';
      let from; let to; let view = 'day';
      if (q.get('from')) { from = new Date(q.get('from')).toISOString(); to = new Date(q.get('to')).toISOString(); view = 'range'; }
      else {
        view = q.get('view') || 'day';
        let date = q.get('date') || cairoToday();
        if (view === 'week') date = weekStart(date);
        [from, to] = dayRange(date, view === 'week' ? 7 : 1);
      }
      const doc = q.get('doctor_id'); const room = q.get('room_id'); const pat = q.get('patient_id'); const st = q.get('status');
      const list = Object.values(DB.appts).filter((a) => a.branch.code === branch && a.starts_at >= from && a.starts_at < to
        && (!doc || (a.doctor && +a.doctor.id === +doc)) && (!room || (a.room && +a.room.id === +room))
        && (!pat || +a.patient.id === +pat) && (!st || st.split(',').includes(a.status)))
        .sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id - y.id)).map(apptItem);
      return ok(list, { range: { from, to, tz: 'Africa/Cairo', view }, truncated: false, generated_at: nowIso() });
    }
    if (m === 'GET' && path === '/api/v1/appointments/queue') {
      const branch = q.get('branch') || 'main';
      const today = cairoToday();
      const [from, to] = dayRange(today, 1);
      const all = Object.values(DB.appts).filter((a) => a.branch.code === branch);
      const inToday = (a) => a.starts_at >= from && a.starts_at < to;
      const waiting = all.filter((a) => a.status === 'checked_in').sort((x, y) => {
        const ux = x.queue && x.queue.priority === 'urgent' ? 0 : 1; const uy = y.queue && y.queue.priority === 'urgent' ? 0 : 1;
        if (ux !== uy) return ux - uy;
        const cx = (x.queue && x.queue.checked_in_at) || ''; const cy = (y.queue && y.queue.checked_in_at) || '';
        return cx < cy ? -1 : cx > cy ? 1 : x.id - y.id;
      });
      const inService = all.filter((a) => a.status === 'in_service').sort((x, y) => (x.starts_at < y.starts_at ? -1 : 1));
      const upcoming = all.filter((a) => inToday(a) && ['booked', 'confirmed'].includes(a.status)).sort((x, y) => (x.starts_at < y.starts_at ? -1 : 1));
      const done = { completed: 0, no_show: 0, cancelled: 0 };
      for (const a of all) if (inToday(a) && done[a.status] !== undefined) done[a.status]++;
      return ok({ date: today, waiting: waiting.map(apptItem), in_service: inService.map(apptItem), upcoming: upcoming.map(apptItem), done_counts: done }, { generated_at: nowIso() });
    }
    if (m === 'POST' && path === '/api/v1/appointments') {
      if (!body.patient_id || !body.starts_at) return err(422, 'validation_failed', { fields: { starts_at: ['required'] } });
      const branch = body.branch || 'main';
      const end = new Date(Date.parse(body.starts_at) + (body.duration_min || 30) * 60000).toISOString();
      if (busy(branch, new Date(body.starts_at).toISOString(), end, body.doctor_id, body.room_id).length) {
        return err(409, 'slot_conflict', { conflicts: [{ resource_type: 'doctor', resource_id: body.doctor_id }] });
      }
      const a = createAppt(body, body.source);
      if (!a) return err(404, 'not_found');
      return json(201, { data: apptDetail(a) });
    }
    if ((r = path.match(/^\/api\/v1\/appointments\/(\d+)$/)) && m === 'GET') {
      const a = DB.appts[r[1]];
      return a ? ok(apptDetail(a)) : err(404, 'not_found');
    }
    if ((r = path.match(/^\/api\/v1\/appointments\/(\d+)\/(status|queue|note|reschedule)$/))) {
      const a = DB.appts[r[1]];
      if (!a) return err(404, 'not_found');
      const op = r[2];
      if (op === 'status') {
        if (body.expected_status && body.expected_status !== a.status) return err(409, 'status_conflict', { current_status: a.status });
        const from = a.status; const to = body.to;
        if (to === 'cancelled' && !body.cancel_reason) return err(422, 'cancel_reason_required');
        a.status = to;
        if (to === 'checked_in') {
          const day = cairoToday(); const key = a.branch.code + ':' + day;
          DB.queueNo[key] = (DB.queueNo[key] || 0) + 1;
          a.queue = { day, number: DB.queueNo[key], priority: 'normal', checked_in_at: nowIso() };
        }
        if (from === 'checked_in' && to === 'confirmed') a.queue = null;
        if (to === 'cancelled') a.cancel_reason = body.cancel_reason;
        touch(a, 'status_changed', { from_status: from, to_status: to, reason_code: to === 'cancelled' ? body.cancel_reason : (from === 'checked_in' && to === 'confirmed' ? 'check_in_undone' : null) });
      } else if (op === 'queue') {
        if (body.expected_status && body.expected_status !== a.status) return err(409, 'status_conflict', { current_status: a.status });
        if (a.queue) a.queue.priority = body.priority === 'urgent' ? 'urgent' : 'normal';
        touch(a, 'priority_changed');
      } else if (op === 'note') {
        a.note = body.note || null;
        touch(a, 'note_changed');
      } else if (op === 'reschedule') {
        const branch = a.branch.code;
        const starts = body.starts_at ? new Date(body.starts_at).toISOString() : a.starts_at;
        const dur = body.duration_min || a.duration_min;
        const end = new Date(Date.parse(starts) + dur * 60000).toISOString();
        const doc = body.doctor_id !== undefined ? body.doctor_id : a.doctor && a.doctor.id;
        const room = body.room_id !== undefined ? body.room_id : a.room && a.room.id;
        if (busy(branch, starts, end, doc, room, a.id).length) return err(409, 'slot_conflict', { conflicts: [{ resource_type: 'doctor', resource_id: doc }] });
        const before = { starts_at: a.starts_at };
        applyResources(a, body, branch);
        setTimes(a, starts, dur);
        if (a.status === 'confirmed') a.status = 'booked';
        touch(a, 'rescheduled', { changes: { starts_at: [before.starts_at, a.starts_at] } });
      }
      return ok(apptDetail(a));
    }
    if (m === 'GET' && path === '/api/v1/scheduling/availability') {
      const branch = q.get('branch') || 'main';
      const date = q.get('date') || cairoToday();
      const dur = +(q.get('duration_min') || 30);
      const doc = q.get('doctor_id'); const room = q.get('room_id');
      const slots = [];
      const res = DB.resources[branch].data;
      const win = (DB.resources[branch].meta && DB.resources[branch].meta.display_window) || { start: '08:00', end: '20:00' };
      let t = Date.parse(utcFromLocal(date, win.start));
      const end = Date.parse(utcFromLocal(date, win.end));
      const now = Date.now();
      for (; t + dur * 60000 <= end; t += 15 * 60000) {
        if (t < now) continue;
        const a = new Date(t).toISOString(); const b = new Date(t + dur * 60000).toISOString();
        if (busy(branch, a, b, doc, room).length) continue;
        const l = localOf(a);
        slots.push({ starts_at: a, ends_at: b, local: { date: l.date, start: l.hm, end: localOf(b).hm, utc_offset: OFFSET } });
      }
      void res;
      return ok({ date, slots }, { step_min: 15, hours_configured: false });
    }
    if (m === 'GET' && path === '/api/v1/scheduling/resources') {
      const b = q.get('branch') || 'main';
      return json(200, clone(DB.resources[b] || DB.resources.main));
    }
    return null;
  }

  // ---------- patients ----------
  function nextAppt(pid) {
    const now = nowIso();
    const f = Object.values(DB.appts).filter((a) => +a.patient.id === +pid && ['booked', 'confirmed'].includes(a.status) && a.starts_at >= now)
      .sort((x, y) => (x.starts_at < y.starts_at ? -1 : 1));
    return f.length ? f[0].starts_at : null;
  }
  const SUMMARY_KEYS = ['id', 'ref', 'branch', 'name', 'phone', 'phone2', 'age_years', 'sex', 'tags', 'status', 'next_appointment_at', 'projection', 'has_alert'];
  function patientFull(p) {
    p.next_appointment_at = nextAppt(p.id);
    p.has_alert = !!(p.alerts && (p.alerts.allergy === 'reported' || p.alerts.medication === 'reported'));
    return clone(p);
  }
  function patientSummary(p) {
    const f = patientFull(p); const o = {};
    for (const k of SUMMARY_KEYS) o[k] = f[k];
    return o;
  }
  function ageOf(birth) {
    if (!birth) return null;
    const b = new Date(birth + 'T00:00:00Z'); const t = new Date(cairoToday() + 'T00:00:00Z');
    let y = t.getUTCFullYear() - b.getUTCFullYear();
    if (t.getUTCMonth() < b.getUTCMonth() || (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate())) y--;
    return y;
  }
  function tagsFor(ids, branch) {
    const defs = DB.resources[branch || 'main'].data.tags || [];
    return (ids || []).map((id) => findIn(defs, id)).filter(Boolean)
      .map((t) => ({ id: t.id, code: t.code, label_ar: t.label_ar, label_en: t.label_en, is_placeholder: t.is_placeholder }));
  }
  function createPatient(body) {
    const branch = body.branch || 'main';
    const id = DB.seq.patient++;
    const p = {
      id, ref: 'PAT-DEMO' + String(id).padStart(4, '0'), branch: clone(DB.branches[branch]), name: body.name, phone: normPhone(body.phone), phone2: normPhone(body.phone2),
      age_years: ageOf(body.birth_date), sex: body.sex || null, tags: tagsFor(body.tag_ids, branch), status: 'active', next_appointment_at: null,
      projection: 'clinical', has_alert: false, birth_date: body.birth_date || null, locale: body.locale || 'ar', contact_method: body.contact_method || 'whatsapp',
      notes: body.notes || null, source: body.source || 'walk_in', origin_reference: null, last_completed_at: null, version: 1,
      created_at: nowIso(), updated_at: nowIso(), alerts: { allergy: 'unknown', medication: 'unknown' },
    };
    DB.patients[id] = p;
    return p;
  }
  function normPhone(v) {
    if (!v) return null;
    const d = String(v).replace(/[^\d+]/g, '');
    if (/^0\d{10}$/.test(d)) return '+2' + d;
    if (/^20\d{10}$/.test(d)) return '+' + d;
    return d;
  }
  function matchQ(p, q) {
    q = (q || '').toLowerCase().trim();
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    return (p.name || '').toLowerCase().includes(q) || (p.ref || '').toLowerCase().includes(q) || (digits.length >= 3 && (p.phone || '').includes(digits));
  }
  function patientsRoutes(m, path, q, body) {
    let r;
    if (m === 'GET' && path === '/api/v1/patients') {
      const st = q.get('status') || 'active'; const br = q.get('branch'); const tag = q.get('tag');
      const list = Object.values(DB.patients).filter((p) => p.status === st && (!br || p.branch.code === br)
        && (!tag || (p.tags || []).some((t) => String(t.id) === tag || t.code === tag))).sort((a, b) => b.id - a.id).map(patientSummary);
      return ok(list, { next_cursor: null });
    }
    if (m === 'POST' && path === '/api/v1/patients/search') {
      const list = Object.values(DB.patients).filter((p) => (!body.branch || p.branch.code === body.branch) && matchQ(p, body.q))
        .sort((a, b) => b.id - a.id).map(patientSummary);
      return ok(list, { next_cursor: null, mode: /\d/.test(body.q || '') ? 'phone' : 'name', truncated: false });
    }
    if (m === 'POST' && path === '/api/v1/patients/duplicate-check') {
      const digits = (body.phone || '').replace(/\D/g, '');
      const c = digits.length >= 6 ? Object.values(DB.patients).filter((p) => (p.phone || '').replace(/\D/g, '') === digits && +p.id !== +body.exclude_patient_id) : [];
      return ok({ candidates: c.map((p) => ({ id: p.id, ref: p.ref, name: p.name, phone: p.phone, branch: p.branch, match: ['phone'], status: p.status })) });
    }
    if (m === 'POST' && path === '/api/v1/patients') {
      if (!body.name || !body.phone) return err(422, 'validation_failed', { fields: Object.assign({}, !body.name ? { name: ['required'] } : {}, !body.phone ? { phone: ['required'] } : {}) });
      return json(201, { data: patientFull(createPatient(body)) });
    }
    if ((r = path.match(/^\/api\/v1\/patients\/(\d+)$/))) {
      const p = DB.patients[r[1]];
      if (!p) return err(404, 'not_found');
      if (m === 'GET') return ok(patientFull(p));
      if (m === 'PATCH') {
        for (const k of ['name', 'phone', 'birth_date', 'sex', 'locale', 'contact_method', 'notes', 'source']) if (body[k] !== undefined) p[k] = body[k];
        p.age_years = ageOf(p.birth_date);
        p.version++; p.updated_at = nowIso();
        return ok(patientFull(p));
      }
    }
    if ((r = path.match(/^\/api\/v1\/patients\/(\d+)\/(tags|alerts|archive|restore|timeline)$/))) {
      const p = DB.patients[r[1]];
      if (!p) return err(404, 'not_found');
      const op = r[2];
      if (op === 'timeline' && m === 'GET') {
        const items = Object.values(DB.appts).filter((a) => +a.patient.id === +p.id).sort((x, y) => (x.starts_at > y.starts_at ? -1 : 1))
          .map((a) => ({
            appointment: { id: a.id, starts_at: a.starts_at, ends_at: a.ends_at, local: clone(a.local), status: a.status, doctor: clone(a.doctor),
              service: a.service ? { id: a.service.id, code: a.service.code, name_ar: a.service.name_ar, name_en: a.service.name_en } : null,
              room: a.room ? { id: a.room.id, name_ar: a.room.name_ar, name_en: a.room.name_en } : null },
            events: clone(DB.events[a.id] || []),
          }));
        return ok(items, { next_cursor: null, registered_at: p.created_at });
      }
      if (op === 'tags') p.tags = tagsFor(body.tag_ids, p.branch.code);
      if (op === 'alerts') { p.alerts = Object.assign({}, p.alerts, body.allergy ? { allergy: body.allergy } : {}, body.medication ? { medication: body.medication } : {}); }
      if (op === 'archive') p.status = 'archived';
      if (op === 'restore') p.status = 'active';
      p.version++; p.updated_at = nowIso();
      return ok(patientFull(p));
    }
    return null;
  }

  // ---------- booking requests ----------
  const LIST_KEYS = ['id', 'reference', 'status', 'branch', 'name', 'phone', 'service', 'preferred_time', 'contact_method', 'locale', 'has_note', 'duplicate_count', 'assigned_to', 'is_stale', 'created_at', 'contacted_at', 'resolved_at'];
  const TRANSITIONS = { new: ['contacted', 'booked', 'rejected'], contacted: ['booked', 'rejected'] };
  function brItem(x) { const o = {}; for (const k of LIST_KEYS) o[k] = clone(x[k]); return o; }
  const me = () => ({ id: DB.me.user.id, display_name: DB.me.user.display_name });
  function bookingRoutes(m, path, q, body) {
    let r;
    if (m === 'GET' && path === '/api/v1/booking-requests/summary') {
      const out = {};
      for (const b of ['main', 'north']) out[b] = { branch: b, new: 0, contacted: 0, booked: 0, rejected: 0, oldest_new_at: null };
      for (const x of Object.values(DB.requests)) {
        const e = out[x.branch.code]; if (!e) continue;
        e[x.status]++;
        if (x.status === 'new' && (!e.oldest_new_at || x.created_at < e.oldest_new_at)) e.oldest_new_at = x.created_at;
      }
      return ok(Object.values(out));
    }
    if (m === 'GET' && path === '/api/v1/booking-requests/assignees') {
      const b = q.get('branch');
      return ok(DB.assignees.data.filter((a) => !b || a.branch === b));
    }
    if (m === 'GET' && path === '/api/v1/booking-requests') {
      const st = q.get('status'); const qq = (q.get('q') || '').toLowerCase(); const asc = q.get('order') !== 'desc';
      const list = Object.values(DB.requests).filter((x) => (!st || x.status === st)
        && (!qq || (x.name || '').toLowerCase().includes(qq) || (x.phone || '').includes(qq) || (x.reference || '').toLowerCase().includes(qq)))
        .sort((a, b) => (asc ? (a.created_at < b.created_at ? -1 : 1) : (a.created_at > b.created_at ? -1 : 1))).map(brItem);
      return json(200, { data: list, next_cursor: null });
    }
    if ((r = path.match(/^\/api\/v1\/booking-requests\/(\d+)$/)) && m === 'GET') {
      const x = DB.requests[r[1]];
      return x ? json(200, clone(x)) : err(404, 'not_found');
    }
    if ((r = path.match(/^\/api\/v1\/booking-requests\/(\d+)\/(status|note|assignee|convert)$/))) {
      const x = DB.requests[r[1]];
      if (!x) return err(404, 'not_found');
      const op = r[2];
      if (op === 'status') {
        if (body.expected_status !== x.status) return err(409, 'status_conflict', { current_status: x.status });
        if (!(TRANSITIONS[x.status] || []).includes(body.to)) return err(422, 'invalid_transition');
        if (body.to === 'rejected' && !body.reject_reason) return err(422, 'reject_reason_required');
        x.status = body.to;
        if (body.to === 'contacted') { x.contacted_at = nowIso(); x.contacted_by = me(); }
        if (body.to === 'booked' || body.to === 'rejected') { x.resolved_at = nowIso(); x.resolved_by = me(); }
        x.reject_reason = body.to === 'rejected' ? body.reject_reason : null;
        return json(200, clone(x));
      }
      if (op === 'note') { x.internal_note = body.internal_note || null; return json(200, clone(x)); }
      if (op === 'assignee') { x.assigned_to = body.user_id ? (DB.users[body.user_id] || null) : null; return json(200, clone(x)); }
      if (op === 'convert') {
        if (body.expected_status && body.expected_status !== x.status) return err(409, 'status_conflict', { current_status: x.status });
        let p;
        const pb = body.patient || {};
        if (pb.mode === 'existing') p = DB.patients[pb.patient_id];
        else p = createPatient({ branch: x.branch.code, name: pb.name || x.name, phone: pb.phone || x.phone, birth_date: pb.birth_date, sex: pb.sex, notes: pb.notes, locale: x.locale, contact_method: x.contact_method, source: 'booking_request' });
        if (!p) return err(404, 'not_found');
        const ab = Object.assign({ branch: x.branch.code }, body.appointment || {}, { patient_id: p.id });
        const a = createAppt(ab, 'booking_request');
        a.booking_reference = x.reference;
        x.status = 'booked'; x.resolved_at = nowIso(); x.resolved_by = me(); x.appointment_id = a.id; x.patient_id = p.id;
        return ok({ appointment: apptDetail(a), patient: patientFull(p), booking_request: { id: x.id, reference: x.reference, status: 'booked', appointment_id: a.id, patient_id: p.id } });
      }
    }
    return null;
  }


  // ---------- leads ----------
  const LEAD_ITEM_KEYS = ['id', 'ref', 'status', 'lost_reason', 'branch', 'name', 'phone_last4', 'phone_kind', 'service_key', 'flags', 'source', 'platform', 'campaign_name', 'form', 'assigned_to', 'has_possible_match', 'anonymised', 'received_at', 'received_at_local', 'version'];
  const TAB_STATUS = { new: ['new'], in_progress: ['contacted'], booked: ['booked', 'converted'], lost: ['lost'] };
  function leadActions(l) {
    switch (l.status) {
      case 'new': return ['mark_contacted', 'mark_lost', 'assign', 'edit_note', 'convert', 'erase'];
      case 'contacted': return ['mark_lost', 'assign', 'edit_note', 'convert', 'erase'];
      case 'booked': return ['mark_lost'];
      case 'lost': return ['reopen'];
      default: return [];
    }
  }
  function localStamp(iso) {
    const l = localOf(iso);
    return { date: l.date, time: l.hm, utc_offset: OFFSET };
  }
  function leadDetail(l) { l.allowed_actions = leadActions(l); return clone(l); }
  function leadItem(l) { const o = {}; for (const k of LEAD_ITEM_KEYS) o[k] = clone(l[k]); return o; }
  function leadEvent(l, from, to, extra) {
    const at = nowIso();
    (l.events = l.events || []).push(Object.assign({ type: 'status_changed', from_status: from, to_status: to, lost_reason: null, assignee: null,
      actor: me(), occurred_at: at, occurred_at_local: localStamp(at) }, extra || {}));
    l.version = (l.version || 1) + 1;
  }
  function leadList(tab, q) {
    const order = DB.leadOrder[tab] || DB.leadOrder.all || [];
    const rank = (id) => { const i = order.indexOf(+id); return i < 0 ? -1 : i; };
    const sts = TAB_STATUS[tab];
    q = (q || '').toLowerCase().trim();
    return Object.values(DB.leads).filter((l) => (!sts || sts.includes(l.status))
      && (!q || (l.name || '').toLowerCase().includes(q) || (l.ref || '').toLowerCase().includes(q) || (l.phone || '').includes(q) || (l.phone_last4 || '') === q))
      .sort((a, b) => rank(a.id) - rank(b.id) || (a.received_at < b.received_at ? 1 : -1)).map(leadItem);
  }
  function leadsRoutes(m, path, q, body) {
    let r;
    if (m === 'GET' && path === '/api/v1/leads/summary') {
      const out = {};
      for (const b of ['main', 'north']) out[b] = { branch: b, new: 0, contacted: 0, booked: 0, converted: 0, lost: 0, unassigned_new: 0, assigned_to_me_new: 0, oldest_new_at: null, oldest_new_at_local: null };
      for (const l of Object.values(DB.leads)) {
        const e = out[l.branch.code]; if (!e) continue;
        if (e[l.status] !== undefined) e[l.status]++;
        if (l.status === 'new') {
          if (!l.assigned_to) e.unassigned_new++; else if (+l.assigned_to.id === +DB.me.user.id) e.assigned_to_me_new++;
          if (!e.oldest_new_at || l.received_at < e.oldest_new_at) { e.oldest_new_at = l.received_at; e.oldest_new_at_local = localStamp(l.received_at); }
        }
      }
      return ok(Object.values(out));
    }
    if (m === 'GET' && path === '/api/v1/leads/assignees') {
      const b = q.get('branch') || 'main';
      return json(200, clone(DB.leadAssignees[b] || DB.leadAssignees.main));
    }
    if (m === 'GET' && path === '/api/v1/leads') return ok(leadList(q.get('tab') || 'all'), { next_cursor: null });
    if (m === 'POST' && path === '/api/v1/leads/search') return ok(leadList(body.tab || 'all', body.q), { next_cursor: null });
    if ((r = path.match(/^\/api\/v1\/leads\/(\d+)$/)) && m === 'GET') {
      const l = DB.leads[r[1]];
      return l ? ok(leadDetail(l)) : err(404, 'not_found');
    }
    if ((r = path.match(/^\/api\/v1\/leads\/(\d+)\/(contacted|lost|reopen|assignee|note|convert|erase)$/))) {
      const l = DB.leads[r[1]];
      if (!l) return err(404, 'not_found');
      const op = r[2];
      if (body.expected_status && body.expected_status !== l.status) return err(409, 'status_conflict', { current_status: l.status });
      const at = nowIso();
      if (op === 'contacted') {
        leadEvent(l, l.status, 'contacted'); l.status = 'contacted';
        if (!l.first_contacted_at) { l.first_contacted_at = at; l.first_contacted_at_local = localStamp(at); l.first_contacted_by = me(); }
      } else if (op === 'lost') {
        if (!body.lost_reason) return err(422, 'validation_failed', { fields: { lost_reason: ['required'] } });
        leadEvent(l, l.status, 'lost', { lost_reason: body.lost_reason }); l.status = 'lost'; l.lost_reason = body.lost_reason;
        l.resolved_at = at; l.resolved_at_local = localStamp(at); l.resolved_by = me();
      } else if (op === 'reopen') {
        leadEvent(l, 'lost', l.first_contacted_at ? 'contacted' : 'new', { type: 'reopened' });
        l.status = l.first_contacted_at ? 'contacted' : 'new'; l.lost_reason = null; l.resolved_at = null; l.resolved_at_local = null; l.resolved_by = null;
      } else if (op === 'assignee') {
        l.assigned_to = body.user_id ? (DB.users[body.user_id] || null) : null;
        leadEvent(l, null, null, { type: 'assigned', assignee: l.assigned_to });
      } else if (op === 'note') {
        l.internal_note = body.internal_note || null; l.version = (l.version || 1) + 1;
      } else if (op === 'erase') {
        return demoOnly();
      } else if (op === 'convert') {
        const pb = body.patient || {};
        let p;
        if (pb.mode === 'existing') p = DB.patients[pb.patient_id];
        else p = createPatient({ branch: l.branch.code, name: pb.name || l.name, phone: pb.phone || l.phone, birth_date: pb.birth_date, sex: pb.sex, notes: pb.notes, source: 'meta_lead' });
        if (!p) return err(404, 'not_found');
        if (!p.phone) return err(422, 'validation_failed', { fields: { 'patient.phone': ['required'] } });
        const a = createAppt(Object.assign({ branch: l.branch.code }, body.appointment || {}, { patient_id: p.id }), 'meta_lead');
        leadEvent(l, l.status, 'booked'); l.status = 'booked';
        l.booked_at = at; l.booked_at_local = localStamp(at); l.patient_id = p.id; l.appointment_id = a.id;
        return json(201, { data: { lead: { id: l.id, ref: l.ref, status: 'booked', appointment_id: a.id, patient_id: p.id }, appointment: apptDetail(a), patient: patientFull(p) } });
      }
      return ok(leadDetail(l));
    }
    return null;
  }

  // ---------- auth ----------
  function authRoutes(m, path, body) {
    if (path === '/api/auth/csrf') return json(200, { csrf_token: 'demo-csrf-token' });
    if (path === '/api/auth/me') return DB.signedIn ? json(200, clone(DB.me)) : err(401, 'unauthenticated');
    if (path === '/api/auth/login' && m === 'POST') {
      DB.signedIn = true;
      return json(200, { user: clone(DB.me.user), must_change_password: false, two_factor: 'verified', csrf_token: 'demo-csrf-token' });
    }
    if (path === '/api/auth/2fa/verify') return json(200, { two_factor: 'verified' });
    if (path === '/api/auth/logout') { DB.signedIn = false; return json(200, { status: 'signed_out' }); }
    if (path === '/api/v1/me/access') return json(200, clone(DB.access));
    if (path === '/api/v1/clock') {
      const n = new Date();
      return ok({ now: n.toISOString(), timezone: 'Africa/Cairo', today: cairoToday(), utc_offset: OFFSET, next_transition: null });
    }
    return null;
  }

  // ---------- read-only records (sheets, templates, packages, photos) ----------
  function recordedRoutes(m, path, q) {
    if (m !== 'GET') return null;
    let r;
    if ((r = path.match(/^\/api\/v1\/photos\/(\d+)\/file$/))) {
      const p = DB.photo[r[1] + ':' + (q.get('variant') || 'thumb')];
      if (!p) return err(404, 'not_found');
      const bin = Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0));
      return new Response(bin, { status: 200, headers: { 'Content-Type': p.ct || 'image/jpeg' } });
    }
    const full = path + (q.toString() ? '?' + q.toString() : '');
    let v = DB.raw(full);
    if (v && DB.rawStatus(full) < 400) return json(200, v);
    const cands = DB.byPath[path] || [];
    if (cands.length) {
      // same path, best match on the non-date parameters; a different patient gets the smallest (emptiest) answer
      const want = {};
      q.forEach((val, key) => { if (!/^(from|to|date|cursor)$/.test(key)) want[key] = val; });
      let best = null; let bestScore = -1;
      for (const k of cands) {
        const kq = new URLSearchParams(k.split('?')[1] || '');
        let score = 0; let clash = false;
        for (const key of Object.keys(want)) {
          if (kq.get(key) === want[key]) score++;
          else if (kq.has(key) && /(_id|^id)$/.test(key)) clash = true;
        }
        if (!clash && score > bestScore) { best = k; bestScore = score; }
      }
      if (!best) {
        best = cands.slice().sort((a, b) => JSON.stringify(DB.raw(a)).length - JSON.stringify(DB.raw(b)).length)[0];
      }
      v = DB.raw(best);
      if (v) return json(200, v);
    }
    if (/^\/api\/v1\/patients\/\d+\/(sheets|packages)$/.test(path)) return ok([], { next_cursor: null });
    if (/^\/api\/v1\/sheets\/\d+\/(photos|history)$/.test(path)) return ok([], { next_cursor: null });
    return null;
  }

  function lookupRoutes(m, path, body) {
    if (m === 'POST' && (path === '/api/v1/pos/invoices/lookup' || path === '/api/v1/finance/invoices/lookup')) {
      const no = String(body.invoice_no || '').trim().toUpperCase();
      const base = path.startsWith('/api/v1/pos') ? '/api/v1/pos/invoices/' : '/api/v1/finance/invoices/';
      for (const k of DB.byPath ? Object.keys(DB.byPath) : []) {
        if (!k.startsWith(base)) continue;
        const v = DB.raw(k);
        const inv = v && v.data && (v.data.invoice_no ? v.data : v.data.invoice);
        if (inv && String(inv.invoice_no || '').toUpperCase().endsWith(no)) return json(200, v);
      }
      return err(404, 'not_found');
    }
    return null;
  }

  async function handle(method, url, bodyText) {
    await ready;
    if (!DB) return err(503, 'unavailable');
    const u = new URL(url, location.href);
    const path = u.pathname.replace(/^.*?(\/api\/)/, '/api/');
    const q = u.searchParams;
    let body = {};
    if (bodyText) { try { body = JSON.parse(bodyText); } catch (_) { body = {}; } }
    const m = method.toUpperCase();
    const res = authRoutes(m, path, body) || appointmentsRoutes(m, path, q, body) || patientsRoutes(m, path, q, body)
      || bookingRoutes(m, path, q, body) || leadsRoutes(m, path, q, body) || lookupRoutes(m, path, body) || recordedRoutes(m, path, q);
    if (res) return res;
    if (m !== 'GET') return demoOnly();
    return err(404, 'not_found');
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let path;
    try { path = new URL(url, location.href).pathname; } catch (_) { path = ''; }
    if (!/\/api\//.test(path)) return realFetch(input, init);
    const method = (init && init.method) || (input && input.method) || 'GET';
    let bodyText = null;
    const b = init && init.body;
    if (typeof b === 'string') bodyText = b;
    else if (b instanceof Uint8Array || b instanceof ArrayBuffer) bodyText = new TextDecoder().decode(b);
    else if (b instanceof Blob) bodyText = await b.text();
    else if (b && typeof b === 'object' && !(b instanceof FormData)) { try { bodyText = new TextDecoder().decode(b); } catch (_) { bodyText = null; } }
    await new Promise((r) => setTimeout(r, 120)); // feel of a network round trip
    return handle(method, url, bodyText);
  };
})();
