(() => {
  'use strict';

  /* ---------- 기본 세팅 ---------- */
  const CFG = window.APP_CONFIG || {};
  const hasSb = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/YOUR_/.test(CFG.SUPABASE_URL) && window.supabase;
  const sb = hasSb ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
  let session = null;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

  const state = { decks: [], deckId: null, cards: [], draft: [], queue: [], idx: 0, playing: false };
  const settings = Object.assign(
    { engine: 'browser', rate: 1, gap: 4, shuffle: true, weak: true, explain: true },
    safeJSON(localStorage.getItem('uas.settings'), {})
  );

  function safeJSON(s, fallback) { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  }

  /* ---------- 저장소: Supabase(로그인 시) / localStorage(비로그인) ---------- */
  const LS = 'uas.data';
  const local = {
    read() { const d = safeJSON(localStorage.getItem(LS), null); return d && d.decks ? d : { decks: [], cards: [] }; },
    write(d) { localStorage.setItem(LS, JSON.stringify(d)); },
  };

  const db = {
    cloud() { return !!(sb && session); },

    async decks() {
      if (this.cloud()) {
        const { data, error } = await sb.from('decks').select('*').order('created_at');
        if (error) throw error;
        return data;
      }
      return local.read().decks;
    },
    async addDeck(title) {
      if (this.cloud()) {
        const { data, error } = await sb.from('decks').insert({ title }).select().single();
        if (error) throw error;
        return data;
      }
      const d = local.read();
      const deck = { id: uid(), title, created_at: new Date().toISOString() };
      d.decks.push(deck); local.write(d);
      return deck;
    },
    async delDeck(id) {
      if (this.cloud()) {
        const { error } = await sb.from('decks').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      const d = local.read();
      d.decks = d.decks.filter((x) => x.id !== id);
      d.cards = d.cards.filter((c) => c.deck_id !== id);
      local.write(d);
    },
    async cards(deckId) {
      if (this.cloud()) {
        const { data, error } = await sb.from('cards').select('*').eq('deck_id', deckId).order('created_at');
        if (error) throw error;
        return data;
      }
      return local.read().cards.filter((c) => c.deck_id === deckId);
    },
    async addCards(deckId, arr) {
      if (this.cloud()) {
        const { error } = await sb.from('cards').insert(arr.map((c) => ({ deck_id: deckId, ...c })));
        if (error) throw error;
        return;
      }
      const d = local.read();
      arr.forEach((c) => d.cards.push({ id: uid(), deck_id: deckId, wrong_count: 0, created_at: new Date().toISOString(), ...c }));
      local.write(d);
    },
    async patchCard(id, patch) {
      if (this.cloud()) {
        const { error } = await sb.from('cards').update(patch).eq('id', id);
        if (error) throw error;
        return;
      }
      const d = local.read();
      const c = d.cards.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
      local.write(d);
    },
    async delCard(id) {
      if (this.cloud()) {
        const { error } = await sb.from('cards').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      const d = local.read();
      d.cards = d.cards.filter((c) => c.id !== id);
      local.write(d);
    },
  };

  /* ---------- 로그인 ---------- */
  async function initAuth() {
    if (!sb) { renderAccount(); return; }
    const { data } = await sb.auth.getSession();
    session = data.session;
    sb.auth.onAuthStateChange((_e, s) => {
      const changed = (s?.user?.id) !== (session?.user?.id);
      session = s;
      renderAccount();
      if (changed) loadDecks();
    });
    renderAccount();
  }

  function renderAccount() {
    const el = $('#account');
    if (!sb) { el.innerHTML = '<span class="chip">로컬 모드</span>'; return; }
    if (session) {
      el.innerHTML = `<span>${esc(session.user.email)}</span><button class="link" id="logout">로그아웃</button>`;
      $('#logout').onclick = () => sb.auth.signOut();
    } else {
      el.innerHTML = `<span class="chip">로컬 모드</span>
        <input id="email" type="email" placeholder="이메일" autocomplete="email" aria-label="이메일">
        <button class="ghost" id="login">로그인 링크 받기</button>`;
      $('#login').onclick = async () => {
        const email = $('#email').value.trim();
        if (!email) return toast('이메일을 입력해 주세요.');
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
        toast(error ? '전송 실패: ' + error.message : '메일로 로그인 링크를 보냈어요.');
      };
    }
  }

  /* ---------- 덱 / 카드 로딩 ---------- */
  async function loadDecks() {
    try {
      stop();
      let decks = await db.decks();
      if (!decks.length) decks = [await db.addDeck('내 첫 덱')];
      state.decks = decks;
      const saved = localStorage.getItem('uas.deck');
      state.deckId = decks.find((d) => d.id === saved)?.id || decks[0].id;
      renderDecks();
      await loadCards();
    } catch (e) {
      toast('불러오기 실패: ' + (e.message || e));
    }
  }

  function renderDecks() {
    $('#deckSelect').innerHTML = state.decks.map((d) => `<option value="${esc(d.id)}" ${d.id === state.deckId ? 'selected' : ''}>${esc(d.title)}</option>`).join('');
  }

  async function loadCards() {
    state.cards = await db.cards(state.deckId);
    renderManage();
    buildQueue();
    renderPlayer(null, false);
  }

  /* ---------- 카드 만들기 ---------- */
  function parseManual(text) {
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [question, answer, explanation] = l.split(/\s*(?:::|\||\t)\s*/);
      return { question, answer, explanation: explanation || '' };
    }).filter((c) => c.question && c.answer);
  }

  async function authHeaders() {
    const h = { 'content-type': 'application/json' };
    if (session) h.authorization = 'Bearer ' + session.access_token;
    return h;
  }

  async function generate() {
    const text = $('#memo').value.trim();
    if (!text) return toast('메모를 붙여넣어 주세요.');
    const btn = $('#generate');
    btn.disabled = true; btn.textContent = '변환 중…';
    try {
      const res = await fetch('/api/cards', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ text }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      state.draft = j.cards;
    } catch (e) {
      const parsed = parseManual(text);
      if (parsed.length) {
        state.draft = parsed;
        toast('AI 변환을 쓸 수 없어 구분자 방식으로 변환했어요. (' + e.message + ')');
      } else {
        toast('AI 변환 실패: ' + e.message + ' — "질문 :: 정답" 형식으로 적으면 바로 변환돼요.');
      }
    } finally {
      btn.disabled = false; btn.textContent = '카드로 변환';
    }
    renderDraft();
  }

  function renderDraft() {
    const n = state.draft.length;
    $('#draft').innerHTML = n
      ? state.draft.map((c, i) => `
        <article class="draft-card">
          <label>문제<textarea data-i="${i}" data-k="question" rows="2">${esc(c.question)}</textarea></label>
          <label>정답<textarea data-i="${i}" data-k="answer" rows="2">${esc(c.answer)}</textarea></label>
          <label>해설<textarea data-i="${i}" data-k="explanation" rows="2">${esc(c.explanation)}</textarea></label>
          <button class="link danger" data-del="${i}">이 카드 빼기</button>
        </article>`).join('') + `<div class="row"><button id="saveDraft" class="primary">카드 ${n}장 저장</button><span class="hint">틀린 내용이 없는지 확인했나요?</span></div>`
      : '';
  }

  async function saveDraft() {
    const cards = state.draft
      .map((c) => ({ question: (c.question || '').trim(), answer: (c.answer || '').trim(), explanation: (c.explanation || '').trim() }))
      .filter((c) => c.question && c.answer);
    if (!cards.length) return toast('저장할 카드가 없어요.');
    try {
      await db.addCards(state.deckId, cards);
      state.draft = []; $('#memo').value = ''; renderDraft();
      await loadCards();
      toast(cards.length + '장 저장했어요.');
      showView('listen');
    } catch (e) { toast('저장 실패: ' + (e.message || e)); }
  }

  /* ---------- 카드 관리 ---------- */
  function renderManage() {
    const el = $('#cardList');
    el.innerHTML = state.cards.length
      ? state.cards.map((c) => `
        <article class="item">
          <b>${esc(c.question)}</b>
          <span class="ans">${esc(c.answer)}</span>
          ${c.explanation ? `<span>${esc(c.explanation)}</span>` : ''}
          <div class="foot">
            <span>${c.wrong_count ? `<span class="badge">헷갈림 ${c.wrong_count}</span>` : ''}</span>
            <button class="link danger" data-del-card="${esc(c.id)}">삭제</button>
          </div>
        </article>`).join('')
      : '<p class="empty">아직 카드가 없어요. "카드 만들기"에서 메모를 붙여넣어 보세요.</p>';
  }

  /* ---------- 재생 큐 ---------- */
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function buildQueue() {
    const q = [];
    for (const c of state.cards) {
      const n = settings.weak ? 1 + Math.min(c.wrong_count || 0, 3) : 1;
      for (let i = 0; i < n; i++) q.push(c);
    }
    state.queue = settings.shuffle ? shuffle(q) : q;
    state.idx = 0;
  }

  /* ---------- 음성 ---------- */
  const audio = $('#audio');
  let runToken = 0;
  let stopCurrent = null;
  let cloudBroken = false;
  let utterRef = null; // 일부 브라우저에서 GC로 onend가 안 오는 문제 방지
  const audioCache = new Map();

  const cancellable = (fn) => new Promise((res) => { stopCurrent = res; fn(res); });
  const wait = (ms) => cancellable((res) => setTimeout(res, ms));

  function speakBrowser(text) {
    return cancellable((res) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = settings.rate;
      const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith('ko'));
      if (v) u.voice = v;
      u.onend = u.onerror = () => res();
      utterRef = u;
      speechSynthesis.speak(u);
    });
  }

  async function audioUrl(text) {
    if (audioCache.has(text)) return audioCache.get(text);
    const p = (async () => {
      const res = await fetch('/api/tts', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ text }) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + res.status);
      }
      return URL.createObjectURL(await res.blob());
    })();
    audioCache.set(text, p);
    p.catch(() => audioCache.delete(text));
    return p;
  }

  function playUrl(url) {
    return cancellable((res) => {
      audio.src = url;
      audio.playbackRate = settings.rate;
      audio.onended = audio.onerror = () => res();
      audio.play().catch(() => res());
    });
  }

  async function say(text, token) {
    if (!text) return;
    if (settings.engine === 'cloud' && !cloudBroken) {
      try {
        const url = await audioUrl(text);
        if (token !== runToken) return;
        await playUrl(url);
        return;
      } catch (e) {
        cloudBroken = true;
        toast('클라우드 음성을 쓸 수 없어 브라우저 음성으로 대체해요. (' + e.message + ')');
      }
    }
    if (token !== runToken) return;
    await speakBrowser(text);
  }

  function prefetch(c) {
    if (settings.engine !== 'cloud' || cloudBroken) return;
    [c.answer, settings.explain ? c.explanation : ''].forEach((t) => t && audioUrl(t).catch(() => {}));
  }

  /* ---------- 재생 루프 ---------- */
  function setPhase(t) {
    $('#phase').textContent = t;
    const step = t === '문제' ? 'q' : t.startsWith('생각') ? 't' : t === '정답' ? 'a' : t === '해설' ? 'e' : 'idle';
    $('#player').dataset.step = step;
  }

  function renderPlayer(card, showAnswer) {
    const total = state.queue.length;
    $('#goMake').hidden = total > 0;
    $('#intro').hidden = total > 0;
    $('#counter').textContent = total ? `${Math.min(state.idx + 1, total)} / ${total}` : '';
    $('#progress').style.width = total ? ((state.idx + (state.playing ? 0.5 : 0)) / total) * 100 + '%' : '0';
    const q = $('#qText'), a = $('#aText');
    if (!card) {
      q.textContent = total ? '재생 버튼을 누르면 문제부터 읽어줘요.' : '카드를 만들면 여기에서 문제가 나와요.';
      a.hidden = true;
      return;
    }
    q.textContent = card.question;
    a.textContent = card.answer;
    a.hidden = !showAnswer;
  }

  function setPlayIcon() {
    $('#play').innerHTML = state.playing
      ? '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    $('#play').setAttribute('aria-label', state.playing ? '일시정지' : '재생');
    $('#player').classList.toggle('playing', state.playing);
  }

  async function run() {
    if (!state.queue.length) return toast('먼저 카드를 만들어 주세요.');
    const token = ++runToken;
    state.playing = true; setPlayIcon(); updateMedia();
    while (token === runToken && state.idx < state.queue.length) {
      const c = state.queue[state.idx];
      renderPlayer(c, false);
      prefetch(c);
      setPhase('문제');
      await say(c.question, token); if (token !== runToken) return;
      for (let s = settings.gap; s > 0; s--) {
        setPhase(`생각하는 시간 ${s}`);
        await wait(1000); if (token !== runToken) return;
      }
      renderPlayer(c, true);
      setPhase('정답');
      await say(c.answer, token); if (token !== runToken) return;
      if (settings.explain && c.explanation) {
        setPhase('해설');
        await wait(300); if (token !== runToken) return;
        await say(c.explanation, token); if (token !== runToken) return;
      }
      await wait(900); if (token !== runToken) return;
      state.idx++;
    }
    if (token === runToken) {
      state.playing = false; state.idx = 0; setPlayIcon();
      setPhase('한 바퀴 끝났어요'); renderPlayer(null, false);
    }
  }

  function stop() {
    runToken++;
    state.playing = false;
    if (stopCurrent) stopCurrent();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    audio.pause();
    setPlayIcon();
    if (state.queue.length) setPhase('일시정지');
    else setPhase('대기 중');
  }

  function toggle() { state.playing ? stop() : run(); }

  function jump(d) {
    if (!state.queue.length) return;
    const was = state.playing;
    stop();
    state.idx = Math.max(0, Math.min(state.queue.length - 1, state.idx + d));
    renderPlayer(state.queue[state.idx], false);
    if (was) run();
  }

  async function mark(delta) {
    const c = state.queue[state.idx];
    if (!c) return;
    const next = Math.max(0, (c.wrong_count || 0) + delta);
    if (next === (c.wrong_count || 0)) return toast('이미 0이에요.');
    try {
      await db.patchCard(c.id, { wrong_count: next });
      c.wrong_count = next; // 큐에 같은 객체가 여러 번 들어 있어도 함께 갱신
      renderManage();
      toast(delta > 0 ? '다음 바퀴부터 더 자주 나와요.' : '빈도를 줄였어요.');
    } catch (e) { toast('저장 실패: ' + (e.message || e)); }
  }

  /* ---------- 잠금화면 / 블루투스 리모컨 ---------- */
  function updateMedia() {
    if (!('mediaSession' in navigator)) return;
    const deck = state.decks.find((d) => d.id === state.deckId);
    navigator.mediaSession.metadata = new MediaMetadata({ title: '울트라 오디오 스터디', artist: deck ? deck.title : '' });
  }
  function initMedia() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* 미지원 */ } };
    set('play', () => { if (!state.playing) run(); });
    set('pause', () => { if (state.playing) stop(); });
    set('nexttrack', () => jump(1));
    set('previoustrack', () => jump(-1));
  }

  /* ---------- 화면 전환 / 이벤트 ---------- */
  function showView(v) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    ['listen', 'make', 'manage'].forEach((n) => { $('#view-' + n).hidden = n !== v; });
  }

  function bindSettings() {
    $('#sEngine').value = settings.engine;
    $('#sRate').value = settings.rate;
    $('#oRate').textContent = settings.rate + '배';
    $('#sGap').value = settings.gap;
    $('#sShuffle').checked = settings.shuffle;
    $('#sWeak').checked = settings.weak;
    $('#sExplain').checked = settings.explain;

    const persist = () => localStorage.setItem('uas.settings', JSON.stringify(settings));
    $('#sEngine').onchange = (e) => { settings.engine = e.target.value; cloudBroken = false; persist(); };
    $('#sRate').oninput = (e) => {
      settings.rate = Number(e.target.value); $('#oRate').textContent = settings.rate + '배'; persist();
      audio.playbackRate = settings.rate;
    };
    $('#sGap').onchange = (e) => { settings.gap = Math.max(1, Math.min(20, Number(e.target.value) || 4)); persist(); };
    $('#sShuffle').onchange = (e) => { settings.shuffle = e.target.checked; persist(); stop(); buildQueue(); renderPlayer(null, false); };
    $('#sWeak').onchange = (e) => { settings.weak = e.target.checked; persist(); stop(); buildQueue(); renderPlayer(null, false); };
    $('#sExplain').onchange = (e) => { settings.explain = e.target.checked; persist(); };
  }

  function bind() {
    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showView(b.dataset.view); });

    $('#deckSelect').onchange = async (e) => {
      stop(); state.deckId = e.target.value; localStorage.setItem('uas.deck', state.deckId);
      try { await loadCards(); } catch (err) { toast('불러오기 실패: ' + err.message); }
    };
    $('#newDeck').onclick = async () => {
      const title = (prompt('새 덱 이름 (예: 정보처리기사 필기)') || '').trim();
      if (!title) return;
      try {
        const deck = await db.addDeck(title);
        state.decks.push(deck); state.deckId = deck.id; localStorage.setItem('uas.deck', deck.id);
        stop(); renderDecks(); await loadCards();
      } catch (e) { toast('덱 만들기 실패: ' + (e.message || e)); }
    };
    $('#delDeck').onclick = async () => {
      if (!confirm('이 덱과 안의 카드를 모두 삭제할까요?')) return;
      try { await db.delDeck(state.deckId); await loadDecks(); } catch (e) { toast('삭제 실패: ' + (e.message || e)); }
    };

    $('#goMake').onclick = () => showView('make');
    $('#generate').onclick = generate;
    $('#draft').addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.i !== undefined) state.draft[Number(t.dataset.i)][t.dataset.k] = t.value;
    });
    $('#draft').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'saveDraft') return saveDraft();
      if (t.dataset.del !== undefined) { state.draft.splice(Number(t.dataset.del), 1); renderDraft(); }
    });

    $('#cardList').addEventListener('click', async (e) => {
      const id = e.target.dataset.delCard;
      if (!id) return;
      try { await db.delCard(id); await loadCards(); } catch (err) { toast('삭제 실패: ' + (err.message || err)); }
    });

    $('#play').onclick = toggle;
    $('#prev').onclick = () => jump(-1);
    $('#next').onclick = () => jump(1);
    $('#markWrong').onclick = () => mark(1);
    $('#markKnown').onclick = () => mark(-1);

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) && !$('#view-listen').hidden) {
        e.preventDefault(); toggle();
      }
    });

    bindSettings();
    initMedia();
    setPlayIcon();
  }

  /* ---------- 시작 ---------- */
  (async function init() {
    bind();
    await initAuth();
    await loadDecks();
  })();
})();
