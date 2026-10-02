// 안부한장 — 화면 (해시 라우팅)
//  #/            홈: 가족 방 만들기 · 최근 방
//  #/f/<가족id>  자녀 화면: 부모님의 오늘, 7일, 하트, 형제 초대, 안부 부탁
//  #/p/<토큰>    부모님 화면: 큰 버튼 하나 + 사진·한마디(선택) + 받은 하트
import { createStore, me, recentFamilies } from './store.js?v=202610021441';
import { esc, toast, share as webShare, pickPhoto, compressImage, joinNames, josa, timeLabel } from './util.js?v=202610021441';
import { isApp, siteBase, nativeShare, haptic, pickPhotoNative, registerPush, initNative } from './native.js?v=202610021441';

const $app = document.getElementById('app');
let store;
let unsub = null;

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
function kstNowMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = p.split(':').map(Number);
  return h * 60 + m;
}
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// ───────── 라우터 ─────────
async function route() {
  if (unsub) { unsub(); unsub = null; }
  const h = location.hash.slice(1);
  let m;
  try {
    if ((m = h.match(/^\/f\/([\w-]+)/))) return await renderFamily(m[1]);
    if ((m = h.match(/^\/p\/([\w-]+)/))) return await renderParent(m[1]);
    renderHome();
  } catch (e) {
    $app.innerHTML = `<div class="empty">${esc(e.message)}<br><br><a href="#/">처음으로</a></div>`;
  }
}

// ───────── 홈 ─────────
function renderHome() {
  const recent = recentFamilies();
  $app.innerHTML = `
    <div class="hero">
      <span class="brand">💛 안부한장 <small>베타</small></span>
      <h1>부모님의 오늘,<br>한 장으로 받아보세요</h1>
      <p>부모님은 링크만 누르면 돼요. 버튼 한 번이나 사진 한 장이 곧 안부예요. 형제들도 같이 봐요.</p>
    </div>
    <form class="card stack" id="create">
      <div class="field"><span>부모님을 뭐라고 부르세요?</span>
        <div class="chips" id="pn">${['엄마', '아빠', '어머니', '아버지'].map((n) => `<button type="button" class="chip" data-pn="${n}">${n}</button>`).join('')}</div>
        <input class="input" name="parentName" maxlength="20" placeholder="직접 입력 (예: 우리 엄마)" required></div>
      <label class="field"><span>내 이름</span><input class="input" name="childName" maxlength="20" placeholder="예: 준식" required></label>
      <label class="field"><span>이 시각까지 소식이 없으면 '아직'으로 표시</span>
        <select class="input" name="deadline">${Array.from({ length: 13 }, (_, i) => i + 8).map((h) =>
          `<option value="${String(h).padStart(2, '0')}:00" ${h === 12 ? 'selected' : ''}>${h < 12 ? '오전' : '오후'} ${h > 12 ? h - 12 : h}시</option>`).join('')}</select></label>
      <button class="btn primary block">가족 방 만들기</button>
    </form>
    ${recent.length ? `<div class="card recent"><b>내 가족 방</b>${recent.map((f) =>
      `<a href="#/f/${esc(f.id)}"><span>${esc(f.parentName)}의 하루</span><span class="muted small">›</span></a>`).join('')}</div>` : ''}
    <p class="muted small foot"><a href="privacy.html">개인정보처리방침</a></p>`;

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
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
}

