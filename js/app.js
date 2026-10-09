// 안부한장 — 화면 (해시 라우팅)
//  (주소만)      소개 페이지 — 웹에서만, index.html에 정적으로 들어 있다 (앱은 건너뜀)
//  #/ · #/start  홈: 가족 방 만들기 · 최근 방
//  #/f/<가족id>  자녀 화면: 부모님의 오늘, 7일, 하트, 형제 초대, 안부 부탁
//  #/f/<가족id>/s 설정: 부모님 호칭·마감, 내 이름·알림
//  #/p/<토큰>    부모님 화면: 큰 버튼 하나 + 사진·한마디(선택) + 받은 하트
import { createStore, me, recentFamilies, localTz, forgetFamily } from './store.js?v=202610091345';
import { esc, toast, friendly, share as webShare, pickPhoto, compressImage, joinNames, josa, timeLabel } from './util.js?v=202610091345';
import {
  isApp, siteBase, nativeShare, haptic, pickPhotoNative, registerPush, initNative, exitApp, pushPermission, askReview,
  callSupported, callStatus, openCallSettings, testCall,
} from './native.js?v=202610091345';

const $app = document.getElementById('app');
let store;
let unsub = null;

// ───────── 새 소식 반영 ─────────
// 가족·부모님 화면은 view()로 다시 그린다. 실시간 신호·앱으로 돌아옴·알림 도착·1분마다·당겨서 새로고침이 부른다.
// 글을 쓰는 중이면(입력칸에 커서) 다 쓰고 나갈 때까지 미룬다. 쓰던 글·고른 사진은 drafts에 남아 다시 그려도 그대로다.
let view = null;
let lastRender = 0;
let pendingRefresh = false;
let trail = null;
let refreshing = null;
const drafts = new Map();
const typing = () => { const a = document.activeElement; return !!a && $app.contains(a) && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName); };
function refreshView({ force = false } = {}) {
  if (!view) return Promise.resolve();
  if (!force && typing()) { pendingRefresh = true; return Promise.resolve(); }
  const wait = 1500 - (Date.now() - lastRender);
  if (!force && wait > 0) { clearTimeout(trail); trail = setTimeout(() => refreshView(), wait); return Promise.resolve(); }
  if (refreshing) return refreshing;
  pendingRefresh = false;
  const y = scrollY;
  bgRefresh = !force;
  refreshing = view().then(() => scrollTo(0, y)).catch(() => {}).finally(() => { refreshing = null; bgRefresh = false; });
  return refreshing;
}
// 저절로 새로고침(1분마다·실시간 신호·앱으로 돌아옴)일 때, 받은 내용이 지난번과 같으면 화면을 다시 그리지 않는다 (10/7)
let bgRefresh = false;
let lastSig = '';
function unchanged(key, data) {
  const sig = key + JSON.stringify(data);
  const same = bgRefresh && sig === lastSig;
  lastSig = sig;
  return same;
}

// 당겨서 새로고침 (화면 맨 위에서 아래로 끌기)
function initPullToRefresh() {
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.textContent = '↻';
  document.body.append(ind);
  let y0 = null;
  addEventListener('touchstart', (e) => {
    y0 = (view && scrollY <= 0 && e.touches.length === 1 && !document.querySelector('.photo-viewer')) ? e.touches[0].clientY : null;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const d = Math.max(0, Math.min((e.touches[0].clientY - y0) * 0.5, 90));
    ind.style.transform = `translate(-50%, ${d}px) rotate(${d * 4}deg)`;
    ind.classList.toggle('ready', d >= 60);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (ind.classList.contains('ready')) {
      ind.classList.add('spin');
      await refreshView({ force: true });
      ind.classList.remove('spin');
      toast('최신 소식이에요', 1400);
    }
    ind.classList.remove('ready');
    ind.style.transform = '';
  });
}

// 마지막으로 본 가족·부모님 화면 (앱을 아이콘으로 켜면 거기서 시작)
const LAST_KEY = 'haru:lastView';
const rememberView = (h) => { try { localStorage.setItem(LAST_KEY, h); } catch { /* 저장 불가 */ } };
const lastView = () => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };

// 안드로이드 뒤로가기: 앱 안에서 이동한 만큼만 뒤로, 첫 화면에서는 "한 번 더 누르면 종료"
let depth = 0;
let replacing = false;
let backAt = 0;
const replaceHash = (h) => { replacing = true; location.replace(h); };
function onHashChange() {
  const d = history.state?.d;
  if (replacing) { replacing = false; history.replaceState({ d: depth }, ''); }
  else if (typeof d === 'number') depth = d;
  else { depth += 1; history.replaceState({ d: depth }, ''); }
  route();
}
function onBack() {
  const v = document.querySelector('.photo-viewer');
  if (v) { v.remove(); return true; }
  if (depth > 0) { history.back(); return true; }
  if (Date.now() - backAt < 2000) { exitApp(); return true; }
  backAt = Date.now();
  toast('한 번 더 누르면 종료돼요', 2000);
  return true;
}

