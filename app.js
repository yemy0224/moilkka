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
  places: [],
  detail: null,          // 방 상세: 시간 투표 수, 식당 순위, 내 표
  showOthers: false,
  placeForm: null,
  busy: false,
  error: '',
  push: 'unknown',   // 이 기기 알림: on | off | denied | unsupported | needInstall
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
  bell: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  fork: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 3c-2 0-3 2-3 5s1 4 3 4v9"/></svg>',
  heart: (on) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`,
  pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  tick: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  checkSm: '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bolt: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/></svg>',
  more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>',
  pen: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/></svg>',
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

// 앱 스타일 확인 창 (브라우저 기본 창 대신)
function ask(title, body = '', { ok = '확인', cancel = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'ask-wrap';
    wrap.innerHTML = `
      <div class="ask-back"></div>
      <div class="ask" role="alertdialog" aria-modal="true" aria-labelledby="askTitle">
        <div class="ask-text"><b id="askTitle">${esc(title)}</b>${body ? `<p>${esc(body)}</p>` : ''}</div>
        <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ok>${esc(ok)}</button>
        <button class="btn white" data-cancel>${esc(cancel)}</button>
      </div>`;
    const done = (v, fromPop = false) => {
      askCancel = null;
      if (!fromPop) popNav();
      wrap.classList.add('out'); setTimeout(() => wrap.remove(), 160); resolve(v);
    };
    askCancel = (fromPop) => done(false, fromPop);
    pushNav();
    wrap.querySelector('[data-ok]').onclick = () => done(true);
    wrap.querySelector('[data-cancel]').onclick = () => done(false);
    wrap.querySelector('.ask-back').onclick = () => done(false);
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('in'));
    wrap.querySelector('[data-cancel]').focus();
  });
}

function errText(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/wrong code/.test(m)) return '초대 번호를 다시 확인해주세요';
  if (/group full/.test(m)) return '이 그룹은 이미 8명이 꽉 찼어요';
  if (/Anonymous sign-ins are disabled/i.test(m)) return 'Supabase에서 익명 로그인을 켜야 해요 (README 참고)';
  if (/room expired/.test(m)) return '응답 마감이 지난 방이에요';
  if (/only the owner/.test(m)) return '방장만 바꿀 수 있어요';
  if (/voting closed/.test(m)) return '투표가 이미 마감됐어요';
  if (/leave instead/.test(m)) return '확정된 모임은 없앨 수 없어요. 참석 취소를 눌러주세요';
  if (/join first/.test(m)) return '참석한 사람만 할 수 있어요';
  if (/only the person who added/.test(m)) return '담은 사람만 지울 수 있어요';
  if (/places_url_check/.test(m)) return '네이버 지도 링크만 담을 수 있어요';
  if (/push not ready/.test(m)) return '알림 서버를 준비 중이에요. 1분 뒤에 다시 눌러주세요';
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

// 뒤로가기: 하위 화면·열린 창은 기록을 남겨서 휴대폰 뒤로가기로 닫혀요 (앱이 꺼지지 않게)
const SUB_VIEWS = ['room', 'newRoom', 'addPlace', 'editProfile'];
let navDepth = 0;
let pendingBack = 0;
let popSkip = 0;
let overlayPushed = false;
let askCancel = null;
function pushNav() { history.pushState({ nav: Date.now() }, ''); navDepth++; }
function popNav() {
  if (navDepth <= 0) return;
  navDepth--;
  if (!pendingBack) setTimeout(() => { const n = pendingBack; pendingBack = 0; popSkip++; history.go(-n); }, 0);
  pendingBack++;
}
function syncOverlayNav() {
  const open = !!(state.selDay || state.quickOpen);
  if (open && !overlayPushed) { overlayPushed = true; pushNav(); }
  else if (!open && overlayPushed) { overlayPushed = false; popNav(); }
}
window.addEventListener('popstate', () => {
  if (popSkip) { popSkip--; return; }
  navDepth = Math.max(0, navDepth - 1);
  if (askCancel) { askCancel(true); return; }
  if (overlayPushed) { overlayPushed = false; state.selDay = null; state.quickOpen = false; render(); return; }
  if (SUB_VIEWS.includes(state.view)) {
    if (state.view === 'editProfile') state.tab = 'settings';
    go('main', {}, true);
  }
});

function go(view, extra = {}, fromPop = false) {
  const wasSub = SUB_VIEWS.includes(state.view);
  const isSub = SUB_VIEWS.includes(view);
  if (!fromPop) {
    if (!wasSub && isSub) pushNav();
    else if (wasSub && !isSub) popNav();
  }
  Object.assign(state, extra, { view });
  render();
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────
// 푸시 알림
// ─────────────────────────────────────────────
const NOTIFY_KINDS = [
  ['invite', '초대장 · 확정 · 취소', '새 방이 생기거나 모임이 확정·취소될 때'],
  ['vote', '시간 · 식당', '투표 마감 하루 전, 시간과 식당이 정해졌을 때'],
  ['eve', '모임 전날', '전날 저녁 7시에 한 번'],
  ['long', '오랜만이에요', '한 달 가까이 못 봤을 때'],
];
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// 서비스 워커가 준비될 때까지 (최대 4초)
function swReg() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('service worker not ready')), 4000)),
  ]);
}

function b64ToBytes(b64) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function pushStatus() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'needInstall' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await swReg();
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

async function savePushSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (error) throw error;
}

// 알림 켜기 (버튼을 눌렀을 때만 불러요. 아이폰은 이래야 허락 창이 떠요)
async function enablePush() {
  const st = await pushStatus();
  if (st === 'needInstall') { toast('아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요'); return false; }
  if (st === 'unsupported') { toast('이 브라우저는 알림을 지원하지 않아요'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    state.push = perm === 'denied' ? 'denied' : 'off';
    toast(perm === 'denied' ? '알림이 막혀 있어요. 휴대폰 설정에서 49th 알림을 허용해주세요' : '알림을 켜지 않았어요');
    return false;
  }
  const { data: key, error } = await sb.rpc('push_public_key');
  if (error) throw error;
  if (!key) throw new Error('push not ready');
  const reg = await swReg();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await savePushSub(sub);
  state.push = 'on';
  toast('알림을 켰어요');
  return true;
}

async function disablePush() {
  const reg = await swReg();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sb.rpc('remove_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => {});
  }
  state.push = 'off';
  toast('이 기기 알림을 껐어요');
}

// 앱을 열 때마다 조용히 기기 정보를 다시 저장 (주소가 바뀌었을 수 있어요)
async function refreshPush() {
  try {
    state.push = await pushStatus();
    if (state.push !== 'on') return;
    const reg = await swReg();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await savePushSub(sub);
  } catch (e) { console.warn(e); }
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
  let places;
  const [g, mem, rooms, mine, counts, prog] = await Promise.all([
    sb.from('groups').select('*').eq('id', gid).single(),
    sb.from('members').select('id,name,color,user_id').eq('group_id', gid).order('created_at'),
    sb.from('rooms').select('id,kind,title,day,slot,time_label,status,reply_deadline,created_by,place_id,finalized,tie_place_ids,tie_deadline,room_members(member_id,status)').eq('group_id', gid).gte('day', from).order('day'),
    sb.from('availability').select('day,slot').eq('member_id', state.me.id).gte('day', from),
    sb.rpc('availability_counts', { p_group: gid, p_from: from, p_to: to }),
    sb.rpc('group_progress', { p_group: gid }),
    sb.rpc('place_list', { p_group: gid }),
  ]).then((all) => { places = all[6]; return all.slice(0, 6); });
  for (const r of [g, mem, rooms, mine, counts, prog, places]) if (r.error) throw r.error;
  state.places = places.data;
  state.group = g.data;
  state.members = mem.data;
  state.rooms = rooms.data;
  state.mine = new Set(mine.data.map((a) => `${a.day}|${a.slot}`));
  state.counts = Object.fromEntries(counts.data.map((c) => [`${c.day}|${c.slot}`, c.others]));
  state.progress = prog.data;
  if (state.view === 'room' && state.roomId) await loadRoomDetail(state.roomId);
}

async function loadRoomDetail(id) {
  const [tc, rk, mt, tv] = await Promise.all([
    sb.rpc('room_time_counts', { p_room: id }),
    sb.rpc('room_place_ranking', { p_room: id }),
    sb.from('time_votes').select('label').eq('room_id', id),
    sb.from('tie_votes').select('place_id').eq('room_id', id),
  ]);
  for (const r of [tc, rk, mt, tv]) if (r.error) throw r.error;
  state.detail = { id, times: tc.data, ranking: rk.data, myTime: mt.data[0]?.label, myTie: tv.data[0]?.place_id };
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'places', filter: `group_id=eq.${state.group.id}` }, softReload)
    .subscribe();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') softReload(); });

const memberById = (id) => state.members.find((m) => m.id === id);
const myStatus = (room) => room.room_members.find((r) => r.member_id === state.me.id)?.status;
const joinedCount = (room) => room.room_members.filter((r) => r.status === 'joined').length;
const needCount = (room) => (room.kind === 'auto' ? state.group.threshold : room.room_members.filter((x) => x.status !== 'passed').length);
const roomTitle = (room) => `${longDate(room.day)} ${SLOT[room.slot]}`;
const placeById = (id) => state.places.find((p) => p.id === id);
const voteDeadlineText = (day) => { const { m, d } = md(addDays(day, -3)); return `${m}월 ${d}일 밤 9시`; };
const placeMeta = (p) => [p.category, p.area].filter(Boolean).map(esc).join(' · ');
// 맛집 종류 (필수 5개)와 아이콘
const CATS = ['한식', '중식', '일식', '분식', '기타'];
const CAT_LOOK = {
  한식: { bg: '#FFF1E3', fg: '#C2610C', svg: '<path d="M4 11h16a8 8 0 0 1-16 0z"/><path d="M9 7.5c0-1.5 1-1.5 1-3M13 7.5c0-1.5 1-1.5 1-3"/>' },
  중식: { bg: '#FFF4D6', fg: '#9A6200', svg: '<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M14 3l-4 8M18.5 4l-5 7"/>' },
  일식: { bg: '#E3F3F4', fg: '#1D7A80', svg: '<path d="M3 12c3-4.5 9-5.5 13-2l4-3v10l-4-3c-4 3.5-10 2.5-13-2z"/><circle cx="8" cy="11.2" r="0.9" fill="currentColor"/>' },
  분식: { bg: '#FDE8EE', fg: '#B8325E', svg: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>' },
  기타: { bg: '#EEF1F5', fg: '#5A6B80', svg: '<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 3c-2 0-3 2-3 5s1 4 3 4v9"/>' },
};
const foodKind = (p) => CAT_LOOK[p.category] || CAT_LOOK['기타'];
const thumb = (p, size = 48) => {
  const k = foodKind(p);
  const icon = Math.round(size * 0.5);
  return `<span class="avatar" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;background:${k.bg};color:${k.fg}"><svg width="${icon}" height="${icon}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${k.svg}</svg></span>`;
};
const liveRooms = () => state.rooms.filter((r) => !(r.kind === 'auto' && r.status === 'open' && new Date(r.reply_deadline) < new Date()));

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
    const oL = state.counts[`${day}|L`] || 0;
    const oD = state.counts[`${day}|D`] || 0;
    const sel = !compact && state.selDay === day;
    const room = state.rooms.some((r) => r.kind === 'auto' && r.day === day);
    const { m, d: dd } = md(day);
    const tag = compact ? 'div' : 'button';
    cells += `<${tag} class="cal-cell ${inWin && !compact ? 'window' : ''} ${past ? 'past' : ''} ${sel ? 'sel' : ''}" ${past && !compact ? 'disabled' : ''} ${compact ? '' : `data-act="pickDay" data-day="${day}" aria-pressed="${sel}"`}
      aria-label="${m}월 ${dd}일, ${[l ? '점심' : '', d ? '저녁' : ''].filter(Boolean).join('·') || '안 칠함'}${compact ? '' : `, 점심 친구 ${oL}명 저녁 친구 ${oD}명`}">
      <span class="num ${dow(day) === 0 ? 'sun' : ''}">${dd === 1 ? `<span class="month">${m}월</span>` : ''}${dd}</span>
      <span class="capsule"><span class="${l ? 'l' : ''}"></span><span class="${d ? 'd' : ''}"></span></span>
      ${compact ? '' : `<span class="others"><span>${'<i class="ol"></i>'.repeat(Math.min(oL, 3))}</span><span>${'<i class="od"></i>'.repeat(Math.min(oD, 3))}</span></span>`}
      ${room ? '<span class="room-dot"></span>' : ''}
    </${tag}>`;
  }
  return `<div class="cal ${compact ? 'mini-cal' : ''}">
    <div class="cal-week">${WD.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    ${compact ? '' : `<div class="legend">
      <span><i class="dot" style="background:var(--lunch)"></i>점심</span>
      <span><i class="dot" style="background:var(--dinner)"></i>저녁</span>
      <span><i class="dot" style="background:#9FB4CC;width:5px;height:5px"></i>되는 친구</span>
      <span><i class="dot" style="background:#F5F9FF;border:1px solid #D6E6F7"></i>방이 생길 수 있는 날</span>
    </div>`}
  </div>`;
}

// 빠르게 칠하기 (내일부터 4주, 빈칸만)
const QUICK = {
  weekend_dinner: { label: '주말 저녁 전부', slot: 'D', dows: [0, 6] },
  weekend_lunch: { label: '주말 점심 전부', slot: 'L', dows: [0, 6] },
  weekday_dinner: { label: '평일 저녁 전부', slot: 'D', dows: [1, 2, 3, 4, 5] },
};
function quickTargets(kind) {
  const q = QUICK[kind];
  const out = [];
  for (let i = 1; i <= 28; i++) {
    const day = addDays(today(), i);
    if (q.dows.includes(dow(day)) && !state.mine.has(`${day}|${q.slot}`)) out.push(day);
  }
  return out;
}
const futureMine = () => [...state.mine].filter((k) => k.slice(0, 10) >= today()).length;

function paintTools() {
  return `<div class="paint-tools"><span class="paint-hint">날짜를 누르고 점심·저녁을 골라요</span><button class="quick-btn" data-act="quickOpen">${ic.bolt}빠르게</button></div>`;
}

// 날짜를 누르면 아래에서 점심·저녁 고르기
function dayPanel() {
  const day = state.selDay;
  if (!day || state.quickOpen) return '';
  const l = state.mine.has(`${day}|L`);
  const d = state.mine.has(`${day}|D`);
  const oL = state.counts[`${day}|L`] || 0;
  const oD = state.counts[`${day}|D`] || 0;
  const inWin = day >= addDays(today(), ROOM_FROM) && day <= addDays(today(), ROOM_TO);
  const opt = (v, label, on) => `<button class="day-opt${on ? (v ? ' on' : ' on-none') : ''}" data-act="setDay" data-v="${v}" aria-pressed="${on}">${label}</button>`;
  return `
  <div class="day-panel" role="dialog" aria-label="${longDate(day)} 칠하기">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="stack-sm" style="gap:1px"><b style="font-size:15px">${longDate(day)}</b>
        <span style="font-size:11.5px;color:var(--quiet)">되는 친구 점심 ${oL}명 · 저녁 ${oD}명${inWin ? ' · 방이 생길 수 있는 날' : ''}</span></div>
      <button class="link-btn" style="min-height:32px;padding:0;white-space:nowrap;flex:none" data-act="closeDay">닫기</button>
    </div>
    <div class="day-opts">
      ${opt('L', '<i class="dot" style="background:var(--lunch)"></i>점심', l && !d)}
      ${opt('D', '<i class="dot" style="background:var(--dinner)"></i>저녁', d && !l)}
      ${opt('LD', '둘 다', l && d)}
      ${opt('', '안 돼요', !l && !d)}
    </div>
  </div>`;
}

function quickSheet() {
  if (!state.quickOpen) return '';
  return `
  <div class="sheet-back" data-act="quickClose"></div>
  <div class="sheet" role="dialog" aria-label="빠르게 칠하기">
    <div class="sheet-grip"></div>
    <div class="row" style="justify-content:space-between;padding:0 4px"><h2 class="title-sm">빠르게 칠하기</h2><button class="link-btn" data-act="quickClose">닫기</button></div>
    <div class="card">
      ${Object.entries(QUICK).map(([k, q]) => {
        const n = quickTargets(k).length;
        return `<button class="list-row" data-act="quickPaint" data-kind="${k}" ${n ? '' : 'disabled'}><i class="dot" style="background:${q.slot === 'L' ? 'var(--lunch)' : 'var(--dinner)'}"></i><span class="grow">${q.label}</span><span class="meta">${n ? `빈칸 ${n}개` : '다 칠했어요'}</span></button>`;
      }).join('')}
    </div>
    <div class="card"><button class="list-row" data-act="quickClear" style="color:var(--danger)" ${futureMine() ? '' : 'disabled'}><span class="grow">앞으로 칠한 것 전부 지우기</span><span class="meta">${futureMine()}칸</span></button></div>
    <p class="note">내일부터 4주 안의 빈칸만 채워요. 패스했던 칸과 없어진 방의 시간대는 건너뛰어요</p>
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
    ${paintTools()}
    ${calendar()}
    <p class="note">파란 칸에 ${state.group.threshold}명이 겹치면 방이 생겨요</p>
  </main>
  ${quickSheet()}${dayPanel()}
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" data-act="finishOnboarding">완료</button>
  </div></div>`;
}

function viewNotify() {
  const need = state.push === 'needInstall';
  return `
  <main class="screen">
    <div class="stack-sm" style="padding:8px 4px 0">
      <div class="notify-icon">${ic.bell}</div>
      <h1 class="title-md">방이 생기면
알려드릴까요?</h1>
      <p class="sub">${need ? '아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요. 나중에 설정에서 켤 수 있어요' : '초대장, 확정, 투표 마감, 모임 전날에만 알려드려요. 종류별로 설정에서 끌 수 있어요'}</p>
    </div>
  </main>
  <div class="bottom-bar"><div class="inner stack-sm">
    ${need ? '' : '<button class="btn primary" data-act="notifyOn">알림 켜기</button>'}
    <button class="btn ${need ? 'primary' : 'plain'}" data-act="notifyLater">${need ? '확인' : '나중에'}</button>
  </div></div>`;
}

function notifySection() {
  const p = state.push;
  const prefs = state.me.notify || {};
  const device =
    p === 'on' ? `<div class="list-row"><span class="grow">이 기기 알림</span><span class="sub">켜짐</span><button class="pill" style="border:none;font-size:12px;padding:6px 12px" data-act="pushOff">끄기</button></div>`
    : p === 'denied' ? `<div class="list-row"><span class="grow">이 기기 알림</span><span class="sub">막혀 있어요</span></div>`
    : p === 'needInstall' ? `<div class="list-row"><span class="grow">이 기기 알림</span><span class="sub">홈 화면 앱에서 켤 수 있어요</span></div>`
    : p === 'unsupported' ? `<div class="list-row"><span class="grow">이 기기 알림</span><span class="sub">지원하지 않는 브라우저예요</span></div>`
    : `<div class="list-row"><span class="grow">이 기기 알림</span><button class="pill blue" style="border:none;font-size:12px;padding:6px 12px" data-act="pushOn">켜기</button></div>`;
  const rows = NOTIFY_KINDS.map(([k, label, meta]) => {
    const on = prefs[k] !== false;
    return `<button class="list-row" role="switch" aria-checked="${on}" data-act="notifyPref" data-k="${k}"><span class="grow stack-sm"><span>${label}</span><span class="meta">${meta}</span></span><span class="switch" aria-hidden="true"></span></button>`;
  }).join('');
  const hint = p === 'denied' ? '휴대폰 설정 → 알림 → 49th에서 허용해주세요' : '초대장 말고는 참석한 모임 소식만 알려드려요';
  return `
    <div class="stack-sm">
      <span class="note">알림</span>
      <div class="card">${device}${rows}</div>
      <p class="note">${hint}</p>
    </div>`;
}

// ─────────────────────────────────────────────
// 메인 탭
// ─────────────────────────────────────────────
function tabbar() {
  const b = (id, label, icon) => `<button data-act="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${icon}${label}</button>`;
  return `<nav class="tabbar" aria-label="하단 메뉴"><div class="inner">${b('home', '홈', ic.home)}${b('cal', '캘린더', ic.cal)}${b('food', '맛집', ic.fork)}${b('settings', '설정', ic.gear)}</div></nav>`;
}

