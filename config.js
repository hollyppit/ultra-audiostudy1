// Supabase 대시보드 > Project Settings > API 에서 복사해 붙여넣으세요.
// anon 키는 공개용 키라 프론트엔드에 넣어도 됩니다. (service_role 키는 절대 넣지 마세요)
// 비워두면 브라우저 localStorage에만 저장하는 "로컬 모드"로 동작합니다.
// LOGIN_ENABLED: false 이면 로그인 없이 "로컬 모드"(이 브라우저에만 저장)로 동작합니다. (테스트용)
// 정식 오픈할 때 true 로 바꾸세요. 서버 쪽은 Cloudflare 환경변수 ALLOW_ANON 을 지우면 다시 로그인 필수가 됩니다.
window.APP_CONFIG = {
  LOGIN_ENABLED: false,
  SUPABASE_URL: "https://yblzmnfgybtdzlszifmb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_J9f7FHRuWxBzpH_OIi54IA_TfqfsJPP",
};
