// 안부한장 데이터 계층 — Supabase RPC(테이블 직접 접근은 RLS로 차단) + 실시간 "바뀜" 신호
// 링크가 곧 권한: 가족 id(자녀용) / 부모 토큰(부모님 화면)

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ } },
};

export function uid(len = 12) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
export function deviceId() {
  let d = LS.get('haru:device');
  if (!d) { d = uid(12); LS.set('haru:device', d); }
  return d;
}

// 이 기기에서 각 가족의 "나"(자녀 member id)와 최근 가족 목록
export const me = {
  get: (fid) => LS.get(`haru:me:${fid}`),
  set: (fid, mid) => LS.set(`haru:me:${fid}`, mid),
};
export function rememberFamily(f) {
  const list = LS.get('haru:recent', []).filter((x) => x.id !== f.id);
  list.unshift({ id: f.id, parentName: f.parentName, at: Date.now() });
  LS.set('haru:recent', list.slice(0, 10));
}
export const recentFamilies = () => LS.get('haru:recent', []);
// 지운 가족 방은 이 폰의 '내 가족 방' 목록과 마지막 화면 기억에서도 뺀다
export function forgetFamily(fid) {
  LS.set('haru:recent', LS.get('haru:recent', []).filter((x) => x.id !== fid));
  try { localStorage.removeItem(`haru:me:${fid}`); if ((localStorage.getItem('haru:lastView') || '').includes(fid)) localStorage.removeItem('haru:lastView'); } catch { /* 저장 불가 */ }
}
// 이 휴대폰의 시간대 (해외 사는 자녀 → 밤에는 조용한 알림)
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

export class Store {
  #sb;
  #channels = new Map();
  #signed = new Map();
  constructor(sb) { this.#sb = sb; }

  async #rpc(fn, args) {
    const { data, error } = await this.#sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }
  #ping(fid) {
    this.#channels.get(fid)?.send({ type: 'broadcast', event: 'changed', payload: {} });
  }