function viewMain() {
  const body = state.tab === 'cal' ? viewCalendarTab() : state.tab === 'food' ? viewFood() : state.tab === 'settings' ? viewSettings() : viewHome();
  return body + tabbar() + (state.tab === 'cal' ? quickSheet() + dayPanel() : '');
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
    ? '친구들이 될 수도 있다고 칠한 시간이 겹쳤어요'
    : `${esc(creator?.name || '친구')}님이 초대했어요${room.title ? ' · ' + esc(room.title) : ''}${room.time_label ? ' · ' + esc(room.time_label) : ''}`;
  const bars = Array.from({ length: need }, (_, i) => `<span class="${i < joined ? 'on' : ''}"></span>`).join('');
  return `<div class="invite">
    <div class="row" style="gap:12px;align-items:flex-start">
      <span class="badge-icon" style="background:var(--warn)">${ic.mail}</span>
      <span class="grow stack-sm"><b style="font-size:14px;font-weight:600">${esc(roomTitle(room))}</b><span style="font-size:12px;color:var(--quiet)">${why}</span></span>
    </div>
    <div class="stack-sm">
      <div class="row" style="justify-content:space-between;font-size:12px"><b style="font-weight:600">${room.kind === 'auto' ? `${need}명 모이면 확정` : '모두 참석하면 확정'}</b><span style="color:var(--quiet)">지금 ${joined}명</span></div>
      <div class="progress" style="grid-template-columns:repeat(${need},minmax(0,1fr))">${bars}</div>
      <span style="font-size:11.5px;color:var(--quiet)">${new Date(room.reply_deadline) < new Date() ? '응답 마감이 지났지만 지금 참석해도 돼요' : `${deadlineText(room.reply_deadline).replace(' 마감', '')}까지 답해주세요`}</span>
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
  const place = placeById(room.place_id);
  const meta = room.status !== 'confirmed'
    ? [room.title, `확정까지 ${need - joined}명`].filter(Boolean).map(esc).join(' · ')
    : [room.title, room.time_label || (room.kind === 'auto' ? '시간 투표 중' : ''), place ? place.name : room.tie_place_ids ? '식당 동표' : '식당 미정']
        .filter(Boolean).map(esc).join(' · ');
  return `<button class="list-row" data-act="openRoom" data-room="${room.id}">
    <span class="datebox"><small>${m}월</small><b>${d}</b></span>
    <span class="grow stack-sm"><span class="main">${WD[dow(room.day)]}요일 ${SLOT[room.slot]} · ${joined}명</span><span class="meta">${meta}</span></span>
    ${pill}${ic.chev}
  </button>`;
}

// 홈 맨 위: 내가 칠했는지 (방장은 친구들 칠한 수도 한 줄)
function myPaintCard() {
  const t = today();
  const n = [...state.mine].filter((k) => k.slice(0, 10) >= t).length;
  const owner = state.group.owner_id === state.session.user.id;
  const prog = state.progress;
  const painted = prog.filter((p) => p.painted).length;
  const top = n
    ? `<div class="list-row"><span class="badge-icon" style="background:var(--good-soft);color:var(--good)">${ic.tick}</span><span class="grow stack-sm" style="gap:1px"><b style="font-weight:600;font-size:14px">앞으로 ${n}칸 칠했어요</b><span class="meta">겹치면 초대장으로 알려드려요</span></span><button class="link-btn" data-act="tab" data-tab="cal">수정</button></div>`
    : `<div class="list-row"><span class="badge-icon" style="background:#FFF4E5;color:#C25E00">${ic.pen}</span><span class="grow stack-sm" style="gap:1px"><b style="font-weight:600;font-size:14px">아직 안 칠했어요</b><span class="meta">될 수도 있는 날 선택하기</span></span><button class="pill blue solid" data-act="tab" data-tab="cal">칠하기</button></div>`;
  const ownerRow = owner && prog.length > 1
    ? `<button class="list-row" data-act="tab" data-tab="cal"><span class="pill gray" style="font-size:11px;padding:2px 7px">방장</span><span class="grow" style="font-size:13px">${prog.length}명 중 <b style="font-weight:600">${painted}명</b>이 칠했어요</span>${ic.chev}</button>`
    : '';
  return `<div class="card">${top}${ownerRow}</div>`;
}

// 캘린더 위: 누가 칠했는지 (나는 항상 맨 앞, 어느 날인지는 안 보여요)
function paintStrip() {
  const prog = [...state.progress].sort((a, b) => (b.is_me ? 1 : 0) - (a.is_me ? 1 : 0));
  const painted = prog.filter((p) => p.painted).length;
  return `
  <div class="card pad stack-sm" style="gap:10px">
    <div class="row" style="justify-content:space-between;padding:0 2px"><b style="font-size:13px;font-weight:600">칠한 친구</b><span class="meta">${prog.length}명 중 ${painted}명</span></div>
    <div class="paint-strip">${prog.map((p) => `
      <div class="paint-person${p.painted ? '' : ' not'}">
        <span class="pp-av" style="${p.painted ? `background:${p.color}` : ''}">${esc(p.name.slice(0, 1))}${p.painted ? `<span class="pp-check">${ic.checkSm}</span>` : ''}</span>
        <span class="pp-name">${p.is_me ? '나' : esc(p.name)}</span>
      </div>`).join('')}</div>
  </div>`;
}

function viewHome() {
  const rooms = liveRooms();
  const invites = rooms.filter((r) => r.status === 'open' && ['invited', 'passed'].includes(myStatus(r)));
  const upcoming = rooms.filter((r) => myStatus(r) === 'joined');
  const fresh = invites.length === 0 && upcoming.length === 0;
  return `
  <main class="screen">
    <div class="head">
      <div class="stack-sm" style="gap:0">
        <span class="eyebrow">${(() => { const { m, d } = md(today()); return `${m}월 ${d}일 ${WD[dow(today())]}요일`; })()}</span>
        <h1 class="title-lg">${esc(state.group.name)}</h1>
      </div>
      <div class="avatars" style="padding-bottom:6px">${state.members.slice(0, 8).map((m) => avatar(m.name, m.color, 30)).join('')}</div>
    </div>

    ${myPaintCard()}

    ${fresh ? `
    <div class="card pad row" style="gap:14px;align-items:flex-start">
      <span class="badge-icon" style="background:var(--warn)">${ic.mail}</span>
      <span class="grow stack-sm"><b style="font-weight:600">아직 초대장이 없어요</b><span class="sub" style="font-size:13px">8~14일 뒤 같은 시간대를 ${state.group.threshold}명 이상 칠하면 여기로 초대장이 와요.</span></span>
    </div>` : ''}

    ${invites.length ? `<section class="stack"><h2 class="title-sm" style="padding:0 4px">초대장</h2>${invites.map(inviteCard).join('')}</section>` : ''}

    <section class="stack">
      <div class="head" style="align-items:center"><h2 class="title-sm">다가오는 모임</h2><button class="link-btn" data-act="newRoom">${ic.plus}새 방</button></div>
      <div class="card">${upcoming.length ? upcoming.map(upcomingRow).join('') : '<div class="empty">참석하기로 한 모임이 아직 없어요</div>'}</div>
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
    ${paintStrip()}
    ${paintTools()}
    <div class="stack-sm">
      ${calendar()}
      <p class="note">파란 칸에 ${state.group.threshold}명이 겹치면 방이 생겨요</p>
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
        ${st !== 'passed' && (room.status === 'open' || (room.kind === 'manual' && (room.created_by === state.me.id || !memberById(room.created_by)))) ? `<button class="icon-btn" aria-label="방 없애기" data-act="deleteRoom" data-room="${room.id}">${ic.x}</button>` : ''}
      </div>
    </div>
    <div class="stack-sm" style="padding:0 4px">
      <h1 class="title-md">${esc(room.title || roomTitle(room))}</h1>
      <span class="sub" style="font-size:13px">${room.title ? esc(roomTitle(room)) + ' · ' : ''}${room.time_label ? esc(room.time_label) + ' · ' : ''}${dd === 0 ? '오늘' : `D-${dd}`} · ${room.status === 'confirmed' ? '확정' : `확정까지 ${needCount(room) - joined.length}명`}</span>
    </div>
    <div class="card">
      <div class="list-row"><span class="grow main">참석 ${joined.length}명</span><div class="avatars">${joined.map((m) => avatar(m.name, m.color, 28)).join('')}</div></div>
      ${waiting.length ? `<div class="list-row"><span class="grow meta">아직 답 안 한 사람 ${waiting.length}명</span></div>` : ''}
      ${room.status === 'open' ? `<div class="list-row"><span class="grow meta">${room.kind === 'auto'
        ? `${deadlineText(room.reply_deadline).replace(' 마감', '')}까지 안 모이면 사라져요`
        : new Date(room.reply_deadline) < new Date() ? '참석이 2명 되면 확정돼요' : `${deadlineText(room.reply_deadline).replace(' 마감', '')}에 참석한 사람끼리 확정돼요`}</span></div>` : ''}
    </div>
    ${room.status === 'confirmed' && st === 'joined' ? roomVoteSections(room) : `<p class="note">${room.status === 'confirmed' ? '참석하면 시간과 식당을 같이 정해요' : '확정되면 시간과 식당을 정해요'}</p>`}
    ${st === 'joined' ? `<button class="link-btn quiet-danger" data-act="leaveRoom" data-room="${room.id}">참석 취소</button>` : ''}
    ${st === 'invited' ? `<div class="row"><button class="btn primary small" data-act="respond" data-room="${room.id}" data-status="joined">참석</button><button class="btn white small" data-act="respond" data-room="${room.id}" data-status="passed">패스</button></div>` : ''}
  </main>`;
}

function roomVoteSections(room) {
  const d = state.detail && state.detail.id === room.id ? state.detail : null;
  if (!d) return '<p class="note">불러오는 중…</p>';
  let html = '';

  // 시간
  if (room.kind === 'auto') {
    if (room.finalized) {
      html += `<section class="stack"><h2 class="title-sm" style="padding:0 4px">시간</h2><div class="card pad row"><b class="grow">${esc(room.time_label)}</b><span class="pill green">정해졌어요</span></div></section>`;
    } else {
      html += `<section class="stack">
        <div class="stack-sm" style="padding:0 4px"><h2 class="title-sm">몇 시에 볼까요?</h2><span class="sub" style="font-size:12.5px">${voteDeadlineText(room.day)}에 정해져요</span></div>
        <div role="radiogroup" aria-label="시간" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
          ${d.times.map((t) => { const on = d.myTime === t.label; return `<button role="radio" aria-checked="${on}" data-act="voteTime" data-label="${esc(t.label)}" class="btn small ${on ? 'primary' : 'white'}" style="flex-direction:column;gap:0;min-height:56px"><span>${esc(t.label)}</span><span style="font-size:11px;font-weight:500;opacity:.8">${t.votes}명</span></button>`; }).join('')}
        </div>
      </section>`;
    }
  }

  // 식당
  const ranking = d.ranking;
  const chosen = placeById(room.place_id) || ranking.find((p) => p.id === room.place_id);
  const tieOn = room.tie_place_ids && new Date(room.tie_deadline) > new Date();
  const placeRow = (p, right) => `<div class="list-row">${thumb(p, 44)}<span class="grow stack-sm"><span class="main">${esc(p.name)}</span><span class="meta">${placeMeta(p) || '&nbsp;'}</span></span>${right}</div>`;
  const mapLink = (p) => p.url ? `<a class="pill blue" style="text-decoration:none" href="${esc(p.url)}" target="_blank" rel="noopener">지도</a>` : '';
  const heartBtn = (p) => `<button class="icon-btn" style="background:none;color:${p.mine ? '#E0164A' : '#8E8E93'};flex-direction:column;gap:0;height:46px" aria-pressed="${p.mine}" aria-label="${esc(p.name)} 하트" data-act="heart" data-place="${p.id}">${ic.heart(p.mine)}<span style="font-size:11px;font-weight:600">${p.hearts}</span></button>`;

  if (chosen) {
    html += `<section class="stack"><h2 class="title-sm" style="padding:0 4px">식당</h2><div class="card">
      ${placeRow(chosen, mapLink(chosen) + '<span class="pill green">정해졌어요</span>')}
      <button class="list-row" data-act="togglePlaces" style="color:var(--accent)"><span class="grow">${state.showOthers ? '접기' : '다른 곳으로 바꾸기'}</span></button>
      ${state.showOthers ? ranking.filter((p) => p.id !== chosen.id).map((p) => placeRow(p, `<button class="pill gray" style="border:none;padding:7px 11px" data-act="setPlace" data-place="${p.id}">여기로</button>`)).join('') : ''}
    </div></section>`;
  } else if (tieOn) {
    const ties = room.tie_place_ids.map((id) => ranking.find((p) => p.id === id)).filter(Boolean);
    html += `<section class="stack">
      <div class="stack-sm" style="padding:0 4px"><h2 class="title-sm">하트가 똑같이 나왔어요</h2><span class="sub" style="font-size:12.5px">한 곳만 골라주세요 · ${deadlineText(room.tie_deadline)}</span></div>
      <div class="card">${ties.map((p) => { const on = d.myTie === p.id; return `<button class="list-row" role="radio" aria-checked="${on}" data-act="voteTie" data-place="${p.id}">${thumb(p, 44)}<span class="grow stack-sm"><span class="main">${esc(p.name)}</span><span class="meta">${placeMeta(p) || '&nbsp;'}</span></span><span style="color:${on ? '#E0164A' : '#C7C7CC'}">${ic.heart(on)}</span></button>`; }).join('')}</div>
    </section>`;
  } else if (!ranking.length) {
    html += `<section class="stack"><h2 class="title-sm" style="padding:0 4px">어디서 먹을까요?</h2><div class="card pad stack-sm"><span class="sub">아직 담아둔 맛집이 없어요</span><button class="link-btn" data-act="tab" data-tab="food">맛집 담으러 가기</button></div></section>`;
  } else {
    const top = ranking[0];
    const rest = ranking.slice(1);
    html += `<section class="stack">
      <div class="stack-sm" style="padding:0 4px"><h2 class="title-sm">어디서 먹을까요?</h2><span class="sub" style="font-size:12.5px">${room.kind === 'auto' ? `하트 1순위로 ${voteDeadlineText(room.day)}에 정해져요` : '참석자 누구나 정할 수 있어요'}</span></div>
      <div class="card">
        ${placeRow(top, (top.hearts ? '<span class="pill blue">1순위</span>' : '') + heartBtn(top))}
        <div class="list-row" style="gap:8px">${mapLink(top)}<span class="grow"></span><button class="pill blue" style="border:none;padding:8px 14px;font-size:13px" data-act="setPlace" data-place="${top.id}">여기로 정하기</button></div>
        ${rest.length ? `<button class="list-row" data-act="togglePlaces" style="color:var(--accent)"><span class="grow">${state.showOthers ? '접기' : `다른 후보 ${rest.length}곳`}</span></button>` : ''}
        ${state.showOthers ? rest.map((p) => placeRow(p, heartBtn(p) + `<button class="pill gray" style="border:none;padding:7px 11px" data-act="setPlace" data-place="${p.id}">여기로</button>`)).join('') : ''}
      </div>
    </section>`;
  }
  return html;
}

// ─────────────────────────────────────────────
// 맛집
// ─────────────────────────────────────────────
function viewFood() {
  const all = state.places;
  const cat = state.foodCat || '전체';
  const list = cat === '전체' ? all : all.filter((p) => p.category === cat);
  const chips = ['전체', ...CATS].map((c) => {
    const n = c === '전체' ? all.length : all.filter((p) => p.category === c).length;
    return `<button class="cat-chip${cat === c ? ' on' : ''}" aria-pressed="${cat === c}" data-act="foodCat" data-cat="${c}">${c}<span>${n}</span></button>`;
  }).join('');
  return `
  <main class="screen">
    <div class="head">
      <div class="stack-sm" style="gap:0"><span class="eyebrow">우리가 담아둔 곳 ${all.length}</span><h1 class="title-lg">맛집</h1></div>
      <button class="icon-btn" style="background:var(--accent);color:#fff;margin-bottom:4px" aria-label="맛집 담기" data-act="addPlaceOpen">${ic.plus}</button>
    </div>
    ${all.length ? `<div class="cat-scroll">${chips}</div>` : ''}
    ${list.length ? `<div class="card food-list">${list.map((p) => `<div class="list-row">
        ${thumb(p, 40)}
        <span class="grow stack-sm">
          <span class="main">${esc(p.name)}</span>
          <span class="meta">${placeMeta(p) || '&nbsp;'}</span>
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="font-size:11.5px;text-decoration:none;align-self:flex-start">지도 보기</a>` : ''}
        </span>
        ${p.added_by_me ? `<button class="more-btn" aria-label="${esc(p.name)} 지우기" data-act="deletePlace" data-place="${p.id}">${ic.more}</button>` : ''}
        <button class="icon-btn" style="background:none;color:${p.mine ? '#E0164A' : '#8E8E93'};flex-direction:column;gap:0;height:48px" aria-pressed="${p.mine}" aria-label="${esc(p.name)} 하트" data-act="heart" data-place="${p.id}">${ic.heart(p.mine)}<span style="font-size:11px;font-weight:600">${p.hearts}</span></button>
      </div>`).join('')}</div>
      <p class="note">하트가 많은 곳이 모임 방에서 1순위로 올라가요</p>`
      : all.length ? `<div class="card pad"><span class="sub" style="font-size:13px">${esc(cat)}으로 담은 곳이 아직 없어요</span></div>`
      : `<div class="card pad stack-sm" style="align-items:flex-start"><b style="font-weight:600">아직 담아둔 맛집이 없어요</b><span class="sub">네이버 지도에서 가고 싶은 곳의 링크를 담아두세요.</span><button class="link-btn" data-act="addPlaceOpen">${ic.plus}맛집 담기</button></div>`}
  </main>`;
}

