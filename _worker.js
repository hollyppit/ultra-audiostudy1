// Cloudflare Pages 고급 모드 (_worker.js): /api/* 는 여기서 처리하고 나머지는 정적 파일로 넘깁니다.

// 유료 API(TTS·STT)를 아무나 호출하지 못하게 Supabase 로그인 토큰을 확인합니다.
// - ALLOW_ANON=1 이면: 로그인 없이 모두 통과 (테스트용). ※ 주소를 아는 누구나 유료 API를 쓸 수 있으니 정식 오픈 전에 반드시 지우세요.
// - 그 외에 SUPABASE_URL / SUPABASE_ANON_KEY 가 설정돼 있으면: 로그인한 사용자만 통과
// - 둘 다 없으면: 거부
async function requireUser(request, env) {
  if (env.ALLOW_ANON === '1') return { ok: true };
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, reason: '서버에 SUPABASE_URL / SUPABASE_ANON_KEY가 설정되지 않았어요.' };
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, reason: '로그인이 필요해요. (로그인 없이는 클라우드 음성을 쓸 수 없어요)' };

  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: 'Bearer ' + token },
  });
  return res.ok ? { ok: true } : { ok: false, reason: '로그인이 만료됐어요. 다시 로그인해 주세요.' };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// ---- /api/tts ----