  createFamily({ parentName, childName, deadline }) {
    return this.#rpc('hb_create_family', { p_parent_name: parentName, p_child_name: childName, p_deadline: deadline, p_device: deviceId() });
  }
  async getFamily(fid) {
    const f = await this.#rpc('hb_get_family', { p_family: fid });
    if (!f) throw new Error('가족 방을 찾을 수 없어요');
    rememberFamily(f);
    return f;
  }
  async join(fid, name) {
    const m = await this.#rpc('hb_join', { p_family: fid, p_name: name, p_device: deviceId() });
    this.#ping(fid);
    return m;
  }
  // 가족 방 설정 (바꾸지 않는 값은 비워 둔다). remindAt/remindOn = 부모님 폰 매일 알림
  async updateFamily(fid, { parentName, deadline, remindAt = null, remindOn = null, callOn = null }) {
    await this.#rpc('hb_update_family', {
      p_family: fid, p_parent_name: parentName || '', p_deadline: deadline || '', p_remind_at: remindAt, p_remind_on: remindOn,
      p_call_on: callOn,
    });
    this.#ping(fid);
  }
  // 부모님 폰 알림: 자녀가 '안부 부탁' → { pushed } (false면 부모님 폰이 아직 연결 안 됨 → 링크 공유)
  askParent(fid, memberId) {
    return this.#rpc('hb_ask_parent', { p_family: fid, p_member: memberId });
  }
  // 부모님 화면(앱)에서 '매일 알림 받기'
  registerParentPush(token, pushToken, platform) {
    return this.#rpc('hb_register_parent_push', { p_token: token, p_push: pushToken, p_platform: platform, p_tz: localTz() });
  }
  // 부모님 화면 '안부 알람 받기' — 이 폰(알림 토큰)에만 켜고 끈다
  parentCallOpt(token, pushToken, on) {
    return this.#rpc('hb_parent_call_opt', { p_token: token, p_push: pushToken, p_on: on });
  }
  // 가족 방 지우기 — 형제·부모님 모두에게서 사라진다 (hb_011)
  async deleteFamily(fid, memberId) {
    await this.#rpc('hb_delete_family', { p_family: fid, p_member: memberId });
    this.#ping(fid);
  }
  async unlinkParent(fid, memberId) {
    await this.#rpc('hb_unlink_parent', { p_family: fid, p_member: memberId });
    this.#ping(fid);
  }
  async parentView(token) {
    const v = await this.#rpc('hb_parent_view', { p_token: token });
    if (!v) throw new Error('링크가 올바르지 않아요. 자녀에게 다시 받아 주세요');
    return v;
  }
  async checkin(token, fid, { mood, message, photo }) {
    const r = await this.#rpc('hb_checkin', { p_token: token, p_mood: mood || '', p_message: message || '', p_photo: photo || '' });
    this.#ping(fid);
    return r;
  }
  async heart(fid, checkinId, memberId) {
    const on = await this.#rpc('hb_heart', { p_family: fid, p_checkin: checkinId, p_member: memberId });
    this.#ping(fid);
    return on;
  }
  // 가족 이야기: 자녀 → 부모님 한마디·사진 (형제도 같이 본다)
  async addNote(fid, memberId, { message, photo }) {
    const r = await this.#rpc('hb_add_note', { p_family: fid, p_member: memberId, p_message: message || '', p_photo: photo || '' });
    this.#ping(fid);
    return r;
  }
  async deleteNote(fid, memberId, noteId) {
    await this.#rpc('hb_delete_note', { p_family: fid, p_member: memberId, p_note: noteId });
    this.#ping(fid);
  }
  async parentHeart(token, fid, noteId) {
    const on = await this.#rpc('hb_parent_heart', { p_token: token, p_note: noteId });
    this.#ping(fid);
    return on;
  }
  async registerPush(fid, memberId, token, platform) {
    try {
      await this.#rpc('hb_register_push', { p_family: fid, p_member: memberId, p_token: token, p_platform: platform, p_tz: localTz() });
    } catch { /* 다음 실행 때 다시 */ }
  }
  // 내 이름·알림 설정 (바꾸지 않는 값은 null)
  async updateMember(fid, memberId, { name = null, notifyCheckin = null, notifyLate = null } = {}) {
    await this.#rpc('hb_update_member', {
      p_family: fid, p_member: memberId, p_name: name, p_notify_checkin: notifyCheckin, p_notify_late: notifyLate, p_tz: localTz(),
    });
    this.#ping(fid);
  }
  async log(fid, type) {
    try { await this.#rpc('hb_log_event', { p_family: fid, p_type: type, p_device: deviceId() }); } catch { /* 지표 실패는 무시 */ }
  }

  async uploadPhoto(fid, blob) {
    const path = `${fid}/${uid(14)}.jpg`;
    const { error } = await this.#sb.storage.from('haru-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new Error(error.message);
    return path;
  }
  // 사진 주소: Edge Function `media`가 가족 방을 확인하고 1시간짜리 서명 주소를 준다.
  // (Storage 읽기를 공개 키에 열어 두면 버킷 목록 = 가족 id가 밖에서 보여서 막았다 — 10/6)
  async photoUrls(paths) {
    const now = Date.now();
    const out = {};
    const need = new Map(); // 가족 id → 경로들
    for (const p of paths) {
      const hit = this.#signed.get(p);
      if (hit && hit.exp > now) { out[p] = hit.url; continue; }
      const scope = p.split('/')[0];
      need.set(scope, [...(need.get(scope) || []), p]);
    }
    for (const [scope, list] of need) {
      for (let i = 0; i < list.length; i += 50) {
        const { data, error } = await this.#sb.functions.invoke('media', { body: { bucket: 'haru-photos', scope, paths: list.slice(i, i + 50) } });
        if (error) throw new Error('사진을 불러오지 못했어요');
        for (const [p, url] of Object.entries(data?.urls || {})) {
          this.#signed.set(p, { url, exp: now + 50 * 60 * 1000 });
          out[p] = url;
        }
      }
    }
    return out;
  }
  async photoUrl(path) {
    const url = (await this.photoUrls([path]))[path];
    if (!url) throw new Error('사진을 불러오지 못했어요');
    return url;
  }

  subscribe(fid, cb) {
    const ch = this.#sb.channel(`hb:${fid}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'changed' }, () => cb()).subscribe();
    this.#channels.set(fid, ch);
    return () => { this.#sb.removeChannel(ch); this.#channels.delete(fid); };
  }
}

export async function createStore(config) {
  // 스토어 스크린샷용 가상 데이터 — tools/store-shots/shot.html(같은 출처의 부모 창)이 넣어 준다. 실서버를 건드리지 않는다
  try { if (window.parent !== window && window.parent.HARU_DEMO_STORE) return window.parent.HARU_DEMO_STORE; } catch { /* 다른 출처 */ }
  // 앱은 js/supabase.js(빌드 때 내장)가 window.supabase를 만든다 → 인터넷 없이 켜도 화면이 뜬다. 웹은 CDN
  const { createClient } = window.supabase?.createClient ? window.supabase
    : await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return new Store(createClient(config.supabaseUrl, config.supabaseAnonKey));
}