const isNaverUrl = (u) => /^https:\/\/([a-z0-9-]+\.)*(naver\.me|naver\.com)\//i.test((u || '').trim());
// 네이버 지도 공유 문구("[네이버 지도]\n가게 이름\n주소\nhttps://naver.me/…")에서 링크와 이름을 뽑아요
function parseShareText(text) {
  const t = String(text || '');
  const m = t.match(/https:\/\/[^\s<>"']+/);
  const url = m ? m[0].replace(/[),.]+$/, '') : '';
  const lines = t.split(/\r?\n/)
    .map((x) => x.replace(/https:\/\/\S+/g, '').replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean);
  const looksLikeAddress = (x) => /(특별시|광역시|도|시|군|구|동|읍|면|로|길)\s*\d/.test(x) || /^(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)\s/.test(x);
  const name = lines.find((x) => !looksLikeAddress(x) && x.length <= 40) || '';
  return { url, name };
}
function applyShareText(text) {
  const { url, name } = parseShareText(text);
  if (!url) return false;
  state.placeForm.url = url;
  if (!state.placeForm.name.trim() && name) state.placeForm.name = name;
  return true;
}

function placeFormValid() {
  const f = state.placeForm;
  return f.name.trim() && CATS.includes(f.category) && (!f.url.trim() || isNaverUrl(f.url));
}
function viewAddPlace() {
  const f = state.placeForm;
  const bad = f.url.trim() && !isNaverUrl(f.url);
  return `
  <main class="screen" style="gap:16px">
    <div class="topbar"><button class="back" data-act="toFood">${ic.back}맛집</button><b>맛집 담기</b><span style="width:40px"></span></div>
    <div class="field">
      <label for="placeUrl">네이버 지도 링크</label>
      <div class="row"><input class="input" id="placeUrl" inputmode="url" placeholder="https://naver.me/..." value="${esc(f.url)}" style="${bad ? 'border-color:var(--danger)' : ''}"><button class="btn white small" style="width:auto;white-space:nowrap" data-act="pasteLink">붙여넣기</button></div>
      <p class="note" id="urlNote" style="${bad ? 'color:var(--danger)' : ''}">${bad ? '네이버 지도 링크만 담을 수 있어요' : '네이버 지도 앱에서 장소 → 공유 → 링크 복사'}</p>
    </div>
    <div class="field"><label for="placeName">식당 이름</label><input class="input" id="placeName" maxlength="40" placeholder="예: 창가 파스타" value="${esc(f.name)}"></div>
    <div class="field"><span class="label">종류</span>
      <div class="cat-pick" role="radiogroup" aria-label="종류">${CATS.map((c) => `<button role="radio" aria-checked="${f.category === c}" class="cat-chip${f.category === c ? ' on' : ''}" data-act="pickCat" data-cat="${c}">${c}</button>`).join('')}</div>
    </div>
    <div class="field"><label for="placeArea">동네 (선택)</label><input class="input" id="placeArea" maxlength="20" placeholder="예: 서울역" value="${esc(f.area)}"></div>
    <p class="note">담으면 내 하트가 하나 들어가요.</p>
  </main>
  <div class="bottom-bar"><div class="inner">
    <button class="btn primary" id="savePlace" data-act="savePlace" ${placeFormValid() ? '' : 'disabled'}>맛집 풀에 담기</button>
  </div></div>`;
}

// ─────────────────────────────────────────────
// 직접 방 만들기
// ─────────────────────────────────────────────
// 새 방: 그날 칠한 친구 수와 응답 마감 미리 보기 (서버 규칙과 같게)
function manualDeadline(day) {
  const kst = (d, h) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00+09:00`);
  let v = new Date(Math.min(Date.now() + 3 * 864e5, kst(addDays(day, -1), 21).getTime()));
  if (v.getTime() < Date.now() + 3 * 36e5) v = kst(addDays(day, 1), 0);
  return v.toISOString();
}
function newRoomHint(n) {
  if (!n.day) return '';
  const others = state.counts[`${n.day}|${n.slot}`] || 0;
  const mine = state.mine.has(`${n.day}|${n.slot}`);
  const who = others ? `이날 ${n.slot === 'L' ? '점심' : '저녁'}을 칠한 친구 ${others}명` : `이날 ${n.slot === 'L' ? '점심' : '저녁'}을 칠한 친구는 아직 없어요`;
  return `<div class="card"><div class="list-row"><span class="grow stack-sm"><span style="font-size:14px">${who}${mine ? ' · 나도 칠함' : ''}</span><span class="meta">응답 ${deadlineText(manualDeadline(n.day))}</span></span></div></div>`;
}

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
    ${newRoomHint(n)}
    <p class="note">초대한 친구만 볼 수 있어요. 모두 참석하면 확정되고(패스한 사람은 빼고), 마감 때는 참석한 사람끼리 확정돼요. 직접 없애기 전엔 사라지지 않아요</p>
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
    ${notifySection()}
    <div class="stack-sm">
      <span class="note">멤버</span>
      <div class="card">${state.members.map((m) => `<div class="list-row">${avatar(m.name, m.color, 30)}<span class="grow">${esc(m.name)}${m.id === state.me.id ? ' (나)' : ''}</span>${owner && m.id !== state.me.id ? `<button class="pill" style="border:none;font-size:12px;padding:6px 12px;color:var(--danger)" data-act="kickMember" data-id="${m.id}">내보내기</button>` : ''}</div>`).join('')}</div>
      ${owner ? '<p class="note">방장은 멤버를 내보낼 수 있어요. 그 사람의 칠과 참석은 지워지고, 초대 번호로 다시 들어올 수 있어요</p>' : ''}
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
    : v === 'notify' ? viewNotify()
    : v === 'main' ? viewMain()
    : v === 'room' ? viewRoom()
    : v === 'newRoom' ? viewNewRoom()
    : v === 'addPlace' ? viewAddPlace()
    : '<div class="loading">불러오는 중…</div>';
  app.innerHTML = html;
  syncOverlayNav();
  if (v === 'code') setTimeout(() => document.getElementById('codeInput')?.focus(), 50);
}

// ─────────────────────────────────────────────
// 입력 처리
// ─────────────────────────────────────────────
app.addEventListener('paste', (e) => {
  if (e.target.id !== 'placeUrl') return;
  const text = e.clipboardData?.getData('text') || '';
  if (/https:\/\//.test(text) && text.trim() !== (text.match(/https:\/\/\S+/) || [''])[0]) {
    e.preventDefault();
    if (applyShareText(text)) render();
  }
});

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
  if (['placeUrl', 'placeName', 'placeCat', 'placeArea'].includes(t.id)) {
    const key = { placeUrl: 'url', placeName: 'name', placeCat: 'category', placeArea: 'area' }[t.id];
    state.placeForm[key] = t.value;
    const btn = document.getElementById('savePlace');
    if (btn) btn.disabled = !placeFormValid();
    if (t.id === 'placeUrl' && /\s/.test(t.value.trim()) && /https:\/\//.test(t.value)) {
      applyShareText(t.value);
      render();
      return;
    }
    if (t.id === 'placeUrl') {
      const bad = t.value.trim() && !isNaverUrl(t.value);
      t.style.borderColor = bad ? 'var(--danger)' : '';
      const note = document.getElementById('urlNote');
      note.style.color = bad ? 'var(--danger)' : '';
      note.textContent = bad ? '네이버 지도 링크만 담을 수 있어요' : '네이버 지도 앱에서 장소 → 공유 → 링크 복사';
    }
  }
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
  finishOnboarding: async () => {
    state.push = await pushStatus().catch(() => 'unsupported');
    if (state.push === 'off') { go('notify'); return; }
    state.tab = 'home'; go('main');
  },
  notifyOn: () => run(async () => { await enablePush(); state.tab = 'home'; go('main'); }),
  notifyLater: () => { state.tab = 'home'; go('main'); },
  pushOn: () => run(async () => { await enablePush(); render(); }),
  pushOff: () => run(async () => { await disablePush(); render(); }),
  notifyPref: (el) => run(async () => {
    const k = el.dataset.k;
    const next = { ...(state.me.notify || {}), [k]: (state.me.notify || {})[k] === false };
    const prev = state.me.notify;
    state.me.notify = next; render();
    const { error } = await sb.from('members').update({ notify: next }).eq('id', state.me.id);
    if (error) { state.me.notify = prev; render(); throw error; }
  }),

  tab: (el) => { state.tab = el.dataset.tab; state.selDay = null; state.quickOpen = false; go('main'); },
  quickOpen: () => { state.quickOpen = true; render(); },
  quickClose: () => { state.quickOpen = false; render(); },
  quickPaint: async (el) => {
    const q = QUICK[el.dataset.kind];
    const n = quickTargets(el.dataset.kind).length;
    if (!(await ask(`${q.label.replace(' 전부', '')} 빈칸 ${n}개를 칠할까요?`, `8~14일 뒤 칸에서 ${state.group.threshold}명 이상 겹치면 바로 방이 생기고 초대장이 가요.`, { ok: `${n}칸 칠하기` }))) return;
    run(async () => {
      const { data, error } = await sb.rpc('bulk_paint', { p_group: state.group.id, p_kind: el.dataset.kind });
      if (error) throw error;
      state.quickOpen = false;
      await loadGroupData();
      render();
      toast(data ? `${data}칸 칠했어요${data < n ? ' (패스했던 칸·없어진 시간대는 건너뛰었어요)' : ''}` : '칠할 수 있는 빈칸이 없었어요');
    });
  },
  quickClear: async () => {
    const n = futureMine();
    if (!(await ask(`앞으로 칠한 ${n}칸을 전부 지울까요?`, '이미 생긴 방, 받은 초대장, 참석한 모임은 그대로예요.', { ok: '전부 지우기', danger: true }))) return;
    run(async () => {
      const { error } = await sb.rpc('clear_my_paint', { p_group: state.group.id });
      if (error) throw error;
      state.quickOpen = false;
      await loadGroupData();
      render();
      toast('칠한 칸을 모두 지웠어요');
    });
  },
  pickDay: (el) => {
    state.selDay = state.selDay === el.dataset.day ? null : el.dataset.day;
    render();
  },
  closeDay: () => { state.selDay = null; render(); },
  setDay: (el) => run(async () => {
    const day = state.selDay;
    if (!day) return;
    const want = el.dataset.v;
    const changes = ['L', 'D'].map((slot) => ({ slot, on: state.mine.has(`${day}|${slot}`), want: want.includes(slot) }))
      .filter((c) => c.on !== c.want);
    state.selDay = null;
    for (const c of changes) { if (c.want) state.mine.add(`${day}|${c.slot}`); else state.mine.delete(`${day}|${c.slot}`); }
    render();
    try {
      for (const c of changes) {
        const { error } = c.want
          ? await sb.from('availability').insert({ member_id: state.me.id, group_id: state.group.id, day, slot: c.slot })
          : await sb.from('availability').delete().match({ member_id: state.me.id, day, slot: c.slot });
        if (error) throw error;
      }
    } catch (e) {
      for (const c of changes) { if (c.on) state.mine.add(`${day}|${c.slot}`); else state.mine.delete(`${day}|${c.slot}`); }
      render();
      throw e;
    }
    if (changes.some((c) => c.want)) softReload();
  }),

  respond: (el) => run(async () => {
    const { data, error } = await sb.rpc('respond_room', { p_room: el.dataset.room, p_status: el.dataset.status });
    if (error) throw error;
    if (data === 'confirmed') toast('확정됐어요!');
    if (data === 'deleted') { toast('방이 없어졌어요'); state.view = 'main'; }
    if (el.dataset.status === 'passed' && state.rooms.find((r) => r.id === el.dataset.room)?.kind === 'auto') toast('패스했어요. 그 칸 칠도 지웠어요');
    await loadGroupData();
    render();
  }),
  openRoom: (el) => {
    state.detail = null;
    state.showOthers = false;
    go('room', { roomId: el.dataset.room });
    run(async () => { await loadRoomDetail(el.dataset.room); render(); });
  },
  toFood: () => { state.tab = 'food'; go('main'); },
  togglePlaces: () => { state.showOthers = !state.showOthers; render(); },
  heart: (el) => run(async () => {
    const { error } = await sb.rpc('toggle_heart', { p_place: el.dataset.place });
    if (error) throw error;
    await loadGroupData();
    render();
  }),
  voteTime: (el) => run(async () => {
    const { error } = await sb.rpc('vote_time', { p_room: state.roomId, p_label: el.dataset.label });
    if (error) throw error;
    await loadRoomDetail(state.roomId);
    render();
  }),
  voteTie: (el) => run(async () => {
    const { error } = await sb.rpc('vote_tie', { p_room: state.roomId, p_place: el.dataset.place });
    if (error) throw error;
    await loadRoomDetail(state.roomId);
    render();
  }),
  setPlace: (el) => run(async () => {
    const { error } = await sb.rpc('set_room_place', { p_room: state.roomId, p_place: el.dataset.place });
    if (error) throw error;
    state.showOthers = false;
    await loadGroupData();
    render();
    toast('식당을 정했어요');
  }),
  pickCat: (el) => { state.placeForm.category = el.dataset.cat; render(); },
  foodCat: (el) => { state.foodCat = el.dataset.cat; render(); },
  addPlaceOpen: () => { state.placeForm = { url: '', name: '', category: state.foodCat && state.foodCat !== '전체' ? state.foodCat : '', area: '' }; go('addPlace'); },
  pasteLink: async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!applyShareText(text)) state.placeForm.url = text.trim();
      render();
    } catch { toast('붙여넣기가 막혀 있어요. 입력칸을 길게 눌러 붙여넣어 주세요'); }
  },
  savePlace: () => run(async () => {
    const f = state.placeForm;
    if (!placeFormValid()) return;
    const { error } = await sb.rpc('add_place', { p_group: state.group.id, p_name: f.name.trim(), p_category: f.category, p_area: f.area, p_url: f.url.trim() });
    if (error) throw error;
    await loadGroupData();
    toast('맛집 풀에 담았어요');
    state.tab = 'food';
    go('main');
  }),
  deletePlace: async (el) => {
    if (!(await ask('이 맛집을 지울까요?', '모두의 하트도 같이 사라져요.', { ok: '지우기', danger: true }))) return;
    run(async () => {
      const { error } = await sb.rpc('delete_place', { p_place: el.dataset.place });
      if (error) throw error;
      await loadGroupData();
      render();
    });
  },
  leaveRoom: async (el) => {
    const room = state.rooms.find((r) => r.id === el.dataset.room);
    let msg = '';
    if (room?.status === 'confirmed') {
      const joined = (room.room_members || []).filter((x) => x.status === 'joined').length - 1;
      const need = room.kind === 'auto' ? state.group.threshold : 0;
      msg = joined >= need
        ? `남은 ${joined}명의 모임은 그대로 진행돼요.`
        : `남는 사람이 ${need}명보다 적어서 모임이 없어져요.`;
      if (room.kind === 'auto') msg += ' 그 칸 내 칠도 지워져요.';
    }
    if (!(await ask('참석을 취소할까요?', msg.trim(), { ok: '참석 취소', danger: true, cancel: '그대로 두기' }))) return;
    run(async () => {
      const { data, error } = await sb.rpc('respond_room', { p_room: el.dataset.room, p_status: 'passed' });
      if (error) throw error;
      toast(data === 'deleted' ? '사람이 부족해서 방이 없어졌어요' : '참석을 취소했어요');
      await loadGroupData();
      state.tab = 'home';
      go('main');
    });
  },
  deleteRoom: async (el) => {
    const auto = state.rooms.find((r) => r.id === el.dataset.room)?.kind === 'auto';
    if (!(await ask('이 방을 없앨까요?', auto
      ? '모두에게서 사라지고 그 칸 내 칠도 지워져요. 누가 그 시간을 새로 칠하면 다시 생길 수 있어요.'
      : '참석자 모두에게서 사라지고 되돌릴 수 없어요.', { ok: '방 없애기', danger: true }))) return;
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
    const place = placeById(room.place_id);
    share(`[49th] ${room.title ? room.title + ' · ' : ''}${roomTitle(room)}${room.time_label ? ' ' + room.time_label : ''}${place ? '\n장소: ' + place.name + (place.url ? ' ' + place.url : '') : ''}\n참석: ${names.join(', ')}\n${location.origin}`);
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
  kickMember: async (el) => {
    const m = state.members.find((x) => x.id === el.dataset.id);
    if (!m || !(await ask(`${m.name}님을 내보낼까요?`, '칠한 시간과 참석 기록이 지워져요. 참석하던 확정 모임은 남은 사람이 충분하면 그대로 유지돼요.', { ok: '내보내기', danger: true }))) return;
    run(async () => {
      const { error } = await sb.rpc('kick_member', { p_member: m.id });
      if (error) throw error;
      toast(`${m.name}님을 내보냈어요`);
      await loadGroupData();
      render();
    });
  },
  leaveGroup: async () => {
    const isOwner = state.group.owner_id === state.session.user.id;
    if (!(await ask(`${state.group.name}에서 나갈까요?`, `내가 칠한 시간과 참석 기록이 모두 지워져요.${isOwner ? ' 방장은 가장 먼저 들어온 멤버에게 넘어가요.' : ''}`, { ok: '나가기', danger: true }))) return;
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
      refreshPush().then(() => { if (state.tab === 'settings') render(); });
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
// 알림을 눌러 앱으로 돌아오면 최신 내용으로
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'refresh' && state.me) loadGroupData().then(render).catch(() => {});
});
boot();
