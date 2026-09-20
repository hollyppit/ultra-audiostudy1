(() => {
  'use strict';

  /* ---------- 기본 세팅 ---------- */
  const CFG = window.APP_CONFIG || {};
  const hasSb = CFG.LOGIN_ENABLED !== false && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/YOUR_/.test(CFG.SUPABASE_URL) && window.supabase;
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
    async renameDeck(id, title) {
      if (this.cloud()) {
        const { error } = await sb.from('decks').update({ title }).eq('id', id);
        if (error) throw error;
        return;
      }
      const d = local.read();
      const deck = d.decks.find((x) => x.id === id);
      if (deck) deck.title = title;
      local.write(d);
    },
    async cards(deckId) {
      if (this.cloud()) {
        // position 컬럼이 아직 없는 DB에서도 동작하도록 created_at 정렬로 폴백
        let r = await sb.from('cards').select('*').eq('deck_id', deckId).order('position', { nullsFirst: false }).order('created_at');
        if (r.error) r = await sb.from('cards').select('*').eq('deck_id', deckId).order('created_at');
        if (r.error) throw r.error;
        return r.data;
      }
      return local.read().cards.filter((c) => c.deck_id === deckId).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    },
    async addCards(deckId, arr, start = 0) {
      if (this.cloud()) {
        const rows = arr.map((c, i) => ({ deck_id: deckId, position: start + i, ...c }));
        let { error } = await sb.from('cards').insert(rows);
        if (error && rows.some((r) => r.kind === 'note')) {
          throw new Error('오디오북을 저장하려면 Supabase SQL Editor에서 supabase-schema.sql을 다시 실행해 주세요. (' + error.message + ')');
        }
        if (error) ({ error } = await sb.from('cards').insert(rows.map(({ position, ...rest }) => rest)));
        if (error) throw error;
        return;
      }
      const d = local.read();
      arr.forEach((c, i) => d.cards.push({ id: uid(), deck_id: deckId, wrong_count: 0, created_at: new Date().toISOString(), position: start + i, ...c }));
      local.write(d);
    },
    async reorder(ids) {
      if (this.cloud()) {
        const results = await Promise.all(ids.map((id, i) => sb.from('cards').update({ position: i }).eq('id', id)));
        const bad = results.find((r) => r.error);
        if (bad) throw new Error('순서를 저장하려면 Supabase cards 테이블에 position 컬럼이 필요해요. (supabase-position.sql 참고)');
        return;
      }
      const d = local.read();
      ids.forEach((id, i) => { const c = d.cards.find((x) => x.id === id); if (c) c.position = i; });
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
      if (!decks.length) decks = [await db.addDeck('내 첫 폴더')];
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
    const deck = state.decks.find((d) => d.id === state.deckId);
    $('#saveTarget').textContent = deck ? `만든 내용은 "${deck.title}" 폴더에 저장돼요.` : '';
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

  /* 만들기 방식: 'audiobook'(기본, 메모를 듣기 좋게 정리) | 'qa'(문제·정답 카드) */
  let mode = localStorage.getItem('uas.mode') === 'qa' ? 'qa' : 'audiobook';

  function setMode(m) {
    mode = m;
    try { localStorage.setItem('uas.mode', m); } catch { /* 저장 불가 환경 */ }
    document.querySelectorAll('.seg [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    const ab = m === 'audiobook';
    $('#makeTitle').textContent = ab ? '메모를 오디오북으로 정리해요' : '메모를 카드로 바꿔요';
    $('#makeSub').textContent = ab
      ? '붙여넣은 메모를 듣기 좋은 문장으로 다듬어, 순서대로 읽어줘요.'
      : '공부한 내용을 붙여넣으면 문제·정답·해설 카드가 만들어져요.';
    $('#generate').textContent = ab ? '오디오북으로 정리' : '카드로 변환';
    $('#memo').placeholder = ab
      ? '공부한 내용을 그대로 붙여넣으세요.\n\n주제가 바뀌는 곳에 빈 줄을 넣으면 항목별로 나눠서 읽어줘요.\nAI를 못 쓰는 환경에서는 문단 그대로 담겨요.'
      : '공부한 내용을 그대로 붙여넣으세요.\n\nAI를 못 쓰는 환경에서는 한 줄에 하나씩\n질문 :: 정답 :: 해설(선택)\n형식으로 적어도 카드가 됩니다.';
  }

  // 메모를 문단 단위로 묶어 한 번에 5,000자 이하로 보냅니다. (AI 호출 한도 대응)
  function chunkMemo(text, max = 5000) {
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    let cur = '';
    for (let p of paras) {
      while (p.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(p.slice(0, max)); p = p.slice(max); }
      if (cur && (cur + '\n\n' + p).length > max) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
    }
    if (cur) out.push(cur);
    return out;
  }

  // AI를 못 쓸 때: 빈 줄로 나뉜 덩어리를 그대로 한 항목씩 (기호만 정리)
  function parseAudiobook(text) {
    const clean = (s) => s.replace(/^[\s#>*•\-·▶■●○]+/gm, '').replace(/\s*\n\s*/g, ' ').trim();
    const paras = text.split(/\n{2,}/).map(clean).filter(Boolean);
    const list = paras.length > 1 ? paras : text.split('\n').map(clean).filter(Boolean);
    return list.map((body) => ({ kind: 'note', question: '', answer: body, explanation: '' }));
  }

  async function callCards(text, m) {
    const res = await fetch('/api/cards', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ text, mode: m }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return j.cards;
  }

  async function generate() {
    stopDictation();
    const text = $('#memo').value.trim();
    if (!text) return toast('메모를 붙여넣거나 말로 입력해 주세요.');
    const btn = $('#generate');
    const idleLabel = btn.textContent;
    btn.disabled = true; btn.textContent = mode === 'audiobook' ? '정리 중…' : '변환 중…';
    try {
      if (mode === 'audiobook') {
        try {
          const parts = chunkMemo(text);
          const all = [];
          for (let i = 0; i < parts.length; i++) {
            if (parts.length > 1) btn.textContent = `정리 중… ${i + 1} / ${parts.length}`;
            all.push(...await callCards(parts[i], 'audiobook'));
          }
          state.draft = all;
        } catch (e) {
          state.draft = parseAudiobook(text);
          toast('AI 정리를 쓸 수 없어 메모를 문단 그대로 담았어요. (' + e.message + ')');
        }
      } else {
        try {
          state.draft = await callCards(text, 'qa');
        } catch (e) {
          const parsed = parseManual(text);
          if (parsed.length) {
            state.draft = parsed;
            toast('AI 변환을 쓸 수 없어 구분자 방식으로 변환했어요. (' + e.message + ')');
          } else {
            toast('AI 변환 실패: ' + e.message + ' — "질문 :: 정답" 형식으로 적으면 바로 변환돼요.');
          }
        }
      }
    } finally {
      btn.disabled = false; btn.textContent = idleLabel;
    }
    renderDraft();
  }

  function renderDraft() {
    const n = state.draft.length;
    const notes = n > 0 && state.draft[0].kind === 'note';
    $('#draft').innerHTML = n
      ? state.draft.map((c, i) => c.kind === 'note'
        ? `<article class="draft-card">
            <label>제목 <span class="opt">(선택)</span><textarea data-i="${i}" data-k="question" rows="1">${esc(c.question)}</textarea></label>
            <label>본문 <span class="opt">(이 내용을 읽어줘요)</span><textarea data-i="${i}" data-k="answer" rows="5">${esc(c.answer)}</textarea></label>
            <button class="link danger" data-del="${i}">이 항목 빼기</button>
          </article>`
        : `<article class="draft-card">
            <label>문제<textarea data-i="${i}" data-k="question" rows="2">${esc(c.question)}</textarea></label>
            <label>정답<textarea data-i="${i}" data-k="answer" rows="2">${esc(c.answer)}</textarea></label>
            <label>해설<textarea data-i="${i}" data-k="explanation" rows="2">${esc(c.explanation)}</textarea></label>
            <button class="link danger" data-del="${i}">이 카드 빼기</button>
          </article>`).join('')
        + `<div class="row"><button id="saveDraft" class="primary">${notes ? `오디오북 ${n}개 저장` : `카드 ${n}장 저장`}</button><span class="hint">${notes ? '읽을 내용에 틀린 곳이 없는지 확인했나요?' : '틀린 내용이 없는지 확인했나요?'}</span></div>`
      : '';
  }

  async function saveDraft() {
    const cards = state.draft
      .map((c) => c.kind === 'note'
        ? { kind: 'note', question: (c.question || '').trim(), answer: (c.answer || '').trim(), explanation: '' }
        : { question: (c.question || '').trim(), answer: (c.answer || '').trim(), explanation: (c.explanation || '').trim() })
      .filter((c) => (c.kind === 'note' ? c.answer : c.question && c.answer));
    if (!cards.length) return toast('저장할 내용이 없어요.');
    try {
      await db.addCards(state.deckId, cards, state.cards.length);
      state.draft = []; $('#memo').value = ''; renderDraft();
      await loadCards();
      toast(cards.length + '개 저장했어요.');
      showView('listen');
    } catch (e) { toast('저장 실패: ' + (e.message || e)); }
  }

  /* ---------- 말로 메모하기 (브라우저 음성 인식) ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let dictating = false;

  function setMicUi(on) {
    dictating = on;
    $('#mic').classList.toggle('on', on);
    $('#mic').setAttribute('aria-pressed', String(on));
    $('#micLabel').textContent = on ? '듣는 중… 누르면 멈춰요' : '말로 메모하기';
    if (!on) $('#interim').textContent = '';
  }

  function stopDictation() {
    if (!dictating) return;
    dictating = false; // onend 에서 자동 재시작하지 않도록 먼저 내림
    try { rec && rec.stop(); } catch { /* 이미 멈춤 */ }
    setMicUi(false);
  }

  function startDictation() {
    if (state.playing) stop(); // 재생 음성과 마이크가 겹치지 않게
    rec = new SR();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      const memo = $('#memo');
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (!t) continue;
        if (e.results[i].isFinal) {
          memo.value += (memo.value && !memo.value.endsWith('\n') ? '\n' : '') + t;
          memo.scrollTop = memo.scrollHeight;
        } else {
          interim += t + ' ';
        }
      }
      $('#interim').textContent = interim;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('마이크 사용이 막혀 있어요. 주소창 옆 자물쇠에서 마이크를 허용해 주세요.');
        stopDictation();
      } else if (e.error === 'audio-capture') {
        toast('마이크를 찾지 못했어요.'); stopDictation();
      } else if (e.error === 'network') {
        toast('음성 인식 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'); stopDictation();
      }
      // no-speech 등은 무시: onend 에서 이어서 듣기
    };
    rec.onend = () => {
      if (!dictating) return;
      try { rec.start(); } catch { stopDictation(); } // 브라우저가 침묵 후 끊으면 이어서 듣기
    };

    try { rec.start(); setMicUi(true); } catch { toast('음성 인식을 시작하지 못했어요.'); }
  }

  function initDictation() {
    const btn = $('#mic');
    if (!SR) {
      btn.disabled = true;
      $('#micLabel').textContent = '이 브라우저는 음성 입력 미지원';
      btn.title = 'Chrome, Edge, Safari에서 사용할 수 있어요.';
      return;
    }
    btn.onclick = () => (dictating ? stopDictation() : startDictation());
  }

  /* ---------- 녹음 파일 → 글자 (클라우드 STT) ---------- */
  // 파일을 16kHz 모노로 디코딩해 약 55초 조각(조용한 지점에서 절단)으로 나눠 /api/stt 로 순서대로 보냅니다.
  const STT_MAX_MIN = 20;
  const STT_MAX_MB = 60;
  let sttRun = 0; // 취소용 토큰 (0 이면 대기 중)

  function sttUi(busy, msg) {
    const s = $('#sttStatus');
    s.hidden = !msg;
    s.textContent = msg || '';
    s.classList.toggle('busy', busy);
    $('#sttLabel').textContent = busy ? '변환 취소' : '녹음 파일 → 글자';
  }

  function sttSplit(mono, sr) {
    const win = Math.max(1, Math.floor(0.05 * sr));
    const pts = [0];
    let start = 0;
    while (mono.length - start > 58 * sr) {
      const lo = start + 45 * sr, hi = start + 58 * sr;
      let best = start + 55 * sr, bestE = Infinity;
      for (let p = lo; p + win < hi; p += win) {
        let e = 0;
        for (let i = p; i < p + win; i++) e += mono[i] * mono[i];
        if (e < bestE) { bestE = e; best = p + (win >> 1); }
      }
      pts.push(best); start = best;
    }
    pts.push(mono.length);
    return pts;
  }

  function sttEncode(f32, from, to) {
    const bytes = new Uint8Array((to - from) * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < to - from; i++) {
      const s = Math.max(-1, Math.min(1, f32[from + i]));
      dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function sttPost(audio, rate) {
    const res = await fetch('/api/stt', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ audio, rate }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(j.error || 'HTTP ' + res.status); err.status = res.status; throw err; }
    return j.text || '';
  }

  async function transcribeFile(file) {
    if (file.size > STT_MAX_MB * 1024 * 1024) return toast(`파일이 너무 커요. ${STT_MAX_MB}MB 이하로 올려 주세요.`);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return toast('이 브라우저는 오디오 변환을 지원하지 않아요.');
    const token = ++sttRun;
    if (state.playing) stop();
    stopDictation();
    sttUi(true, '파일을 읽는 중…');

    try {
      const ctx = new Ctx({ sampleRate: 16000 });
      let buf;
      try { buf = await ctx.decodeAudioData(await file.arrayBuffer()); }
      catch { throw new Error('이 파일 형식을 읽지 못했어요. mp3, m4a, wav 파일을 사용해 주세요.'); }
      finally { ctx.close && ctx.close(); }
      if (token !== sttRun) return;

      if (buf.duration > STT_MAX_MIN * 60) throw new Error(`녹음이 너무 길어요. ${STT_MAX_MIN}분 이하로 나눠서 올려 주세요.`);

      const sr = buf.sampleRate, ch = buf.numberOfChannels;
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch; }

      const pts = sttSplit(mono, sr);
      const total = pts.length - 1;
      const memo = $('#memo');
      let got = 0;
      for (let k = 0; k < total; k++) {
        if (token !== sttRun) return;
        sttUi(true, `글자로 바꾸는 중… ${k + 1} / ${total}`);
        const audio = sttEncode(mono, pts[k], pts[k + 1]);
        let text;
        try { text = await sttPost(audio, sr); }
        catch (e) {
          if (e.status && e.status < 500 && e.status !== 429) throw e; // 로그인/키 문제는 즉시 중단
          text = await sttPost(audio, sr); // 일시 오류는 1회 재시도
        }
        if (token !== sttRun) return;
        if (text) {
          memo.value += (memo.value && !memo.value.endsWith('\n') ? '\n' : '') + text;
          memo.scrollTop = memo.scrollHeight;
          got++;
        }
      }
      sttUi(false, '');
      toast(got ? `${Math.max(1, Math.round(buf.duration / 60))}분 분량을 글자로 바꿨어요. 내용을 확인해 주세요.` : '인식된 말이 없어요. 소리가 또렷한 파일인지 확인해 주세요.');
    } catch (e) {
      if (token === sttRun) { sttUi(false, ''); toast('변환 실패: ' + (e.message || e)); }
    } finally {
      if (token === sttRun) sttRun = 0;
    }
  }

  function initStt() {
    $('#sttBtn').onclick = () => {
      if (sttRun) { sttRun = 0; sttUi(false, '변환을 취소했어요. (이미 바뀐 글자는 남아 있어요)'); return; }
      $('#sttFile').click();
    };
    $('#sttFile').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = ''; // 같은 파일을 다시 고를 수 있게
      if (f) transcribeFile(f);
    };
  }

  /* ---------- 카드 관리 ---------- */
  let editId = null;

  function renderManage() {
    const deck = state.decks.find((d) => d.id === state.deckId);
    $('#folderName').textContent = deck ? deck.title : '';
    const nNotes = state.cards.filter((c) => c.kind === 'note').length;
    const nQa = state.cards.length - nNotes;
    $('#folderMeta').textContent = [nNotes && `오디오북 ${nNotes}개`, nQa && `문제 카드 ${nQa}장`].filter(Boolean).join(' · ') || '비어 있어요';
    $('#manageHint').hidden = state.cards.length < 2;

    const el = $('#cardList');
    if (!state.cards.length) {
      el.innerHTML = '<p class="empty">이 폴더에는 아직 내용이 없어요.<br>"만들기"에서 메모를 붙여넣어 보세요.</p>';
      return;
    }
    el.innerHTML = state.cards.map((c) => c.id === editId
      ? `<article class="item editing" data-id="${esc(c.id)}">
          <div class="body">
            ${c.kind === 'note'
              ? `<label>제목 <span class="opt">(선택)</span><textarea data-k="question" rows="1">${esc(c.question)}</textarea></label>
                 <label>본문<textarea data-k="answer" rows="6">${esc(c.answer)}</textarea></label>`
              : `<label>문제<textarea data-k="question" rows="2">${esc(c.question)}</textarea></label>
                 <label>정답<textarea data-k="answer" rows="2">${esc(c.answer)}</textarea></label>
                 <label>해설<textarea data-k="explanation" rows="2">${esc(c.explanation)}</textarea></label>`}
            <div class="row">
              <button class="primary" data-act="save">저장</button>
              <button class="link" data-act="cancel">취소</button>
            </div>
          </div>
        </article>`
      : `<article class="item" data-id="${esc(c.id)}">
          <button class="grip" tabindex="0" aria-label="순서 이동: 끌거나 위아래 화살표 키" title="끌어서 순서 바꾸기">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
          </button>
          <div class="body">
            ${c.kind === 'note'
              ? `${c.question ? `<b>${esc(c.question)}</b>` : ''}<span class="txt">${esc(c.answer)}</span>`
              : `<b>${esc(c.question)}</b><span class="ans">${esc(c.answer)}</span>${c.explanation ? `<span class="exp">${esc(c.explanation)}</span>` : ''}`}
            <div class="foot">
              <span>${c.kind === 'note' ? '<span class="tag">오디오북</span>' : c.wrong_count ? `<span class="badge">헷갈림 ${c.wrong_count}</span>` : ''}</span>
              <span class="acts">
                <button class="link" data-act="edit">편집</button>
                <button class="link danger" data-act="del">삭제</button>
              </span>
            </div>
          </div>
        </article>`).join('');
  }

  async function saveEdit(id, itemEl) {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return;
    const val = (k) => (itemEl.querySelector(`[data-k="${k}"]`)?.value || '').trim();
    const note = card.kind === 'note';
    const patch = note
      ? { question: val('question'), answer: val('answer') }
      : { question: val('question'), answer: val('answer'), explanation: val('explanation') };
    if (note ? !patch.answer : !patch.question || !patch.answer) return toast(note ? '본문은 비워둘 수 없어요.' : '문제와 정답은 비워둘 수 없어요.');
    try {
      await db.patchCard(id, patch);
      Object.assign(card, patch); // 재생 큐가 같은 객체를 참조하므로 함께 갱신됨
      editId = null; renderManage(); renderPlayer(null, false);
      toast('카드를 수정했어요.');
    } catch (e) { toast('저장 실패: ' + (e.message || e)); }
  }

  async function deleteCard(id) {
    const card = state.cards.find((c) => c.id === id);
    if (!card || !confirm(`이 카드를 삭제할까요?\n\n${card.question}`)) return;
    try {
      if (state.playing) stop();
      await db.delCard(id);
      await loadCards();
      toast('카드를 삭제했어요.');
    } catch (e) { toast('삭제 실패: ' + (e.message || e)); }
  }

  /* ---------- 카드 순서 (드래그 / 키보드) ---------- */
  let orderTimer;
  async function commitOrder() {
    const ids = [...$('#cardList').querySelectorAll('.item[data-id]')].map((el) => el.dataset.id);
    const byId = new Map(state.cards.map((c) => [c.id, c]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    if (next.length !== state.cards.length || next.every((c, i) => c === state.cards[i])) return;
    if (state.playing) stop();
    state.cards = next;
    try {
      await db.reorder(ids);
      state.cards.forEach((c, i) => { c.position = i; });
      buildQueue(); renderPlayer(null, false);
      toast(settings.shuffle ? '순서를 저장했어요. (섞어서 재생 중에는 무작위로 들려요)' : '순서를 저장했어요.');
    } catch (e) {
      toast(e.message || '순서 저장 실패');
      await loadCards();
    }
  }

  function initReorder() {
    const list = $('#cardList');

    list.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip');
      if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const item = grip.closest('.item');
      item.classList.add('dragging');
      const move = (ev) => {
        const y = ev.clientY;
        const next = [...list.querySelectorAll('.item:not(.dragging)')].find((it) => {
          const r = it.getBoundingClientRect();
          return y < r.top + r.height / 2;
        }) || null;
        if (next !== item.nextElementSibling) list.insertBefore(item, next);
        if (y < 90) window.scrollBy(0, -14); else if (y > window.innerHeight - 130) window.scrollBy(0, 14);
      };
      const end = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        item.classList.remove('dragging');
        commitOrder();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });

    list.addEventListener('keydown', (e) => {
      const grip = e.target.closest('.grip');
      if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const item = grip.closest('.item');
      if (e.key === 'ArrowUp' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
      else if (e.key === 'ArrowDown' && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
      grip.focus();
      clearTimeout(orderTimer);
      orderTimer = setTimeout(commitOrder, 600);
    });
  }

  /* ---------- 재생 큐 ---------- */
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // 오디오북(note)은 섞지 않고 저장된 순서대로 먼저, 그 뒤에 문제 카드(설정에 따라 섞음)
  function buildQueue() {
    const notes = state.cards.filter((c) => c.kind === 'note');
    const q = [];
    for (const c of state.cards) {
      if (c.kind === 'note') continue;
      const n = settings.weak ? 1 + Math.min(c.wrong_count || 0, 3) : 1;
      for (let i = 0; i < n; i++) q.push(c);
    }
    state.queue = [...notes, ...(settings.shuffle ? shuffle(q) : q)];
    state.idx = 0;
  }

  // 긴 본문은 브라우저 음성이 중간에 끊기는 문제가 있어 문장 단위(약 180자)로 나눠 읽습니다.
  function splitSpeech(text, max = 180) {
    const parts = [];
    for (const para of String(text).split(/\n+/)) {
      const sentences = para.replace(/([.!?。！？…]+)\s+/g, '$1\n').split('\n');
      let cur = '';
      for (let s of sentences) {
        s = s.trim();
        if (!s) continue;
        while (s.length > max) {
          let cut = s.lastIndexOf(' ', max);
          if (cut < max / 2) cut = max;
          if (cur) { parts.push(cur); cur = ''; }
          parts.push(s.slice(0, cut).trim());
          s = s.slice(cut).trim();
        }
        if (cur && (cur + ' ' + s).length > max) { parts.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
      }
      if (cur) parts.push(cur);
    }
    return parts.filter(Boolean);
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

  async function speakLong(text, token) {
    const chunks = splitSpeech(text);
    for (let i = 0; i < chunks.length; i++) {
      if (token !== runToken) return;
      if (settings.engine === 'cloud' && !cloudBroken && chunks[i + 1]) audioUrl(chunks[i + 1]).catch(() => {}); // 다음 조각 미리 받기
      await say(chunks[i], token);
    }
  }

  function prefetch(c) {
    if (settings.engine !== 'cloud' || cloudBroken) return;
    if (c.kind === 'note') {
      [c.question, ...splitSpeech(c.answer).slice(0, 2)].forEach((t) => t && audioUrl(t).catch(() => {}));
      return;
    }
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
    const note = !!card && card.kind === 'note';
    $('#player').dataset.kind = note ? 'note' : 'qa';
    if (!card) {
      q.hidden = false;
      q.textContent = total ? '재생 버튼을 누르면 순서대로 읽어줘요.' : '메모를 오디오북이나 카드로 만들면 여기에서 재생돼요.';
      a.hidden = true;
      return;
    }
    q.hidden = !card.question;
    q.textContent = card.question;
    a.textContent = card.answer;
    a.hidden = note ? false : !showAnswer;
    if (note) a.scrollTop = 0;
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
      if (c.kind === 'note') {
        renderPlayer(c, true);
        prefetch(c);
        setPhase('오디오북');
        if (c.question) {
          await say(c.question, token); if (token !== runToken) return;
          await wait(500); if (token !== runToken) return;
        }
        await speakLong(c.answer, token); if (token !== runToken) return;
        await wait(1200); if (token !== runToken) return;
        state.idx++;
        continue;
      }
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
    if (v !== 'make') stopDictation();
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
      const title = (prompt('새 폴더 이름 (예: 지게차운전기능사)') || '').trim();
      if (!title) return;
      try {
        const deck = await db.addDeck(title);
        state.decks.push(deck); state.deckId = deck.id; localStorage.setItem('uas.deck', deck.id);
        stop(); renderDecks(); await loadCards(); showView('make');
      } catch (e) { toast('덱 만들기 실패: ' + (e.message || e)); }
    };
    $('#delDeck').onclick = async () => {
      if (!confirm('이 폴더와 안의 카드를 모두 삭제할까요? 되돌릴 수 없어요.')) return;
      try { await db.delDeck(state.deckId); await loadDecks(); } catch (e) { toast('삭제 실패: ' + (e.message || e)); }
    };

    $('#goMake').onclick = () => showView('make');
    document.querySelectorAll('.seg [data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    setMode(mode);
    initDictation();
    initStt();
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

    $('#cardList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const item = e.target.closest('.item');
      if (!btn || !item) return;
      const id = item.dataset.id;
      if (btn.dataset.act === 'edit') { editId = id; renderManage(); $('#cardList').querySelector('.editing textarea')?.focus(); }
      else if (btn.dataset.act === 'cancel') { editId = null; renderManage(); }
      else if (btn.dataset.act === 'save') saveEdit(id, item);
      else if (btn.dataset.act === 'del') deleteCard(id);
    });
    initReorder();

    $('#renameDeck').onclick = async () => {
      const deck = state.decks.find((d) => d.id === state.deckId);
      if (!deck) return;
      const title = (prompt('폴더 이름', deck.title) || '').trim();
      if (!title || title === deck.title) return;
      try {
        await db.renameDeck(deck.id, title);
        deck.title = title; renderDecks(); renderManage();
        toast('폴더 이름을 바꿨어요.');
      } catch (e) { toast('이름 변경 실패: ' + (e.message || e)); }
    };

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