// 사진과 한마디를 한 번에 보내는 입력칸 (부모님·자녀 공용). big = 부모님용 큰 버튼
function composerHtml({ id, label, placeholder, maxlength, big = false }) {
  const cls = big ? 'big-btn' : 'cmp-add';
  const photoBtns = isApp
    ? `<button type="button" class="${cls}" data-src="camera">📷 사진 찍기</button><button type="button" class="${cls}" data-src="gallery">🖼 앨범에서</button>`
    : `<button type="button" class="${cls}" data-src="any">📷 사진 ${big ? '고르기' : '넣기'}</button>`;
  return `<form class="composer ${big ? 'big' : ''}" id="${id}">
    ${label ? `<label class="cmp-label" for="${id}-m">${label}</label>` : ''}
    <div class="cmp-preview" hidden><img alt="보낼 사진"><button type="button" class="cmp-x" aria-label="사진 빼기">✕</button></div>
    <textarea id="${id}-m" name="m" maxlength="${maxlength}" rows="2" placeholder="${esc(placeholder)}"></textarea>
    <div class="cmp-row ${isApp ? 'two' : ''}">${photoBtns}</div>
    <p class="cmp-hint" hidden>사진을 넣었어요. 한마디를 적거나 바로 <b>보내기</b>를 눌러 주세요</p>
    <button class="btn primary block cmp-send">보내기</button>
  </form>`;
}
// onSend({message, photo}) → 성공하면 true
function bindComposer(form, { folder, onSend }) {
  const key = `${location.hash}|${form.id}`;
  let d = drafts.get(key) || { text: '', blob: null };
  drafts.set(key, d);
  const prev = form.querySelector('.cmp-preview');
  const hint = form.querySelector('.cmp-hint');
  let url = null;
  const show = () => {
    if (url) URL.revokeObjectURL(url);
    url = d.blob ? URL.createObjectURL(d.blob) : null;
    prev.hidden = !d.blob;
    hint.hidden = !d.blob;
    if (url) prev.querySelector('img').src = url;
    form.classList.toggle('has-photo', !!d.blob);
  };
  form.m.value = d.text;
  show();
  form.m.addEventListener('input', () => { d.text = form.m.value; });
  form.querySelectorAll('[data-src]').forEach((b) => {
    b.onclick = async () => {
      const raw = b.dataset.src === 'any' ? await pickPhoto() : await pickPhotoNative(b.dataset.src);
      if (!raw) return;
      try { d.blob = await compressImage(raw); } catch { return toast('사진을 열지 못했어요'); }
      show();
      form.querySelector('.cmp-send').scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
  });
  prev.querySelector('.cmp-x').onclick = () => { d.blob = null; show(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const message = form.m.value.trim();
    if (!message && !d.blob) return toast('한마디를 적거나 사진을 넣어 주세요');
    const btn = form.querySelector('.cmp-send');
    btn.disabled = true;
    let photo = '';
    if (d.blob) {
      try { toast('사진 올리는 중…', 8000); photo = await store.uploadPhoto(folder, d.blob); }
      catch { btn.disabled = false; return toast('사진을 보내지 못했어요. 다시 해 주세요'); }
    }
    const saved = d;
    drafts.delete(key); // 보내고 나서 다시 그리는 화면은 빈 칸으로
    if (!(await onSend({ message, photo }))) { drafts.set(key, saved); btn.disabled = false; }
  };
}
const sentLabel = ({ message, photo }) => (photo && message ? '사진과 한마디' : photo ? '사진' : '한마디');
// "오늘" / "어제" / "10/2"
function dayWord(day, today) {
  if (day === today) return '오늘';
  const d = new Date(`${today}T12:00:00+09:00`);
  d.setDate(d.getDate() - 1);
  return day === d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) ? '어제' : day.slice(5).replace('-', '/');
}

const MOODS = [
  { id: 'good', emoji: '😊', label: '좋아요' },
  { id: 'ok', emoji: '🙂', label: '그럭저럭' },
  { id: 'tired', emoji: '😮‍💨', label: '피곤해요' },
];
const moodOf = (id) => MOODS.find((m) => m.id === id);
const base = siteBase;
// 앱이면 휴대폰 공유창, 웹이면 브라우저 공유 → 복사
const share = async (p, msg) => (await nativeShare(p)) || webShare(p, msg);
const familyLink = (fid) => `${base()}#/f/${fid}`;
const parentLink = (tok) => `${base()}#/p/${tok}`;

// 한국 시각 기준 "지금 몇 시 몇 분" (마감 판단용)
const awayFromKorea = () => { const tz = localTz(); return !!tz && tz !== 'Asia/Seoul'; };
function kstNowMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = p.split(':').map(Number);
  return h * 60 + m;
}
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
// "10월 3일 토요일" (한국 날짜 기준)
const dateLabel = (iso) => new Date(`${iso}T12:00:00+09:00`).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Seoul' });
const AVATAR_COLORS = ['#2F4260', '#D45D72', '#5C8A70', '#B97A22', '#7A5C99', '#3C7A89'];
// 마감 시각 고르기 (오전 7시 ~ 오후 9시)
function deadlineOptions(selected = '12:00') {
  const hours = Array.from({ length: 15 }, (_, i) => i + 7);
  const opts = hours.map((h) => `${String(h).padStart(2, '0')}:00`);
  if (!opts.includes(selected)) opts.push(selected);
  return opts.sort().map((v) => {
    const [h, m] = v.split(':').map(Number);
    const label = `${h < 12 ? '오전' : '오후'} ${h > 12 ? h - 12 : h}시${m ? ` ${m}분` : ''}`;
    return `<option value="${v}" ${v === selected ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

// ───────── 라우터 ─────────
async function route() {
  if (unsub) { unsub(); unsub = null; }
  view = null;
  const h = location.hash.slice(1);
  const landing = !isApp && !h.startsWith('/');
  const wasLanding = document.documentElement.classList.contains('landing');
  document.documentElement.classList.toggle('landing', landing);
  if (landing) return renderLanding();
  if (wasLanding) scrollTo(0, 0);
  let m;
  try {
    if ((m = h.match(/^\/f\/([\w-]+)\/s$/))) return await renderSettings(m[1]);
    if ((m = h.match(/^\/f\/([\w-]+)/))) return await renderFamily(m[1]);
    if ((m = h.match(/^\/p\/([\w-]+)/))) return await renderParent(m[1]);
    renderHome();
  } catch (e) {
    errorScreen(e, !h.startsWith('/p/'));
  }
}

// 화면을 못 불러왔을 때 — 무엇이 문제인지 한국어로, 다시 시도 버튼 (부모님 화면에선 '처음으로'를 빼서 헷갈리지 않게)
function errorScreen(err, home = true) {
  $app.innerHTML = `<div class="empty err-screen" role="alert"><p>${esc(friendly(err))}</p>
    <button class="btn primary" id="retry">다시 시도</button>${home ? '<p><a href="#/">처음으로</a></p>' : ''}</div>`;
  $app.querySelector('#retry').onclick = () => route();
}

// ───────── 소개 페이지 (웹) ─────────
// 본문은 index.html에 정적으로 있다(검색 노출용). 여기선 최근 방 바로가기와 스토어 버튼만 채운다.
function renderLanding() {
  const recent = recentFamilies();
  const $r = document.getElementById('lp-recent');
  if ($r && recent.length) {
    $r.innerHTML = `내 가족 방: ${recent.slice(0, 3).map((f) => `<a href="#/f/${esc(f.id)}">${esc(f.parentName)}의 하루</a>`).join(' · ')}`;
    $r.hidden = false;
  }
  const st = window.HARU_CONFIG.stores || {};
  const $s = document.getElementById('lp-store');
  if ($s && (st.android || st.ios)) {
    $s.innerHTML = [st.android && `<a class="btn" href="${esc(st.android)}" rel="noopener">Google Play에서 받기</a>`,
      st.ios && `<a class="btn" href="${esc(st.ios)}" rel="noopener">App Store에서 받기</a>`].filter(Boolean).join('');
    $s.classList.add('has-links');
  }
}

// ───────── 홈 ─────────
function renderHome() {
  const recent = recentFamilies();
  $app.innerHTML = `
    <header class="home-top"><span class="wordmark">안부한장</span><span class="beta">베타</span></header>
    <section class="cover">
      <div class="stack-art" aria-hidden="true"><i>🌼</i><i>☕</i><i>💛</i></div>
      <h1>부모님의 오늘,<br>한 장으로 받아보세요</h1>
      <p>부모님은 받은 링크에서 버튼 한 번, 사진 한 장으로 안부를 보내세요. 형제들도 같이 봐요.</p>
    </section>
    <form class="letter-card" id="create">
      <h2>가족 방 만들기</h2>
      <div class="field"><span>부모님을 뭐라고 부르세요?</span>
        <div class="chips" id="pn">${['엄마', '아빠', '어머니', '아버지'].map((n) => `<button type="button" class="chip" data-pn="${n}">${n}</button>`).join('')}</div>
        <input class="input" name="parentName" maxlength="20" placeholder="직접 입력 (예: 우리 엄마)" required></div>
      <label class="field"><span>내 이름</span><input class="input" name="childName" maxlength="20" placeholder="예: 준식" required></label>
      <label class="field"><span>이 시각까지 소식이 없으면 알려 드려요 (한국 시간)</span>
        <select class="input" name="deadline">${deadlineOptions('12:00')}</select></label>
      <button class="btn primary block">가족 방 만들기</button>
    </form>
    ${recent.length ? `<section class="block"><h2>내 가족 방</h2><div class="list-card list">${recent.map((f) =>
      `<a href="#/f/${esc(f.id)}"><span>${esc(f.parentName)}의 하루</span><span class="muted">›</span></a>`).join('')}</div></section>` : ''}
    <p class="foot"><a href="privacy.html">개인정보처리방침</a></p>`;

  const form = $app.querySelector('#create');
  $app.querySelectorAll('[data-pn]').forEach((b) => {
    b.onclick = () => {
      form.parentName.value = b.dataset.pn;
      $app.querySelectorAll('[data-pn]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    };
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await store.createFamily({
        parentName: form.parentName.value.trim(), childName: form.childName.value.trim(), deadline: form.deadline.value,
      });
      me.set(r.id, r.memberId);
      sessionStorage.setItem(`haru:fresh:${r.id}`, '1');
      location.hash = `#/f/${r.id}`;
    } catch (err) { toast(friendly(err)); btn.disabled = false; }
  };
}