// Google Cloud Text-to-Speech (REST) 를 서버에서 호출해 mp3를 돌려줍니다.
// API 키는 Cloudflare 환경변수(TTS_API_KEY)에만 두고 브라우저에는 노출하지 않습니다.
// 앱에서 고를 수 있는 목소리 목록 (허용된 것만 사용 → 비싼 음성을 임의로 호출하지 못하게 막음)
// - Neural2: 자연스럽고 가격이 무난한 기본 목소리
// - Chirp3-HD: 더 사람 같은 프리미엄 목소리 (요금이 더 높아요)
// - kid: Google에는 아이 목소리가 따로 없어서, 여성 목소리의 음높이를 올려 아이 같은 톤으로 만듭니다.
// - oa_*: OpenAI 목소리 (OPENAI_API_KEY 필요)
const VOICES = {
  f1: { name: 'ko-KR-Neural2-A' },
  f2: { name: 'ko-KR-Neural2-B' },
  f3: { name: 'ko-KR-Chirp3-HD-Kore' },
  m1: { name: 'ko-KR-Neural2-C' },
  m3: { name: 'ko-KR-Chirp3-HD-Charon' },
  kid: { name: 'ko-KR-Neural2-B', pitch: 7, rate: 1.05 },
  // OpenAI gpt-4o-mini-tts: 말투를 문장으로 지시할 수 있어요. 아이 톤은 지시문으로 만듭니다.
  oa_coral: { openai: 'coral' },
  oa_nova: { openai: 'nova' },
  oa_onyx: { openai: 'onyx' },
  oa_echo: { openai: 'echo' },
  oa_kid: { openai: 'nova', kid: true },
  // Gemini TTS: 30개 목소리 중 한국어에 어울리는 것들. 말투는 문장으로 지시합니다. (GEMINI_API_KEY 필요)
  gm_kore: { gemini: 'Kore' },         // 여성, 단호하고 또렷한
  gm_sulafat: { gemini: 'Sulafat' },   // 여성, 따뜻한
  gm_aoede: { gemini: 'Aoede' },       // 여성, 경쾌한
  gm_charon: { gemini: 'Charon' },     // 남성, 정보 전달에 좋은
  gm_puck: { gemini: 'Puck' },         // 남성, 활기찬
  gm_achird: { gemini: 'Achird' },     // 남성, 친근한
  gm_kid: { gemini: 'Leda', kid: true },   // 젊은 목소리 + 아이 같은 톤 지시
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

// ---- Gemini TTS ----
// 24kHz 16-bit 모노 PCM(base64)으로 돌아오므로, 브라우저가 재생할 수 있게 WAV 헤더를 붙여 돌려줍니다.
function pcmToWav(pcm, rate = 24000) {
  const wav = new Uint8Array(44 + pcm.length);
  const v = new DataView(wav.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

// 응답 JSON 어디에 있든 base64 오디오(data 필드)를 찾아 돌려줍니다. (API 응답 모양 변경에 대비)
function findAudio(o) {
  if (!o || typeof o !== 'object') return null;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'data' && typeof v === 'string' && v.length > 100) return { data: v, mime: o.mimeType || o.mime_type || '' };
    const r = findAudio(v);
    if (r) return r;
  }
  return null;
}

const GEMINI_STYLE = 'Read the following Korean text clearly and naturally, in a calm and warm tone, pronouncing numbers and units accurately:';
const GEMINI_KID_STYLE = 'Read the following Korean text like a cheerful young child, with a bright, high-pitched voice, clearly:';

async function geminiTts({ voice, kid, text, env }) {
  if (!env.GEMINI_API_KEY) return json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았어요.' }, 501);
  const model = env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  const prompt = (kid ? GEMINI_KID_STYLE : GEMINI_STYLE) + '\n\n' + text;
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };

  // 1) generateContent 방식
  let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  // 2) 이 모델이 generateContent 를 지원하지 않으면 interactions 방식으로 재시도
  if (res.status === 400 || res.status === 404) {
    const retry = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: prompt,
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (retry.ok) res = retry;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'Gemini TTS 호출 실패 (' + res.status + ') ' + detail.slice(0, 200) }, 502);
  }

  const audio = findAudio(await res.json().catch(() => null));
  if (!audio) return json({ error: 'Gemini가 음성을 돌려주지 않았어요. 다시 시도해 주세요.' }, 502);
  const pcm = Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0));
  const rate = Number((/rate=(\d+)/.exec(audio.mime) || [])[1]) || 24000;
  return new Response(pcmToWav(pcm, rate), { headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=86400' } });
}

// ---- 음성 저장(캐시) ----
// 같은 목소리 + 같은 문장은 한 번만 합성하고 저장해 뒀다가 다시 돌려줍니다. (유료 API 재호출 방지)
// 저장 위치(위에서부터 우선):
//  1) Cloudflare R2: 버킷을 AUDIO_CACHE 라는 이름으로 연결했으면 영구 저장
//  2) Supabase Storage: R2가 없고 SUPABASE_URL + SUPABASE_SECRET_KEY 가 있으면 비공개 버킷(tts-cache)에 영구 저장 (버킷은 처음 쓸 때 자동 생성)
//  3) Cloudflare 엣지 캐시: 위 둘이 없을 때의 임시 저장 (지역별·보관 기간이 보장되지 않는 보조 수단)
// 저장 여부와 무관하게 로그인/한도 검사는 항상 먼저 거칩니다.
// ※ SUPABASE_SECRET_KEY 는 서버 전용 비밀 키입니다. 브라우저/config.js 에는 절대 넣지 마세요. (카드 첨부 업로드에도 쓰입니다)

const SB_BUCKET = 'tts-cache';
const sbKey = (env) => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY || '';
const sbReady = (env) => !!(env.SUPABASE_URL && sbKey(env));
const sbBase = (env) => env.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1';
// 새 방식 키(sb_secret_...)는 apikey 헤더로만, 예전 JWT 방식 키는 Authorization 도 함께 보냅니다.
function sbHeaders(env, extra = {}) {
  const k = sbKey(env);
  return k.startsWith('sb_') ? { apikey: k, ...extra } : { apikey: k, authorization: 'Bearer ' + k, ...extra };
}

async function sbGet(env, key) {
  const res = await fetch(`${sbBase(env)}/object/${SB_BUCKET}/${key}`, { headers: sbHeaders(env) });
  return res.ok ? { body: res.body, type: res.headers.get('content-type') || 'audio/mpeg', where: 'supabase' } : null;
}

async function sbPut(env, key, buf, type) {
  const upload = () => fetch(`${sbBase(env)}/object/${SB_BUCKET}/${key}`, {
    method: 'POST',
    headers: sbHeaders(env, { 'content-type': type, 'x-upsert': 'true' }),
    body: buf,
  });
  let res = await upload();
  if (res.status === 404 || res.status === 400) {
    // 버킷이 아직 없으면 비공개 버킷을 만들고 한 번 더 시도
    const made = await fetch(`${sbBase(env)}/bucket`, {
      method: 'POST',
      headers: sbHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id: SB_BUCKET, name: SB_BUCKET, public: false }),
    });
    if (made.ok || made.status === 409) res = await upload();
  }
}
const TTS_CACHE_VER = 'v1'; // 프롬프트·설정을 크게 바꿔 예전 음성을 버리고 싶을 때 올리세요.

