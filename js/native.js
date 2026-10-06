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
export async function pickPhotoNative(source) {
  if (!isApp) return null;
  try {
    const opts = { quality: 75, targetWidth: 1600, targetHeight: 1600, correctOrientation: true };
    const r = source === 'camera'
      ? await Camera.takePhoto(opts)
      : (await Camera.chooseFromGallery({ ...opts, mediaType: 0, limit: 1 })).results?.[0];
    if (!r?.webPath) return null;
    return await (await fetch(r.webPath)).blob();
  } catch { return null; }
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
    if (platform === 'android') {
      await Push.createChannel({
        id: 'anbu', name: '안부 알림', description: '부모님 안부 도착, 아직 소식 없음 알림',
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#D45D72',
      }).catch(() => {});
      // 밤 10시~아침 8시(이 휴대폰 시간)에 오는 알림 — 소리·진동 없이 알림창에만
      await Push.createChannel({
        id: 'anbu_quiet', name: '안부 알림 (밤 시간)', description: '밤에는 소리 없이 조용히 와요',
        importance: 2, visibility: 1, vibration: false,
      }).catch(() => {});
    }
    await Push.addListener('registration', ({ value }) => onToken(value, platform));
    await Push.register();
    return 'requested';
  } catch { return 'unavailable'; }
}

export const exitApp = () => App?.exitApp();

// 딥링크(안부한장 링크로 앱 열기)·알림 탭·안드로이드 뒤로가기·앱으로 돌아옴·앱을 보는 중에 온 알림
export function initNative({ onOpenHash, onBack, onResume }) {
  if (!isApp) return;
  document.documentElement.classList.add('is-app', `is-${platform}`);
  StatusBar.setStyle({ style: 'LIGHT' }).catch(() => {});
  if (platform === 'android') StatusBar.setBackgroundColor({ color: '#F3EEE6' }).catch(() => {});
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
