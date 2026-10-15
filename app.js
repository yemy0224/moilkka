import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ─────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────
const COLORS = ['#DCEBFF', '#FFE8CC', '#E3F5E6', '#FCE4EC', '#EDE7F6', '#E5E5EA'];
const COLOR_NAMES = ['하늘색', '살구색', '연두색', '분홍색', '연보라', '회색'];
const SLOT = { L: '점심', D: '저녁' };
const TIMES = { L: ['오전 11시', '오후 12시', '오후 1시'], D: ['오후 5시', '오후 5시 반', '오후 6시'] };
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const ROOM_FROM = 8;   // 자동 방은 오늘로부터 8일 뒤부터
const ROOM_TO = 14;    // 14일 뒤까지

const state = {
  view: 'loading',
  tab: 'home',
  session: null,
  me: null,          // 내 members 행
  group: null,
  members: [],
  rooms: [],
  mine: new Set(),   // 'YYYY-MM-DD|L'
  counts: {},        // 'YYYY-MM-DD|L' -> 친구 수
  progress: [],
  brush: 'D',
  roomId: null,
  onb: { role: null, code: '', peek: null, codeError: '', name: '', color: COLORS[0], groupName: '49th', threshold: 3 },
  newRoom: null,
  busy: false,
  error: '',
};

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

// ─────────────────────────────────────────────
// 날짜 도우미 (한국 시간 기준)
// ─────────────────────────────────────────────
const fmtYmd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const today = () => fmtYmd.format(new Date());
const toDate = (ymd) => new Date(ymd + 'T00:00:00Z');
const addDays = (ymd, n) => { const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (ymd) => toDate(ymd).getUTCDay();
const md = (ymd) => ({ m: Number(ymd.slice(5, 7)), d: Number(ymd.slice(8, 10)) });
const longDate = (ymd) => { const { m, d } = md(ymd); return `${m}월 ${d}일 ${WD[dow(ymd)]}요일`; };
const diffDays = (ymd) => Math.round((toDate(ymd) - toDate(today())) / 864e5);
const deadlineText = (iso) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: true })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${parts.month}월 ${parts.day}일 ${parts.dayPeriod || ''} ${parts.hour}시 마감`.replace(/\s+/g, ' ');
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (name) => esc((name || '?').trim().slice(0, 1));

// ─────────────────────────────────────────────
// 아이콘
// ─────────────────────────────────────────────
const ic = {
  home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10.5 12 3.5l8.5 7V20a.5.5 0 0 1-.5.5h-5V15H9v5.5H4a.5.5 0 0 1-.5-.5z"/></svg>',
  cal: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  gear: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  chev: '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  mail: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#248A3D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>',
};

const appIcon = (size) => `<div class="app-icon" style="width:${size}px;height:${size}px" aria-hidden="true"><div class="cap"><i></i><i></i></div><b style="font-size:${Math.round(size * 0.17)}px">49th</b></div>`;
const avatar = (name, color, size = 30) => `<span class="avatar" style="width:${size}px;height:${size}px;background:${esc(color)};font-size:${Math.round(size * 0.4)}px">${initial(name)}</span>`;

// ─────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────
const app = document.getElementById('app');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function errText(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/wrong code/.test(m)) return '초대 번호를 다시 확인해주세요';
  if (/group full/.test(m)) return '이 그룹은 이미 8명이 꽉 찼어요';
  if (/Anonymous sign-ins are disabled/i.test(m)) return 'Supabase에서 익명 로그인을 켜야 해요 (README 참고)';
  if (/room expired/.test(m)) return '응답 마감이 지난 방이에요';
  if (/only the owner/.test(m)) return '방장만 바꿀 수 있어요';
  if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인해주세요';
  return '문제가 생겼어요: ' + m;
}

async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  try { await fn(); } catch (e) { console.error(e); toast(errText(e)); } finally { state.busy = false; }
}

async function share(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('복사했어요. 단톡방에 붙여넣어 주세요'); }
  catch { toast(text); }
}

function go(view, extra = {}) {
  Object.assign(state, extra, { view });
  render();
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────
// 데이터
// ─────────────────────────────────────────────
async function ensureSession() {
  if (state.session) return;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  state.session = data.session;
}

async function loadMe() {
  const uid = state.session?.user?.id;
  if (!uid) return false;
  const { data, error } = await sb.from('members').select('*, groups(*)').eq('user_id', uid).limit(1);
  if (error) throw error;
  if (!data || data.length === 0) { state.me = null; state.group = null; return false; }
  const row = data[0];
  state.group = row.groups;
  delete row.groups;
  state.me = row;
  return true;
}

async function loadGroupData() {
  if (!state.group) return;
  const gid = state.group.id;
  const from = today();
  const to = addDays(from, 34);
  // 날짜가 지나 8~14일 창에 들어온 시간도 방이 생기도록 다시 확인
  await sb.rpc('recheck_rooms', { p_group: gid }).then(({ error }) => { if (error) console.warn(error); });
  const [g, mem, rooms, mine, counts, prog] = await Promise.all([
    sb.from('groups').select('*').eq('id', gid).single(),
    sb.from('members').select('id,name,color,user_id').eq('group_id', gid).order('created_at'),
    sb.from('rooms').select('id,kind,title,day,slot,time_label,status,reply_deadline,created_by,room_members(member_id,status)').eq('group_id', gid).gte('day', from).order('day'),
    sb.from('availability').select('day,slot').eq('member_id', state.me.id).gte('day', from),
    sb.rpc('availability_counts', { p_group: gid, p_from: from, p_to: to }),
    sb.rpc('group_progress', { p_group: gid }),
  ]);
  for (const r of [g, mem, rooms, mine, counts, prog]) if (r.error) throw r.error;
  state.group = g.data;
  state.members = mem.data;
  state.rooms = rooms.data;
  state.mine = new Set(mine.data.map((a) => `${a.day}|${a.slot}`));
  state.counts = Object.fromEntries(counts.data.map((c) => [`${c.day}|${c.slot}`, c.others]));
  state.progress = prog.data;
}

let reloadTimer = null;
function softReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => run(async () => {
    if (!state.me) return;
    await loadGroupData();
    if (['main', 'room'].includes(state.view)) render();
  }), 300);
}

let channel = null;
function subscribe() {
  if (channel || !state.group) return;
  channel = sb.channel('49th-' + state.group.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `group_id=eq.${state.group.id}` }, softReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members' }, softReload)
    .subscribe();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') softReload(); });

const memberById = (id) => state.members.find((m) => m.id === id);
const myStatus = (room) => room.room_members.find((r) => r.member_id === state.me.id)?.status;
const joinedCount = (room) => room.room_members.filter((r) => r.status === 'joined').length;
const needCount = (room) => (room.kind === 'auto' ? state.group.threshold : room.room_members.length);
const roomTitle = (room) => `${longDate(room.day)} ${SLOT[room.slot]}`;
const liveRooms = () => state.rooms.filter((r) => !(r.status === 'open' && new Date(r.reply_deadline) < new Date()));

// ─────────────────────────────────────────────
// 화면: 설치 안내
// ─────────────────────────────────────────────
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function viewInstall() {
  const ios = state.installOs ? state.installOs === 'ios' : isIOS();
  const step = (n, title, sub) => `<li><span class="n">${n}</span><span><b>${title}</b><small>${sub}</small></span></li>`;
  return `
  <main class="screen white center" style="padding-top:calc(36px + var(--safe-top))">
    ${appIcon(72)}
    <div class="stack-sm">
      <h1 class="title-md">홈 화면에 추가해주세요</h1>
      <p class="sub" style="white-space:pre-line">홈 화면 앱으로 열어야