// ───────── 자녀 화면 ─────────
async function renderFamily(fid) {
  const f = await store.getFamily(fid);
  const myId = me.get(fid);
  const mine = f.members.find((m) => m.id === myId);
  if (!mine) return renderJoin(f);

  if (!sessionStorage.getItem(`haru:opened:${fid}`)) { sessionStorage.setItem(`haru:opened:${fid}`, '1'); store.log(fid, 'family_opened'); }
  unsub = store.subscribe(fid, () => renderFamily(fid).catch(() => {}));

  const P = f.parentName;
  const today = f.checkins.filter((c) => c.day === f.today);
  // 방을 만든 날은 마감 경고를 하지 않는다 (부모님이 링크를 받기도 전이라)
  const createdToday = new Date(f.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) === f.today;
  const late = !today.length && !createdToday && kstNowMinutes() > toMinutes(f.deadline);
  const fresh = sessionStorage.getItem(`haru:fresh:${fid}`) && !f.checkins.length; // 부모님이 한 번 보내면 안내 끝
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${f.today}T00:00:00+09:00`);
    d.setDate(d.getDate() - (6 - i));
    const iso = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    return { iso, label: '일월화수목금토'[d.getDay()], ok: f.checkins.some((c) => c.day === iso), isToday: iso === f.today };
  });
  const past = f.checkins.filter((c) => c.day !== f.today);

  $app.innerHTML = `
    <header class="top">
      <a class="icon-btn" href="#/" aria-label="처음으로">←</a>
      <h1 class="grow">${esc(P)}의 하루</h1>
    </header>

    ${fresh ? `<div class="card setup">
      <b>👋 먼저 ${esc(P)}께 링크를 보내 주세요</b>
      <p class="small">${esc(josa(P, '은/는'))} 이 링크만 누르면 돼요. 앱 설치나 가입은 필요 없어요.</p>
      <button class="btn primary block" id="send-parent">💌 ${esc(P)}께 링크 보내기</button>
      <button class="btn ghost block" id="invite">👨‍👩‍👧 형제 초대하기</button>
    </div>` : ''}

    <section class="card today ${today.length ? 'got' : late ? 'late' : ''}">
      <div class="row between"><b>오늘</b><span class="muted small">${today.length ? `${timeLabel(today[0].at)} 도착` : `마감 ${f.deadline}`}</span></div>
      ${today.length ? today.map((c) => checkinCard(c, f, myId)).join('')
        : `<div class="waiting">
            <div class="big">${late ? '📞' : '🌤'}</div>
            <p><b>${late ? `${esc(josa(P, '이/가'))} 아직 소식이 없어요` : '아직 오늘 소식을 기다리는 중이에요'}</b></p>
            <p class="muted small">${late ? '전화 한 통 어떠세요?' : '부탁하면 대부분 금방 보내 주세요'}</p>
          </div>`}
      ${today.length ? '' : `<button class="btn primary block" id="ask">💌 오늘 안부 부탁하기</button>`}
    </section>

    <section class="card">
      <b>이번 주</b>
      <div class="week">${days.map((d) => `<div class="day ${d.ok ? 'ok' : ''} ${d.isToday ? 'today' : ''}"><span>${d.label}</span><i>${d.ok ? '✓' : ''}</i></div>`).join('')}</div>
      <p class="muted small">${days.filter((d) => d.ok).length}일 소식을 받았어요</p>
    </section>

    ${past.length ? `<section class="card"><b>지난 소식</b>${past.slice(0, 20).map((c) => `<div class="past"><span class="muted small">${esc(c.day.slice(5).replace('-', '/'))}</span>${checkinCard(c, f, myId)}</div>`).join('')}</section>` : ''}

    <section class="card">
      <div class="row between"><b>함께 보는 가족</b><span class="muted small">${f.members.length}명</span></div>
      <div class="chips members">${f.members.map((m) => `<span class="chip">${esc(m.name)}${m.id === myId ? ' (나)' : ''}</span>`).join('')}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn grow" id="invite2">형제 초대</button>
        <button class="btn grow" id="send-parent2">${esc(P)} 링크 다시 보내기</button>
      </div>
    </section>
    <p class="muted small foot">안부한장 · <a href="privacy.html">개인정보처리방침</a></p>`;

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
  $app.querySelector('#invite')?.addEventListener('click', invite);
  $app.querySelector('#invite2')?.addEventListener('click', invite);
  $app.querySelector('#ask')?.addEventListener('click', () => {
    store.log(fid, 'ask_shared');
    share({ text: `${P}, 오늘 하루 어떠세요? 😊\n버튼 한 번만 눌러 주세요 💛`, url: parentLink(f.parentToken) }, '부탁 메시지를 복사했어요');
  });
  bindHearts(f, myId);
  loadPhotos();
  if (isApp && !sessionStorage.getItem(`haru:push:${fid}`)) {
    sessionStorage.setItem(`haru:push:${fid}`, '1');
    registerPush((token, plat) => store.registerPush(fid, myId, token, plat));
  }
}

function checkinCard(c, f, myId) {
  const mood = moodOf(c.mood);
  const hearted = c.hearts.includes(myId);
  const who = f.members.filter((m) => c.hearts.includes(m.id)).map((m) => m.name);
  return `<div class="checkin">
    ${c.photo ? `<img class="photo" data-photo="${esc(c.photo)}" alt="${esc(f.parentName)}께서 보낸 사진">` : ''}
    ${mood ? `<div class="mood">${mood.emoji} <b>${mood.label}</b></div>` : ''}
    ${c.message ? `<p class="msg">“${esc(c.message)}”</p>` : ''}
    <div class="row between">
      <span class="muted small">${timeLabel(c.at)}</span>
      <button class="heart ${hearted ? 'on' : ''}" data-heart="${esc(c.id)}" aria-pressed="${hearted}">❤️ ${c.hearts.length || ''}</button>
    </div>
    ${who.length ? `<p class="muted small">${esc(joinNames(who))} 하트</p>` : ''}
  </div>`;
}

function bindHearts(f, myId) {
  $app.querySelectorAll('[data-heart]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await store.heart(f.id, b.dataset.heart, myId); await renderFamily(f.id); } catch (e) { toast(e.message); b.disabled = false; }
    };
  });
}

async function loadPhotos() {
  for (const img of $app.querySelectorAll('[data-photo]')) {
    try { img.src = await store.photoUrl(img.dataset.photo); } catch { img.remove(); }
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

// 링크로 처음 들어온 형제: 이름 고르거나 새로 참여
function renderJoin(f) {
  $app.innerHTML = `
    <div class="hero"><span class="brand">💛 안부한장</span>
      <h1>${esc(f.parentName)}의 하루를<br>같이 볼까요?</h1>
      <p>이름을 고르거나 적어 주세요. 이 폰에 기억해 둘게요.</p></div>
    <div class="card stack">
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
    } catch (err) { toast(err.message); }
  };
}