async function ttsCacheKey(voice, text, env) {
  const variant = [TTS_CACHE_VER, JSON.stringify(voice), env.OPENAI_TTS_MODEL || '', env.GEMINI_TTS_MODEL || ''].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(variant + '\n' + text));
  return 'tts/' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const edgeKey = (key) => new Request('https://tts-cache.invalid/' + key);

async function cacheGet(env, key) {
  try {
    if (env.AUDIO_CACHE) {
      const obj = await env.AUDIO_CACHE.get(key);
      return obj ? { body: obj.body, type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'audio/mpeg', where: 'r2' } : null;
    }
    if (sbReady(env)) return await sbGet(env, key);
    const hit = await caches.default.match(edgeKey(key));
    return hit ? { body: hit.body, type: hit.headers.get('content-type') || 'audio/mpeg', where: 'edge' } : null;
  } catch { return null; } // 저장소 문제로 재생이 막히지 않게 무시
}

async function cachePut(env, key, buf, type) {
  try {
    if (env.AUDIO_CACHE) await env.AUDIO_CACHE.put(key, buf, { httpMetadata: { contentType: type } });
    else if (sbReady(env)) await sbPut(env, key, buf, type);
    else await caches.default.put(edgeKey(key), new Response(buf, { headers: { 'content-type': type, 'cache-control': 'public, max-age=2592000' } }));
  } catch { /* 저장 실패는 무시 */ }
}

async function handleTts({ request, env, ctx }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);

  let text, voiceId, warm;
  try { ({ text, voice: voiceId, warm } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  const voice = VOICES[voiceId] || { name: env.TTS_VOICE || VOICES.f1.name };
  if (!text || typeof text !== 'string') return json({ error: '텍스트가 비어 있어요.' }, 400);
  if (text.length > 1000) return json({ error: '한 번에 1,000자까지만 읽을 수 있어요.' }, 400);

  const key = await ttsCacheKey(voice, text, env);
  const hit = await cacheGet(env, key);

  // 미리 만들기(warm): 음성 파일은 돌려주지 않고, 저장본이 없으면 합성해서 저장만 합니다.
  if (warm) {
    if (hit) { try { await hit.body.cancel(); } catch { /* 이미 닫힘 */ } return json({ ok: true, cached: true }); }
    const made = await synthesize({ voice, text, env });
    if (!made.ok) return made;
    await cachePut(env, key, await made.arrayBuffer(), made.headers.get('content-type') || 'audio/mpeg');
    return json({ ok: true, cached: false });
  }

  if (hit) {
    return new Response(hit.body, { headers: { 'content-type': hit.type, 'cache-control': 'private, max-age=86400', 'x-tts-cache': 'hit-' + hit.where } });
  }

  const res = await synthesize({ voice, text, env });
  if (!res.ok) return res; // 오류 응답은 저장하지 않음

  const type = res.headers.get('content-type') || 'audio/mpeg';
  const buf = await res.arrayBuffer();
  const save = cachePut(env, key, buf, type);
  if (ctx && ctx.waitUntil) ctx.waitUntil(save); else await save;
  return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-tts-cache': 'miss' } });
}

async function synthesize({ voice, text, env }) {
  if (voice.openai) return openaiTts({ voice: voice.openai, kid: voice.kid, text, env });
  if (voice.gemini) return geminiTts({ voice: voice.gemini, kid: voice.kid, text, env });
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

// ---- /api/media/* : 카드 첨부(이미지·영상) → Supabase Storage ----
// 파일은 브라우저가 Supabase 로 직접 올립니다. (서버는 "이 경로에 올려도 된다"는 1회용 허가만 발급 → 큰 영상도 Cloudflare 를 거치지 않음)
// 버킷 card-media 는 공개 읽기(주소를 아는 사람만 볼 수 있도록 경로는 무작위 UUID)이고, 업로드는 이 서버가 발급한 허가로만 가능합니다.
const MEDIA_BUCKET = 'card-media';
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const MEDIA_PATH = /^\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,4}$/;

async function mediaEnsureBucket(env) {
  const res = await fetch(`${sbBase(env)}/bucket`, {
    method: 'POST',
    headers: sbHeaders(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ id: MEDIA_BUCKET, name: MEDIA_BUCKET, public: true, file_size_limit: MEDIA_MAX_BYTES, allowed_mime_types: Object.keys(MEDIA_TYPES) }),
  });
  return res.ok || res.status === 409; // 이미 있으면 그대로 사용
}

