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
  async updateFamily(fid, { parentName, deadline }) {
    await this.#rpc('hb_update_family', { p_family: fid, p_parent_name: parentName || '', p_deadline: deadline || '' });
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
  async registerPush(fid, memberId, token, platform) {
    try { await this.#rpc('hb_register_push', { p_family: fid, p_member: memberId, p_token: token, p_platform: platform }); } catch { /* 다음 실행 때 다시 */ }
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
  async photoUrl(path) {
    const hit = this.#signed.get(path);
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await this.#sb.storage.from('haru-photos').createSignedUrl(path, 3600);
    if (error) throw new Error(error.message);
    this.#signed.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  subscribe(fid, cb) {
    const ch = this.#sb.channel(`hb:${fid}`, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'changed' }, () => cb()).subscribe();
    this.#channels.set(fid, ch);
    return () => { this.#sb.removeChannel(ch); this.#channels.delete(fid); };
  }
}

export async function createStore(config) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return new Store(createClient(config.supabaseUrl, config.supabaseAnonKey));
}