초대장 알림을 받을 수 있어요</p>
    </div>
    <div class="seg" style="width:100%" role="group" aria-label="기기">
      <button data-act="installOs" data-os="ios" aria-pressed="${ios}">아이폰</button>
      <button data-act="installOs" data-os="and" aria-pressed="${!ios}">안드로이드</button>
    </div>
    <ol class="steps" style="width:100%">
      ${ios
        ? step(1, '카톡에서 열었다면 Safari로 열기', '카톡 화면의 메뉴에서 "다른 브라우저로 열기"를 눌러요. 카톡 안에서는 추가가 안 돼요.')
          + step(2, '아래쪽 공유 버튼 누르기', '네모에서 화살표가 위로 나온 모양이에요')
          + step(3, '"홈 화면에 추가" 고르기', '안 보이면 목록을 아래로 내려보세요')
          + step(4, '홈 화면의 49th 아이콘으로 열기', '이 창은 닫아도 괜찮아요')
        : step(1, '카톡에서 열었다면 Chrome으로 열기', '카톡 화면의 메뉴에서 "다른 브라우저로 열기"를 눌러요.')
          + step(2, '아래 "설치하기" 누르기', '버튼이 없으면 Chrome 메뉴(⋮)에서 "홈 화면에 추가"를 눌러요')}
    </ol>
  </main>
  <div class="bottom-bar white"><div class="inner">
    ${!ios ? `<button class="btn primary" data-act="installAndroid">설치하기</button>` : ''}
    <button class="link-btn" data-act="skipInstall">그냥 브라우저에서 써볼래요</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 화면: 웰컴