// ───────── 자녀 화면 ─────────
async function renderFamily(fid) {
  const f = await store.getFamily(fid);
  if (!location.hash.startsWith(`#/f/${fid}`) || location.hash.endsWith('/s')) return; // 불러오는 사이 다른 화면으로 갔다
  const myId = me.get(fid);
  const mine = f.members.find((m) => m.id === myId);
  if (!mine) return renderJoin(f);
  if (unchanged(`f:${fid}:${myId}:${kstNowMinutes() > toMinutes(f.deadline)}`, f)) { lastRender = Date.now(); return; }

  if (!sessionStorage.getItem(`haru:opened:${fid}`)) { sessionStorage.setItem(`haru:opened:${fid}`, '1'); store.log(fid, 'family_opened'); }
  if (!unsub) unsub = store.subscribe(fid, () => refreshView());
  view = () => renderFamily(fid);
  lastRender = Date.now();
  rememberView(`#/f/${fid}`);

  const P = f.parentName;
  const KST = awayFromKorea() ? '(한국 시간)' : ''; // 해외에 사는 자녀: 마감은 한국 시간 기준
  const today = f.checkins.filter((c) => c.day === f.today);
  // 방을 만든 날은 마감 경고를 하지 않는다 (부모님이 링크를 받기도 전이라)
  const createdToday = new Date(f.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) === f.today;
  const late = !today.length && !createdToday && kstNowMinutes() > toMinutes(f.deadline);
  // 최근 7일 소식이 없으면(서버도 '늦음' 알림을 멈춘다) 걱정 대신 링크를 다시 보내 보자는 안내
  const weekAgo = new Date(`${f.today}T12:00:00Z`); weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const quiet = f.checkins.length > 0 && !f.checkins.some((c) => c.day >= weekAgo.toISOString().slice(0, 10));
  const fresh = !f.checkins.length; // 부모님이 처음 안부를 보내실 때까지 '처음 할 일' 안내를 남긴다
  // 날짜 계산은 정오(UTC) 기준 — 폰이 미국·베트남 시간이어도 요일이 밀리지 않게
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${f.today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (6 - i));
    const iso = d.toISOString().slice(0, 10);
    return { iso, label: '일월화수목금토'[d.getUTCDay()], ok: f.checkins.some((c) => c.day === iso), isToday: iso === f.today };
  });
  const past = f.checkins.filter((c) => c.day !== f.today);
  // 가족 이야기: 최근 3일 (오늘·어제·그제)
  const talk = (f.notes || []).filter((n) => Date.parse(`${f.today}T00:00:00+09:00`) - Date.parse(`${n.day}T00:00:00+09:00`) <= 2 * 86400000);
  let lastDay = '';
  const talkHtml = talk.map((n) => {
    const head = n.day !== lastDay ? `<p class="talk-day">${dayWord(n.day, f.today)}</p>` : '';
    lastDay = n.day;
    return head + noteBubble(n, f, myId);
  }).join('');

  $app.innerHTML = `
    <header class="mast">
      <a class="icon-btn" href="#/" aria-label="처음으로">←</a>
      <span class="wordmark">안부한장</span>
      <a class="icon-btn" href="#/f/${esc(fid)}/s" aria-label="설정">⚙</a>
    </header>
    <section class="day-head">
      <p class="date">${esc(dateLabel(f.today))}</p>
      <h1>${esc(P)}의 오늘</h1>
    </section>

    ${fresh ? `<section class="letter-card setup">
      <p class="kicker">처음 할 일</p>
      <h2>${esc(P)}께 안부 링크를 보내 주세요</h2>
      <p>${esc(josa(P, '이/가'))} 링크를 누르시면 버튼 한 번, 사진 한 장으로 바로 안부를 보내실 수 있어요.</p>
      <button class="btn primary block" id="send-parent">💌 ${esc(P)}께 링크 보내기</button>
      <button class="btn ghost block" id="invite">👨‍👩‍👧 형제 초대하기</button>
    </section>` : ''}

    <div id="push-card"></div>
    ${kakaoBarHtml()}
    <section class="today-wrap">
      ${today.length ? today.map((c) => todayCard(c, f, myId)).join('')
        : quiet ? `<article class="polaroid">
            <div class="face empty"><span class="e">💌</span></div>
            <div class="caption">
              <p class="note">최근 7일 동안 소식이 없었어요</p>
              <p class="muted small">링크를 잃어버리셨을 수도 있어요. ${esc(P)}께 링크를 다시 보내 드려 볼까요? 그동안 '아직 소식 없음' 알림은 쉬어요</p>
            </div>
          </article>
          <button class="btn block" id="send-parent3">💌 ${esc(P)}께 링크 다시 보내기</button>`
        : `<article class="polaroid ${late ? 'late' : ''}">
            <div class="face empty"><span class="e">${late ? '📞' : '🌤'}</span></div>
            <div class="caption">
              <p class="note">${late ? `${esc(josa(P, '이/가'))} 아직 소식이 없어요` : '오늘의 한 장을 기다리는 중이에요'}</p>
              <p class="muted small">${late ? `마감 ${esc(f.deadline)}${KST}이 지났어요. 전화 한 통 어떠세요?` : `마감 ${esc(f.deadline)}${KST} · 부탁하면 대부분 금방 보내 주세요`}</p>
            </div>
          </article>
          <button class="btn primary block" id="ask">${f.parentDevices ? `📳 ${esc(P)} 폰으로 안부 부탁하기` : '💌 오늘 안부 부탁하기'}</button>
          ${callClaimHtml(f, myId, late)}
          <p class="muted small parent-state">${f.parentDevices
            ? `📱 ${esc(P)} 폰에 앱이 연결돼 있어요${f.parentCallDevices ? ' · 안부 알람 켜짐' : ''}`
            : `📱 ${esc(P)} 폰에 앱이 아직 없어 링크로 부탁해요. <a href="#/f/${esc(fid)}/s">연결 방법</a>`}</p>`}
    </section>

    <section class="block talk">
      <h2>가족 이야기<span>${esc(P)}도 같이 봐요</span></h2>
      ${talkHtml || `<p class="muted small talk-empty">${esc(P)}께 오늘 이야기를 남겨 보세요. 사진도 같이 보낼 수 있어요.</p>`}
      ${composerHtml({ id: 'note', placeholder: `${P}께 한마디 (형제들도 같이 봐요)`, maxlength: 200 })}
    </section>

    <section class="block">
      <h2>이번 주<span>7일 중 ${days.filter((d) => d.ok).length}일 소식</span></h2>
      <div class="stamps">${days.map((d) => `<div class="stamp ${d.ok ? 'ok' : ''} ${d.isToday ? 'today' : ''}"><i>${d.ok ? '✓' : ''}</i><span>${d.label}</span></div>`).join('')}</div>
      <button class="pill week-share" id="week-share">📤 이번 주 소식 형제들과 공유</button>
    </section>

    ${past.length ? `<section class="block"><h2>지난 소식</h2><div class="album">${past.slice(0, 20).map((c) => miniCard(c, f, myId)).join('')}</div></section>` : ''}

    <section class="block">
      <h2>함께 보는 가족<span>${f.members.length}명</span></h2>
      <div class="avatars">${f.members.map((m, i) => `<div class="avatar"><i style="--c:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${esc([...m.name][0] || '?')}</i><span>${esc(m.name)}${m.id === myId ? ' (나)' : ''}</span></div>`).join('')}</div>
      <div class="pill-row">
        <button class="pill" id="invite2">👨‍👩‍👧 형제 초대</button>
        <button class="pill" id="send-parent2">💌 ${esc(P)} 링크 다시 보내기</button>
      </div>
    </section>
    <p class="foot">안부한장 · <a href="privacy.html">개인정보처리방침</a></p>`;

  const sendParent = () => {
    store.log(fid, 'parent_link_shared');
    sessionStorage.removeItem(`haru:fresh:${fid}`);
    share({ text: `${P}! 이제 매일 이 링크로 안부 보내 주세요 💛\n버튼 한 번이면 돼요. 사진도 보낼 수 있어요.`, url: parentLink(f.parentToken) },
      '링크를 복사했어요. 카톡에 붙여 넣으세요');
  };
  const invite = () => {
    store.log(fid, 'invite_shared');
    share({ text: `${P}의 하루를 같이 봐요 💛 (안부한장)`, url: familyLink(fid) }, '초대 링크를 복사했어요');
  };
  $app.querySelector('#send-parent')?.addEventListener('click', sendParent);
  $app.querySelector('#send-parent2')?.addEventListener('click', sendParent);
  $app.querySelector('#send-parent3')?.addEventListener('click', sendParent);
  $app.querySelector('#invite')?.addEventListener('click', invite);
  $app.querySelector('#invite2')?.addEventListener('click', invite);
  // 이번 주 요약을 형제 단톡방에 (가족 방 링크와 함께 — 아직 안 들어온 형제도 들어오게)
  $app.querySelector('#week-share')?.addEventListener('click', () => {
    const weekStart = days[0].iso;
    const okDays = days.filter((d) => d.ok).length;
    const photos = f.checkins.filter((c) => c.day >= weekStart && c.photo).length;
    const talks = (f.notes || []).filter((n) => n.day >= weekStart).length;
    const stamps = days.map((d) => `${d.label}${d.ok ? '✓' : '·'}`).join(' ');
    store.log(fid, 'week_shared');
    share({ text: `📮 ${P}의 이번 주\n7일 중 ${okDays}일 안부 · 사진 ${photos}장 · 가족 이야기 ${talks}개\n${stamps}\n(안부한장)`, url: familyLink(fid) },
      '이번 주 요약을 복사했어요. 형제 단톡방에 붙여 넣으세요');
  });
  // 내가 전화드릴게요 — 형제 화면에 보여서 전화가 겹치거나 비지 않게
  const callBtn = async (on) => {
    try { f.callToday = await store.callClaim(fid, myId, on); haptic(80); toast(on ? '형제들에게 "전화드릴게요"를 알렸어요' : '취소했어요'); await renderFamily(fid); }
    catch (err) { toast(friendly(err)); }
  };
  $app.querySelector('#call-me')?.addEventListener('click', () => callBtn(true));
  $app.querySelector('#call-cancel')?.addEventListener('click', () => callBtn(false));
  // 부모님 안부를 7번 이상 받았으면 별점 요청 (한 기기 한 번)
  if (isApp && f.checkins.length >= 7) setTimeout(() => askReview('haru:review'), 1500);
  // 부모님 폰이 연결돼 있으면 알림으로 바로, 아니면(또는 실패하면) 지금처럼 링크 공유
  $app.querySelector('#ask')?.addEventListener('click', async (e) => {
    const shareAsk = () => {
      store.log(fid, 'ask_shared');
      share({ text: `${P}, 오늘 하루 어떠세요? 😊\n버튼 한 번만 눌러 주세요 💛`, url: parentLink(f.parentToken) }, '부탁 메시지를 복사했어요');
    };
    if (!f.parentDevices) return shareAsk();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await store.askParent(fid, myId);
      if (!r.pushed) return shareAsk();
      haptic(120);
      toast(r.recent ? `방금 ${josa(P, '을/를')} 불렀어요. 조금만 기다려 주세요` : `${P} 폰으로 알림을 보냈어요`);
    } catch { shareAsk(); }
    finally { btn.disabled = false; }
  });
  $app.querySelector('a[aria-label="설정"]').addEventListener('click', () => sessionStorage.setItem('haru:settingsFrom', fid));
  bindHearts(f, myId);
  bindComposer($app.querySelector('#note'), {
    folder: fid,
    onSend: async (d) => {
      try {
        await store.addNote(fid, myId, d);
        haptic(120);
        toast(`${josa(sentLabel(d), '을/를')} 남겼어요`);
        await renderFamily(fid);
        return true;
      } catch (e) { toast(friendly(e)); return false; }
    },
  });
  $app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('이 이야기를 지울까요?')) return;
      try { await store.deleteNote(fid, myId, b.dataset.del); await renderFamily(fid); } catch (e) { toast(friendly(e)); }
    };
  });
  loadPhotos();
  bindPushCard(fid, myId, P);
}

// 오늘 소식이 아직일 때: 누가 전화드리기로 했는지, 아니면(마감이 지났으면) '내가 전화드릴게요' 버튼
function callClaimHtml(f, myId, late) {
  const c = f.callToday;
  if (c) {
    const mine = c.memberId === myId;
    return `<p class="call-claim">📞 <b>${esc(mine ? '내가' : josa(c.name, '이/가'))}</b> ${esc(f.parentName)}께 전화드리기로 했어요 <span class="muted small">${esc(timeLabel(c.at))}</span>
      ${mine ? '<button type="button" class="b-del" id="call-cancel">취소</button>' : ''}</p>`;
  }
  if (!late) return '';
  return `<button class="btn ghost block" id="call-me">📞 내가 전화드릴게요</button>
    <p class="muted small call-hint">형제들 화면에 보여서 전화가 겹치거나 아무도 안 하는 일이 줄어요</p>`;
}

// 이 폰(자녀) 알림 — 이미 허용했으면 조용히 등록, 아직 안 물어봤으면 이유부터 설명, 꺼져 있으면 켜는 방법 (10/7)
async function bindPushCard(fid, myId, P) {
  if (!isApp) return;
  const reg = () => registerPush((token, plat) => store.registerPush(fid, myId, token, plat));
  const perm = await pushPermission();
  if (perm === 'granted') {
    if (!sessionStorage.getItem(`haru:push:${fid}`)) { sessionStorage.setItem(`haru:push:${fid}`, '1'); reg(); }
    return;
  }
  if (perm === 'unsupported') return;
  const box = $app.querySelector('#push-card');
  if (!box) return;
  box.innerHTML = `<section class="pp-card push-card">
    <p class="pp-title">${perm === 'denied' ? '🔕 이 폰은 알림이 꺼져 있어요' : '🔔 알림을 켜 주세요'}</p>
    <p class="pp-desc">${esc(josa(P, '이/가'))} 안부를 보내면 바로, 정한 시각까지 소식이 없으면 알려 드려요.${perm === 'denied'
      ? ' 휴대폰 <b>설정 → 앱 → 안부한장 → 알림</b>에서 켜 주세요.' : ''}</p>
    <button class="btn primary block" id="push-on">${perm === 'denied' ? '다시 확인하기' : '알림 켜기'}</button>
  </section>`;
  box.querySelector('#push-on').onclick = async () => {
    const r = await reg();
    if (r === 'requested') { box.innerHTML = ''; toast('알림을 켰어요 🔔'); return; }
    toast('알림이 아직 꺼져 있어요. 휴대폰 설정 → 앱 → 안부한장 → 알림을 켜 주세요', 4000);
  };
}

// 카톡 안 브라우저로 열린 경우: 홈 화면 추가·사진 올리기가 막힐 수 있어 다른 브라우저로 여는 길을 알려 준다 (10/7)
const inKakao = () => !isApp && /KAKAOTALK/i.test(navigator.userAgent);
function kakaoBarHtml() {
  if (!inKakao()) return '';
  const url = `kakaotalk://web/openExternal?url=${encodeURIComponent(location.href)}`;
  return `<p class="kakao-bar">카카오톡 안에서 열렸어요. <a href="${esc(url)}">다른 브라우저로 열기</a>하면 홈 화면에 추가해 매일 바로 열 수 있어요.</p>`;
}

