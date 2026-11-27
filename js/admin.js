(() => {
  'use strict';
  const sb = window.supabase.createClient(PT_CONFIG.url, PT_CONFIG.anonKey);
  const $ = (id) => document.getElementById(id);
  const MARKS = ['①', '②', '③', '④', '⑤'];
  const CLASSES_FALLBACK = 8;

  const state = { view: 'run', round: 1, cls: null, rounds: [], classCount: CLASSES_FALLBACK, monitorTimer: null, results: null, stats: null, myClasses: [], lastPin: null };

  // ---------- 공통 ----------
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }
  function toast(msg) {
    const t = el('div', { class: 'toast' }, msg);
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }
  const ERR = {
    NOT_ADMIN: '관리자 권한이 없습니다.', HAS_ATTEMPTS: '이미 응시 기록이 있는 회차는 문항을 바꿀 수 없습니다. 먼저 결과 화면에서 응시 기록을 삭제하세요.',
    REASON_REQUIRED: '사유를 적어 주세요.', ALREADY_SUBMITTED: '직접 제출한 학생은 시간을 되돌릴 수 없습니다. 재응시를 허용하세요.',
  };
  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) {
      const code = Object.keys(ERR).find((k) => (error.message || '').includes(k));
      toast(code ? ERR[code] : '처리하지 못했습니다: ' + error.message);
      return null;
    }
    return data;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const mmss = (s) => (s === null || s === undefined ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  function modal(title, bodyNodes, buttons) {
    const body = $('modal-body'); body.innerHTML = ''; body.style.maxWidth = '';
    body.append(el('h2', {}, title), ...[].concat(bodyNodes));
    const row = el('div', { class: 'row', style: 'margin-top:20px;justify-content:flex-end' });
    (buttons || [{ text: '닫기' }]).forEach((b) => row.append(el('button', {
      class: 'btn ' + (b.cls || ''), type: 'button',
      onclick: async () => { if (b.onClick) { const keep = await b.onClick(); if (keep === false) return; } $('modal').classList.add('hidden'); },
    }, b.text)));
    body.append(row);
    $('modal').classList.remove('hidden');
  }
  function confirmBox(title, text, okText, danger) {
    return new Promise((res) => modal(title, [el('p', {}, text)], [
      { text: '취소', onClick: () => res(false) },
      { text: okText, cls: danger ? 'danger solid' : 'primary', onClick: () => res(true) },
    ]));
  }
  function selRow(container, values, current, label, onPick, extra) {
    container.innerHTML = '';
    values.forEach((v) => {
      const b = el('button', { type: 'button', class: v === current ? 'on' : '' }, label(v), extra ? extra(v) : null);
      b.addEventListener('click', () => onPick(v));
      container.appendChild(b);
    });
  }

  // ---------- 로그인 ----------
  let authMode = 'login';
  document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    document.querySelectorAll('[data-auth]').forEach((x) => x.classList.toggle('on', x === b));
    $('btn-login').textContent = authMode === 'login' ? '로그인' : '계정 만들기';
    $('signup-note').classList.toggle('hidden', authMode !== 'signup');
  }));
  function loginMsg(text, kind) { const m = $('login-msg'); m.textContent = text; m.className = 'notice ' + (kind || 'bad'); m.classList.toggle('hidden', !text); }
  $('f-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('l-email').value.trim(), password = $('l-pw').value;
    loginMsg('');
    if (authMode === 'signup') {
      const { error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
      if (error) loginMsg('계정을 만들지 못했습니다: ' + error.message);
      else loginMsg('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 여기서 로그인하세요.', 'good');
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) loginMsg(error.message.includes('confirm') ? '이메일 확인이 아직 안 됐습니다. 메일의 링크를 눌러 주세요.' : '이메일 또는 비밀번호가 맞지 않습니다.');
    else boot();
  });
  $('btn-logout').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { $('scr-login').classList.remove('hidden'); $('app').classList.add('hidden'); return; }
    const me = await rpc('claim_admin');
    if (!me || me.status !== 'approved') {
      $('scr-login').classList.remove('hidden');
      loginMsg(me && me.status === 'pending'
        ? '승인 대기 중입니다. 함께 쓰는 선생님께 \'설정 → 교사\'에서 승인해 달라고 요청하세요.'
        : '이 계정으로는 들어올 수 없습니다.', 'warn');
      await sb.auth.signOut();
      return;
    }
    state.myClasses = me.classes || [];
    if (state.cls === null) state.cls = state.myClasses[0] || 1;
    $('who').textContent = data.session.user.email;
    $('scr-login').classList.add('hidden'); $('app').classList.remove('hidden');
    await loadBasics();
    switchView(state.view);
  }

  async function loadBasics() {
    const { data: rounds } = await sb.from('rounds').select('*').order('round_no');
    state.rounds = rounds || [];
    const { data: maxc } = await sb.from('students').select('class_no').order('class_no', { ascending: false }).limit(1);
    state.classCount = (maxc && maxc[0] && maxc[0].class_no) || CLASSES_FALLBACK;
  }
  const roundTitle = (n) => (state.rounds.find((r) => r.round_no === n) || {}).title || `${n}회`;
  const classList = () => Array.from({ length: state.classCount }, (_, i) => i + 1);

  // ---------- 메뉴 ----------
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  function switchView(v) {
    state.view = v;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    ['run', 'results', 'bank', 'students', 'settings'].forEach((x) => $('view-' + x).classList.toggle('hidden', x !== v));
    clearInterval(state.monitorTimer);
    if (v === 'run') initRun();
    if (v === 'results') initResults();
    if (v === 'bank') initBank();
    if (v === 'students') initStudents();
    if (v === 'settings') initSettings();
  }

  // ---------- 수업 운영 ----------
  let openSessions = [];
  async function initRun() {
    const { data } = await sb.from('class_sessions').select('round_no,class_no,is_open');
    openSessions = (data || []).filter((s) => s.is_open);
    const isOpen = (r, c) => openSessions.some((s) => s.round_no === r && s.class_no === c);
    selRow($('run-round'), state.rounds.map((r) => r.round_no), state.round, (n) => `${n}회`, (n) => { state.round = n; initRun(); });
    const ordered = [...state.myClasses.filter((c) => c <= state.classCount).sort((a, b) => a - b), ...classList().filter((c) => !state.myClasses.includes(c))];
    selRow($('run-class'), ordered, state.cls, (c) => (state.myClasses.includes(c) ? `${c}반 ★` : `${c}반`), (c) => { state.cls = c; initRun(); },
      (c) => (isOpen(state.round, c) ? el('span', { class: 'dot', title: '열림' }) : null));
    const base = location.origin + location.pathname.replace(/admin\.html$/, '');
    const lockUrl = 'ms-edu-secureassessment:' + base + 'index.html!enforceLockdown';
    $('lock-url').textContent = lockUrl;
    $('plain-url').textContent = base;
    $('btn-copy-lock').onclick = () => navigator.clipboard.writeText(lockUrl).then(() => toast('복사했습니다.'));
    try {
      const qr = qrcode(0, 'M'); qr.addData(lockUrl); qr.make();
      $('qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
    } catch (e) { $('qr').textContent = ''; }
    await refreshMonitor();
    state.monitorTimer = setInterval(() => { if (!document.hidden) refreshMonitor(); }, 3000);
  }
  $('run-hide-none').addEventListener('change', () => refreshMonitor());

  function renderSessionCard(sess) {
    const card = $('session-card'); card.innerHTML = '';
    const title = el('h3', {}, `${roundTitle(state.round)} · ${state.cls}반`);
    state.lastPin = sess && sess.is_open ? sess.pin : null;
    if (sess && sess.is_open) {
      card.append(title,
        el('div', { class: 'badge good' }, '열림 · 이 반 학생만 입장 가능'),
        el('div', { class: 'muted small' }, '입장 암호 (칠판에 적어 주세요)'),
        el('div', { class: 'pin-box' }, sess.pin),
        el('div', { class: 'small muted' }, `연 시각 ${fmtTime(sess.opened_at)}`),
        el('button', { class: 'btn danger solid lg block', type: 'button', onclick: closeSession }, '회차 닫기 (수업 끝)'),
        el('p', { class: 'small muted' }, '닫으면 푸는 중인 답안이 자동 제출되고, 이 반 학생에게 점수가 공개됩니다.'));
    } else {
      card.append(title,
        el('div', { class: 'badge' }, sess && sess.closed_at ? `닫힘 · ${fmtTime(sess.closed_at)}` : '아직 열지 않음'),
        el('p', { class: 'small muted' }, '수업을 시작할 때 엽니다. 열 때마다 새 입장 암호가 만들어집니다. 이미 제출한 학생은 다시 열어도 입장할 수 없어, 3차시 미응시자 시험에도 그대로 쓰면 됩니다.'),
        el('button', { class: 'btn good lg block', type: 'button', onclick: openSession }, '회차 열기 (수업 시작)'));
    }
  }
  async function openSession() {
    const other = openSessions.filter((s) => s.class_no !== state.cls);
    if (other.length && !(await confirmBox('다른 반이 열려 있습니다', `${[...new Set(other.map((s) => s.class_no))].join(', ')}반 회차가 아직 열려 있습니다. 그대로 두고 ${state.cls}반을 열까요?`, '열기'))) return;
    const r = await rpc('admin_open_session', { p_round: state.round, p_class: state.cls });
    if (r && r.ok) { toast(`입장 암호 ${r.pin}`); initRun(); }
  }
  async function closeSession() {
    if (!(await confirmBox('회차를 닫을까요?', `${state.cls}반 ${state.round}회를 닫습니다. 푸는 중인 학생은 지금까지 고른 답으로 제출되고, 이 반 점수가 공개됩니다.`, '닫기', true))) return;
    const r = await rpc('admin_close_session', { p_round: state.round, p_class: state.cls });
    if (r && r.ok) { toast(`닫았습니다. 자동 제출 ${r.auto_submitted}명`); initRun(); }
  }

  const STATUS = {
    none: ['미응시', ''], ready: ['입장(시작 전)', 'primary'], in_progress: ['응시 중', 'primary'], submitted: ['제출', 'good'],
  };
  async function refreshMonitor() {
    const r = await rpc('admin_monitor', { p_round: state.round, p_class: state.cls });
    if (!r) return;
    renderSessionCard(r.session);
    const rows = r.students;
    const active = rows.filter((s) => !s.excluded);
    const k = (label, v) => el('div', { class: 'kpi' }, el('div', { class: 'v' }, v), el('div', { class: 'k' }, label));
    $('run-kpis').innerHTML = '';
    $('run-kpis').append(
      k('응시 대상', active.length),
      k('응시 중', active.filter((s) => s.status === 'in_progress').length),
      k('제출', active.filter((s) => s.status === 'submitted').length),
      k('지금 이탈 중', active.filter((s) => s.status === 'in_progress' && s.away).length),
      k('미응시', active.filter((s) => s.status === 'none').length));
    $('run-updated').textContent = `· ${new Date().toLocaleTimeString('ko-KR')} 갱신`;
    const body = $('run-body'); body.innerHTML = '';
    const hide = $('run-hide-none').checked;
    rows.forEach((s) => {
      if (hide && (s.excluded || s.status === 'none')) return;
      let [label, cls] = STATUS[s.status] || [s.status, ''];
      if (s.excluded) { label = '대상 아님'; cls = ''; }
      if (s.status === 'in_progress' && s.away) { label = '이탈 중'; cls = 'bad'; }
      if (s.status === 'submitted' && s.submit_reason && s.submit_reason !== 'manual') label += s.submit_reason === 'timeout' ? '(시간 끝)' : '(마감)';
      const tr = el('tr', { class: s.excluded ? 'dim' : (s.status === 'in_progress' && s.away ? 'alert' : '') },
        el('td', {}, s.student_no, s.locked ? el('span', { class: 'badge warn', style: 'margin-left:6px' }, '잠김') : null),
        el('td', {}, el('span', { class: 'badge ' + cls }, label), s.device_conflicts ? el('span', { class: 'badge bad', style: 'margin-left:4px' }, `다른 기기 ${s.device_conflicts}`) : null),
        el('td', { class: 'num' }, s.total ? `${s.answered}/${s.total}` : ''),
        el('td', { class: 'num' }, s.status === 'in_progress' ? mmss(s.remaining) : ''),
        el('td', { class: 'num' }, s.leaves || ''),
        el('td', { class: 'num' }, s.blocked || ''),
        el('td', {}, s.attempt_id ? (s.lockdown ? el('span', { class: 'badge good' }, '잠금') : el('span', { class: 'badge' }, '일반')) : ''),
        el('td', {}, s.status === 'in_progress' ? (s.online ? el('span', { class: 'badge good' }, '연결') : el('span', { class: 'badge warn' }, '끊김')) : ''),
        el('td', {}, actionButtons(s)));
      body.appendChild(tr);
    });
  }

  function actionButtons(s) {
    const box = el('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' });
    box.append(el('button', { class: 'btn sm', type: 'button', onclick: () => showCode(s.student_no) }, '코드'));
    if (s.attempt_id) box.append(el('button', { class: 'btn sm', type: 'button', onclick: () => showDetail(s.attempt_id, s.student_no) }, '상세'));
    if (s.status === 'in_progress' || (s.status === 'submitted' && s.submit_reason !== 'manual')) {
      box.append(el('button', { class: 'btn sm', type: 'button', onclick: () => adjustTime(s) }, '시간'));
    }
    if (s.device_conflicts && !s.allow_device_change && s.status !== 'submitted') {
      box.append(el('button', { class: 'btn sm', type: 'button', onclick: async () => {
        if (await confirmBox('기기 교체 승인', `${s.student_no} 학생이 다른 기기로 이어서 풀 수 있게 합니다. 기존 기기는 더 이상 쓸 수 없습니다.`, '승인')) {
          const r = await rpc('admin_allow_device', { p_attempt: s.attempt_id }); if (r) { toast('승인했습니다. 새 기기에서 다시 입장하면 됩니다.'); refreshMonitor(); }
        } } }, '기기 승인'));
    }
    if (s.attempt_id) box.append(el('button', { class: 'btn sm danger', type: 'button', onclick: () => resetAttempt(state.round, s.student_no, refreshMonitor) }, '재응시'));
    return box;
  }

  async function showCode(sno) {
    const { data } = await sb.from('students').select('code').eq('student_no', sno).single();
    if (!data) { toast('코드를 불러오지 못했습니다.'); return; }
    modal(`${sno} 개인 코드`, [
      el('div', { class: 'pin-box', style: 'font-size:3rem;margin:12px 0' }, data.code),
      el('p', { class: 'small muted' }, '학생에게만 보여 주세요. 코드가 새어 나간 것 같으면 \'학생·코드\' 화면에서 재발급하세요.'),
    ]);
  }

  // 학생 접속 안내(프로젝터용)
  async function showJoin() {
    const base = location.origin + location.pathname.replace(/admin\.html$/, '');
    const { data: st } = await sb.from('settings').select('short_url').eq('id', 1).single();
    const short = st && st.short_url ? st.short_url.replace(/^https?:\/\//, '') : '';
    try { const qr = qrcode(0, 'M'); qr.addData(st && st.short_url ? st.short_url : base); qr.make(); $('join-qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 1 }); } catch (e) { $('join-qr').textContent = ''; }
    $('join-short').textContent = short;
    $('join-url').textContent = short ? base : base.replace(/^https?:\/\//, '');
    $('join-url').style.fontSize = short ? '1.1rem' : '2rem';
    $('join-pin').textContent = state.lastPin ? `${state.cls}반 입장 암호  ${state.lastPin}` : '';
    $('join').classList.remove('hidden');
    try { await document.documentElement.requestFullscreen(); } catch (e) {}
  }
  $('btn-join-info').addEventListener('click', showJoin);
  $('btn-join-close').addEventListener('click', () => { $('join').classList.add('hidden'); try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {} });

  function adjustTime(s) {
    const kind = el('select', {},
      el('option', { value: 'restore' }, '시간 복구 — 기기 고장·인터넷 끊김으로 잃은 시간'),
      el('option', { value: 'accommodation' }, '편의 제공 연장 — 학교 규정상 대상 학생만'));
    const min = el('input', { type: 'number', min: '1', max: '60', value: '2' });
    const reason = el('input', { type: 'text', placeholder: '예: 3분 동안 태블릿이 꺼져 교사가 확인함' });
    modal(`${s.student_no} 시간 조정`, [
      el('p', { class: 'small muted' }, '형평성을 위해 사유를 반드시 적고, 기록은 결과 화면에 남습니다. 시간 초과·마감으로 제출된 학생은 복구하면 다시 풀 수 있습니다.'),
      el('div', { class: 'field' }, el('label', {}, '종류'), kind),
      el('div', { class: 'field' }, el('label', {}, '분'), min),
      el('div', { class: 'field' }, el('label', {}, '사유 (필수)'), reason),
    ], [
      { text: '취소' },
      { text: '적용', cls: 'primary', onClick: async () => {
        if (!reason.value.trim()) { toast('사유를 적어 주세요.'); return false; }
        const sec = Math.round(Number(min.value) * 60);
        if (!(sec > 0 && sec <= 3600)) { toast('1~60분 사이로 넣어 주세요.'); return false; }
        const r = await rpc('admin_adjust_time', { p_attempt: s.attempt_id, p_kind: kind.value, p_seconds: sec, p_reason: reason.value.trim() });
        if (r) { toast('적용했습니다.'); refreshMonitor(); }
      } },
    ]);
  }

  function resetAttempt(round, sno, after) {
    const reason = el('input', { type: 'text', placeholder: '예: 기기 고장으로 응시 불가, 교사 확인' });
    modal(`${sno} 재응시 허용`, [
      el('p', {}, '이 학생의 이 회차 응시 기록(답·점수·이탈 기록)을 지우고, 다시 입장하면 문항을 새로 뽑습니다. 되돌릴 수 없습니다.'),
      el('div', { class: 'field' }, el('label', {}, '사유 (필수, 조치 기록에 남음)'), reason),
    ], [
      { text: '취소' },
      { text: '재응시 허용', cls: 'danger solid', onClick: async () => {
        if (!reason.value.trim()) { toast('사유를 적어 주세요.'); return false; }
        const r = await rpc('admin_reset_attempt', { p_round: round, p_student_no: sno, p_reason: reason.value.trim() });
        if (r) { toast('재응시를 허용했습니다.'); after && after(); }
      } },
    ]);
  }

  const EVT = {
    enter: '입장', start: '시작', view: '문항 이동', answer: '답 선택', leave: '화면 이탈', return: '복귀',
    fullscreen_exit: '전체 화면 벗어남', fullscreen_enter: '전체 화면 복귀', copy: '복사 시도', paste: '붙여넣기 시도',
    contextmenu: '우클릭 시도', print: '인쇄 시도', key_block: '단축키 시도', device_conflict: '다른 기기 접속 시도',
    lockdown: '잠금 모드 확인', submit: '제출', resize: '창 크기 변경',
  };
  async function showDetail(attemptId, sno) {
    const r = await rpc('admin_attempt_detail', { p_attempt: attemptId });
    if (!r) return;
    // 문항별로 머문 시간: 문항 이동 기록 사이의 간격
    const evs = r.events;
    const dwell = {};
    let curItem = 0, since = null;
    for (const e of evs) {
      const t = new Date(e.at).getTime();
      if (e.type === 'start') { since = t; curItem = 0; continue; }
      if (since === null) continue;
      if (e.type === 'view' && e.item !== null) { dwell[curItem] = (dwell[curItem] || 0) + (t - since); curItem = e.item; since = t; }
      if (e.type === 'submit') { dwell[curItem] = (dwell[curItem] || 0) + (t - since); since = null; }
    }
    const itemTable = el('table', {}, el('thead', {}, el('tr', {}, el('th', { class: 'num' }, '순서'), el('th', { class: 'num' }, '은행 번호'), el('th', { class: 'num' }, '단원'), el('th', {}, '결과'), el('th', { class: 'num' }, '머문 시간'))),
      el('tbody', {}, r.items.map((it) => el('tr', {},
        el('td', { class: 'num' }, it.no), el('td', { class: 'num' }, it.q_no), el('td', { class: 'num' }, it.unit_no),
        el('td', {}, it.mine === null ? el('span', { class: 'badge' }, '답 없음') : (it.mine === it.answer ? el('span', { class: 'badge good' }, '맞음') : el('span', { class: 'badge bad' }, '틀림'))),
        el('td', { class: 'num' }, dwell[it.no - 1] ? `${Math.round(dwell[it.no - 1] / 1000)}초` : '')))));
    const evTable = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '시각'), el('th', {}, '기록'), el('th', { class: 'num' }, '문항'), el('th', {}, '내용'))),
      el('tbody', {}, evs.filter((e) => e.type !== 'view').map((e) => el('tr', { class: ['leave', 'fullscreen_exit', 'copy', 'paste', 'contextmenu', 'print', 'key_block', 'device_conflict'].includes(e.type) ? 'alert' : '' },
        el('td', {}, fmtTime(e.at)), el('td', {}, EVT[e.type] || e.type), el('td', { class: 'num' }, e.item === null ? '' : e.item + 1),
        el('td', { class: 'small' }, e.type === 'return' && e.detail ? `${e.detail.seconds}초 동안 벗어남` : (e.detail && e.detail.key) || (e.detail && e.detail.reason) || (e.type === 'enter' && e.detail ? (e.detail.lockdown ? '잠금 모드' : '일반') + (e.detail.ip ? ` · ${e.detail.ip}` : '') : ''))))));
    modal(`${sno} 응시 상세`, [
      el('h3', {}, '문항별'), el('div', { class: 'table-wrap' }, itemTable),
      el('h3', { style: 'margin-top:16px' }, '기록(시간 순)'), el('div', { class: 'table-wrap', style: 'max-height:320px;overflow:auto' }, evTable),
    ]);
    $('modal-body').style.maxWidth = '860px';
  }

  // ---------- 결과 ----------
  async function initResults() {
    selRow($('res-round'), state.rounds.map((r) => r.round_no), state.round, (n) => `${n}회`, (n) => { state.round = n; initResults(); });
    const sel = $('res-class');
    if (!sel.options.length) {
      sel.append(el('option', { value: '' }, '전체'), ...classList().map((c) => el('option', { value: c }, `${c}반`)));
      sel.addEventListener('change', renderResults);
      $('res-status').addEventListener('change', renderResults);
    }
    const [res, stats] = await Promise.all([rpc('admin_results', { p_round: state.round }), rpc('admin_item_stats', { p_round: state.round })]);
    state.results = res ? res.students : [];
    state.stats = stats ? stats.items : [];
    await loadBasics();
    renderReviewCard();
    renderResults();
    renderStats();
  }
  function renderReviewCard() {
    const r = state.rounds.find((x) => x.round_no === state.round);
    const card = $('review-card'); card.innerHTML = '';
    const on = r && r.review_released;
    card.append(
      el('div', { class: 'row' },
        el('div', {}, el('h3', { style: 'margin:0' }, '오답 공개'),
          el('div', { class: 'small muted' }, on ? '공개 중: 학생이 내 20문항·내 답·정답을 볼 수 있습니다.' : '비공개: 3차시(미응시자 시험)가 모두 끝난 뒤 한 번 공개하세요. 점수는 반별로 회차를 닫을 때 이미 공개됩니다.')),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn ' + (on ? '' : 'primary'), type: 'button', onclick: async () => {
          if (!on) {
            const open = (await sb.from('class_sessions').select('class_no').eq('round_no', state.round).eq('is_open', true)).data || [];
            const msg = open.length ? `아직 열린 반이 있습니다(${open.map((x) => x.class_no).join(', ')}반). 응시 중에 정답이 공개됩니다. 그래도 공개할까요?` : '모든 학생에게 이 회차의 문항·내 답·정답을 공개합니다. 남은 응시가 없는지 확인하셨나요?';
            if (!(await confirmBox('오답 공개', msg, '공개', open.length > 0))) return;
          }
          if (await rpc('admin_set_review', { p_round: state.round, p_released: !on })) { await loadBasics(); renderReviewCard(); }
        } }, on ? '공개 취소' : '오답 공개')));
  }
  function filteredResults() {
    const c = $('res-class').value;
    return (state.results || []).filter((s) => !c || String(s.class_no) === c);
  }
  function statusMatch(s) {
    const f = $('res-status').value;
    if (!f) return true;
    if (f === 'submitted') return !s.excluded && s.status === 'submitted';
    if (f === 'none') return !s.excluded && s.status === 'none';
    if (f === 'flag') return s.leaves > 0 || s.blocked > 0 || s.device_conflicts > 0;
    return true;
  }
  function renderResults() {
    const rows = filteredResults();
    const active = rows.filter((s) => !s.excluded);
    const done = active.filter((s) => s.status === 'submitted');
    const avg = done.length ? (done.reduce((a, s) => a + s.score, 0) / done.length).toFixed(1) : '-';
    const k = (label, v) => el('div', { class: 'kpi' }, el('div', { class: 'v' }, v), el('div', { class: 'k' }, label));
    $('res-kpis').innerHTML = '';
    $('res-kpis').append(k('응시 대상', active.length), k('제출', done.length), k('미응시', active.filter((s) => s.status === 'none').length), k('평균 점수', avg),
      k('이탈 기록 있는 학생', done.filter((s) => s.leaves > 0).length));
    const body = $('res-body'); body.innerHTML = '';
    const shown = rows.filter(statusMatch);
    if (!shown.length) body.append(el('tr', {}, el('td', { colspan: 12, class: 'muted' }, '해당하는 학생이 없습니다.')));
    shown.forEach((s) => {
      let st = s.excluded ? '대상 아님' : ({ none: '미응시', ready: '입장(시작 전)', in_progress: '응시 중', submitted: '제출' })[s.status];
      if (s.status === 'submitted' && s.submit_reason === 'timeout') st += '(시간 끝)';
      if (s.status === 'submitted' && s.submit_reason === 'closed') st += '(마감)';
      const flag = s.leaves > 0 || s.blocked > 0 || s.device_conflicts > 0;
      body.append(el('tr', { class: s.excluded ? 'dim' : (flag ? 'alert' : '') },
        el('td', {}, s.student_no), el('td', {}, st),
        el('td', { class: 'num' }, s.correct ?? ''), el('td', { class: 'num' }, s.score ?? ''),
        el('td', {}, fmtTime(s.submitted_at)), el('td', { class: 'num' }, s.leaves || ''),
        el('td', { class: 'num' }, s.away_seconds ? `${s.away_seconds}초` : ''), el('td', { class: 'num' }, s.blocked || ''),
        el('td', { class: 'num' }, s.answers_after_return || ''),
        el('td', {}, s.status !== 'none' ? (s.lockdown ? '잠금' : '일반') : ''),
        el('td', { class: 'small' }, (s.adjust || []).map((a) => `${a.kind === 'restore' ? '복구' : '연장'} ${Math.round(a.seconds / 60)}분: ${a.reason}`).join(' / ')),
        el('td', {}, s.status !== 'none' ? el('button', { class: 'btn sm danger', type: 'button', onclick: () => resetAttempt(state.round, s.student_no, initResults) }, '재응시') : '')));
    });
  }
  function renderStats() {
    const body = $('stat-body'); body.innerHTML = '';
    (state.stats || []).forEach((q) => body.append(el('tr', {},
      el('td', { class: 'num' }, q.q_no), el('td', { class: 'num' }, q.unit_no), el('td', {}, q.stem),
      el('td', { class: 'num' }, q.shown), el('td', { class: 'num' }, q.shown ? `${Math.round((q.correct / q.shown) * 100)}%` : ''))));
  }
  $('btn-xlsx').addEventListener('click', () => {
    const rows = (state.results || []).map((s) => ({
      학번: s.student_no, 반: s.class_no, 상태: s.excluded ? '대상 아님' : ({ none: '미응시', ready: '입장', in_progress: '응시 중', submitted: '제출' })[s.status],
      정답수: s.correct ?? '', 문항수: s.total ?? '', 점수: s.score ?? '', 제출시각: s.submitted_at ? fmtTime(s.submitted_at) : '',
      제출방식: ({ manual: '직접 제출', timeout: '시간 끝', closed: '마감' })[s.submit_reason] || '',
      화면이탈: s.leaves, 이탈시간초: s.away_seconds, 차단시도: s.blocked, 다른기기접속: s.device_conflicts, 복귀직후답: s.answers_after_return,
      잠금모드: s.status !== 'none' ? (s.lockdown ? '예' : '아니오') : '',
      시간조정: (s.adjust || []).map((a) => `${a.kind === 'restore' ? '복구' : '연장'} ${Math.round(a.seconds / 60)}분: ${a.reason}`).join(' / '),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    // 학번은 글자로(앞자리 보존)
    rows.forEach((_, i) => { const c = ws[XLSX.utils.encode_cell({ r: i + 1, c: 0 })]; if (c) { c.t = 's'; } });
    const ws2 = XLSX.utils.json_to_sheet((state.stats || []).map((q) => ({ 번호: q.q_no, 단원: q.unit_no, 발문: q.stem, 출제횟수: q.shown, 정답수: q.correct, 정답률: q.shown ? Math.round((q.correct / q.shown) * 1000) / 10 : '' })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '학생별');
    XLSX.utils.book_append_sheet(wb, ws2, '문항별');
    XLSX.writeFile(wb, `수행평가_${state.round}회_결과.xlsx`);
  });
  $('btn-delete-records').addEventListener('click', async () => {
    if (!(await confirmBox('응시 기록 삭제', `${roundTitle(state.round)}의 응시·점수·이탈 기록을 모두 지웁니다. 되돌릴 수 없습니다. 엑셀로 내려받아 두셨나요?`, '모두 삭제', true))) return;
    if (await rpc('admin_delete_records', { p_round: state.round })) { toast('삭제했습니다.'); initResults(); }
  });

  // ---------- 문제은행 ----------
  async function initBank() {
    selRow($('bank-round'), state.rounds.map((r) => r.round_no), state.round, (n) => `${n}회`, (n) => { state.round = n; $('bank-preview').innerHTML = ''; initBank(); });
    const [{ data: units }, { data: qs }] = await Promise.all([
      sb.from('units').select('*').eq('round_no', state.round).order('unit_no'),
      sb.from('questions').select('*').eq('round_no', state.round).order('q_no'),
    ]);
    const r = state.rounds.find((x) => x.round_no === state.round) || { question_count: 20 };
    const k = (label, v) => el('div', { class: 'kpi' }, el('div', { class: 'v' }, v), el('div', { class: 'k' }, label));
    $('bank-kpis').innerHTML = '';
    const n = (units || []).length;
    $('bank-kpis').append(k('문항 수', (qs || []).length), k('단원 수', n),
      ...(units || []).map((u) => {
        const cnt = (qs || []).filter((q) => q.unit_no === u.unit_no).length;
        const need = n ? Math.ceil(r.question_count / n) : 0;
        return k(`학습 ${u.unit_no}. ${u.title} (출제 ${Math.floor(r.question_count / n)}${r.question_count % n ? '~' + need : ''})`, cnt);
      }));
    const body = $('bank-body'); body.innerHTML = '';
    const unitName = (no) => { const u = (units || []).find((x) => x.unit_no === no); return u ? `학습 ${no}` : no; };
    (qs || []).forEach((q) => {
      const inp = el('input', { type: 'text', class: 'group-input', value: q.exclusion_group || '', maxlength: '20' });
      inp.addEventListener('change', async () => {
        const { error } = await sb.from('questions').update({ exclusion_group: inp.value.trim() || null }).eq('id', q.id);
        toast(error ? '저장하지 못했습니다.' : `${q.q_no}번 묶음을 저장했습니다.`);
      });
      body.append(el('tr', {}, el('td', { class: 'num' }, q.q_no), el('td', {}, unitName(q.unit_no)),
        el('td', {}, el('div', { style: 'font-weight:600' }, q.stem),
          el('ul', { class: 'opt-list' }, q.options.map((o, i) => el('li', { class: i === q.answer ? 'ans' : '' }, `${MARKS[i]} ${o}${i === q.answer ? '  ✓' : ''}`)))),
        el('td', { class: 'small' }, q.page || ''), el('td', {}, inp)));
    });
  }
  $('bank-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    let parsed;
    try { parsed = await PTParse.parseDocx(file); } catch (e) { toast('파일을 읽지 못했습니다: ' + e.message); return; }
    // 기존 금지 묶음을 번호 기준으로 이어 받기
    const { data: old } = await sb.from('questions').select('q_no,exclusion_group').eq('round_no', state.round);
    const oldGroup = Object.fromEntries((old || []).map((q) => [q.q_no, q.exclusion_group]));
    parsed.questions.forEach((q) => { q.group = oldGroup[q.q_no] || ''; });
    const box = $('bank-preview'); box.innerHTML = '';
    const byUnit = parsed.units.map((u) => `학습 ${u.unit_no}(${parsed.questions.filter((q) => q.unit_no === u.unit_no).length}문항)`).join(', ');
    const card = el('div', { class: 'card stack' },
      el('h3', {}, `미리보기: ${file.name}`),
      el('p', {}, `${parsed.questions.length}문항 · ${byUnit}`),
      parsed.problems.length ? el('div', { class: 'notice bad' }, el('strong', {}, '확인이 필요합니다'), el('ul', {}, parsed.problems.map((p) => el('li', {}, p)))) : el('div', { class: 'notice good' }, '모든 문항에서 정답 표시를 찾았습니다.'),
      el('div', { class: 'table-wrap', style: 'max-height:360px;overflow:auto' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { class: 'num' }, '번호'), el('th', {}, '단원'), el('th', {}, '발문 · 보기'), el('th', {}, '쪽'))),
        el('tbody', {}, parsed.questions.map((q) => el('tr', {}, el('td', { class: 'num' }, q.q_no), el('td', {}, `학습 ${q.unit_no}`),
          el('td', {}, el('div', { style: 'font-weight:600' }, q.stem), el('ul', { class: 'opt-list' }, q.options.map((o, i) => el('li', { class: i === q.answer ? 'ans' : '' }, `${MARKS[i]} ${o}${i === q.answer ? '  ✓' : ''}`)))),
          el('td', { class: 'small' }, q.page)))))),
      el('div', { class: 'row' },
        el('span', { class: 'small muted' }, `저장하면 ${roundTitle(state.round)}의 기존 문항을 이 파일로 바꿉니다. 응시 기록이 있으면 바꿀 수 없습니다.`),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', onclick: () => { box.innerHTML = ''; } }, '취소'),
        el('button', { class: 'btn primary', type: 'button', disabled: parsed.problems.length ? true : null, onclick: async () => {
          const r = await rpc('admin_import_questions', { p_round: state.round, p_units: parsed.units, p_questions: parsed.questions });
          if (r && r.ok) { toast(`${r.count}문항을 저장했습니다.`); box.innerHTML = ''; initBank(); }
        } }, '저장')));
    box.append(card);
  });

  // ---------- 학생·코드 ----------
  let stuClass = 1;
  async function initStudents() {
    const sel = $('stu-class');
    sel.innerHTML = '';
    sel.append(...classList().map((c) => el('option', { value: c, selected: c === stuClass ? true : null }, `${c}반`)));
    sel.onchange = () => { stuClass = Number(sel.value); renderStudents(); };
    const { data: st } = await sb.from('settings').select('grade').eq('id', 1).single();
    if (st && st.grade) $('iss-grade').value = st.grade;
    renderStudents();
  }
  async function renderStudents() {
    const [{ data: stu }, { data: att }] = await Promise.all([
      sb.from('students').select('*').eq('class_no', stuClass).order('student_no'),
      sb.from('attempts').select('student_no,round_no,status'),
    ]);
    const body = $('stu-body'); body.innerHTML = '';
    if (!stu || !stu.length) { body.append(el('tr', {}, el('td', { colspan: 5, class: 'muted' }, '아직 코드가 없습니다. 위에서 코드를 만드세요.'))); return; }
    stu.forEach((s) => {
      const mine = (att || []).filter((a) => a.student_no === s.student_no);
      const chk = el('input', { type: 'checkbox', checked: !s.excluded ? true : null });
      chk.addEventListener('change', async () => {
        const { error } = await sb.from('students').update({ excluded: !chk.checked }).eq('student_no', s.student_no);
        toast(error ? '저장하지 못했습니다.' : (chk.checked ? `${s.student_no} 응시 대상` : `${s.student_no} 대상 아님`));
        tr.className = chk.checked ? '' : 'dim';
      });
      const tr = el('tr', { class: s.excluded ? 'dim' : '' },
        el('td', {}, s.student_no), el('td', { class: 'mono' }, s.code),
        el('td', {}, el('label', { style: 'font-weight:400;margin:0' }, chk, ' 대상')),
        el('td', { class: 'small' }, mine.map((a) => `${a.round_no}회 ${({ ready: '입장', in_progress: '응시 중', submitted: '제출' })[a.status]}`).join(', '),
          s.locked_until && new Date(s.locked_until) > new Date() ? el('span', { class: 'badge warn' }, '잠김') : null),
        el('td', {}, el('button', { class: 'btn sm', type: 'button', onclick: async () => {
          if (!(await confirmBox('코드 다시 만들기', `${s.student_no}의 코드를 새로 만듭니다. 이전 코드는 쓸 수 없게 됩니다. (잠김도 풀립니다)`, '다시 만들기'))) return;
          const r = await rpc('admin_reissue_code', { p_student_no: s.student_no });
          if (r) { toast(`새 코드 ${r.code}`); renderStudents(); }
        } }, '코드 재발급')));
      body.append(tr);
    });
  }
  $('btn-issue').addEventListener('click', async () => {
    const g = Number($('iss-grade').value), c = Number($('iss-classes').value), m = Number($('iss-max').value);
    if (!(await confirmBox('코드 만들기', `${g}학년 1~${c}반, 반마다 1~${m}번(${c * m}명)의 학번과 코드를 만듭니다. 이미 있는 학번은 그대로 둡니다.`, '만들기'))) return;
    const r = await rpc('admin_issue_codes', { p_grade: g, p_classes: c, p_max_no: m });
    if (r) { toast(`${r.added}명을 새로 만들었습니다.`); await loadBasics(); initStudents(); }
  });
  async function printCodes(classes) {
    const { data } = await sb.from('students').select('*').in('class_no', classes).eq('excluded', false).order('student_no');
    const area = $('print-area'); area.innerHTML = '';
    classes.forEach((c) => {
      const list = (data || []).filter((s) => s.class_no === c);
      if (!list.length) return;
      area.append(el('div', { class: 'print-page' }, el('h2', {}, `${c}반 수행평가 개인 코드 (점선을 따라 잘라 나눠 주세요)`),
        el('div', { class: 'slips' }, list.map((s) => el('div', { class: 'slip' },
          el('div', { class: 'sn' }, `학번 ${s.student_no}`), el('div', { class: 'cd' }, s.code),
          el('div', { class: 'hint' }, '1·2회 모두 이 코드를 씁니다. 다른 사람에게 보여 주지 마세요.'))))));
    });
    window.print();
  }
  $('btn-print').addEventListener('click', () => printCodes([stuClass]));
  $('btn-print-all').addEventListener('click', () => printCodes(classList()));

  // ---------- 설정 ----------
  async function renderTeachers() {
    const list = (await rpc('admin_teachers')) || [];
    const body = $('teacher-body'); body.innerHTML = '';
    list.forEach((t) => body.append(el('tr', { class: t.approved ? '' : 'alert' },
      el('td', {}, t.email || '(이메일 없음)', t.me ? el('span', { class: 'badge primary', style: 'margin-left:6px' }, '나') : null),
      el('td', {}, t.approved ? el('span', { class: 'badge good' }, '승인됨') : el('span', { class: 'badge warn' }, '승인 대기')),
      el('td', {}, (t.classes || []).length ? t.classes.map((c) => `${c}반`).join(', ') : ''),
      el('td', {}, el('div', { class: 'row', style: 'gap:6px' },
        !t.approved ? el('button', { class: 'btn sm good', type: 'button', onclick: async () => {
          if (!(await confirmBox('교사 승인', `${t.email}을(를) 승인하면 모든 반의 운영·결과·문제은행·학생 코드를 같은 권한으로 쓸 수 있습니다. 함께 가르치는 선생님이 맞나요?`, '승인'))) return;
          if (await rpc('admin_set_teacher', { p_user: t.user_id, p_approved: true })) { toast('승인했습니다.'); renderTeachers(); }
        } }, '승인') : null,
        !t.me ? el('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!(await confirmBox(t.approved ? '교사 해제' : '가입 거절', `${t.email}을(를) 목록에서 지웁니다. 이 계정은 더 이상 관리 화면에 들어올 수 없습니다.`, '지우기', true))) return;
          if (await rpc('admin_set_teacher', { p_user: t.user_id, p_approved: false })) { toast('지웠습니다.'); renderTeachers(); }
        } }, t.approved ? '해제' : '거절') : null)))));
    const box = $('my-classes'); box.innerHTML = '';
    classList().forEach((c) => {
      const b = el('button', { type: 'button', class: state.myClasses.includes(c) ? 'on' : '' }, `${c}반`);
      b.addEventListener('click', async () => {
        const next = state.myClasses.includes(c) ? state.myClasses.filter((x) => x !== c) : [...state.myClasses, c].sort((a, x) => a - x);
        if (await rpc('admin_set_my_classes', { p_classes: next })) { state.myClasses = next; renderTeachers(); }
      });
      box.append(b);
    });
  }

  async function initSettings() {
    await loadBasics();
    renderTeachers();
    $('student-url').textContent = '학생용 주소: ' + location.origin + location.pathname.replace(/admin\.html$/, '');
    const box = $('set-rounds'); box.innerHTML = '';
    state.rounds.forEach((r) => {
      const title = el('input', { type: 'text', value: r.title });
      const dur = el('input', { type: 'number', min: '1', max: '180', value: r.duration_min });
      const cnt = el('input', { type: 'number', min: '1', max: '100', value: r.question_count });
      box.append(el('div', { class: 'row', style: 'align-items:flex-end' },
        el('div', { style: 'flex:1;min-width:220px' }, el('label', {}, `${r.round_no}회 이름`), title),
        el('div', { style: 'width:120px' }, el('label', {}, '제한 시간(분)'), dur),
        el('div', { style: 'width:120px' }, el('label', {}, '출제 문항 수'), cnt),
        el('button', { class: 'btn', type: 'button', onclick: async () => {
          const { error } = await sb.from('rounds').update({ title: title.value.trim(), duration_min: Number(dur.value), question_count: Number(cnt.value) }).eq('round_no', r.round_no);
          toast(error ? '저장하지 못했습니다: ' + error.message : `${r.round_no}회를 저장했습니다. 이미 시작한 학생의 시간은 바뀌지 않습니다.`);
          loadBasics();
        } }, '저장')));
      box.append(el('p', { class: 'small muted' }, `점수 = 정답 수 × ${r.points_per_q}점 + 기본점 ${r.base_score}점`));
    });
    const { data: st } = await sb.from('settings').select('*').eq('id', 1).single();
    $('set-lockdown').checked = !!(st && st.require_lockdown);
    $('set-short').value = (st && st.short_url) || '';
    $('set-ip').value = st ? (st.allowed_ip_prefixes || []).join(', ') : '';
    const { data: ev } = await sb.from('events').select('detail,at').eq('type', 'enter').order('at', { ascending: false }).limit(30);
    const ips = {};
    (ev || []).forEach((e) => { const ip = e.detail && e.detail.ip; if (ip) ips[ip] = (ips[ip] || 0) + 1; });
    $('recent-ips').textContent = Object.keys(ips).length ? '최근 입장 주소: ' + Object.entries(ips).map(([ip, n]) => `${ip} (${n}회)`).join(', ') : '최근 입장 기록이 없습니다.';
  }
  $('btn-save-short').addEventListener('click', async () => {
    let v = $('set-short').value.trim();
    if (v && !/^https?:\/\//.test(v)) v = 'https://' + v;
    const { error } = await sb.from('settings').update({ short_url: v || null }).eq('id', 1);
    toast(error ? '저장하지 못했습니다.' : '저장했습니다.');
  });
  $('btn-save-settings').addEventListener('click', async () => {
    const prefixes = $('set-ip').value.split(',').map((s) => s.trim()).filter(Boolean);
    if ($('set-lockdown').checked && !(await confirmBox('잠금 모드 필수', '학교 서피스 고에서 잠금 모드가 실제로 열리고, 응시 화면에 "잠금 모드에서 응시 중"이 보이는 것을 확인하셨나요? 확인하지 않고 켜면 아무도 입장하지 못할 수 있습니다.', '켜기', true))) return;
    const { error } = await sb.from('settings').update({ require_lockdown: $('set-lockdown').checked, allowed_ip_prefixes: prefixes }).eq('id', 1);
    toast(error ? '저장하지 못했습니다.' : '저장했습니다.');
  });

  sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') { $('app').classList.add('hidden'); $('scr-login').classList.remove('hidden'); } });
  boot();
})();