// ───────── 부모님 화면 ─────────
async function renderParent(token, justSent = false) {
  const v = await store.parentView(token);
  if (!unsub) {
    unsub = store.subscribe(v.familyId, () => renderParent(token).catch(() => {}));
    if (!sessionStorage.getItem(`haru:popened:${token}`)) { sessionStorage.setItem(`haru:popened:${token}`, '1'); store.log(v.familyId, 'parent_opened'); }
  }
  const kids = joinNames(v.children);
  const sent = v.todayCheckins.length > 0;
  const hearts = [...new Set(v.todayCheckins.flatMap((c) => c.hearts))];

  $app.innerHTML = `
    <div class="parent">
      <p class="greet">${esc(v.parentName)},<br>오늘 하루 어떠세요?</p>
      ${sent ? `<div class="sent ${justSent ? 'pop' : ''}">
          <div class="big">💛</div>
          <p><b>${esc(kids)}에게 전했어요</b></p>
          ${hearts.length ? `<p class="hearts">❤️ ${esc(joinNames([...hearts.slice(0, -1), josa(hearts.at(-1), '이/가')]))} 하트를 보냈어요</p>` : '<p class="muted">곧 하트가 올 거예요</p>'}
        </div>` : ''}
      <p class="ask">${sent ? '더 보내고 싶으시면 눌러 주세요' : '아래 버튼 하나만 눌러 주세요'}</p>
      <div class="moods">${MOODS.map((m) => `<button class="mood-btn" data-mood="${m.id}"><span>${m.emoji}</span>${m.label}</button>`).join('')}</div>
      ${isApp ? `<div class="two"><button class="big-btn" data-src="camera">📷 사진 찍기</button><button class="big-btn" data-src="gallery">🖼 앨범에서</button></div>`
        : '<button class="big-btn" data-src="any">📷 사진 한 장 보내기</button>'}
      <form id="msg" class="msg-form">
        <textarea name="m" maxlength="100" rows="2" placeholder="한마디 남기기 (예: 오늘 장 보고 왔다)"></textarea>
        <button class="big-btn">✉️ 한마디 보내기</button>
      </form>
      ${v.streak ? `<p class="streak">이번 주 <b>${v.streak}일</b> 소식을 보내셨어요 👏</p>` : ''}
      <p class="tip">💡 매일 쉽게 여시려면: 크롬 메뉴 ⋮ → <b>홈 화면에 추가</b></p>
    </div>`;

  const send = async (data, label) => {
    $app.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await store.checkin(token, v.familyId, data);
      haptic(250);
      toast(`${label} 보냈어요`);
      await renderParent(token, true);
    } catch (e) {
      toast(e.message);
      $app.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  $app.querySelectorAll('[data-mood]').forEach((b) => {
    b.onclick = () => send({ mood: b.dataset.mood }, moodOf(b.dataset.mood).label);
  });
  $app.querySelectorAll('[data-src]').forEach((b) => { b.onclick = () => sendPhoto(b.dataset.src); });
  async function sendPhoto(src) {
    const raw = src === 'any' ? await pickPhoto() : await pickPhotoNative(src);
    if (!raw) return;
    let path;
    try {
      toast('사진 올리는 중…', 8000);
      path = await store.uploadPhoto(v.familyId, await compressImage(raw));
    } catch { return toast('사진을 보내지 못했어요. 다시 해 주세요'); }
    send({ photo: path }, '사진');
  }
  $app.querySelector('#msg').onsubmit = (e) => {
    e.preventDefault();
    const m = e.target.m.value.trim();
    if (!m) return toast('한마디를 적어 주세요');
    send({ message: m }, '한마디');
  };
}

// ───────── 시작 ─────────
(async () => {
  store = await createStore(window.HARU_CONFIG);
  window.__haru = { store };
  addEventListener('hashchange', route);
  initNative({
    onOpenHash: (h) => { if (location.hash !== h) location.hash = h; else route(); },
    onBack: () => {
      const v = document.querySelector('.photo-viewer');
      if (v) { v.remove(); return true; }
      if (location.hash && location.hash !== '#/') { history.back(); return true; }
      return false;
    },
  });
  route();
})();