// 오늘의 한 장: 사진이 있으면 폴라로이드, 없으면 줄 쳐진 편지지에 기분
function todayCard(c, f, myId) {
  const mood = moodOf(c.mood);
  const hearted = c.hearts.includes(myId);
  const who = f.members.filter((m) => c.hearts.includes(m.id)).map((m) => m.name);
  const face = c.photo
    ? `<img class="photo" data-photo="${esc(c.photo)}" alt="${esc(f.parentName)}께서 보낸 사진">`
    : `<div class="face">${mood ? `<span class="e">${mood.emoji}</span><span class="l">${mood.label}</span>` : '<span class="e">✉️</span>'}</div>`;
  return `<article class="polaroid">
    ${face}
    <div class="caption">
      ${c.photo && mood ? `<span class="mood-tag ${esc(c.mood)}">${mood.emoji} ${mood.label}</span>` : ''}
      ${c.message ? `<p class="note">“${esc(c.message)}”</p>` : ''}
    </div>
    <div class="meta">
      <time>${timeLabel(c.at)} 도착</time>
      <button class="heart ${hearted ? 'on' : ''}" data-heart="${esc(c.id)}" aria-pressed="${hearted}" aria-label="하트">❤️ ${c.hearts.length || ''}</button>
    </div>
    ${who.length ? `<p class="hearted">${esc(joinNames(who))} 하트</p>` : ''}
  </article>`;
}

