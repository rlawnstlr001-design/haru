// 앱(Capacitor) 안에서만 쓰는 기능. 웹에서는 isApp=false라 모두 웹 방식으로 대신한다.
// www 빌드 때 넣는 js/capacitor.js(코어)가 window.Capacitor를 만든다 — 트립N빵과 같은 구조.

const C = window.Capacitor;
export const isApp = !!C?.isNativePlatform?.();
export const platform = isApp ? C.getPlatform() : 'web';

const plug = (name) => (isApp ? C.registerPlugin(name) : null);
const Share = plug('Share');
const Haptics = plug('Haptics');
const App = plug('App');
const StatusBar = plug('StatusBar');
const Camera = plug('Camera');
const Push = plug('PushNotifications');
// 안드로이드 전용 네이티브 플러그인(MainActivity에 등록): 안부 알람
const Call = isApp && platform === 'android' ? plug('AnbuCall') : null;

export const callSupported = !!Call;
// { fullScreen } — 안드로이드 14+는 잠금 화면에 알람처럼 크게 띄우려면 사용자가 '전체 화면 알림'을 허용해야 한다
export async function callStatus() {
  if (!Call) return null;
  try { return await Call.status(); } catch { return null; }
}
export const openCallSettings = () => Call?.openFullScreenSettings().catch(() => {});
export const testCall = (hash) => Call?.test({ hash, delay: 5 }).catch(() => {});
// 홈 화면 안부 위젯 (안드로이드): 부모님 화면을 열 때 링크·이름·오늘 보냈는지 저장, 홈 화면에 놓기 요청
export const widgetSupported = !!Call;
export const saveWidget = (data) => Call?.saveWidget(data).catch(() => {});
export async function pinWidget() {
  if (!Call) return false;
  try { return (await Call.pinWidget()).ok; } catch { return false; }
}

// 공유 링크의 바탕 주소 — 앱 안 주소는 localhost라 실제 웹 주소로
export function siteBase() {
  if (isApp) return window.HARU_CONFIG.site;
  return location.href.split('#')[0];
}

export async function nativeShare({ text, url }) {
  if (!isApp) return false;
  try { await Share.share({ text, url, dialogTitle: '보내기' }); } catch { /* 닫음 */ }
  return true;
}

export function haptic(ms = 200) {
  if (isApp) {
    (platform === 'ios' ? Haptics.notification({ type: 'SUCCESS' }) : Haptics.vibrate({ duration: ms })).catch(() => {});
  } else {
    try { navigator.vibrate?.(ms); } catch { /* 지원 안 함 */ }
  }
}

// 사진: 앱은 카메라/앨범을 고르는 작은 창, 웹은 파일 선택창
// 10/19: 카메라 앱이 떠 있는 사이 안드로이드가 메모리를 확보하려고 우리 앱을 끄는 일이 있다(트립N빵에서 '앱이 종료'로 보고됨, 오류 기록 없음).
// 새 API(takePhoto·chooseFromGallery)는 다시 켜진 뒤 결과를 버리므로, appRestoredResult로 돌려주는 getPhoto를 쓴다 → restoredPhoto()
const photoBlob = async (r) => (r?.webPath ? (await fetch(r.webPath)).blob() : null);
export async function pickPhotoNative(source) {
  if (!isApp) return null;
  try {
    return await photoBlob(await Camera.getPhoto({
      source: source === 'camera' ? 'CAMERA' : 'PHOTOS', resultType: 'uri',
      quality: 75, width: 1600, height: 1600, correctOrientation: true, saveToGallery: false,
    }));
  } catch { return null; }
}
// 앱이 꺼졌다 다시 켜졌을 때, 꺼지기 전에 찍은 사진(없으면 null). App 플러그인이 듣는 쪽이 생길 때까지 붙잡아 둔다
export function restoredPhoto(ms = 1500) {
  if (!isApp) return Promise.resolve(null);
  return new Promise((resolve) => {
    let handle = null;
    const done = (v) => { clearTimeout(timer); handle?.remove?.(); resolve(v); };
    const timer = setTimeout(() => done(null), ms);
    Promise.resolve(App.addListener('appRestoredResult', async (r) => {
      if (r?.pluginId !== 'Camera' || !r.success) return done(null);
      try { done(await photoBlob(r.data)); } catch { done(null); }
    })).then((h) => { handle = h; });
  });
}

// 이 폰의 알림 허용 상태: 'granted' | 'denied' | 'prompt'(아직 안 물어봄) | 'unsupported'(웹·꺼 둠)
export async function pushPermission() {
  if (!isApp || !window.HARU_CONFIG?.push) return 'unsupported';
  try {
    const p = await Push.checkPermissions();
    return p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'prompt';
  } catch { return 'unsupported'; }
}

