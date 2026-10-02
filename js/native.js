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
    await Push.addListener('registration', ({ value }) => onToken(value, platform));
    await Push.register();
    return 'requested';
  } catch { return 'unavailable'; }
}

// 딥링크(안부한장 링크로 앱 열기)·알림 탭·안드로이드 뒤로가기
export function initNative({ onOpenHash, onBack }) {
  if (!isApp) return;
  document.documentElement.classList.add('is-app', `is-${platform}`);
  StatusBar.setStyle({ style: 'LIGHT' }).catch(() => {});
  if (platform === 'android') StatusBar.setBackgroundColor({ color: '#FFFBF3' }).catch(() => {});
  const open = (url) => { try { onOpenHash(new URL(url).hash || '#/'); } catch { /* 무시 */ } };
  App.addListener('appUrlOpen', ({ url }) => open(url));
  App.getLaunchUrl().then((r) => r?.url && open(r.url)).catch(() => {});
  Push?.addListener('pushNotificationActionPerformed', ({ notification }) => {
    const h = notification?.data?.hash;
    if (h) onOpenHash(h);
  });
  App.addListener('backButton', () => { if (!onBack()) App.exitApp(); });
}