// 가족 이야기 한 줄: 내 것은 오른쪽, 다른 형제는 왼쪽(이름·색)
function noteBubble(n, f, myId) {
  const i = f.members.findIndex((m) => m.id === n.memberId);
  const who = f.members[i];
  const mine = n.memberId === myId;
  return `<div class="bubble ${mine ? 'mine' : ''}">
    ${mine ? '' : `<i class="b-av" style="--c:${AVATAR_COLORS[Math.max(i, 0) % AVATAR_COLORS.length]}">${esc([...(who?.name || '?')][0])}</i>`}
    <div class="b-body">
      ${mine ? '' : `<span class="b-name">${esc(who?.name || '가족')}</span>`}
      ${n.photo ? `<img class="photo" data-photo="${esc(n.photo)}" alt="${esc(josa(who?.name || '가족', '이/가'))} 보낸 사진">` : ''}
      ${n.message ? `<p>${esc(n.message)}</p>` : ''}
      <span class="b-meta">${timeLabel(n.at)}${n.parentHeart ? ` · <b class="b-heart">💗 ${esc(f.parentName)}</b>` : ''}${mine ? ` · <button type="button" class="b-del" data-del="${esc(n.id)}">지우기</button>` : ''}</span>
    </div>
  </div>`;
}

// 지난 소식: 작은 폴라로이드
function miniCard(c, f, myId) {
  const mood = moodOf(c.mood);
  const hearted = c.hearts.includes(myId);
  return `<figure class="mini">
    ${c.photo ? `<img class="photo" data-photo="${esc(c.photo)}" alt="${esc(c.day)} 사진">`
      : `<div class="mini-face ${esc(c.mood || '')}">${mood ? mood.emoji : '✉️'}</div>`}
    ${c.message ? `<span class="m-note">“${esc(c.message)}”</span>` : ''}
    <figcaption><span>${esc(c.day.slice(5).replace('-', '/'))}${c.photo && mood ? ` ${mood.emoji}` : ''}</span>
      <button class="heart sm ${hearted ? 'on' : ''}" data-heart="${esc(c.id)}" aria-pressed="${hearted}" aria-label="하트">❤️ ${c.hearts.length || ''}</button></figcaption>
  </figure>`;
}

function bindHearts(f, myId) {
  $app.querySelectorAll('[data-heart]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await store.heart(f.id, b.dataset.heart, myId); await renderFamily(f.id); } catch (e) { toast(friendly(e)); b.disabled = false; }
    };
  });
}

// 화면의 사진 주소를 한 번에 받아 채운다 (못 받은 사진은 빼고)
async function loadPhotos() {
  const imgs = [...$app.querySelectorAll('[data-photo]')];
  if (!imgs.length) return;
  let urls = {};
  try { urls = await store.photoUrls([...new Set(imgs.map((i) => i.dataset.photo))]); } catch { /* 아래에서 뺀다 */ }
  for (const img of imgs) {
    const url = urls[img.dataset.photo];
    if (!url) { img.remove(); continue; }
    img.src = url;
    img.onclick = () => showPhoto(img.src);
  }
}

function showPhoto(url) {
  const v = document.createElement('div');
  v.className = 'photo-viewer';
  v.innerHTML = `<img src="${esc(url)}" alt="사진"><span>눌러서 닫기</span>`;
  v.onclick = () => v.remove();
  document.body.append(v);
}

