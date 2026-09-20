// Cloudflare Pages 고급 모드 (_worker.js): /api/* 는 여기서 처리하고 나머지는 정적 파일로 넘깁니다.

// 유료 API(Claude, TTS)를 아무나 호출하지 못하게 Supabase 로그인 토큰을 확인합니다.
// - ALLOW_ANON=1 이면: 로그인 없이 모두 통과 (테스트용). ※ 주소를 아는 누구나 유료 API를 쓸 수 있으니 정식 오픈 전에 반드시 지우세요.
// - 그 외에 SUPABASE_URL / SUPABASE_ANON_KEY 가 설정돼 있으면: 로그인한 사용자만 통과
// - 둘 다 없으면: 거부
async function requireUser(request, env) {
  if (env.ALLOW_ANON === '1') return { ok: true };
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, reason: '서버에 SUPABASE_URL / SUPABASE_ANON_KEY가 설정되지 않았어요.' };
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

// 오디오북 모드: 문제/정답으로 쪼개지 않고, 메모를 순서대로 "듣기 좋은 원고"로 다듬습니다.
const SYSTEM_AUDIOBOOK = `당신은 학습 메모를 "귀로 듣는 오디오북 원고"로 정리하는 도우미입니다.

규칙:
- 메모에 있는 내용만 사용하세요. 메모에 없는 사실을 추가하거나 추측하지 마세요.
- 내용을 빼지 마세요. 중요도가 낮아 보여도 버리지 말고 정리해서 담으세요.
- 메모의 순서를 유지하세요. 주제가 바뀌는 곳마다 항목을 나누고, 항목마다 짧은 제목(20자 이내)과 본문을 쓰세요.
- 본문은 소리 내어 읽었을 때 자연스러운 문장으로 다듬으세요. 한 항목은 1~6문장, 문장은 짧게 쓰세요.
- #, -, *, 표 기호, 번호 기호 같은 표시는 지우고 문장으로 풀어 쓰세요. "위 표", "다음 그림" 같은 표현은 쓰지 마세요.
- 숫자와 단위는 귀로 듣기 쉽게 한국어로 쓰세요. (예: 2.5m → 2.5미터, 80mm → 80밀리미터, 6° → 6도) 숫자 값 자체는 절대 바꾸지 마세요.
- 응답은 JSON 배열만 출력하세요. 설명, 코드블록 표시는 금지입니다.
형식: [{"title":"...","body":"..."}]`;

