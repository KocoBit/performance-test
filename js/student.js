(() => {
  'use strict';
  const sb = window.supabase.createClient(PT_CONFIG.url, PT_CONFIG.anonKey, { auth: { persistSession: false } });
  const $ = (id) => document.getElementById(id);
  const MARKS = ['①', '②', '③', '④', '⑤'];
  const STORE = 'pt_session';

  const ERRORS = {
    BAD_CREDENTIALS: '학번 또는 개인 코드가 맞지 않습니다.',
    BAD_PIN: '입장 암호가 맞지 않습니다. 칠판의 4자리를 확인하세요.',
    LOCKED: '여러 번 틀려 잠시 잠겼습니다. 잠시 뒤 다시 시도하거나 교사에게 알려 주세요.',
    NOT_OPEN: '지금 우리 반에 열린 회차가 아닙니다. 회차를 확인하거나 교사에게 문의하세요.',
    ALREADY_SUBMITTED: '이미 제출한 회차입니다.',
    OTHER_DEVICE: '다른 기기에서 응시 중인 기록이 있습니다. 교사에게 기기 교체 승인을 요청하세요.',
    EXCLUDED: '응시 대상으로 등록되지 않은 학번입니다. 교사에게 문의하세요.',
    NETWORK: '학교 네트워크에서만 응시할 수 있습니다.',
    LOCKDOWN_REQUIRED: '잠금 모드(테스트 응시)로 열어야 응시할 수 있습니다.',
    NO_QUESTIONS: '문항이 준비되지 않았습니다. 교사에게 알려 주세요.',
    SESSION: '응시 정보가 만료되었습니다. 다시 입장해 주세요.',
    BAD_INPUT: '입력이 올바르지 않습니다.',
  };
  const errText = (r) => {
    let t = ERRORS[r && r.error] || '연결에 문제가 있습니다. 잠시 뒤 다시 시도하세요.';
    if (r && r.error === 'LOCKED' && r.seconds) t += ` (${Math.ceil(r.seconds / 60)}분 남음)`;
    return t;
  };

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) return { ok: false, error: 'NET', detail: error.message };
    return data;
  }

  // ---------- 기기 식별·잠금 모드 ----------
  function deviceId() {
    let id = null;
    try { id = localStorage.getItem('pt_device'); } catch (e) {}
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      try { localStorage.setItem('pt_device', id); } catch (e) {}
    }
    return id;
  }
  // 윈도우 '테스트 응시(Take a Test)' 앱 안에서는 SecureBrowser API가 있다
  const inLockdown = () => typeof window.SecureBrowser !== 'undefined';
  function lockdownLink() {
    return 'ms-edu-secureassessment:' + location.origin + location.pathname + '!enforceLockdown';
  }

  // ---------- 화면 전환 ----------
  const screens = ['scr-enter', 'scr-guide', 'scr-exam', 'scr-done', 'scr-result'];
  function show(id) {
    screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));
    document.body.classList.toggle('exam', id === 'scr-exam');
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
  function showMsg(el, text) { el.textContent = text; el.classList.toggle('hidden', !text); }
  const digits = (el, n) => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, n); });

  // ---------- 상태 ----------
  let session = null;   // {token, round, title, sno, minutes, count}
  let items = [];       // [{stem, options, mine}]
  let cur = 0;
  let remaining = 0, remainingAt = 0;
  let tickTimer = null, beatTimer = null;
  let queue = [];       // 보낼 사건
  let awaySince = null;
  let examActive = false;
  let pendingSaves = 0;

  function saveSession() { try { sessionStorage.setItem(STORE, JSON.stringify(session)); } catch (e) {} }
  function clearSession() { session = null; try { sessionStorage.removeItem(STORE); } catch (e) {} }

  // ---------- 입장 ----------
  let round = 1;
  document.querySelectorAll('#round-pick button').forEach((b) => b.addEventListener('click', () => {
    round = Number(b.dataset.round);
    document.querySelectorAll('#round-pick button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('f-enter').classList.toggle('hidden', b.dataset.tab !== 'exam');
    $('f-result').classList.toggle('hidden', b.dataset.tab !== 'result');
  }));
  digits($('in-sno'), 5); digits($('in-code'), 6); digits($('in-pin'), 4);
  digits($('r-sno'), 5); digits($('r-code'), 6);

  $('f-enter').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter || $('f-enter').querySelector('button[type=submit]');
    btn.disabled = true; showMsg($('enter-msg'), '');
    const r = await rpc('student_enter', {
      p_round: round, p_student_no: $('in-sno').value, p_code: $('in-code').value,
      p_pin: $('in-pin').value, p_device: deviceId(), p_lockdown: inLockdown(),
    });
    btn.disabled = false;
    if (!r || !r.ok) { showMsg($('enter-msg'), errText(r)); return; }
    session = { token: r.token, round, title: r.round_title, sno: r.student_no, minutes: r.duration_min, count: r.question_count };
    saveSession();
    $('in-code').value = ''; $('in-pin').value = '';
    if (r.status === 'in_progress') startExam(true);
    else showGuide();
  });

  function showGuide() {
    $('g-title').textContent = session.title;
    $('g-sno').textContent = session.sno;
    $('g-count').textContent = session.count;
    $('g-min').textContent = session.minutes;
    showMsg($('guide-msg'), '');
    show('scr-guide');
  }
  $('btn-start').addEventListener('click', () => startExam(false));

  // ---------- 시험 ----------
  async function requestFs() {
    const el = document.documentElement;
    try { if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' }); } catch (e) {}
  }

  async function startExam(resume) {
    await requestFs();   // 시작 버튼을 누른 순간이어야 전체 화면이 허용된다
    const r = await rpc('student_start', { p_token: session.token });
    if (!r || !r.ok) {
      if (r && r.error === 'ALREADY_SUBMITTED') { finish('submitted'); return; }
      if (resume) { clearSession(); show('scr-enter'); showMsg($('enter-msg'), errText(r)); }
      else showMsg($('guide-msg'), errText(r));
      return;
    }
    items = r.items;
    setRemaining(r.remaining);
    cur = Math.min(cur, items.length - 1);
    examActive = true;
    $('e-title').textContent = session.title;
    $('e-sno').textContent = session.sno;
    buildWatermark(session.sno);
    buildGrid();
    render();
    show('scr-exam');
    if (inLockdown()) push('lockdown', null, { secure: true });
    clearInterval(tickTimer); tickTimer = setInterval(tick, 250);
    clearInterval(beatTimer); beatTimer = setInterval(heartbeat, 5000);
    heartbeat();
  }

  function setRemaining(sec) { remaining = sec; remainingAt = performance.now(); }
  function secondsLeft() { return Math.max(0, remaining - (performance.now() - remainingAt) / 1000); }
  function tick() {
    const s = Math.ceil(secondsLeft());
    const el = $('e-timer');
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('low', s <= 60);
    if (s <= 0 && examActive) { examActive = false; setTimeout(() => submit(true), 1500); }
  }

  function buildWatermark(sno) {
    const line = (sno + '      ').repeat(14);
    $('watermark').textContent = Array.from({ length: 16 }, () => line).join('\n');
  }

  function buildGrid() {
    const g = $('e-grid'); g.innerHTML = '';
    items.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = i + 1;
      b.addEventListener('click', () => go(i));
      g.appendChild(b);
    });
  }

  function render() {
    const it = items[cur];
    $('e-qno').textContent = `${cur + 1} / ${items.length}`;
    $('e-stem').textContent = it.stem;
    const box = $('e-opts'); box.innerHTML = '';
    it.options.forEach((text, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'opt' + (it.mine === i ? ' sel' : '');
      const m = document.createElement('span'); m.className = 'mark'; m.textContent = MARKS[i];
      const t = document.createElement('span'); t.textContent = text;
      b.append(m, t);
      b.addEventListener('click', () => choose(i));
      box.appendChild(b);
    });
    [...$('e-grid').children].forEach((b, i) => {
      b.classList.toggle('done', items[i].mine !== null && items[i].mine !== undefined);
      b.classList.toggle('cur', i === cur);
    });
    const answered = items.filter((x) => x.mine !== null && x.mine !== undefined).length;
    $('e-progress').textContent = `${answered}/${items.length} 답함`;
    $('btn-prev').disabled = cur === 0;
    $('btn-next').disabled = cur === items.length - 1;
  }

  function go(i) {
    if (i < 0 || i >= items.length || i === cur) return;
    cur = i; render();
    push('view', cur);
  }
  $('btn-prev').addEventListener('click', () => go(cur - 1));
  $('btn-next').addEventListener('click', () => go(cur + 1));

  async function choose(i) {
    if (!examActive) return;
    const idx = cur;
    const prev = items[idx].mine;
    const next = prev === i ? null : i;   // 같은 보기를 다시 누르면 선택 취소
    items[idx].mine = next; render();
    pendingSaves++; $('e-save').textContent = '저장 중…';
    const r = await rpc('student_answer', { p_token: session.token, p_index: idx, p_choice: next });
    pendingSaves--;
    if (r && r.ok) {
      if (typeof r.remaining === 'number') setRemaining(r.remaining);
      if (!pendingSaves) $('e-save').textContent = '저장됨';
    } else if (r && (r.error === 'ALREADY_SUBMITTED' || r.error === 'SESSION')) {
      finish('closed');
    } else {
      items[idx].mine = prev; render();
      $('e-save').textContent = '저장 실패';
      toast('답이 저장되지 않았습니다. 인터넷 연결을 확인하고 다시 골라 주세요.');
    }
  }

  // ---------- 사건 기록·상태 확인 ----------
  function push(type, item, detail) {
    queue.push({ type, item: item ?? null, detail: Object.assign({ t: new Date().toISOString() }, detail || {}) });
    if (queue.length >= 20) heartbeat();
  }
  async function heartbeat() {
    if (!session) return;
    const batch = queue.splice(0, 50);
    const r = await rpc('student_log', { p_token: session.token, p_events: batch });
    if (!r || !r.ok) {
      if (r && r.error === 'SESSION') { finish('closed'); return; }
      queue = batch.concat(queue).slice(-200);   // 연결이 끊기면 모아 두었다가 다시 보낸다
      return;
    }
    if (typeof r.remaining === 'number') setRemaining(r.remaining);
    if (r.status === 'submitted' && $('scr-exam').classList.contains('hidden') === false) finish('closed');
  }

  // 화면 이탈(다른 탭·창·앱)
  function leave(kind) {
    if (!examActive || awaySince !== null) return;
    awaySince = Date.now();
    push(kind, cur);
    heartbeat();
  }
  function comeBack() {
    if (!examActive || awaySince === null) return;
    const seconds = Math.round((Date.now() - awaySince) / 1000);
    awaySince = null;
    push('return', cur, { seconds });
    heartbeat();
    toast(`화면 이탈 ${seconds}초가 기록되었습니다.`);
  }
  document.addEventListener('visibilitychange', () => { document.hidden ? leave('leave') : comeBack(); });
  window.addEventListener('blur', () => leave('leave'));
  window.addEventListener('focus', () => { if (!document.hidden && (document.fullscreenElement || !document.fullscreenEnabled)) comeBack(); });

  // 전체 화면 벗어남
  document.addEventListener('fullscreenchange', () => {
    if (!examActive) return;
    if (document.fullscreenElement) { push('fullscreen_enter', cur); $('cover').classList.add('hidden'); comeBack(); }
    else { push('fullscreen_exit', cur); $('cover').classList.remove('hidden'); if (awaySince === null) awaySince = Date.now(); heartbeat(); }
  });
  $('btn-back').addEventListener('click', async () => {
    await requestFs();
    if (document.fullscreenElement || !document.fullscreenEnabled) { $('cover').classList.add('hidden'); comeBack(); }
  });

  // 복사·붙여넣기·우클릭·인쇄·단축키 막기(시도는 기록)
  const lastBlock = {};
  function blocked(type, ev, detail) {
    if (!examActive) return;
    ev.preventDefault();
    const now = Date.now();
    if (lastBlock[type] && now - lastBlock[type] < 1500) return;
    lastBlock[type] = now;
    push(type, cur, detail);
    toast('이 동작은 시험 중에 막혀 있으며 기록되었습니다.');
  }
  ['copy', 'cut'].forEach((t) => document.addEventListener(t, (e) => blocked('copy', e)));
  document.addEventListener('paste', (e) => blocked('paste', e));
  document.addEventListener('contextmenu', (e) => blocked('contextmenu', e));
  document.addEventListener('selectstart', (e) => { if (examActive) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => { if (examActive) e.preventDefault(); });
  window.addEventListener('beforeprint', () => { if (examActive) push('print', cur); });
  document.addEventListener('keydown', (e) => {
    if (!examActive) return;
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'p', 'f', 's', 'u', 'a', 'g', 'h', 'j', 'l', 't', 'n', 'w', 'r'].includes(k)) {
      blocked('key_block', e, { key: (e.ctrlKey ? 'Ctrl+' : 'Cmd+') + k.toUpperCase() });
    } else if (['f12', 'printscreen', 'f5', 'f3', 'f11'].includes(k) || (e.altKey && ['arrowleft', 'arrowright', 'tab'].includes(k))) {
      blocked('key_block', e, { key: e.key });
    } else if (k === 'arrowright') { go(cur + 1); e.preventDefault(); }
    else if (k === 'arrowleft') { go(cur - 1); e.preventDefault(); }
    else if (['1', '2', '3', '4', '5'].includes(k) && items[cur] && Number(k) <= items[cur].options.length) choose(Number(k) - 1);
  });
  window.addEventListener('beforeunload', (e) => { if (examActive) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- 제출 ----------
  function modal(html, buttons) {
    const body = $('modal-body'); body.innerHTML = html;
    const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '20px';
    buttons.forEach(({ text, cls, onClick }) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn lg ' + (cls || ''); b.textContent = text;
      b.addEventListener('click', () => { $('modal').classList.add('hidden'); onClick && onClick(); });
      row.appendChild(b);
    });
    body.appendChild(row);
    $('modal').classList.remove('hidden');
  }
  $('btn-submit').addEventListener('click', () => {
    const empty = items.map((x, i) => (x.mine === null || x.mine === undefined ? i + 1 : null)).filter(Boolean);
    const warn = empty.length
      ? `<div class="notice warn" style="margin-top:12px">아직 답하지 않은 문항: <strong>${empty.join(', ')}번</strong> (${empty.length}개)</div>` : '';
    modal(`<h2>제출할까요?</h2><p>제출하면 답을 바꿀 수 없습니다.</p>${warn}`, [
      { text: '계속 풀기' },
      { text: '제출하기', cls: 'primary', onClick: () => submit(false) },
    ]);
  });

  async function submit(auto) {
    examActive = false;
    await heartbeat();
    const r = await rpc('student_submit', { p_token: session.token });
    if (!r || !r.ok) {
      if (r && r.error === 'NET' && !auto) { examActive = true; toast('제출하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.'); return; }
    }
    finish(auto ? 'timeout' : 'submitted');
  }

  function finish(reason) {
    examActive = false;
    clearInterval(tickTimer); clearInterval(beatTimer);
    $('cover').classList.add('hidden'); $('modal').classList.add('hidden');
    clearSession(); items = []; cur = 0; queue = [];
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    $('done-msg').textContent = reason === 'closed'
      ? '시험이 마감되어 그때까지 고른 답으로 제출되었습니다. 점수는 마감 뒤 \'결과 확인\'에서 볼 수 있습니다.'
      : reason === 'timeout'
        ? '시간이 끝나 그때까지 고른 답으로 제출되었습니다. 점수는 마감 뒤 \'결과 확인\'에서 볼 수 있습니다.'
        : '답안이 제출되었습니다. 점수는 시험이 마감된 뒤 \'결과 확인\'에서 볼 수 있습니다.';
    show('scr-done');
    let n = 10; $('done-count').textContent = n;
    const t = setInterval(() => { n--; $('done-count').textContent = n; if (n <= 0) { clearInterval(t); goHome(); } }, 1000);
    $('btn-home').onclick = () => { clearInterval(t); goHome(); };
  }
  function goHome() {
    $('in-sno').value = ''; $('in-code').value = ''; $('in-pin').value = '';
    showMsg($('enter-msg'), ''); show('scr-enter');
  }

  // ---------- 결과 확인 ----------
  $('f-result').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg($('result-msg'), '');
    const r = await rpc('student_result', { p_student_no: $('r-sno').value, p_code: $('r-code').value });
    if (!r || !r.ok) { showMsg($('result-msg'), errText(r)); return; }
    $('r-code').value = '';
    renderResult(r);
  });
  $('btn-res-back').addEventListener('click', () => { $('res-body').innerHTML = ''; show('scr-enter'); });

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function renderResult(r) {
    $('res-sno').textContent = r.student_no;
    const body = $('res-body'); body.innerHTML = '';
    r.rounds.forEach((x) => {
      const card = el('div', 'card stack');
      card.appendChild(el('h2', '', x.title));
      if (x.state === 'none') card.appendChild(el('p', 'muted', '응시 기록이 없습니다.'));
      else if (x.state === 'in_progress') card.appendChild(el('p', 'muted', '아직 제출하지 않은 회차입니다.'));
      else if (x.state === 'waiting') card.appendChild(el('p', 'muted', '제출 완료. 점수는 이 회차가 마감된 뒤 공개됩니다.'));
      else {
        const row = el('div', 'row');
        const s = el('div', 'score-big', `${x.score}점`);
        const d = el('div', 'muted', `맞힌 문항 ${x.correct} / ${x.total}`);
        row.append(s, d); card.appendChild(row);
        if (!x.review) card.appendChild(el('p', 'small muted', '문항별 정답은 모든 응시가 끝난 뒤 공개됩니다.'));
      }
      if (x.review) {
        const wrong = x.review.filter((q) => !q.correct).length;
        card.appendChild(el('p', '', `틀린 문항 ${wrong}개 · 빨간 표시는 내가 고른 오답, 초록은 정답입니다.`));
        const list = el('div', 'stack');
        x.review.forEach((q) => {
          const it = el('div', 'review-item' + (q.correct ? '' : ' wrong'));
          const head = el('div', 'row');
          head.append(el('strong', '', `${q.no}번`), el('span', q.correct ? 'badge good' : 'badge bad', q.correct ? '맞음' : (q.mine === null ? '답 없음' : '틀림')));
          it.appendChild(head);
          it.appendChild(el('p', '', q.stem));
          q.options.forEach((o, i) => {
            let cls = 'review-opt';
            if (i === q.answer) cls += ' answer';
            else if (i === q.mine) cls += ' mine-wrong';
            it.appendChild(el('div', cls, `${MARKS[i]} ${o}${i === q.answer ? '  (정답)' : ''}${i === q.mine && i !== q.answer ? '  (내 답)' : ''}`));
          });
          list.appendChild(it);
        });
        card.appendChild(list);
      }
      body.appendChild(card);
    });
    show('scr-result');
  }

  // ---------- 처음 ----------
  if (inLockdown()) {
    $('lock-ok').classList.remove('hidden');
    try { window.SecureBrowser.security.lockDown(true, () => {}, () => {}); } catch (e) {}
  } else {
    $('lock-banner').classList.remove('hidden');
    $('lock-link').href = lockdownLink();
  }
  try { session = JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch (e) { session = null; }
  if (session && session.token) {
    // 새로고침·꺼짐 뒤: 같은 문항·답·남은 시간으로 이어서
    show('scr-guide'); showGuide();
    $('btn-start').textContent = '이어서 풀기';
  } else {
    show('scr-enter');
  }
})();