// ─────────────────────────────────────────────
function viewWelcome() {
  const feat = (color, path, t, s) => `<div class="feature"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg><span><b>${t}</b><small>${s}</small></span></div>`;
  return `
  <main class="screen white center" style="padding:calc(80px + var(--safe-top)) 32px 160px;gap:44px">
    <div class="stack" style="align-items:center;gap:18px">
      ${appIcon(92)}
      <div class="stack-sm">
        <h1 class="title-lg">49th</h1>
        <p class="sub" style="font-size:15px;white-space:pre-line">되는 날만 칠해두면
약속은 알아서 잡혀요</p>
      </div>
    </div>
    <div class="stack" style="gap:24px;width:100%">
      ${feat('#0071E3', '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 15l2.5 2.5L16 13"/>', '될 수도 있는 시간 칠하기', '투표 열고 기다릴 필요 없이, 점심·저녁을 칠해두세요.')}
      ${feat('#FF9500', '<path d="M4 7h16v12H4z"/><path d="M4 7l8 6 8-6"/>', '겹치면 초대장이 와요', '여러 명이 되는 시간엔 방이 생겨요. 참석하거나 조용히 패스하면 끝.')}
    </div>
  </main>
  <div class="bottom-bar white"><div class="inner">
    <button class="btn primary" data-act="startHost">시작하기</button>
    <button class="link-btn" data-act="startFriend">초대 번호를 받았어요</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 화면: 초대 번호
// ─────────────────────────────────────────────
function codeBoxes() {
  const c = state.onb.code;
  const bad = !!state.onb.codeError;
  return Array.from({ length: 6 }, (_, i) => `<span class="${bad ? 'bad' : i === c.length ? 'active' : ''}">${esc(c[i] || '')}</span>`).join('');
}
function viewCode() {
  const p = state.onb.peek;
  return `
  <main class="screen">
    <button class="back" data-act="toWelcome">${ic.back}</button>
    <div class="stack-sm" style="padding:0 4px">
      <h1 class="title-md">초대 번호를 입력해주세요</h1>
      <p class="sub">친구에게 받은 6자리 번호예요</p>
    </div>
    <div class="code-boxes" id="codeBoxes">
      ${codeBoxes()}
      <input class="code-input" id="codeInput" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="초대 번호 여섯 자리" value="${esc(state.onb.code)}">
    </div>
    <div id="codeResult">${codeResult()}</div>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" data-act="codeNext" ${p ? '' : 'disabled'} id="codeNext">${p ? esc(p.name) + '에 참여하기' : '다음'}</button>
  </div></div>`;
}
function codeResult() {
  const p = state.onb.peek;
  if (state.onb.codeError) return `<p class="err">${esc(state.onb.codeError)}</p>`;
  if (!p) return '';
  return `<div class="card pad row" style="gap:12px">
      <span class="avatar" style="width:44px;height:44px;border-radius:12px;background:#1C1C1E;color:#fff;font-size:13px;font-weight:700">49th</span>
      <span class="grow stack-sm"><b>${esc(p.name)}</b><span class="meta" style="font-size:12px;color:var(--quiet)">${esc(p.owner_name || '')}님이 만든 그룹 · ${p.member_count}명 참여 중</span></span>
      ${ic.check}
    </div>`;
}

// ─────────────────────────────────────────────
// 화면: 프로필
// ─────────────────────────────────────────────
function viewProfile() {
  const o = state.onb;
  const editing = state.view === 'editProfile';
  const name = editing ? o.name : o.name;
  return `
  <main class="screen">
    <button class="back" data-act="${editing ? 'toSettings' : o.role === 'host' ? 'toWelcome' : 'toCode'}">${ic.back}</button>
    <div class="stack-sm" style="padding:0 4px">
      <h1 class="title-md">${editing ? '프로필 수정' : o.role === 'host' ? '먼저 내 프로필을 만들어요' : esc(o.peek?.name || '49th') + ' 친구들에게 보일 프로필'}</h1>
      <p class="sub">${editing ? '친구들에게 바로 반영돼요' : '설정에서 언제든 바꿀 수 있어요'}</p>
    </div>
    <div class="stack" style="align-items:center;gap:18px">
      <span id="bigAvatar">${avatar(name, o.color, 104)}</span>
      <div class="swatches" role="group" aria-label="배경색">
        ${COLORS.map((c, i) => `<button class="swatch" style="background:${c}" aria-label="${COLOR_NAMES[i]}" aria-pressed="${o.color === c}" data-act="pickColor" data-color="${c}"></button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label for="nameInput">이름</label>
      <input class="input" id="nameInput" maxlength="20" placeholder="친구들이 부르는 이름" value="${esc(name)}">
    </div>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" id="profileNext" data-act="${editing ? 'saveProfile' : 'profileNext'}" ${name.trim() ? '' : 'disabled'}>${editing ? '저장' : '다음'}</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 화면: 그룹 만들기
// ─────────────────────────────────────────────
function viewGroup() {
  const o = state.onb;
  return `
  <main class="screen">
    <button class="back" data-act="toProfile">${ic.back}</button>
    <div class="stack-sm" style="padding:0 4px">
      <h1 class="title-md">함께 모일 그룹을 만들어요</h1>
      <p class="sub">만들면 친구에게 보낼 초대 번호가 나와요</p>
    </div>
    <div class="field">
      <label for="groupInput">그룹 이름</label>
      <input class="input" id="groupInput" maxlength="30" value="${esc(o.groupName)}">
    </div>
    <div class="field">
      <span class="label">방이 생기는 기준</span>
      <div class="card row" style="min-height:52px;padding:0 12px 0 16px;justify-content:space-between">
        <span>${o.threshold}명 이상 되는 시간</span>
        <div class="stepper"><button data-act="onbThreshold" data-d="-1" aria-label="한 명 줄이기">−</button><span></span><button data-act="onbThreshold" data-d="1" aria-label="한 명 늘리기">+</button></div>
      </div>
      <p class="note">방이 생기는 인원이자 모임이 확정되는 인원이에요. 방장만 바꿀 수 있어요.</p>
    </div>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" data-act="createGroup">그룹 만들기</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 캘린더 (공통 부품)
// ─────────────────────────────────────────────
function calendar(compact = false) {
  const t = today();
  const start = addDays(t, -dow(t));       // 이번 주 일요일부터
  const weeks = compact ? 3 : 5;
  const winFrom = addDays(t, ROOM_FROM);
  const winTo = addDays(t, ROOM_TO);
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(start, i);
    const past = day < t;
    const inWin = day >= winFrom && day <= winTo;
    const l = state.mine.has(`${day}|L`);
    const d = state.mine.has(`${day}|D`);
    const others = state.counts[`${day}|${state.brush}`] || 0;
    const room = state.rooms.some((r) => r.kind === 'auto' && r.day === day);
    const { m, d: dd } = md(day);
    const tag = compact ? 'div' : 'button';
    cells += `<${tag} class="cal-cell ${inWin && !compact ? 'window' : ''} ${past ? 'past' : ''}" ${past && !compact ? 'disabled' : ''} ${compact ? '' : `data-act="paint" data-day="${day}"`}
      aria-label="${m}월 ${dd}일 ${compact ? '' : SLOT[state.brush]} ${compact ? [l ? '점심' : '', d ? '저녁' : ''].filter(Boolean).join('·') || '' : state.mine.has(`${day}|${state.brush}`) ? '칠함' : '안 칠함'}">
      ${dd === 1 ? `<span class="month">${m}월</span>` : ''}
      <span class="num ${dow(day) === 0 ? 'sun' : ''}">${dd}</span>
      <span class="capsule"><span class="${l ? 'l' : ''}"></span><span class="${d ? 'd' : ''}"></span></span>
      ${compact ? '' : `<span class="others">${'<i></i>'.repeat(Math.min(others, 6))}</span>`}
      ${room ? '<span class="room-dot"></span>' : ''}
    </${tag}>`;
  }
  return `<div class="cal ${compact ? 'mini-cal' : ''}">
    <div class="cal-week">${WD.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    ${compact ? '' : `<div class="legend">
      <span><i class="dot" style="background:var(--lunch)"></i>점심</span>
      <span><i class="dot" style="background:var(--dinner)"></i>저녁</span>
      <span><i class="dot" style="background:#AEAEB2;width:6px;height:6px"></i>${SLOT[state.brush]}에 되는 친구</span>
      <span><i class="dot" style="background:#F5F9FF;border:1px solid #D6E6F7"></i>방이 생길 수 있는 날</span>
    </div>`}
  </div>`;
}
function brushSeg() {
  return `<div class="seg" role="group" aria-label="칠할 시간대">
    <button data-act="brush" data-slot="L" aria-pressed="${state.brush === 'L'}"><i class="dot" style="background:var(--lunch)"></i>점심</button>
    <button data-act="brush" data-slot="D" aria-pressed="${state.brush === 'D'}"><i class="dot" style="background:var(--dinner)"></i>저녁</button>
  </div>`;
}

function viewFirstPaint() {
  return `
  <main class="screen">
    <div class="stack-sm" style="padding:8px 4px 0">
      <h1 class="title-md">앞으로 될 수도 있는
시간을 칠해주세요</h1>
      <p class="sub">확실하지 않아도 돼요. 언제든 바꿀 수 있어요</p>
    </div>
    ${brushSeg()}
    ${calendar()}
    <p class="note">파란 칸(8~14일 뒤)에 ${state.group.threshold}명 이상 겹치면 방이 생겨요</p>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" data-act="finishOnboarding">완료</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 메인 탭
// ─────────────────────────────────────────────
function tabbar() {
  const b = (id, label, icon) => `<button data-act="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${icon}${label}</button>`;
  return `<nav class="tabbar" aria-label="하단 메뉴"><div class="inner">${b('home', '홈', ic.home)}${b('cal', '캘린더', ic.cal)}${b('settings', '설정', ic.gear)}</div></nav>`;
}

function viewMain() {
  const body = state.tab === 'cal' ? viewCalendarTab() : state.tab === 'settings' ? viewSettings() : viewHome();
  return body + tabbar();
}

function inviteCard(room) {
  const st = myStatus(room);
  if (st === 'passed') {
    return `<div class="card row" style="padding:12px 16px;justify-content:space-between">
      <span class="sub">${esc(roomTitle(room))}은 패스했어요</span>
      <button class="link-btn" data-act="respond" data-room="${room.id}" data-status="invited">되돌리기</button>
    </div>`;
  }
  const need = needCount(room);
  const joined = joinedCount(room);
  const creator = memberById(room.created_by);
  const why = room.kind === 'auto'
    ? `${need}명 이상 될 수도 있는 시간이라 방이 생겼어요`
    : `${esc(creator?.name || '친구')}님이 초대했어요${room.title ? ' · ' + esc(room.title) : ''}${room.time_label ? ' · ' + esc(room.time_label) : ''}`;
  const bars = Array.from({ length: need }, (_, i) => `<span class="${i < joined ? 'on' : ''}"></span>`).join('');
  return `<div class="invite">
    <div class="row" style="gap:12px;align-items:flex-start">
      <span class="badge-icon" style="background:var(--warn)">${ic.mail}</span>
      <span class="grow stack-sm"><b style="font-size:15px;font-weight:600">${esc(roomTitle(room))}</b><span style="font-size:12px;color:var(--quiet)">${why}</span></span>
    </div>
    <div class="stack-sm">
      <div class="row" style="justify-content:space-between;font-size:12px"><b style="font-weight:600">${room.kind === 'auto' ? `${need}명 참석하면 확정` : '초대받은 사람이 모두 참석하면 확정'}</b><span style="color:var(--quiet)">지금 ${joined}명 · ${deadlineText(room.reply_deadline)}</span></div>
      <div class="progress" style="grid-template-columns:repeat(${need},minmax(0,1fr))">${bars}</div>
    </div>
    <div class="row">
      <button class="btn primary small" data-act="respond" data-room="${room.id}" data-status="joined">참석</button>
      <button class="btn gray small" data-act="respond" data-room="${room.id}" data-status="passed">패스</button>
    </div>
  </div>`;
}

function upcomingRow(room) {
  const { m, d } = md(room.day);
  const joined = joinedCount(room);
  const need = needCount(room);
  const pill = room.status === 'confirmed'
    ? '<span class="pill green">확정</span>'
    : `<span class="pill orange">${need - joined}명 더</span>`;
  const meta = room.kind === 'manual'
    ? [room.title, room.time_label].filter(Boolean).map(esc).join(' · ') || '직접 만든 방'
    : room.status === 'confirmed' ? `${joined}명 참석` : `확정까지 ${need - joined}명`;
  return `<button class="list-row" data-act="openRoom" data-room="${room.id}">
    <span class="datebox"><small>${m}월</small><b>${d}</b></span>
    <span class="grow stack-sm"><span class="main">${WD[dow(room.day)]}요일 ${SLOT[room.slot]} · ${joined}명</span><span class="meta">${meta}</span></span>
    ${pill}${ic.chev}
  </button>`;
}

function viewHome() {
  const rooms = liveRooms();
  const invites = rooms.filter((r) => r.status === 'open' && ['invited', 'passed'].includes(myStatus(r)));
  const upcoming = rooms.filter((r) => myStatus(r) === 'joined');
  const fresh = invites.length === 0 && upcoming.length === 0;
  const prog = state.progress;
  const painted = prog.filter((p) => p.painted).length;

  return `
  <main class="screen">
    <div class="head">
      <div class="stack-sm" style="gap:0">
        <span class="eyebrow">${(() => { const { m, d } = md(today()); return `${m}월 ${d}일 ${WD[dow(today())]}요일`; })()}</span>
        <h1 class="title-lg">${esc(state.group.name)}</h1>
      </div>
      <div class="avatars" style="padding-bottom:6px">${state.members.slice(0, 8).map((m) => avatar(m.name, m.color, 30)).join('')}</div>
    </div>

    ${fresh ? `
    <section class="stack">
      <div class="stack-sm" style="padding:0 4px"><h2 class="title-sm">친구들이 모이는 중</h2><span class="sub" style="font-size:12px">${prog.length}명 참여 · ${painted}명이 칠했어요</span></div>
      <div class="card">
        ${prog.map((p) => `<div class="list-row">${avatar(p.name, p.color, 30)}<span class="grow">${esc(p.name)}${p.is_me ? ' (나)' : ''}${p.is_owner ? ' · 방장' : ''}</span><span class="pill ${p.painted ? 'green' : 'orange'}">${p.painted ? '칠함' : '아직 안 칠함'}</span></div>`).join('')}
        <div class="list-row"><span class="grow sub" style="font-size:14px">초대 번호 <b style="color:var(--ink);letter-spacing:2px">${esc(state.group.code)}</b></span><button class="pill blue" style="border:none;font-size:13px;padding:8px 14px" data-act="shareCode">공유</button></div>
      </div>
    </section>
    <div class="card pad row" style="gap:14px;align-items:flex-start">
      <span class="badge-icon" style="background:var(--warn)">${ic.mail}</span>
      <span class="grow stack-sm"><b style="font-weight:600">아직 초대장이 없어요</b><span class="sub" style="font-size:13px">8~14일 뒤 같은 시간대를 ${state.group.threshold}명 이상 칠하면 여기로 초대장이 와요.</span></span>
    </div>` : ''}

    ${invites.length ? `<section class="stack"><h2 class="title-sm" style="padding:0 4px">초대장</h2>${invites.map(inviteCard).join('')}</section>` : ''}

    <section class="stack">
      <div class="head" style="align-items:center"><h2 class="title-sm">다가오는 모임</h2><button class="link-btn" data-act="newRoom">${ic.plus}새 방</button></div>
      <div class="card">${upcoming.length ? upcoming.map(upcomingRow).join('') : '<div class="empty">참석하기로 한 모임이 아직 없어요</div>'}</div>
    </section>

    <section class="stack">
      <div class="head" style="align-items:center"><h2 class="title-sm">내 일정</h2><button class="link-btn" data-act="tab" data-tab="cal">편집</button></div>
      ${calendar(true)}
    </section>
  </main>`;
}

function viewCalendarTab() {
  const t = today();
  const coming = state.rooms.filter((r) => r.kind === 'auto' && r.day >= addDays(t, ROOM_FROM));
  return `
  <main class="screen">
    <div class="stack-sm" style="gap:0;padding:0 4px">
      <span class="eyebrow">될 수도 있는 시간을 가볍게 칠해요</span>
      <h1 class="title-lg">캘린더</h1>
    </div>
    ${brushSeg()}
    <div class="stack-sm">
      ${calendar()}
      <p class="note">파란 칸(8~14일 뒤)에 ${state.group.threshold}명 이상 겹치면 방이 생겨요 · 더 가까운 날은 홈의 '새 방'으로</p>
    </div>
    ${coming.length ? `<section class="stack"><h2 class="title-sm" style="padding:0 4px">생긴 방</h2><div class="card">${coming.map((r) => `<button class="list-row" data-act="tab" data-tab="home"><span class="grow">${esc(roomTitle(r))}</span><span class="pill ${r.status === 'confirmed' ? 'green' : 'orange'}">${r.status === 'confirmed' ? '확정' : '초대 중'}</span>${ic.chev}</button>`).join('')}</div></section>` : ''}
  </main>`;
}

// ─────────────────────────────────────────────
// 방 상세
// ─────────────────────────────────────────────
function viewRoom() {
  const room = state.rooms.find((r) => r.id === state.roomId);
  if (!room) return `<main class="screen"><button class="back" data-act="toHome">${ic.back}홈</button><p class="empty">이 방은 없어졌어요</p></main>`;
  const st = myStatus(room);
  const joined = room.room_members.filter((r) => r.status === 'joined').map((r) => memberById(r.member_id)).filter(Boolean);
  const waiting = room.room_members.filter((r) => r.status === 'invited').map((r) => memberById(r.member_id)).filter(Boolean);
  const dd = diffDays(room.day);
  return `
  <main class="screen" style="gap:16px">
    <div class="topbar">
      <button class="back" data-act="toHome">${ic.back}홈</button>
      <div class="row">
        <button class="icon-btn" style="color:var(--accent)" aria-label="단톡방에 공유" data-act="shareRoom" data-room="${room.id}">${ic.share}</button>
        ${st !== 'passed' ? `<button class="icon-btn" aria-label="방 없애기" data-act="deleteRoom" data-room="${room.id}">${ic.x}</button>` : ''}
      </div>
    </div>
    <div class="stack-sm" style="padding:0 4px">
      <h1 class="title-md">${esc(room.title || roomTitle(room))}</h1>
      <span class="sub" style="font-size:13px">${room.title ? esc(roomTitle(room)) + ' · ' : ''}${room.time_label ? esc(room.time_label) + ' · ' : ''}${dd === 0 ? '오늘' : `D-${dd}`} · ${room.status === 'confirmed' ? '확정' : `확정까지 ${needCount(room) - joined.length}명`}</span>
    </div>
    <div class="card">
      <div class="list-row"><span class="grow main">참석 ${joined.length}명</span><div class="avatars">${joined.map((m) => avatar(m.name, m.color, 28)).join('')}</div></div>
      ${waiting.length ? `<div class="list-row"><span class="grow meta">아직 답 안 한 사람 ${waiting.length}명</span></div>` : ''}
      ${room.status === 'open' ? `<div class="list-row"><span class="grow meta">${deadlineText(room.reply_deadline)} · 그때까지 안 모이면 조용히 사라져요</span></div>` : ''}
    </div>
    <p class="note">초대받은 사람만 이 방을 볼 수 있어요. 시간과 식당 정하기는 다음 업데이트에 들어가요.</p>
    ${st === 'joined' ? `<button class="btn danger" data-act="leaveRoom" data-room="${room.id}">참석 취소</button>` : ''}
    ${st === 'invited' ? `<div class="row"><button class="btn primary small" data-act="respond" data-room="${room.id}" data-status="joined">참석</button><button class="btn white small" data-act="respond" data-room="${room.id}" data-status="passed">패스</button></div>` : ''}
  </main>`;
}

// ─────────────────────────────────────────────
// 직접 방 만들기
// ─────────────────────────────────────────────
function viewNewRoom() {
  const n = state.newRoom;
  const friends = state.members.filter((m) => m.id !== state.me.id);
  const count = n.invitees.size;
  return `
  <main class="screen" style="gap:16px">
    <div class="topbar"><button class="back" data-act="toHome">취소</button><b>새 방</b><span style="width:40px"></span></div>
    <div class="field"><label for="roomTitle">방 이름</label><input class="input" id="roomTitle" maxlength="30" placeholder="예: 전시 보러 가기" value="${esc(n.title)}"></div>
    <div class="field"><span class="label">초대할 친구</span>
      <div class="card">${friends.length ? friends.map((f) => `<button class="list-row" role="checkbox" aria-checked="${n.invitees.has(f.id)}" data-act="toggleInvitee" data-id="${f.id}">${avatar(f.name, f.color, 30)}<span class="grow">${esc(f.name)}</span><span class="avatar" style="width:24px;height:24px;${n.invitees.has(f.id) ? 'background:var(--accent);color:#fff' : 'border:1.5px solid #C7C7CC'};font-size:12px">${n.invitees.has(f.id) ? '✓' : ''}</span></button>`).join('') : '<div class="empty">아직 들어온 친구가 없어요</div>'}</div>
    </div>
    <div class="field"><label for="roomDay">날짜</label><input class="input" type="date" id="roomDay" min="${today()}" value="${esc(n.day)}"></div>
    <div class="field"><span class="label">시간</span>
      <div class="seg"><button data-act="nrSlot" data-slot="L" aria-pressed="${n.slot === 'L'}">점심</button><button data-act="nrSlot" data-slot="D" aria-pressed="${n.slot === 'D'}">저녁</button></div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:4px">
        ${TIMES[n.slot].map((t, i) => `<button class="btn small ${n.time === i ? 'primary' : 'white'}" data-act="nrTime" data-i="${i}">${t}</button>`).join('')}
      </div>
    </div>
    <p class="note">초대한 친구만 이 방을 볼 수 있고, 모두 참석하면 확정돼요</p>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" data-act="createRoom" ${count && n.day ? '' : 'disabled'}>${count ? `${count}명에게 초대 보내기` : '친구를 골라주세요'}</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
function viewSettings() {
  const owner = state.group.owner_id === state.session.user.id;
  const ownerName = state.progress.find((p) => p.is_owner)?.name || '방장';
  return `
  <main class="screen" style="gap:18px">
    <h1 class="title-lg" style="padding:0 4px">설정</h1>
    <button class="card list-row" data-act="editProfile">${avatar(state.me.name, state.me.color, 56)}<span class="grow stack-sm"><span class="main" style="font-size:17px">${esc(state.me.name)}</span><span class="meta">프로필 사진 색, 이름</span></span>${ic.chev}</button>
    <div class="stack-sm">
      <span class="note">${esc(state.group.name)} · ${state.members.length}명</span>
      <div class="card">
        <div class="list-row"><span class="grow">초대 번호</span><b style="letter-spacing:2px">${esc(state.group.code)}</b><button class="pill blue" style="border:none;font-size:12px;padding:6px 12px" data-act="shareCode">공유</button></div>
        <div class="list-row"><span class="grow">방이 생기는 기준</span><span class="sub">${state.group.threshold}명 이상</span>
          ${owner ? `<div class="stepper"><button data-act="setThreshold" data-d="-1" aria-label="한 명 줄이기">−</button><span></span><button data-act="setThreshold" data-d="1" aria-label="한 명 늘리기">+</button></div>` : ic.lock}
        </div>
      </div>
      <p class="note">${owner ? '방이 생기는 인원이자 확정 인원이에요' : `방장(${esc(ownerName)})만 바꿀 수 있어요`}</p>
    </div>
    <div class="stack-sm">
      <span class="note">멤버</span>
      <div class="card">${state.members.map((m) => `<div class="list-row">${avatar(m.name, m.color, 30)}<span class="grow">${esc(m.name)}</span></div>`).join('')}</div>
    </div>
    <div class="stack-sm">
      <p class="note">이 기기에서만 로그인돼 있어요. 앱을 지우거나 브라우저 데이터를 지우면 초대 번호로 다시 들어와야 해요.</p>
    </div>
    <button class="btn danger" data-act="leaveGroup">${esc(state.group.name)} 나가기</button>
  </main>`;
}

// ─────────────────────────────────────────────
// 렌더링
// ─────────────────────────────────────────────
function render() {
  const v = state.view;
  const html =
    v === 'install' ? viewInstall()
    : v === 'welcome' ? viewWelcome()
    : v === 'code' ? viewCode()
    : v === 'profile' || v === 'editProfile' ? viewProfile()
    : v === 'group' ? viewGroup()
    : v === 'firstPaint' ? viewFirstPaint()
    : v === 'main' ? viewMain()
    : v === 'room' ? viewRoom()
    : v === 'newRoom' ? viewNewRoom()
    : '<div class="loading">불러오는 중…</div>';
  app.innerHTML = html;
  if (v === 'code') setTimeout(() => document.getElementById('codeInput')?.focus(), 50);
}

// ─────────────────────────────────────────────
// 입력 처리
// ─────────────────────────────────────────────
app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'codeInput') {
    const v = t.value.replace(/\D/g, '').slice(0, 6);
    t.value = v;
    state.onb.code = v;
    state.onb.peek = null;
    state.onb.codeError = '';
    refreshCode();
    if (v.length === 6) run(async () => {
      await ensureSession();
      const { data, error } = await sb.rpc('peek_group', { p_code: v });
      if (error) throw error;
      if (!data || data.length === 0) state.onb.codeError = '초대 번호를 다시 확인해주세요';
      else state.onb.peek = data[0];
      refreshCode();
    });
  }
  if (t.id === 'nameInput') {
    state.onb.name = t.value;
    const btn = document.getElementById('profileNext');
    if (btn) btn.disabled = !t.value.trim();
    const big = document.getElementById('bigAvatar');
    if (big) big.innerHTML = avatar(t.value, state.onb.color, 104);
  }
  if (t.id === 'groupInput') state.onb.groupName = t.value;
  if (t.id === 'roomTitle') state.newRoom.title = t.value;
  if (t.id === 'roomDay') { state.newRoom.day = t.value; render(); }
});

function refreshCode() {
  const boxes = document.getElementById('codeBoxes');
  if (!boxes) return;
  // 입력칸은 그대로 두고 숫자 칸만 바꿔요 (포커스 유지)
  const c = state.onb.code;
  const bad = !!state.onb.codeError;
  boxes.querySelectorAll('span').forEach((s, i) => {
    s.textContent = c[i] || '';
    s.className = bad ? 'bad' : i === c.length ? 'active' : '';
  });
  document.getElementById('codeResult').innerHTML = codeResult();
  const next = document.getElementById('codeNext');
  const p = state.onb.peek;
  next.disabled = !p;
  next.textContent = p ? `${p.name}에 참여하기` : '다음';
}

const actions = {
  installOs: (el) => { state.installOs = el.dataset.os; render(); },
  installAndroid: async () => {
    if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; }
    else toast('Chrome 메뉴(⋮)에서 "홈 화면에 추가"를 눌러주세요');
  },
  skipInstall: () => { sessionStorage.setItem('skipInstall', '1'); boot(); },

  startHost: () => { state.onb.role = 'host'; go('profile'); },
  startFriend: () => { state.onb.role = 'friend'; go('code'); },
  toWelcome: () => go('welcome'),
  toCode: () => go('code'),
  toProfile: () => go('profile'),
  toHome: () => { state.tab = 'home'; go('main'); },
  toSettings: () => { state.tab = 'settings'; go('main'); },

  codeNext: () => { if (state.onb.peek) go('profile'); },
  pickColor: (el) => {
    state.onb.color = el.dataset.color;
    document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.color === state.onb.color)));
    const big = document.getElementById('bigAvatar');
    if (big) big.innerHTML = avatar(state.onb.name, state.onb.color, 104);
  },
  profileNext: () => run(async () => {
    const name = state.onb.name.trim();
    if (!name) return;
    if (state.onb.role === 'host') { go('group'); return; }
    await ensureSession();
    await sb.rpc('join_group', { p_code: state.onb.code, p_my_name: name, p_color: state.onb.color }).then(({ error }) => { if (error) throw error; });
    await afterJoin();
  }),
  onbThreshold: (el) => { state.onb.threshold = Math.min(7, Math.max(2, state.onb.threshold + Number(el.dataset.d))); render(); },
  createGroup: () => run(async () => {
    const gname = state.onb.groupName.trim() || '49th';
    await ensureSession();
    const { error } = await sb.rpc('create_group', { p_group_name: gname, p_threshold: state.onb.threshold, p_my_name: state.onb.name.trim(), p_color: state.onb.color });
    if (error) throw error;
    await afterJoin();
  }),
  finishOnboarding: () => { state.tab = 'home'; go('main'); },

  tab: (el) => { state.tab = el.dataset.tab; go('main'); },
  brush: (el) => { state.brush = el.dataset.slot; render(); },
  paint: (el) => run(async () => {
    const day = el.dataset.day;
    const key = `${day}|${state.brush}`;
    const on = state.mine.has(key);
    if (on) state.mine.delete(key); else state.mine.add(key);
    render();
    const q = on
      ? sb.from('availability').delete().match({ member_id: state.me.id, day, slot: state.brush })
      : sb.from('availability').insert({ member_id: state.me.id, group_id: state.group.id, day, slot: state.brush });
    const { error } = await q;
    if (error) { if (on) state.mine.add(key); else state.mine.delete(key); render(); throw error; }
    if (!on) softReload();
  }),

  respond: (el) => run(async () => {
    const { data, error } = await sb.rpc('respond_room', { p_room: el.dataset.room, p_status: el.dataset.status });
    if (error) throw error;
    if (data === 'confirmed') toast('확정됐어요!');
    if (data === 'deleted') { toast('방이 없어졌어요'); state.view = 'main'; }
    await loadGroupData();
    render();
  }),
  openRoom: (el) => go('room', { roomId: el.dataset.room }),
  leaveRoom: (el) => {
    const room = state.rooms.find((r) => r.id === el.dataset.room);
    const msg = room?.status === 'confirmed'
      ? '확정된 모임이라 취소하면 방이 없어지고 모두에게서 사라져요. 취소할까요?'
      : '참석을 취소할까요?';
    if (!confirm(msg)) return;
    run(async () => {
      const { data, error } = await sb.rpc('respond_room', { p_room: el.dataset.room, p_status: 'passed' });
      if (error) throw error;
      toast(data === 'deleted' ? '방이 없어졌어요' : '참석을 취소했어요');
      await loadGroupData();
      state.tab = 'home';
      go('main');
    });
  },
  deleteRoom: (el) => {
    if (!confirm('이 방을 없앨까요? 참석자 모두에게서 사라지고 되돌릴 수 없어요.')) return;
    run(async () => {
      const { error } = await sb.rpc('delete_room', { p_room: el.dataset.room });
      if (error) throw error;
      toast('방을 없앴어요');
      await loadGroupData();
      state.tab = 'home';
      go('main');
    });
  },
  shareRoom: (el) => {
    const room = state.rooms.find((r) => r.id === el.dataset.room);
    if (!room) return;
    const names = room.room_members.filter((r) => r.status === 'joined').map((r) => memberById(r.member_id)?.name).filter(Boolean);
    share(`[49th] ${room.title ? room.title + ' · ' : ''}${roomTitle(room)}${room.time_label ? ' ' + room.time_label : ''}\n참석: ${names.join(', ')}\n${location.origin}`);
  },

  newRoom: () => {
    state.newRoom = { title: '', invitees: new Set(), day: addDays(today(), 1), slot: 'D', time: 1 };
    go('newRoom');
  },
  toggleInvitee: (el) => { const s = state.newRoom.invitees; if (s.has(el.dataset.id)) s.delete(el.dataset.id); else s.add(el.dataset.id); render(); },
  nrSlot: (el) => { state.newRoom.slot = el.dataset.slot; render(); },
  nrTime: (el) => { state.newRoom.time = Number(el.dataset.i); render(); },
  createRoom: () => run(async () => {
    const n = state.newRoom;
    const { error } = await sb.rpc('create_manual_room', {
      p_group: state.group.id, p_title: n.title.trim(), p_day: n.day, p_slot: n.slot,
      p_time: TIMES[n.slot][n.time], p_invitees: [...n.invitees],
    });
    if (error) throw error;
    toast('초대를 보냈어요');
    await loadGroupData();
    state.tab = 'home';
    go('main');
  }),

  shareCode: () => share(`[49th] 같이 약속 잡자! 앱 열고 초대 번호 ${state.group.code} 입력해줘\n${location.origin}`),
  setThreshold: (el) => run(async () => {
    const n = Math.min(7, Math.max(2, state.group.threshold + Number(el.dataset.d)));
    if (n === state.group.threshold) return;
    const { error } = await sb.rpc('set_threshold', { p_group: state.group.id, p_threshold: n });
    if (error) throw error;
    state.group.threshold = n;
    render();
  }),
  editProfile: () => { state.onb.name = state.me.name; state.onb.color = state.me.color; go('editProfile'); },
  saveProfile: () => run(async () => {
    const name = state.onb.name.trim();
    const { error } = await sb.from('members').update({ name, color: state.onb.color }).eq('id', state.me.id);
    if (error) throw error;
    state.me.name = name;
    state.me.color = state.onb.color;
    await loadGroupData();
    toast('저장했어요');
    state.tab = 'settings';
    go('main');
  }),
  leaveGroup: () => {
    if (!confirm(`${state.group.name}에서 나갈까요? 내가 칠한 시간과 참석 기록이 모두 지워져요.`)) return;
    run(async () => {
      const { error } = await sb.rpc('leave_group', { p_group: state.group.id });
      if (error) throw error;
      if (channel) { sb.removeChannel(channel); channel = null; }
      state.me = null; state.group = null;
      go('welcome');
    });
  },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

async function afterJoin() {
  const ok = await loadMe();
  if (!ok) throw new Error('그룹을 불러오지 못했어요');
  await loadGroupData();
  subscribe();
  go('firstPaint');
}

// ─────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────
async function boot() {
  if (isMobile() && !isStandalone() && !sessionStorage.getItem('skipInstall')) { go('install'); return; }
  try {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    if (state.session && (await loadMe())) {
      await loadGroupData();
      subscribe();
      state.tab = 'home';
      go('main');
      return;
    }
    go('welcome');
  } catch (e) {
    console.error(e);
    app.innerHTML = `<main class="screen"><h1 class="title-md">연결하지 못했어요</h1><p class="sub">${esc(errText(e))}</p><button class="btn primary" onclick="location.reload()">다시 시도</button></main>`;
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