// 푸시 알림 등록 → 토큰을 서버에 저장.
// Firebase(google-services.json) 없이 register()를 부르면 안드로이드 앱이 죽으므로 config.js의 push 스위치로 막는다.
export async function registerPush(onToken) {
  if (!isApp) return 'unsupported';
  if (!window.HARU_CONFIG?.push) return 'off';
  try {
    let p = await Push.checkPermissions();
    if (p.receive !== 'granted') p = await Push.requestPermissions();
    if (p.receive !== 'granted') return 'denied';
    // 안드로이드: 전용 채널(중요도 최고 = 소리·진동·화면 위 팝업). 없으면 FCM "기타" 채널로 가서 갤럭시에선 조용히 온다
    // 잠금 화면: visibility 0(PRIVATE) = 휴대폰 설정이 '민감한 내용 숨기기'면 내용을 가린다 (10/7, 예전 채널은 1=항상 보임)
    // 안드로이드는 만든 채널 설정을 못 바꿔서 새 이름(anbu2)으로 만들고 예전 채널은 지운다. 서버(hb-push)도 anbu2로 보낸다
    if (platform === 'android') {
      await Push.createChannel({
        id: 'anbu2', name: '안부 알림', description: '부모님 안부 도착, 아직 소식 없음 알림',
        importance: 5, visibility: 0, vibration: true, lights: true, lightColor: '#D45D72',
      }).catch(() => {});
      // 밤 10시~아침 8시(이 휴대폰 시간)에 오는 알림 — 소리·진동 없이 알림창에만
      await Push.createChannel({
        id: 'anbu_quiet2', name: '안부 알림 (밤 시간)', description: '밤에는 소리 없이 조용히 와요',
        importance: 2, visibility: 0, vibration: false,
      }).catch(() => {});
      for (const id of ['anbu', 'anbu_quiet']) await Push.deleteChannel({ id }).catch(() => {});
    }
    await Push.addListener('registration', ({ value }) => onToken(value, platform));
    await Push.register();
    return 'requested';
  } catch { return 'unavailable'; }
}

// 상태 표시줄을 화면 테마와 맞춘다 — 다크 모드에서 위쪽 띠만 밝게 남던 문제 (10/7)
export function syncStatusBar() {
  if (!isApp) return;
  const forced = document.documentElement.dataset.theme;
  const dark = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}); // DARK = 어두운 바탕용 밝은 글씨
  if (platform === 'android') StatusBar.setBackgroundColor({ color: dark ? '#1B1A18' : '#F3EEE6' }).catch(() => {});
}

// 별점 요청(Play 인앱 리뷰) — 미리 묻지 않고 바로 띄운다(구글 정책). 한 기기에 한 번만. 스토어 설치본에서만 실제로 뜬다 (10/7)
const Review = plug('InAppReview');
export async function askReview(key) {
  if (!isApp || !Review) return false;
  try { if (localStorage.getItem(key)) return false; localStorage.setItem(key, String(Date.now())); } catch { return false; }
  try { await Review.requestReview(); return true; } catch { return false; }
}

export const exitApp = () => App?.exitApp();

// 딥링크(안부한장 링크로 앱 열기)·알림 탭·안드로이드 뒤로가기·앱으로 돌아옴·앱을 보는 중에 온 알림
export function initNative({ onOpenHash, onBack, onResume }) {
  if (!isApp) return;
  document.documentElement.classList.add('is-app', `is-${platform}`);
  syncStatusBar();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncStatusBar);
  // 링크의 #/… 로 이동. 웹의 '앱으로 열기'(intent://)는 해시가 빠질 수 있어 ?h=/p/… 로도 넘긴다
  const open = (url) => {
    try {
      const u = new URL(url);
      const h = u.hash || (u.searchParams.get('h') ? `#${u.searchParams.get('h')}` : '#/');
      onOpenHash(h);
    } catch { /* 무시 */ }
  };
  App.addListener('appUrlOpen', ({ url }) => open(url));
  App.getLaunchUrl().then((r) => r?.url && open(r.url)).catch(() => {});
  Push?.addListener('pushNotificationActionPerformed', ({ notification }) => {
    const h = notification?.data?.hash;
    if (h) onOpenHash(h);
  });
  // 앱을 보는 중에 알림이 오면 화면도 바로 새로 고친다
  Push?.addListener('pushNotificationReceived', () => onResume?.());
  App.addListener('resume', () => onResume?.());
  App.addListener('backButton', () => { if (!onBack()) App.exitApp(); });
}