async function handleMediaSign({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  if (!sbReady(env)) return json({ error: '서버에 SUPABASE_URL / SUPABASE_SECRET_KEY가 설정되지 않았어요. (첨부 기능에 필요해요)' }, 501);

  let type, size;
  try { ({ type, size } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  const ext = MEDIA_TYPES[type];
  if (!ext) return json({ error: '지원하지 않는 형식이에요. (사진: JPG·PNG·GIF·WebP·AVIF, 영상: MP4·WebM·MOV)' }, 400);
  if (!(Number(size) > 0) || Number(size) > MEDIA_MAX_BYTES) return json({ error: `파일이 너무 커요. ${MEDIA_MAX_BYTES / 1048576}MB 이하로 올려 주세요.` }, 400);

  const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  const sign = () => fetch(`${sbBase(env)}/object/upload/sign/${MEDIA_BUCKET}/${path}`, { method: 'POST', headers: sbHeaders(env, { 'content-type': 'application/json' }), body: '{}' });
  let res = await sign();
  if (res.status === 404 || res.status === 400) { // 버킷이 아직 없으면 만들고 한 번 더
    if (await mediaEnsureBucket(env)) res = await sign();
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: '첨부 준비 실패 (' + res.status + ') ' + detail.slice(0, 160) }, 502);
  }
  const j = await res.json().catch(() => ({}));
  const token = new URL(j.url || j.signedUrl || '', 'https://placeholder.invalid').searchParams.get('token');
  if (!token) return json({ error: '업로드 허가를 받지 못했어요.' }, 502);
  return json({ path, token });
}

async function handleMediaDelete({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ error: auth.reason }, 401);
  if (!sbReady(env)) return json({ error: '서버에 SUPABASE_URL / SUPABASE_SECRET_KEY가 설정되지 않았어요.' }, 501);

  let paths;
  try { ({ paths } = await request.json()); } catch { return json({ error: '잘못된 요청이에요.' }, 400); }
  if (!Array.isArray(paths)) return json({ error: '잘못된 요청이에요.' }, 400);
  const valid = paths.filter((p) => typeof p === 'string' && MEDIA_PATH.test(p)).slice(0, 50); // 이 서버가 만든 형식의 경로만 삭제
  if (!valid.length) return json({ ok: true, deleted: 0 });

  const res = await fetch(`${sbBase(env)}/object/${MEDIA_BUCKET}`, {
    method: 'DELETE',
    headers: sbHeaders(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ prefixes: valid }),
  });
  if (!res.ok) return json({ error: '삭제 실패 (' + res.status + ')' }, 502);
  return json({ ok: true, deleted: valid.length });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      if (request.method !== 'POST') return json({ error: 'POST만 지원해요.' }, 405);
      if (pathname === '/api/tts') return handleTts({ request, env, ctx });
      if (pathname === '/api/stt') return handleStt({ request, env });
      if (pathname === '/api/media/sign') return handleMediaSign({ request, env });
      if (pathname === '/api/media/delete') return handleMediaDelete({ request, env });
      return json({ error: '없는 API예요.' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
