// 안부한장 — 트립N빵과 같은 Supabase 프로젝트(hb_ 테이블). 공개 키는 웹에 노출돼도 된다(권한은 RPC가 통제).
window.HARU_CONFIG = {
  supabaseUrl: 'https://nkmkqczahmwqjddzpeqr.supabase.co',
  supabaseAnonKey: 'sb_publishable_EkAloSEEewcCT4qyu6smSQ_gk4kDT_R',
  // 앱에서 공유하는 링크의 주소 (도메인 연결 후 https://anbuhanjang.com/ 으로 교체)
  site: 'https://rlawnstlr001-design.github.io/haru/',
  // 푸시 알림: android/app/google-services.json(Firebase) 있을 때만 true — 없이 켜면 안드로이드 앱이 죽는다
  push: true,
};