// ───────── 설정 ─────────
async function renderSettings(fid) {
  const f = await store.getFamily(fid);
  const myId = me.get(fid);
  const mine = f.members.find((m) => m.id === myId);
  if (!mine) { replaceHash(`#/f/${fid}`); return; }
  const tz = localTz();
  const P = f.parentName;
  const away = tz && tz !== 'Asia/Seoul';
  $app.innerHTML = `
    <header class="mast">
      <a class="icon-btn" href="#/f/${esc(fid)}" aria-label="돌아가기">←</a>
      <span class="wordmark">안부한장</span>
      <span class="icon-btn" aria-hidden="true"></span>
    </header>
    <h1 class="page-title">설정</h1>
    <form id="settings">
      <section class="group">
        <h2>가족 방</h2>
        <label class="field"><span>부모님 호칭</span>
          <input class="input" name="parentName" maxlength="20" value="${esc(f.parentName)}" required></label>
        <label class="field"><span>이 시각까지 소식이 없으면 알려 드려요 (한국 시간)</span>
          <select class="input" name="deadline">${deadlineOptions(f.deadline)}</select></label>
        <p class="muted small">가족 방 설정은 형제 모두에게 똑같이 바뀌어요.</p>
      </section>
      <section class="group">
        <h2>${esc(P)} 폰 알림</h2>
        <div style="margin-top:4px">
          <label class="toggle"><span><b>매일 안부 알림</b><small>정한 시각에 ${esc(P)} 폰으로 "오늘 하루 어떠세요?" 알림이 가요. 그날 이미 안부를 보내셨으면 가지 않아요</small></span>
            <input type="checkbox" name="remindOn" ${f.remindOn !== false ? 'checked' : ''}></label>
        </div>
        <label class="field"><span>알림 시각 (한국 시간)</span>
          <select class="input" name="remindAt">${deadlineOptions(f.remindAt || '09:00')}</select></label>
        <div style="margin-top:8px">
          <label class="toggle"><span><b>⏰ 안 보내시면 안부 알람</b><small>매일 알림 30분 뒤에도 안부가 없으면 ${esc(P)} 폰에서 알람이 울려요. 30분 뒤 한 번 더, 하루 최대 2번, 밤 10시~아침 8시엔 쉬어요 (안드로이드).
            ${f.parentCallDevices ? `✅ ${esc(P)} 폰에서 알람을 켜 두셨어요` : `${esc(P)} 폰 화면에서 <b>'안부 알람 받기'</b>를 직접 켜셔야 울려요`}</small></span>
            <input type="checkbox" name="callOn" ${f.callOn !== false ? 'checked' : ''}></label>
        </div>
        <p class="muted small" id="parent-dev">${f.parentDevices
          ? `✅ ${esc(P)} 폰 ${f.parentDevices}대에 연결돼 있어요. '오늘 안부 부탁하기'도 링크 대신 알림으로 가요. <button type="button" class="b-del" id="unlink">연결 끊기</button>`
          : `아직 연결된 ${esc(P)} 폰이 없어요. ${esc(P)} 폰에 안부한장 앱을 설치하고 부모님 링크를 연 뒤, 화면 아래 <b>'매일 알림 받기'</b>를 눌러 주세요.`}</p>
      </section>
      <section class="group">
        <h2>나</h2>
        <label class="field"><span>내 이름</span>
          <input class="input" name="myName" maxlength="20" value="${esc(mine.name)}" required></label>
        <div style="margin-top:12px">
          <label class="toggle"><span><b>안부 도착 알림</b><small>${esc(josa(f.parentName, '이/가'))} 안부를 보내면 바로 알려 드려요</small></span>
            <input type="checkbox" name="notifyCheckin" ${mine.notifyCheckin !== false ? 'checked' : ''}></label>
          <label class="toggle"><span><b>'아직 소식 없음' 알림</b><small>마감이 지나도 소식이 없으면 알려 드려요. 1시간이 더 지나면 다른 형제에게도 가요</small></span>
            <input type="checkbox" name="notifyLate" ${mine.notifyLate !== false ? 'checked' : ''}></label>
        </div>
        <p class="muted small">${isApp
          ? `밤 10시~아침 8시(이 휴대폰 시간)에는 소리 없이 조용히 와요.${away ? ` 지금 이 휴대폰은 ${esc(tz)} 시간이에요.` : ''}`
          : '알림은 안부한장 앱에서 받을 수 있어요.'}</p>
        <p class="muted small" id="my-push"></p>
      </section>
      <button class="btn primary block" style="margin-top:18px">저장</button>
    </form>
    <section class="group danger-zone">
      <h2>가족 방 지우기</h2>
      <p class="muted small">이 가족 방의 안부·사진·이야기가 <b>형제 모두와 ${esc(P)} 화면에서</b> 사라지고 되돌릴 수 없어요. 링크도 더는 열리지 않아요.</p>
      <button type="button" class="btn block danger" id="del-family">가족 방 지우기</button>
    </section>`;
  pushPermission().then((perm) => {
    const el = $app.querySelector('#my-push');
    if (!el || perm === 'unsupported') return;
    el.innerHTML = perm === 'granted' ? '🔔 이 폰은 알림이 켜져 있어요.'
      : `🔕 이 폰은 알림이 꺼져 있어요. 휴대폰 <b>설정 → 앱 → 안부한장 → 알림</b>에서 켜 주세요.`;
  });
  $app.querySelector('#del-family').onclick = async () => {
    if (!confirm(`'${P}' 가족 방을 지울까요?\n형제 모두와 ${P} 화면에서 안부·사진·이야기가 사라져요.`)) return;
    if (!confirm('정말 지울까요? 되돌릴 수 없어요.')) return;
    try {
      await store.deleteFamily(fid, myId);
      forgetFamily(fid);
      if (unsub) { unsub(); unsub = null; }
      toast('가족 방을 지웠어요');
      replaceHash('#/');
    } catch (err) { toast(friendly(err)); }
  };

  const form = $app.querySelector('#settings');
  $app.querySelector('#unlink')?.addEventListener('click', async () => {
    if (!confirm(`${P} 폰 연결을 끊을까요? 다시 연결하려면 ${P} 폰에서 '매일 알림 받기'를 눌러 주세요.`)) return;
    try { await store.unlinkParent(fid, myId); toast('연결을 끊었어요'); await renderSettings(fid); } catch (err) { toast(friendly(err)); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const parentName = form.parentName.value.trim();
      const deadline = form.deadline.value;
      const remindAt = form.remindAt.value;
      const remindOn = form.remindOn.checked;
      const callOn = form.callOn.checked;
      if (parentName !== f.parentName || deadline !== f.deadline || remindAt !== f.remindAt || remindOn !== f.remindOn
        || callOn !== f.callOn) {
        await store.updateFamily(fid, { parentName, deadline, remindAt, remindOn, callOn });
      }
      await store.updateMember(fid, myId, {
        name: form.myName.value.trim(), notifyCheckin: form.notifyCheckin.checked, notifyLate: form.notifyLate.checked,
      });
      toast('저장했어요');
      // 가족 화면의 ⚙로 들어왔으면 뒤로(기록이 쌓이지 않게), 링크로 바로 왔으면 가족 화면으로
      if (sessionStorage.getItem('haru:settingsFrom') === fid) history.back();
      else replaceHash(`#/f/${fid}`);
    } catch (err) { toast(friendly(err)); btn.disabled = false; }
  };
}

// 링크로 처음 들어온 형제: 이름 고르거나 새로 참여
function renderJoin(f) {
  $app.innerHTML = `
    <header class="home-top"><span class="wordmark">안부한장</span></header>
    <section class="cover">
      <h1>${esc(f.parentName)}의 하루를<br>같이 볼까요?</h1>
      <p>이름을 고르거나 적어 주세요. 이 폰에 기억해 둘게요.</p>
    </section>
    <p class="wrong-link">💡 <b>${esc(f.parentName)}이신가요?</b> 이 링크는 자녀들이 같이 보는 링크예요. 안부는 자녀가 따로 보내 드린 <b>'안부 보내기' 링크</b>에서 보내 주세요.</p>
    <div class="letter-card">
      ${f.members.length ? `<div class="chips">${f.members.map((m) => `<button class="chip" data-mid="${esc(m.id)}">${esc(m.name)}</button>`).join('')}</div>` : ''}
      <form class="row" id="join"><input class="input grow" name="n" maxlength="20" placeholder="내 이름" required><button class="btn primary">참여</button></form>
    </div>`;
  $app.querySelectorAll('[data-mid]').forEach((b) => {
    b.onclick = () => { me.set(f.id, b.dataset.mid); route(); };
  });
  $app.querySelector('#join').onsubmit = async (e) => {
    e.preventDefault();
    const n = e.target.n.value.trim();
    const exist = f.members.find((m) => m.name === n);
    try {
      const id = exist ? exist.id : (await store.join(f.id, n)).id;
      me.set(f.id, id);
      route();
    } catch (err) { toast(friendly(err)); }
  };
}

// ───────── 웹(카톡 안 브라우저 등)으로 열린 부모님 화면 → 앱으로 열기 ─────────
// 카톡은 링크를 앱으로 넘기지 않고 자기 브라우저로 연다. 안드로이드는 intent:// 로 안부한장 앱을 직접 연다
// (앱이 없으면 소개 페이지로). 해시가 빠지는 브라우저를 위해 ?h= 에도 같은 경로를 싣는다.
const isAndroidWeb = () => !isApp && /Android/i.test(navigator.userAgent);
function appIntentUrl(token) {
  const path = `/p/${token}`;
  const fallback = encodeURIComponent('https://anbuhanjang.com/');
  return `intent://anbuhanjang.com/?h=${encodeURIComponent(path)}#${path}#Intent;scheme=https;package=com.sosolab.anbuhanjang;S.browser_fallback_url=${fallback};end`;
}
function openInAppHtml(token) {
  if (!isAndroidWeb()) return '<p class="tip">💡 매일 쉽게 여시려면: 브라우저 메뉴 → <b>홈 화면에 추가</b></p>';
  return `<section class="pp-card">
    <p class="pp-title">📱 앱에서 열기</p>
    <p class="pp-desc">매일 알림과 안부 알람은 안부한장 앱에서 받아요. 앱을 설치했다면 아래를 눌러 주세요.</p>
    <a class="btn primary block pp-btn" href="${esc(appIntentUrl(token))}">안부한장 앱으로 열기</a>
    <p class="pp-note">앱이 없으면 안부한장 소개 화면으로 가요</p>
  </section>`;
}

// ───────── 부모님 폰 알림 (앱에서만) ─────────
// 이 폰에서 '매일 알림 받기'를 눌렀으면 기억해 두고, 앱을 켤 때마다 조용히 다시 등록(토큰이 바뀌어도 이어지게)
const PP_KEY = (token) => `haru:pp:${token}`;
const PTOK_KEY = (token) => `haru:pptok:${token}`; // 이 폰의 알림 토큰 (안부 알람 켜고 끌 때 서버에 알려 준다)
const PCALL_KEY = (token) => `haru:pcall:${token}`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } };
const pcallOn = (token) => lsGet(PCALL_KEY(token)) === '1';
const ppOn = (token) => { try { return localStorage.getItem(PP_KEY(token)) === '1'; } catch { return false; } };
const timeWord = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h > 12 ? h - 12 : h}시${m ? ` ${m}분` : ''}`; };
function parentPushHtml(v, token) {
  if (ppOn(token)) {
    const call = callSupported && v.remindOn && v.callOn !== false;
    const callOn = pcallOn(token);
    return `<p class="tip">🔔 ${v.remindOn ? `매일 ${timeWord(v.remindAt)}에 알려 드려요. 자녀가 안부를 부탁해도 알림이 와요.` : '자녀가 안부를 부탁하면 알림이 와요.'}</p>
    ${call ? `<section class="pp-call" id="pp-call">
      <label class="toggle pp-toggle"><span><b>⏰ 안부 알람 받기</b><small>알림 30분 뒤에도 안부를 안 보내셨으면 알람처럼 울려요. 하루 최대 2번, 밤에는 쉬어요</small></span>
        <input type="checkbox" id="pp-call-on" ${callOn ? 'checked' : ''}></label>
      ${callOn ? `<p class="pp-fs" id="pp-fs" hidden>잠금 화면에서도 크게 뜨게 하려면 한 번만 허용해 주세요.
        <button type="button" class="btn block" id="pp-fs-btn">허용하러 가기</button></p>
      <button type="button" class="btn ghost block" id="pp-test">⏰ 알람 미리 들어 보기</button>` : ''}
    </section>` : ''}`;
  }
  return `<section class="pp-card">
    <p class="pp-title">🔔 매일 알림 받기</p>
    <p class="pp-desc">${v.remindOn ? `매일 ${timeWord(v.remindAt)}에 "오늘 하루 어떠세요?" 알림을 보내 드려요. ` : ''}알림을 누르면 이 화면이 바로 열려요.</p>
    <button class="btn primary block pp-btn" id="pp-on">알림 받기</button>
  </section>`;
}
function bindParentPush(token) {
  if (!isApp) return;
  const reg = () => registerPush(async (t, plat) => {
    try { await store.registerParentPush(token, t, plat); lsSet(PP_KEY(token), '1'); lsSet(PTOK_KEY(token), t); } catch { /* 다음에 다시 */ }
  });
  if (ppOn(token) && !sessionStorage.getItem(PP_KEY(token))) { sessionStorage.setItem(PP_KEY(token), '1'); reg(); }
  const sw = $app.querySelector('#pp-call-on');
  if (sw) {
    sw.onchange = async () => {
      const push = lsGet(PTOK_KEY(token));
      if (!push) { sw.checked = !sw.checked; reg(); return toast('알림 연결을 다시 하는 중이에요. 잠시 뒤 다시 눌러 주세요'); }
      sw.disabled = true;
      try {
        await store.parentCallOpt(token, push, sw.checked);
        lsSet(PCALL_KEY(token), sw.checked ? '1' : '0');
        toast(sw.checked ? '안부 알람을 켰어요 ⏰' : '안부 알람을 껐어요');
        await refreshView({ force: true });
      } catch (e) { sw.checked = !sw.checked; sw.disabled = false; toast(friendly(e)); }
    };
  }
  if ($app.querySelector('#pp-test')) {
    callStatus().then((s) => { const el = $app.querySelector('#pp-fs'); if (el && s && !s.fullScreen) el.hidden = false; });
    $app.querySelector('#pp-fs-btn').onclick = () => openCallSettings();
    $app.querySelector('#pp-test').onclick = () => {
      testCall(`#/p/${token}`);
      toast('5초 뒤에 울려요. 화면을 꺼 두면 잠금 화면 모습도 볼 수 있어요', 4000);
    };
  }
  const b = $app.querySelector('#pp-on');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    const r = await reg();
    if (r === 'denied') { b.disabled = false; return toast('알림이 꺼져 있어요. 휴대폰 설정 → 앱 → 안부한장 → 알림을 켜 주세요', 4000); }
    if (r !== 'requested') { b.disabled = false; return toast('알림을 켜지 못했어요. 잠시 뒤 다시 눌러 주세요'); }
    // 토큰은 곧 도착한다 — 저장되면 안내가 바뀐다
    setTimeout(() => { if (ppOn(token)) { toast('알림을 켰어요 🔔'); refreshView({ force: true }); } else b.disabled = false; }, 2500);
  };
}

