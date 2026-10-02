// 공용 도구 — 화면 문자열 이스케이프, 토스트, 복사·공유, 사진 압축

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('on'), ms);
}

export async function copy(text, msg = '복사했어요') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg);
}

// 휴대폰 공유창(카톡 등) → 안 되면 복사
export async function share({ text, url }, copiedMsg) {
  if (navigator.share) {
    try { await navigator.share({ text, url }); return true; } catch { /* 취소 → 복사 */ }
  }
  await copy(`${text}\n${url}`, copiedMsg);
  return false;
}

// 사진 고르기(웹): 카메라·앨범은 휴대폰이 알아서 보여준다
export function pickPhoto() {
  return new Promise((resolve) => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    i.onchange = () => resolve(i.files?.[0] || null);
    i.click();
  });
}

// 업로드 전에 긴 변 1600px JPEG로 줄인다 (2MB 한도·데이터 절약)
export async function compressImage(blob, max = 1600, quality = 0.75) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}

// "준식·민수" 처럼 이름 잇기
export const joinNames = (names) => names.join('·');

// 받침에 맞춰 조사: 이/가, 을/를, 은/는, 와/과
export function josa(word, pair) {
  const c = String(word).charCodeAt(String(word).length - 1);
  const has = c >= 0xAC00 && c <= 0xD7A3 ? (c - 0xAC00) % 28 !== 0 : false;
  const [a, b] = pair.split('/');
  return word + (has ? a : b);
}

export function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
}
