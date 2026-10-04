// 안부한장 — 트립N빵과 같은 Supabase 프로젝트(hb_ 테이블). 공개 키는 웹에 노출돼도 된다(권한은 RPC가 통제).
window.HARU_CONFIG = {
  supabaseUrl: 'https://nkmkqczahmwqjddzpeqr.supabase.co',
  supabaseAnonKey: 'sb_publishable_EkAloSEEewcCT4qyu6smSQ_gk4kDT_R',
  // 앱에서 공유하는 링크의 주소 (10/3 도메인 연결)
  site: 'https://anbuhanjang.com/',
  // 푸시 알림: android/app/google-services.json(Firebase) 있을 때만 true — 없이 켜면 안드로이드 앱이 죽는다
  push: true,
  // 스토어 주소 — 정식 출시되면 채운다. 비어 있으면 소개 페이지에 '출시 준비 중'으로 보인다
  stores: { android: '', ios: '' },
};