// 큰 '취소' 막대: ms 안에 취소를 안 누르면 run() (같은 막대가 떠 있으면 바꿔치기)
let undoTimer = null;
function undoBar(text, ms, run) {
  document.querySelector('.undo-bar')?.remove();
  clearTimeout(undoTimer);
  const bar = document.createElement('div');
  bar.className = 'undo-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<span>${esc(text)}</span><button type="button">취소</button><i style="animation-duration:${ms}ms"></i>`;
  document.body.append(bar);
  bar.querySelector('button').onclick = () => { clearTimeout(undoTimer); bar.remove(); toast('취소했어요'); };
  undoTimer = setTimeout(() => { bar.remove(); run(); }, ms);
}

// ───────── 부모님 화면 ─────────
// 위에서부터: 오늘 보낸 것·받은 하트 → 자녀들이 보낸 이야기(하트로 답) → 기분 버튼(한 번에 보냄) → 사진·한마디 같이 보내기
async function renderParent(token, justSent = false) {
  const v = await store.parentView(token);
  if (location.hash !== `#/p/${token}`) return;
  if (!justSent && unchanged(`p:${token}:${ppOn(token)}:${pcallOn(token)}`, v)) { lastRender = Date.now(); return; }
  if (!unsub) {
    unsub = store.subscribe(v.familyId, () => refreshView());
    if (!sessionStorage.getItem(`haru:popened:${token}`)) { sessionStorage.setItem(`haru:popened:${token}`, '1'); store.log(v.familyId, 'parent_opened'); }
  }
  view = () => renderParent(token);
  lastRender = Date.now();
  rememberView(`#/p/${token}`);
  const kids = joinNames(v.children);
  const sent = v.todayCheckins.length > 0;
  const hearts = [...new Set(v.todayCheckins.flatMap((c) => c.hearts))];
  const photos = v.todayCheckins.filter((c) => c.photo);
  const notes = [...(v.notes || [])].reverse().slice(0, 8); // 최근 것부터
  // 오늘 아직 안 보내셨으면 기분 버튼이 먼저, 이야기는 아래로 (위에 '와 있어요' 안내)
  const notesHtml = notes.length ? `<section class="kids-talk" id="kids-talk">
          <h2 class="p-h">💌 자녀들이 보낸 이야기</h2>
          ${notes.map((n) => `<article class="kid-note">
            <p class="kn-who"><b>${esc(n.name)}</b> <span>${dayWord(n.day, v.today)} ${timeLabel(n.at)}</span></p>
            ${n.photo ? `<img class="photo" data-photo="${esc(n.photo)}" alt="${esc(josa(n.name, '이/가'))} 보낸 사진">` : ''}
            ${n.message ? `<p class="kn-msg">${esc(n.message)}</p>` : ''}
            <button class="heart kn-heart ${n.heart ? 'on' : ''}" data-pheart="${esc(n.id)}" aria-pressed="${n.heart}">${n.heart ? '❤️ 하트 보냈어요' : '🤍 하트 보내기'}</button>
          </article>`).join('')}
        </section>` : '';

  $app.innerHTML = `
    <div class="parent">
      ${me.get(v.familyId) ? `<p class="wrong-link">💡 이 화면은 <b>${esc(josa(v.parentName, '이/가'))}</b> 쓰는 화면이에요. 여기서 누르면 ${esc(josa(v.parentName, '이/가'))} 보낸 안부로 기록돼요.
        <a href="#/f/${esc(v.familyId)}">내 가족 방으로 가기</a></p>` : ''}
      ${kakaoBarHtml()}
      <p class="date">${esc(dateLabel(v.today))}</p>
      <h1 class="greet">${esc(v.parentName)},<br>오늘 하루 어떠세요?</h1>
      ${sent ? `<section class="sent-card ${justSent ? 'pop' : ''}">
          ${photos.length ? `<div class="sent-photos">${photos.map((c) => `<img class="photo" data-photo="${esc(c.photo)}" alt="보낸 사진">`).join('')}</div>` : ''}
          <p class="sent-title">💛 ${esc(kids)}에게 전했어요</p>
          ${hearts.length ? `<p class="hearts">❤️ ${esc(joinNames([...hearts.slice(0, -1), josa(hearts.at(-1), '이/가')]))} 하트를 보냈어요</p>` : '<p class="muted">곧 하트가 올 거예요</p>'}
        </section>` : ''}
      ${sent ? notesHtml : (notes.length ? `<button type="button" class="kids-jump">💌 자녀들 이야기 ${notes.length}개가 와 있어요 ↓</button>` : '')}
      <p class="ask">${sent ? '더 보내고 싶으시면 눌러 주세요' : '기분 하나만 눌러도 돼요'}</p>
      <div class="mood-tiles">${MOODS.map((m) => `<button class="mood-tile ${m.id}" data-mood="${m.id}"><span class="e">${m.emoji}</span><span>${m.label}</span></button>`).join('')}</div>
      ${composerHtml({ id: 'msg', label: '📷 사진·한마디 같이 보내기', placeholder: '예: 오늘 장 보고 왔다', maxlength: 100, big: true })}
      ${sent ? '' : notesHtml}
      ${v.streak ? `<p class="streak">이번 주 <b>${v.streak}일</b> 소식을 보내셨어요 👏</p>` : ''}
      ${isApp ? parentPushHtml(v, token) : openInAppHtml(token)}
    </div>`;
  loadPhotos();

  const send = async (data, label) => {
    $app.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await store.checkin(token, v.familyId, data);
      haptic(250);
      toast(`${label} 보냈어요`);
      await renderParent(token, true);
      scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    } catch (e) {
      toast(friendly(e));
      $app.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return false;
    }
  };
  // 잘못 누른 기분이 형제들에게 바로 가지 않게: 3초 동안 '취소'를 보여 준 뒤 보낸다
  $app.querySelectorAll('[data-mood]').forEach((b) => {
    b.onclick = () => {
      const m = moodOf(b.dataset.mood);
      haptic(60);
      undoBar(`${m.emoji} ${m.label} — 보내는 중이에요`, 3000, () => send({ mood: m.id }, m.label));
    };
  });
  bindComposer($app.querySelector('#msg'), { folder: v.familyId, onSend: (d) => send(d, josa(sentLabel(d), '을/를')) });
  bindParentPush(token);
  $app.querySelector('.kids-jump')?.addEventListener('click', () => document.getElementById('kids-talk')?.scrollIntoView({ behavior: 'smooth' }));
  $app.querySelectorAll('[data-pheart]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { if (await store.parentHeart(token, v.familyId, b.dataset.pheart)) haptic(120); await renderParent(token); }
      catch (e) { toast(friendly(e)); b.disabled = false; }
    };
  });
}

// ───────── 시작 ─────────
(async () => {
  store = await createStore(window.HARU_CONFIG);
  window.__haru = { store };
  // 앱을 아이콘으로 켰으면(해시 없음) 마지막으로 본 화면부터
  const startAt = isApp && (!location.hash || location.hash === '#/') ? lastView() : null;
  history.replaceState({ d: 0 }, '', startAt ? `#${startAt.slice(1)}` : undefined);
  addEventListener('hashchange', onHashChange);
  initNative({
    // 알림·링크로 앱이 열릴 때: 첫 화면이면 그 화면을 첫 화면으로(뒤로가기가 만들기 화면으로 가지 않게)
    onOpenHash: (h) => {
      if (location.hash === h) return refreshView({ force: true });
      if (depth === 0) replaceHash(h); else location.hash = h;
    },
    onBack,
    onResume: () => refreshView(),
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshView(); });
  addEventListener('online', () => refreshView());
  $app.addEventListener('focusout', () => { if (pendingRefresh) setTimeout(() => refreshView(), 400); });
  setInterval(() => { if (document.visibilityState === 'visible') refreshView(); }, 60000);
  initPullToRefresh();
  route();
})();
