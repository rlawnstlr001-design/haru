// 안부한장 — 화면 (해시 라우팅)
//  (주소만)      소개 페이지 — 웹에서만, index.html에 정적으로 들어 있다 (앱은 건너뜀)
//  #/ · #/start  홈: 가족 방 만들기 · 최근 방
//  #/f/<가족id>  자녀 화면: 부모님의 오늘, 7일, 하트, 형제 초대, 안부 부탁
//  #/f/<가족id>/s 설정: 부모님 호칭·마감, 내 이름·알림
//  #/p/<토큰>    부모님 화면: 큰 버튼 하나 + 사진·한마디(선택) + 받은 하트
import { createStore, me, recentFamilies, localTz } from './store.js?v=202610040956';
import { esc, toast, share as webShare, pickPhoto, compressImage, joinNames, josa, timeLabel } from './util.js?v=202610040956';
import { isApp, siteBase, nativeShare, haptic, pickPhotoNative, registerPush, initNative } from './native.js?v=202610040956';

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
    $app.innerHTML = `<div class="empty">${esc(e.message)}<br><br><a href="#/">처음으로</a></div>`;
  }
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

    <section class="today-wrap">
      ${today.length ? today.map((c) => todayCard(c, f, myId)).join('')
        : `<article class="polaroid ${late ? 'late' : ''}">
            <div class="face empty"><span class="e">${late ? '📞' : '🌤'}</span></div>
            <div class="caption">
              <p class="note">${late ? `${esc(josa(P, '이/가'))} 아직 소식이 없어요` : '오늘의 한 장을 기다리는 중이에요'}</p>
              <p class="muted small">${late ? `마감 ${esc(f.deadline)}이 지났어요. 전화 한 통 어떠세요?` : `마감 ${esc(f.deadline)} · 부탁하면 대부분 금방 보내 주세요`}</p>
            </div>
          </article>
          <button class="btn primary block" id="ask">💌 오늘 안부 부탁하기</button>`}
    </section>

    <section class="block">
      <h2>이번 주<span>7일 중 ${days.filter((d) => d.ok).length}일 소식</span></h2>
      <div class="stamps">${days.map((d) => `<div class="stamp ${d.ok ? 'ok' : ''} ${d.isToday ? 'today' : ''}"><i>${d.ok ? '✓' : ''}</i><span>${d.label}</span></div>`).join('')}</div>
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
  $app.querySelector('#invite')?.addEventListener('click', invite);
  $app.querySelector('#invite2')?.addEventListener('click', invite);
  $app.querySelector('#ask')?.addEventListener('click', () => {
    store.log(fid, 'ask_shared');
    share({ text: `${P}, 오늘 하루 어떠세요? 😊\n버튼 한 번만 눌러 주세요 💛`, url: parentLink(f.parentToken) }, '부탁 메시지를 복사했어요');
  });
  $app.querySelector('a[aria-label="설정"]').addEventListener('click', () => sessionStorage.setItem('haru:settingsFrom', fid));
  bindHearts(f, myId);
  loadPhotos();
  if (isApp && !sessionStorage.getItem(`haru:push:${fid}`)) {
    sessionStorage.setItem(`haru:push:${fid}`, '1');
    registerPush((token, plat) => store.registerPush(fid, myId, token, plat));
  }
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

// ───────── 설정 ─────────
async function renderSettings(fid) {
  const f = await store.getFamily(fid);
  const myId = me.get(fid);
  const mine = f.members.find((m) => m.id === myId);
  if (!mine) { location.replace(`#/f/${fid}`); return; }
  const tz = localTz();
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
      </section>
      <button class="btn primary block" style="margin-top:18px">저장</button>
    </form>`;

  const form = $app.querySelector('#settings');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const parentName = form.parentName.value.trim();
      const deadline = form.deadline.value;
      if (parentName !== f.parentName || deadline !== f.deadline) await store.updateFamily(fid, { parentName, deadline });
      await store.updateMember(fid, myId, {
        name: form.myName.value.trim(), notifyCheckin: form.notifyCheckin.checked, notifyLate: form.notifyLate.checked,
      });
      toast('저장했어요');
      // 가족 화면의 ⚙로 들어왔으면 뒤로(기록이 쌓이지 않게), 링크로 바로 왔으면 가족 화면으로
      if (sessionStorage.getItem('haru:settingsFrom') === fid) history.back();
      else location.replace(`#/f/${fid}`);
    } catch (err) { toast(err.message); btn.disabled = false; }
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

  const photos = v.todayCheckins.filter((c) => c.photo);
  $app.innerHTML = `
    <div class="parent">
      <p class="date">${esc(dateLabel(v.today))}</p>
      <h1 class="greet">${esc(v.parentName)},<br>오늘 하루 어떠세요?</h1>
      ${sent ? `<section class="sent-card ${justSent ? 'pop' : ''}">
          ${photos.length ? `<div class="sent-photos">${photos.map((c) => `<img class="photo" data-photo="${esc(c.photo)}" alt="보낸 사진">`).join('')}</div>` : ''}
          <p class="sent-title">💛 ${esc(kids)}에게 전했어요</p>
          ${hearts.length ? `<p class="hearts">❤️ ${esc(joinNames([...hearts.slice(0, -1), josa(hearts.at(-1), '이/가')]))} 하트를 보냈어요</p>` : '<p class="muted">곧 하트가 올 거예요</p>'}
        </section>` : ''}
      <p class="ask">${sent ? '더 보내고 싶으시면 눌러 주세요' : '아래에서 하나만 눌러 주세요'}</p>
      <div class="mood-tiles">${MOODS.map((m) => `<button class="mood-tile ${m.id}" data-mood="${m.id}"><span class="e">${m.emoji}</span><span>${m.label}</span></button>`).join('')}</div>
      <div class="photo-btns ${isApp ? 'two' : ''}">${isApp
        ? '<button class="big-btn" data-src="camera">📷 사진 찍기</button><button class="big-btn" data-src="gallery">🖼 앨범에서</button>'
        : '<button class="big-btn" data-src="any">📷 사진 한 장 보내기</button>'}</div>
      <form id="msg" class="note-form">
        <label for="msg-m">✉️ 한마디</label>
        <textarea id="msg-m" name="m" maxlength="100" rows="2" placeholder="예: 오늘 장 보고 왔다"></textarea>
        <button class="btn primary">보내기</button>
      </form>
      ${v.streak ? `<p class="streak">이번 주 <b>${v.streak}일</b> 소식을 보내셨어요 👏</p>` : ''}
      ${isApp ? '' : '<p class="tip">💡 매일 쉽게 여시려면: 크롬 메뉴 ⋮ → <b>홈 화면에 추가</b></p>'}
    </div>`;
  loadPhotos();

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