async function handleCards({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 ANTHROPIC_API_KEY가 설정되지 않았어요.' }, 501);

  let text, mode;
  try { ({ text, mode } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  const audiobook = mode === 'audiobook';
  if (!text || typeof text !== 'string') return json({ error: '메모가 비어 있어요.' }, 400);
  const maxLen = audiobook ? 6000 : 12000;
  if (text.length > maxLen) return json({ error: `메모가 너무 길어요. ${maxLen.toLocaleString('en-US')}자 이하로 나눠서 넣어 주세요.` }, 400);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CARD_MODEL || 'claude-sonnet-5',
      max_tokens: audiobook ? 8000 : 4000,
      system: audiobook ? SYSTEM_AUDIOBOOK : SYSTEM,
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

  if (audiobook) {
    const notes = cards
      .filter((c) => c && c.body)
      .map((c) => ({ kind: 'note', question: String(c.title || ''), answer: String(c.body), explanation: '' }));
    return json({ cards: notes });
  }

  cards = cards
    .filter((c) => c && c.question && c.answer)
    .map((c) => ({ question: String(c.question), answer: String(c.answer), explanation: String(c.explanation || '') }));
  return json({ cards });
}

// ---- /api/tts ----

// Google Cloud Text-to-Speech (REST) 를 서버에서 호출해 mp3를 돌려줍니다.
// API 키는 Cloudflare 환경변수(TTS_API_KEY)에만 두고 브라우저에는 노출하지 않습니다.
// 앱에서 고를 수 있는 목소리 목록 (허용된 것만 사용 → 비싼 음성을 임의로 호출하지 못하게 막음)
// - Neural2: 자연스럽고 가격이 무난한 기본 목소리
// - Chirp3-HD: 더 사람 같은 프리미엄 목소리 (요금이 더 높아요)
// - kid: Google에는 아이 목소리가 따로 없어서, 여성 목소리의 음높이를 올려 아이 같은 톤으로 만듭니다.
// - 네이버 클로바 보이스(CLOVA Voice, 접두사 nv_): 한국어 발음·억양이 자연스럽고 아이 목소리도 있어요. 네이버 클라우드 키가 따로 필요합니다.
//   (v로 시작하는 speaker = 프리미엄 목소리, n으로 시작하는 speaker = 기본 목소리)
const VOICES = {
  f1: { name: 'ko-KR-Neural2-A' },
  f2: { name: 'ko-KR-Neural2-B' },
  f3: { name: 'ko-KR-Chirp3-HD-Kore' },
  m1: { name: 'ko-KR-Neural2-C' },
  m3: { name: 'ko-KR-Chirp3-HD-Charon' },
  kid: { name: 'ko-KR-Neural2-B', pitch: 7, rate: 1.05 },
  nv_vara: { naver: 'vara' },           // 아라 (여)
  nv_vmikyung: { naver: 'vmikyung' },   // 미경 (여)
  nv_vyuna: { naver: 'vyuna' },         // 유나 (여)
  nv_vdaeseong: { naver: 'vdaeseong' }, // 대성 (남)
  nv_vian: { naver: 'vian' },           // 이안 (남)
  nv_vdain: { naver: 'vdain' },         // 다인 (여자아이)
  nv_nhajun: { naver: 'nhajun' },       // 하준 (남자아이)
  // OpenAI gpt-4o-mini-tts: 말투를 문장으로 지시할 수 있어요. 아이 톤은 지시문으로 만듭니다.
  oa_coral: { openai: 'coral' },
  oa_nova: { openai: 'nova' },
  oa_onyx: { openai: 'onyx' },
  oa_echo: { openai: 'echo' },
  oa_kid: { openai: 'nova', kid: true },
};

const OPENAI_STYLE = '한국어 학습용 오디오북입니다. 또박또박 자연스러운 한국어 발음과 억양으로, 차분하고 따뜻한 톤으로 읽어 주세요. 숫자와 단위는 정확하게 읽어 주세요.';
const OPENAI_KID_STYLE = '초등학생 어린아이처럼 밝고 높은 목소리로, 또박또박 한국어로 읽어 주세요. 숫자와 단위는 정확하게 읽어 주세요.';

// OpenAI TTS → mp3 그대로 전달
async function openaiTts({ voice, kid, text, env }) {
  if (!env.OPENAI_API_KEY) return json({ error: '서버에 OPENAI_API_KEY가 설정되지 않았어요.' }, 501);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice,
      input: text,
      instructions: kid ? OPENAI_KID_STYLE : OPENAI_STYLE,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'OpenAI TTS 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }
  return new Response(res.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' } });
}

// 네이버 클라우드 CLOVA Voice (tts-premium) → mp3 그대로 전달
async function naverTts({ speaker, text, env }) {
  if (!env.NAVER_TTS_ID || !env.NAVER_TTS_SECRET) {
    return json({ error: '서버에 NAVER_TTS_ID / NAVER_TTS_SECRET이 설정되지 않았어요.' }, 501);
  }
  const res = await fetch('https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts', {
    method: 'POST',
    headers: {
      'X-NCP-APIGW-API-KEY-ID': env.NAVER_TTS_ID,
      'X-NCP-APIGW-API-KEY': env.NAVER_TTS_SECRET,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ speaker, text, format: 'mp3' }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: '네이버 TTS 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }
  return new Response(res.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' } });
}

async function handleTts({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);

  let text, voiceId;
  try { ({ text, voice: voiceId } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  const voice = VOICES[voiceId] || { name: env.TTS_VOICE || VOICES.f1.name };
  if (!text || typeof text !== 'string') return json({ error: '텍스트가 비어 있어요.' }, 400);
  if (text.length > 1000) return json({ error: '한 번에 1,000자까지만 읽을 수 있어요.' }, 400);

  if (voice.naver) return naverTts({ speaker: voice.naver, text, env });
  if (voice.openai) return openaiTts({ voice: voice.openai, kid: voice.kid, text, env });
  if (!env.TTS_API_KEY) return json({ error: '서버에 TTS_API_KEY가 설정되지 않았어요.' }, 501);

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(env.TTS_API_KEY), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ko-KR', name: voice.name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: voice.rate || 1.0, ...(voice.pitch ? { pitch: voice.pitch } : {}) },
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
