// Cloudflare Pages 고급 모드 (_worker.js): /api/* 는 여기서 처리하고 나머지는 정적 파일로 넘깁니다.

// 유료 API(Claude, TTS)를 아무나 호출하지 못하게 Supabase 로그인 토큰을 확인합니다.
// - SUPABASE_URL / SUPABASE_ANON_KEY 가 설정돼 있으면: 로그인한 사용자만 통과
// - 없으면: ALLOW_ANON=1 일 때만 통과 (로컬 개발용). 배포 환경에서는 설정하지 마세요.
async function requireUser(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return env.ALLOW_ANON === '1' ? { ok: true } : { ok: false, reason: '서버에 SUPABASE_URL / SUPABASE_ANON_KEY가 설정되지 않았어요.' };
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, reason: '로그인이 필요해요. (로그인 없이는 AI 변환·클라우드 음성을 쓸 수 없어요)' };

  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: 'Bearer ' + token },
  });
  return res.ok ? { ok: true } : { ok: false, reason: '로그인이 만료됐어요. 다시 로그인해 주세요.' };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// ---- /api/cards ----

const SYSTEM = `당신은 자격증 시험 준비용 "오디오 학습 카드"를 만드는 도우미입니다.
사용자가 준 메모를 문제/정답/해설 카드로 나눕니다.

규칙:
- 메모에 있는 내용만 사용하세요. 메모에 없는 사실을 추가하거나 추측하지 마세요.
- 귀로만 듣습니다. 문제는 그 자체로 이해되게 쓰고, "위 표", "다음 그림" 같은 표현은 쓰지 마세요.
- 문제는 한 문장, 정답은 짧게(가능하면 한 문장 이내), 해설은 1~2문장으로 쓰세요.
- 숫자, 약어, 고유명사는 메모 그대로 유지하세요.
- 메모 하나에서 카드 여러 장이 나올 수 있습니다. 중요도가 낮은 문장은 건너뛰세요.
- 응답은 JSON 배열만 출력하세요. 설명, 코드블록 표시는 금지입니다.
형식: [{"question":"...","answer":"...","explanation":"..."}]`;

async function handleCards({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 ANTHROPIC_API_KEY가 설정되지 않았어요.' }, 501);

  let text;
  try { ({ text } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  if (!text || typeof text !== 'string') return json({ error: '메모가 비어 있어요.' }, 400);
  if (text.length > 12000) return json({ error: '메모가 너무 길어요. 12,000자 이하로 나눠서 넣어 주세요.' }, 400);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CARD_MODEL || 'claude-sonnet-5',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'AI 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }

  const data = await res.json();
  const raw = (data.content || []).map((b) => b.text || '').join('').replace(/```json|```/g, '').trim();
  let cards;
  try { cards = JSON.parse(raw); } catch { return json({ error: 'AI 응답을 해석하지 못했어요. 다시 시도해 주세요.' }, 502); }
  if (!Array.isArray(cards)) return json({ error: 'AI 응답 형식이 올바르지 않아요.' }, 502);

  cards = cards
    .filter((c) => c && c.question && c.answer)
    .map((c) => ({ question: String(c.question), answer: String(c.answer), explanation: String(c.explanation || '') }));
  return json({ cards });
}

// ---- /api/tts ----

// Google Cloud Text-to-Speech (REST) 를 서버에서 호출해 mp3를 돌려줍니다.
// API 키는 Cloudflare 환경변수(TTS_API_KEY)에만 두고 브라우저에는 노출하지 않습니다.
async function handleTts({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  if (!env.TTS_API_KEY) return json({ error: '서버에 TTS_API_KEY가 설정되지 않았어요.' }, 501);

  let text;
  try { ({ text } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  if (!text || typeof text !== 'string') return json({ error: '텍스트가 비어 있어요.' }, 400);
  if (text.length > 1000) return json({ error: '한 번에 1,000자까지만 읽을 수 있어요.' }, 400);

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(env.TTS_API_KEY), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ko-KR', name: env.TTS_VOICE || 'ko-KR-Neural2-A' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'TTS 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }

  const { audioContent } = await res.json();
  const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' } });
}

// ---- /api/stt ----

// 녹음 파일(음성) → 글자. 브라우저가 파일을 약 1분 단위 16-bit PCM(WAV 본문)으로 잘라 base64 로 보내면,
// Google Cloud Speech-to-Text (동기 recognize, 1분 이하 오디오) 로 변환해 텍스트를 돌려줍니다.
// 키는 STT_API_KEY, 없으면 TTS_API_KEY 를 함께 씁니다. (해당 키에 Speech-to-Text API 사용 권한이 있어야 해요)
async function handleStt({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  const key = env.STT_API_KEY || env.TTS_API_KEY;
  if (!key) return json({ error: '서버에 STT_API_KEY(또는 TTS_API_KEY)가 설정되지 않았어요.' }, 501);

  let audio, rate;
  try { ({ audio, rate } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  if (!audio || typeof audio !== 'string') return json({ error: '오디오가 비어 있어요.' }, 400);
  if (audio.length > 3_500_000) return json({ error: '오디오 조각이 너무 길어요. (1분 이하로 잘라 보내야 해요)' }, 400);
  rate = Number(rate) || 16000;
  if (rate < 8000 || rate > 48000) return json({ error: '지원하지 않는 샘플레이트예요.' }, 400);

  const res = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: rate,
        languageCode: 'ko-KR',
        enableAutomaticPunctuation: true,
        model: env.STT_MODEL || 'default',
      },
      audio: { content: audio },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'STT 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }

  const data = await res.json();
  const text = (data.results || []).map((r) => (r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : '')).join(' ').trim();
  return json({ text });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      if (request.method !== 'POST') return json({ error: 'POST만 지원해요.' }, 405);
      if (pathname === '/api/cards') return handleCards({ request, env });
      if (pathname === '/api/tts') return handleTts({ request, env });
      if (pathname === '/api/stt') return handleStt({ request, env });
      return json({ error: '없는 API예요.' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
