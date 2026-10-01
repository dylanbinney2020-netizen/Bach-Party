import { api, startLiveUpdates } from './api.js';
import * as U from './util.js';
import * as ART from './art.js';

const { esc } = U;
const BRAND = window.BRAND || {};
const B = (k, d) => (BRAND[k] == null || BRAND[k] === '' ? d : BRAND[k]);

// ---------------------------------------------------------------- state
let S = null;                 // server state (read model)
let serverOffset = 0;         // server clock minus device clock
let syncStatus = 'polling';
let fetching = false, refetchQueued = false, pendingRender = false;
let pendingConfirm = null;
let seenPickIds = new Set();
let freshPickIds = new Set();
let stopLive = null;

const ui = {
  tab: 'home', expanded: {}, golfView: 'board', golfTeam: 1, entryHole: null, entryVal: null,
  fbKind: 'cfb', fbView: {}, pickGroup: 'team', more: null, acc: { weekend: true }, modal: null, f: {}, busy: false,
};

const $app = document.getElementById('app');

// ---------------------------------------------------------------- helpers
const me = () => S.me;
const isCommish = () => S && S.me.role === 'commissioner';
const canScore = (t) => isCommish() || (S.me.role === 'scorekeeper' && S.me.team_id === t);
const scoringTeam = () => (S.me.role === 'scorekeeper' ? S.me.team_id : null);
const testMode = () => S.competition.mode === 'test';
const final = () => S.competition.status === 'final';
const nowServer = () => Date.now() + serverOffset;
// True until anything that can earn points has happened.
const preEvent = () => S.standings.every((x) => x.total === 0) && !S.blackjack.finalized && !S.golf.scores.length && !S.picks.length;
const standingsMeta = () => (final() ? 'Final' : preEvent() ? 'Competition has not started' : 'Live');

function applyBrand(st) {
  const bt = BRAND.teams || {};
  for (const t of st.teams) {
    const o = bt[t.id] || {};
    if (o.primary) t.color = o.primary;
    if (o.logo) t.logo_url = o.logo;
    t.color2 = o.secondary || null;
  }
}
function teamMark(t, size = '') {
  if (!t) return '';
  return `<span class="team-mark ${size}" style="--tc:${esc(t.color)}">${t.logo_url ? `<img src="${esc(t.logo_url)}" alt="">` : esc(t.short_name)}</span>`;
}
// Event identity block: typographic until BRAND.eventLogo is supplied.
function eventId(extra = '') {
  const logo = B('eventLogo', null);
  return `<div class="event-id ${extra}">${logo ? `<img class="eid-logo" src="${esc(logo)}" alt="${esc(B('eventName', "QUYLE'S"))} ${esc(B('eventTagline', 'BACHELOR PARTY'))}">` :
    `<div class="eid-name">${esc(B('eventName', "QUYLE'S"))}</div><div class="eid-tag">${esc(B('eventTagline', 'BACHELOR PARTY'))}</div>`}
    <div class="eid-rule"></div><div class="eid-loc">${esc(titleCase(B('location', 'ASHEVILLE, NORTH CAROLINA')))}</div><div class="eid-date">${esc(B('dates', 'OCTOBER 9–12, 2026'))}</div></div>`;
}
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

const tlabel = (t, max = 14) => esc(t ? (t.name.length > max ? t.short_name : t.name) : '');
const tstyle = (t) => (t ? `style="--tc:${esc(t.color)}"` : '');
const tname = (id) => esc(U.team(S, id)?.name || `Team ${id}`);

function toast(msg, kind = '') {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const d = document.createElement('div');
  d.className = `toast ${kind}`; d.setAttribute('role', 'status'); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), kind === 'err' ? 4200 : 2400);
}

async function run(fn, args, okMsg) {
  if (ui.busy) return false;
  ui.busy = true;
  try {
    await api.rpc(fn, args);
    if (okMsg) toast(okMsg);
    await refresh(true);
    return true;
  } catch (e) {
    if (e.code === 'NOT_SIGNED_IN') return signOut(true);
    toast(e.message, 'err');
    await refresh(true);
    return false;
  } finally { ui.busy = false; }
}

function confirmThen({ title, body, ok = 'Confirm', danger = false, big = '', kicker = '', meta = '' }, fn) {
  pendingConfirm = fn;
  ui.modal = { type: 'confirm', title, body, ok, danger, big, kicker, meta };
  render();
}

const val = (k) => {
  const el = document.querySelector(`[data-k="${k}"]`);
  if (!el) return ui.f[k] ?? null;
  return el.type === 'checkbox' ? el.checked : el.value;
};
const clearForm = (prefix) => Object.keys(ui.f).forEach((k) => k.startsWith(prefix) && delete ui.f[k]);

// ---------------------------------------------------------------- data flow
async function refresh(force = false) {
  if (fetching) { refetchQueued = true; return; }
  fetching = true;
  try {
    const next = await api.getState();
    serverOffset = Date.parse(next.server_now) - Date.now();
    const changed = !S || force || next.version !== S.version;
    applyBrand(next);
    const prevPickIds = seenPickIds, wasFinal = S && S.competition.finalized_at;
    S = next;
    const ids = new Set(S.picks.map((p) => p.id));
    freshPickIds = new Set([...ids].filter((id) => seenPickIds.size && !seenPickIds.has(id)));
    seenPickIds = ids;
    if (changed) safeRender();
    // broadcast moments: a new pick for everyone watching, and the championship reveal
    if (prevPickIds.size && freshPickIds.size) announcePick([...freshPickIds].map((id) => S.picks.find((x) => x.id === id)).sort((a, b) => b.pick_no - a.pick_no)[0]);
    maybeReveal(wasFinal);
  } catch (e) {
    if (e.code === 'NOT_SIGNED_IN') { signOut(true); return; }
    if (!S) renderFatal(e.message);
  } finally {
    fetching = false;
    if (refetchQueued) { refetchQueued = false; refresh(); }
  }
}

// Don't yank a form out from under someone who is typing.
function safeRender() {
  const a = document.activeElement;
  if (a && a.matches && a.matches('input:not([type=checkbox]), select, textarea') && $app.contains(a)) { pendingRender = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) { pendingRender = false; render(); } }, 60));

async function signOut(expired = false) {
  stopLive && stopLive(); stopLive = null;
  await api.logout();
  S = null; ui.tab = 'home'; ui.more = null; ui.modal = null;
  renderLogin(expired ? 'Session ended. Enter your PIN.' : '');
}

// ---------------------------------------------------------------- login
let pin = '';
function renderLogin(msg = '') {
  pin = '';
  $app.innerHTML = `
  <div class="login">
    <div class="login-sky"><div class="topo-layer"></div></div>
    ${ART.mountains('dusk')}<div class="login-fade"></div>
    <div class="login-mark">${eventId()}</div>
    <div class="pin-label" id="pin-label">ENTER PIN</div>
    <div class="pin-boxes" id="pin-boxes" aria-live="polite" aria-labelledby="pin-label">${'<span></span>'.repeat(4)}</div>
    <div class="pad" role="group" aria-label="PIN keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-pin="${n}" aria-label="${n}">${n}</button>`).join('')}
      <span></span><button data-pin="0" aria-label="0">0</button><button data-pin="del" aria-label="Delete">⌫</button>
    </div>
    <div class="login-msg" id="login-msg">${esc(msg)}</div>
  </div>`;
}

function paintPin(err = false) {
  const boxes = document.getElementById('pin-boxes');
  if (!boxes) return;
  [...boxes.children].forEach((b, i) => b.classList.toggle('on', i < pin.length));
  boxes.classList.toggle('err', err);
}
async function pinKey(k) {
  const msg = document.getElementById('login-msg');
  if (k === 'del') pin = pin.slice(0, -1);
  else if (pin.length < 4) pin += k;
  paintPin();
  if (msg) msg.textContent = '';
  if (pin.length === 4) {
    try {
      await api.login(pin);
      await start();
    } catch (e) {
      pin = ''; paintPin(true);
      if (msg) msg.textContent = e.message;
      setTimeout(() => paintPin(false), 450);
    }
  }
}
document.addEventListener('keydown', (e) => {
  if (S || !document.getElementById('pin-boxes')) return;
  if (/^\d$/.test(e.key)) pinKey(e.key);
  if (e.key === 'Backspace') pinKey('del');
});

async function start() {
  $app.innerHTML = skeleton();
  await refresh(true);
  if (!S) return;
  if (!stopLive) stopLive = startLiveUpdates(() => refresh(), (st) => { syncStatus = st; const d = document.querySelector('.sync-dot'); if (d) d.classList.toggle('live', st === 'live'); });
}

function skeleton() {
  return `<header class="topbar">${wordmark()}</header>
  <main><div class="section"><div class="panel">${'<div class="skel"></div>'.repeat(3)}</div></div>
  <div class="section"><div class="panel">${'<div class="skel"></div>'.repeat(4)}</div></div></main>`;
}
function wordmark() {
  const logo = B('eventLogo', null);
  return `<div class="wordmark">${logo ? `<img src="${esc(logo)}" alt="${esc(B('eventName', "QUYLE'S"))}">` : `<b>${esc(B('eventName', "QUYLE'S"))}</b><small>${esc(B('eventTagline', 'BACHELOR PARTY'))}</small>`}</div>`;
}

function renderFatal(msg) {
  $app.innerHTML = `<div class="login"><div class="login-mark"><h1>CAN'T CONNECT</h1></div><div class="rule"></div>
  <p class="muted" style="text-align:center;max-width:320px">${esc(msg)}</p>
  <button class="btn primary" data-act="retry">Try again</button></div>`;
}

// ---------------------------------------------------------------- shell
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  golf: '<path d="M8 21V3l9 4-9 4"/><path d="M4 21h10"/>',
  football: '<ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-35 12 12)"/><path d="M9.5 14.5l5-5M10.5 11.5l2 2M12.5 9.5l2 2"/>',
  standings: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
};
function nav() {
  const tabs = [['home', 'Home'], ['golf', 'Golf'], ['football', 'Football'], ['standings', 'Standings'], ['more', 'More']];
  return `<nav class="nav" aria-label="Main"><div class="nav-inner">${tabs.map(([k, l]) =>
    `<button data-act="tab" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${l.toUpperCase()}</button>`).join('')}</div></nav>`;
}
function topbar() {
  const t = U.team(S, me().team_id);
  return `<header class="topbar">
    ${wordmark()}
    <div class="me-chip">${testMode() ? '<span class="test-flag">TEST MODE</span>' : ''}
      <span class="sync-dot ${syncStatus === 'live' ? 'live' : ''}" title="${syncStatus === 'live' ? 'Live' : 'Refreshing every few seconds'}"></span>
      <span class="me-who"><b>${esc(me().name)}</b><span class="me-team">${esc(t?.name || '')}</span></span>${teamMark(t, 'sm')}</div>
  </header>`;
}

const TICK_TAG = { blackjack: 'CASINO', golf: 'GOLF', draft: 'DRAFT', result: 'RESULT', lead: 'STANDINGS', tiebreaker: 'SNF', champion: 'FINAL' };
function ticker() {
  if (!S.ticker.length) return '';
  const list = S.ticker.slice(0, 14);
  const items = list.map((t) => `<span><em>${TICK_TAG[t.kind] || 'UPDATE'}</em>${esc(U.tickerText(S, t.text))}</span>`).join('');
  const dur = Math.max(30, list.reduce((a, t) => a + t.text.length + 8, 0) * 0.28);
  const live = !final() && liveEvent();
  return `<div class="ticker" aria-label="Latest updates"><div class="ticker-tag">${live ? '<i></i>LIVE' : final() ? 'FINAL' : 'LATEST'}</div>
    <div class="ticker-track" style="--dur:${dur}s">${items}${items}</div></div>`;
}

function render() {
  if (!S) return;
  const view = { home: viewHome, golf: viewGolf, football: viewFootball, standings: viewStandings, more: viewMore }[ui.tab]();
  $app.innerHTML = `${topbar()}<main>${view}</main>${nav()}${modal()}`;
  // restore in-progress form values
  document.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (k in ui.f) { if (el.type === 'checkbox') el.checked = !!ui.f[k]; else el.value = ui.f[k]; }
  });
  paintClocks();
}

// ---------------------------------------------------------------- HOME
const DAYS = [['FRIDAY', 'October 9'], ['SATURDAY', 'October 10'], ['SUNDAY', 'October 11']];
function viewHome() {
  const ev = homeEvents();
  const live = liveEvent();
  const today = live ? ev.find((e) => e.key === live)?.day : null;
  return `<section class="hero home">${ART.mountains('dusk')}<div class="topo-layer"></div>
    <div class="hero-in"><div class="home-id">${B('eventLogo', null) ? `<img src="${esc(B('eventLogo'))}" alt="">` : `<b>${esc(B('eventName', "QUYLE'S"))}</b><span>${esc(B('eventTagline', 'BACHELOR PARTY'))}</span>`}<small>${esc(titleCase(B('location', 'ASHEVILLE, NORTH CAROLINA')))}</small></div>
    <div class="home-day">${final() ? `<em>${esc(B('year', '2026'))}</em>FINAL` : today != null ? `<em>DAY ${today + 1}</em>${DAYS[today][0]}` : `<em>OCT 9–12</em>${preEvent() ? 'UPCOMING' : 'IN PROGRESS'}`}</div></div></section>
  ${ticker()}
  ${final() ? championCard() : ''}
  <section class="section">
    <div class="sec-head"><h2 class="sec-title">${final() ? 'Final standings' : 'Weekend standings'}</h2><span class="sec-meta">${preEvent() ? 'Oct 9–12' : standingsMeta()}</span></div>
    ${standingsList()}
  </section>
  ${!final() ? liveHero(ev, live) : ''}
  ${DAYS.map(([d, date], i) => `<section class="day"><div class="day-head ${today === i ? 'now' : ''}"><b>${d}</b><span>${date}</span></div>
    ${ev.filter((e) => e.day === i).map(eventCard).join('')}</section>`).join('')}
  ${final() ? `<div class="section"><button class="btn block" data-act="more" data-v="archive">Open the weekend archive</button></div>` : ''}
  <div class="rail-foot">${ART.beerCan()}<span>${esc(titleCase(B('location', 'ASHEVILLE, NORTH CAROLINA')))}</span></div>`;
}

function standingsList() {
  const leader = !preEvent() && S.standings.filter((s) => s.rnk === 1).length === 1 ? S.standings[0].team_id : null;
  return `<div class="panel board"><div class="board-head"><span>${preEvent() ? 'COMPETITION HAS NOT STARTED' : final() ? 'FINAL' : 'LIVE STANDINGS'}</span><b>MAX 17 PTS</b></div>${S.standings.map((s) => {
    const t = U.team(S, s.team_id); const open = !!ui.expanded[s.team_id];
    return `<div class="tbar" ${tstyle(t)}>
      <button class="row stand-row ${leader === s.team_id ? 'lead' : ''}" data-act="expand" data-id="${s.team_id}" aria-expanded="${open}">
        <span class="rank">${final() && S.competition.champion_team_id === s.team_id ? `<span class="mini-trophy" title="Weekend champion">${ART.trophy()}</span>` : preEvent() ? '-' : s.rnk}</span>${teamMark(t)}<span class="team-name">${esc(t.name)}</span>
        <span class="pts">${s.total}<small>PTS</small></span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      ${open ? `<div class="breakdown">
        <div><b>${s.blackjack}</b><span>Casino</span></div><div><b>${s.golf}</b><span>Golf</span></div>
        <div><b>${s.cfb}</b><span>CFB</span></div><div><b>${s.nfl}</b><span>NFL</span></div>
        <div class="tot"><b>${s.total}</b><span>Total</span></div></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// One status model for every event card and the live hero.
function homeEvents() {
  const bj = S.blackjack; const g = S.golf;
  const started = g.summary.some((x) => x.thru > 0); const done = g.summary.every((x) => x.complete);
  const lead = g.summary.find((x) => x.pos === 1);
  const out = [];
  out.push({ key: 'casino', day: 0, env: 'casino', name: 'Casino Night', tab: 'more', kind: 'blackjack',
    status: bj.finalized ? 'final' : 'upcoming',
    sub: bj.finalized ? `${tname(bj.first_team)} wins • Mug: ${esc(U.member(S, bj.mug_member_id)?.name || 'not awarded')}` : 'Blackjack + Roulette • 3 / 2 / 1 pts' });
  out.push({ key: 'golf', day: 1, env: 'golf', name: 'Golf', tab: 'golf',
    status: done ? 'final' : started ? 'live' : 'upcoming',
    sub: done ? (g.placements ? `${tname(g.placements[0])} wins` : 'Tie, commissioner deciding') : started ? `${lead.pos_label.startsWith('T') ? 'Tied lead' : tname(lead.team_id)} ${U.fmtPar(lead.to_par)} • ${g.summary.map((x) => `${tlabel(U.team(S, x.team_id), 6)} ${x.thru ? `thru ${x.thru}` : 'not started'}`).join(', ')}` : 'Reems Creek • Team scramble • 4 / 2 / 1 pts' });
  for (const [kind, day, name] of [['cfb', 1, 'College Football'], ['nfl', 2, 'NFL']]) {
    const d = U.draft(S, kind); const ps = U.picksFor(S, kind); const graded = ps.filter((p) => p.result).length;
    let status = 'upcoming', sub = `${d.rounds} picks per team • ATS`;
    if (d.status === 'open') { const oc = U.onClock(S, kind); status = 'live'; sub = `${tname(oc.team)} on the clock • Round ${oc.round}`; }
    else if (d.status === 'paused') { status = 'live'; sub = `Draft paused at pick ${d.pick_count + 1}`; }
    else if (ps.length && graded === ps.length && d.status === 'complete') { status = 'final'; sub = S.teams.map((t) => `${tlabel(t, 6)} ${U.picksFor(S, kind, t.id).filter((p) => p.result === 'win').length}`).join(' • ') + ' wins'; }
    else if (ps.length) { status = 'live'; sub = `${graded} of ${ps.length} results in`; }
    out.push({ key: kind, day, env: kind, name, tab: 'football', kind, status, sub });
  }
  const tb = S.tiebreaker;
  out.push({ key: 'champ', day: 2, env: 'champ', name: 'Championship', tab: 'standings',
    status: final() ? 'final' : tb.status !== 'none' ? 'live' : 'upcoming',
    sub: final() ? `${tname(S.competition.champion_team_id)} are champions` : tb.status !== 'none' ? `SNF sudden death • ${tname(tb.team_a)} vs ${tname(tb.team_b)}` : 'Most points wins • SNF tiebreaker if needed' });
  return out;
}
function liveEvent() {
  const ev = homeEvents();
  const order = ['casino', 'golf', 'cfb', 'nfl', 'champ'];
  const draftLive = ev.find((e) => (e.key === 'cfb' || e.key === 'nfl') && ['open', 'paused'].includes(U.draft(S, e.key).status));
  if (draftLive) return draftLive.key;
  const live = order.map((k) => ev.find((e) => e.key === k)).find((e) => e.status === 'live');
  return live ? live.key : null;
}
const STATUS_PILL = { live: '<span class="pill live">Live</span>', final: '<span class="pill final">Final</span>', upcoming: '<span class="pill">Upcoming</span>' };
function eventCard(e) {
  return `<button class="ecard env-${e.env} is-${e.status}" data-act="goto" data-tab="${e.tab}" ${e.kind ? `data-kind="${e.kind}"` : ''}>
    <span class="ec-art">${ENV_ART[e.env]()}</span><span class="ec-name">${esc(e.name)}</span><span class="ec-sub">${e.sub}</span>${STATUS_PILL[e.status]}</button>`;
}
const ENV_ART = { casino: () => ART.roulette(), golf: () => ART.mountains('day') + ART.flag(), cfb: () => ART.football(), nfl: () => ART.football(), champ: () => ART.trophy() };
function liveHero(ev, live) {
  const e = ev.find((x) => x.key === live) || ev.find((x) => x.status === 'upcoming');
  if (!e) return '';
  const cta = { casino: e.status === 'final' ? 'See results' : 'Event details', golf: 'Open leaderboard', cfb: e.status === 'live' && ['open', 'paused'].includes(U.draft(S, 'cfb').status) ? 'Enter the draft room' : 'See picks', nfl: e.status === 'live' && ['open', 'paused'].includes(U.draft(S, 'nfl').status) ? 'Enter the draft room' : 'See picks', champ: 'See standings' }[e.key];
  return `<section class="section"><button class="live-hero env-${e.env}" data-act="goto" data-tab="${e.tab}" ${e.kind ? `data-kind="${e.kind}"` : ''}>
    <span class="lh-art">${ENV_ART[e.env]()}</span>
    <span class="lh-kick">${e.status === 'live' ? '<span class="pill live">Live now</span>' : '<span class="pill gold">Up next</span>'}<span class="sec-meta">${DAYS[e.day][0]}</span></span>
    <div class="lh-title">${esc(e.name)}</div><div class="lh-sub">${e.sub}</div><span class="lh-cta">${cta} ›</span></button></section>`;
}

function championCard() {
  const c = S.competition; const t = U.team(S, c.champion_team_id); if (!t) return '';
  const s = S.standings.find((x) => x.team_id === t.id);
  const how = c.champion_method === 'tiebreaker' ? 'Won SNF sudden death' : c.champion_method === 'commissioner' ? 'Named by commissioner' : 'On points';
  return `<section class="champ reveal" ${tstyle(t)}>${ART.mountains('night')}
    <div class="champ-inner">${ART.trophy()}<div style="min-width:0"><div class="champ-label">WEEKEND CHAMPION</div>
      <div class="champ-team">${esc(t.name)}</div><div class="champ-score">FINAL SCORE: ${s ? s.total : ''} PTS</div></div></div>
    <div class="champ-foot"><span>${how}</span><button data-act="replay">Replay ›</button></div>
  </section>`;
}

// ---------------------------------------------------------------- GOLF
function viewGolf() {
  const mine = scoringTeam();
  const views = [['board', 'Leaderboard'], ['card', 'Scorecards']];
  if (mine || isCommish()) views.push(['entry', 'Enter scores']);
  if (ui.golfView === 'entry' && !(mine || isCommish())) ui.golfView = 'board';
  if (ui.golfView === 'entry' && mine && !isCommish()) ui.golfTeam = mine;
  return `<section class="hero golf">${ART.mountains('day')}<div class="fairway"></div>${ART.flag()}
    <div class="hero-in"><div class="hero-kicker">Saturday • October 10</div><div class="hero-title">Reems Creek</div><div class="hero-sub">Par 71 • 4-man scramble • 4 / 2 / 1 pts</div></div></section>
  <div class="seg" role="group">${views.map(([k, l]) => `<button data-act="golfview" data-v="${k}" aria-pressed="${ui.golfView === k}">${l}</button>`).join('')}</div>
  ${ui.golfView === 'board' ? golfBoard() : ui.golfView === 'card' ? golfCardView() : golfEntry()}`;
}

function golfBoard() {
  const g = S.golf;
  const done = g.summary.every((x) => x.complete);
  return `<section class="section">
    <div class="sec-head"><h2 class="sec-title">${done ? 'Final leaderboard' : 'Leaderboard'}</h2><span class="sec-meta">${done ? 'Final' : g.summary.some((x) => x.thru) ? 'Live • to par' : 'Not started'}</span></div>
    <div class="panel">
      <div class="lb-head"><span>POS</span><span></span><span>TEAM</span><span>PAR</span><span>THRU</span><span></span></div>
      ${g.summary.map((s) => { const t = U.team(S, s.team_id); return `<button class="row tbar" ${tstyle(t)} data-act="golfcard" data-team="${s.team_id}">
        <span class="lb-row"><span class="lb-pos">${s.pos_label}</span>${teamMark(t)}<span class="team-name">${esc(t.name)}</span>
        <span class="lb-par ${s.to_par < 0 ? 'under' : ''}">${s.thru ? U.fmtPar(s.to_par) : '--'}</span>
        <span class="lb-thru">${s.complete ? '<b>F</b>' : `<b>${s.thru || '-'}</b>`}${s.thru ? `${s.strokes} STR` : ''}</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span></button>`; }).join('')}
    </div>
    ${g.tie_pending ? '<div class="note warn">All cards are in and teams are tied. The commissioner will set the final order.</div>' : ''}
    ${g.placements ? `<div class="note">Golf points: ${tname(g.placements[0])} 4, ${tname(g.placements[1])} 2, ${tname(g.placements[2])} 1</div>` : '<div class="note">Ranked by score relative to par on holes completed. Points (4/2/1) lock when all three teams finish 18.</div>'}
  </section>`;
}

function golfCardView() {
  return `<div class="seg" role="group" aria-label="Team">${S.teams.map((t) => `<button style="--tc:${esc(t.color)}" data-act="golfteam" data-team="${t.id}" aria-pressed="${ui.golfTeam === t.id}">${tlabel(t)}</button>`).join('')}</div>
  <section class="section">${scorecard(ui.golfTeam)}</section>`;
}

function scoreMark(strokes, par) {
  if (strokes == null) return '<span class="dim">·</span>';
  const d = strokes - par;
  const cls = d <= -2 ? 'e' : d === -1 ? 'b' : d === 1 ? 'bo' : d >= 2 ? 'db' : '';
  return `<span class="mark ${cls}">${strokes}</span>`;
}
function scorecard(teamId) {
  const t = U.team(S, teamId); const s = S.golf.summary.find((x) => x.team_id === teamId);
  const sc = Object.fromEntries(S.golf.scores.filter((x) => x.team_id === teamId).map((x) => [x.hole, x.strokes]));
  const nine = (from) => {
    const hs = S.golf.holes.slice(from, from + 9);
    const par = hs.reduce((a, h) => a + h.par, 0);
    const tot = hs.every((h) => sc[h.hole] != null) ? hs.reduce((a, h) => a + sc[h.hole], 0) : hs.some((h) => sc[h.hole] != null) ? hs.reduce((a, h) => a + (sc[h.hole] || 0), 0) : '';
    return `<div class="card-scroll"><table class="sc"><thead><tr><th>HOLE</th>${hs.map((h) => `<th>${h.hole}</th>`).join('')}<th class="tot">${from ? 'IN' : 'OUT'}</th></tr></thead>
      <tbody><tr><td>PAR</td>${hs.map((h) => `<td class="muted">${h.par}</td>`).join('')}<td class="tot muted">${par}</td></tr>
      <tr><td>SCORE</td>${hs.map((h) => `<td>${scoreMark(sc[h.hole], h.par)}</td>`).join('')}<td class="tot">${tot}</td></tr></tbody></table></div>`;
  };
  return `<div class="panel card-paper">
    <div class="team-head" ${tstyle(t)}>${teamMark(t)}<span class="team-name">${esc(t.name)}</span>
      <span class="rec">${s.thru ? U.fmtPar(s.to_par) : '--'}<small>${s.complete ? 'FINAL' : s.thru ? `THRU ${s.thru}` : 'NOT STARTED'}</small></span></div>
    ${nine(0)}<div style="height:1px;background:var(--line)"></div>${nine(9)}
    <table class="tbl"><thead><tr><th class="l">Split</th><th>Strokes</th><th>To par</th></tr></thead><tbody>
      <tr><td class="l">Front 9</td><td>${s.front_strokes || '--'}</td><td>${s.front_strokes ? U.fmtPar(s.front_to_par) : '--'}</td></tr>
      <tr><td class="l">Back 9</td><td>${s.back_strokes || '--'}</td><td>${s.back_strokes ? U.fmtPar(s.back_to_par) : '--'}</td></tr>
      <tr><td class="l">Total</td><td class="big">${s.strokes || '--'}</td><td class="big ${s.to_par < 0 ? 'under' : ''}">${s.thru ? U.fmtPar(s.to_par) : '--'}</td></tr>
    </tbody></table>
    <div class="card-legend"><span><i class="l-e"></i>Eagle</span><span><i class="l-b"></i>Birdie</span><span><i class="l-bo"></i>Bogey</span><span><i class="l-db"></i>Double+</span></div>
    <div class="note" style="border:0">Scorekeeper: ${esc(S.members.find((m) => m.team_id === teamId && m.role === 'scorekeeper')?.name || '--')}</div>
  </div>`;
}

function golfEntry() {
  const teamId = scoringTeam() && !isCommish() ? scoringTeam() : ui.golfTeam;
  const t = U.team(S, teamId);
  if (final()) return '<div class="empty"><b>Weekend is final</b>Scores are locked.</div>';
  const sc = Object.fromEntries(S.golf.scores.filter((x) => x.team_id === teamId).map((x) => [x.hole, x.strokes]));
  if (ui.entryHole == null) ui.entryHole = (S.golf.holes.find((h) => sc[h.hole] == null) || { hole: 18 }).hole;
  const hole = S.golf.holes.find((h) => h.hole === ui.entryHole);
  const cur = ui.entryVal ?? sc[hole.hole] ?? hole.par;
  const rel = cur - hole.par;
  const relName = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' }[rel] || (rel > 0 ? `+${rel}` : `${rel}`);
  return `${isCommish() ? `<div class="seg" role="group" aria-label="Team">${S.teams.map((x) => `<button style="--tc:${esc(x.color)}" data-act="golfteam" data-team="${x.id}" aria-pressed="${teamId === x.id}">${tlabel(x)}</button>`).join('')}</div>
    <div class="note warn">Commissioner correction mode. Edits sync to everyone.</div>` : ''}
  <section class="section"><div class="panel tbar" ${tstyle(t)}>
    <div class="entry">
      <div class="entry-hole">HOLE<b>${hole.hole}</b></div>
      <div class="entry-par">PAR ${hole.par}${sc[hole.hole] != null ? ` • SAVED ${sc[hole.hole]}` : ''}</div>
      <div class="stepper">
        <button class="step-btn" data-act="step" data-d="-1" aria-label="One fewer stroke">−</button>
        <div><div class="step-val" aria-live="polite">${cur}</div><div class="step-rel">${relName.toUpperCase()}</div></div>
        <button class="step-btn" data-act="step" data-d="1" aria-label="One more stroke">+</button>
      </div>
      <button class="btn primary block" style="margin-top:14px;min-height:56px;font-size:18px" data-act="savehole" data-team="${teamId}">Save hole ${hole.hole}</button>
      ${sc[hole.hole] != null ? `<button class="btn sm" style="margin-top:10px" data-act="clearhole" data-team="${teamId}">Clear hole ${hole.hole}</button>` : ''}
    </div>
    <div class="hole-chips">${S.golf.holes.map((h) => `<button class="hole-chip ${sc[h.hole] != null ? 'done' : ''} ${h.hole === hole.hole ? 'cur' : ''}" data-act="hole" data-h="${h.hole}" aria-label="Hole ${h.hole}">${h.hole}<small>${sc[h.hole] ?? ''}</small></button>`).join('')}</div>
  </div></section>
  <section class="section">${scorecard(teamId)}</section>`;
}

// ---------------------------------------------------------------- FOOTBALL
function viewFootball() {
  const kind = ui.fbKind; const d = U.draft(S, kind);
  const inDraft = d.status === 'open' || d.status === 'paused';
  const opts = inDraft ? [['room', 'Draft room'], ['picks', 'Picks']] : [['picks', 'Picks'], ['board', 'Board']];
  let v = ui.fbView[kind];
  if (!opts.some(([k]) => k === v)) v = opts[0][0];
  return `<section class="hero football ${kind}"><div class="field"></div>${ART.football()}
    <div class="hero-in"><div class="hero-kicker">${kind === 'cfb' ? 'Saturday • College Football' : 'Sunday • NFL'}</div><div class="hero-title">${kind === 'cfb' ? 'Saturday ATS' : 'Sunday ATS'}</div><div class="hero-sub">${d.rounds} picks per team • win = 1 pt • straight draft</div></div></section>
  <div class="seg" role="group" aria-label="League">${['cfb', 'nfl'].map((k) => `<button data-act="fbkind" data-kind="${k}" aria-pressed="${kind === k}">${k === 'cfb' ? 'College' : 'NFL'}</button>`).join('')}</div>
  <div class="seg" role="group" style="margin-top:8px">${opts.map(([k, l]) => `<button data-act="fbview" data-v="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>
  ${v === 'room' ? draftRoom(kind) : v === 'board' ? draftBoard(kind, false) : picksView(kind)}`;
}

function clockState(d) {
  if (d.status === 'paused') return { paused: true, ms: d.clock_remaining_ms ?? 60000 };
  if (d.status === 'open' && d.clock_running && d.clock_started_at) return { ms: d.clock_seconds * 1000 - (nowServer() - Date.parse(d.clock_started_at)) };
  return null;
}
function paintClocks() {
  document.querySelectorAll('[data-clock]').forEach((el) => {
    const d = U.draft(S, el.dataset.clock); const c = d && clockState(d);
    if (!c) { el.textContent = ''; return; }
    el.classList.remove('low', 'expired', 'paused');
    if (c.paused) { el.textContent = `PAUSED ${U.fmtClock(c.ms)}`; el.classList.add('paused'); }
    else if (c.ms <= 0) { el.textContent = 'TIME EXPIRED'; el.classList.add('expired'); }
    else { el.textContent = U.fmtClock(c.ms); if (c.ms <= 10000) el.classList.add('low'); }
  });
}
setInterval(() => S && paintClocks(), 250);

function canPickNow(kind) {
  const d = U.draft(S, kind); const oc = U.onClock(S, kind);
  if (d.status !== 'open' || !oc) return { ok: false };
  if (d.drafters[oc.team] === me().id) return { ok: true, team: oc.team };
  if (isCommish() && testMode()) return { ok: true, team: oc.team, proxy: true };
  return { ok: false };
}

function draftRoom(kind) {
  const d = U.draft(S, kind); const oc = U.onClock(S, kind); const t = oc && U.team(S, oc.team);
  const drafter = oc && U.member(S, d.drafters[oc.team]);
  const cp = canPickNow(kind);
  const up = U.upcoming(S, kind, 7);
  return `<section class="scorebug ${oc && d.status === 'open' ? 'otc' : ''}" ${tstyle(t)}>
    <div class="bug-top">${kind === 'cfb' ? 'CFB' : 'NFL'} DRAFT<span>${oc ? `${d.pick_count} OF ${d.total_picks} PICKS MADE` : 'COMPLETE'}</span></div>
    ${oc ? `<div class="bug-main"><div class="otc-label">ON THE CLOCK</div>
        <div class="otc-team">${teamMark(t)}<span class="team-name">${esc(t.name)}</span></div>
        <div class="clock" data-clock="${kind}" aria-live="off"></div>
        <div class="otc-sub">ROUND ${oc.round} • PICK ${oc.overall}</div>
        <div class="otc-drafter">Drafter: ${esc(drafter?.name || 'not set')}</div></div>` : ''}
    <div class="order-strip" aria-label="Upcoming picks">${up.map((u, i) => { const ut = U.team(S, u.team); return `<span class="order-chip ${i === 0 ? 'now' : ''}" ${tstyle(ut)}>${teamMark(ut, 'sm')}<em>#${u.overall}</em></span>`; }).join('')}</div>
  </section>
  ${cp.ok ? `<div class="your-turn">${cp.proxy && d.drafters[cp.team] !== me().id ? `TEST MODE: PICKING FOR ${tname(cp.team).toUpperCase()}` : "YOU'RE ON THE CLOCK • TAP A LINE"}</div>` : ''}
  ${d.status === 'paused' ? '<div class="note warn">The commissioner paused the draft.</div>' : ''}
  ${draftBoard(kind, cp.ok)}
  ${recentPicks(kind)}`;
}

function gameWhen(g) {
  if (g.kickoff) return `${U.fmtKick(g.kickoff)} ET`;
  if (g.game_date) return new Date(`${g.game_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return '';
}

function draftBoard(kind, pickable) {
  const games = S.games.filter((g) => g.kind === kind && g.active);
  const onClockTeam = pickable ? canPickNow(kind).team : null;
  if (!games.length) return `<div class="section"><div class="panel"><div class="empty"><b>No games on the slate yet</b>The commissioner enters every game and spread before the draft.</div></div></div>`;
  return `<section class="section"><div class="sec-head"><h2 class="sec-title">The board</h2><span class="sec-meta">${games.length} games${pickable ? ' • tap a line' : ''}</span></div>
  <div class="panel">${games.map((g) => {
    const oa = U.sideOwner(S, g.id, 'away'), oh = U.sideOwner(S, g.id, 'home');
    const mineOther = onClockTeam && ((oa && oa.team_id === onClockTeam) || (oh && oh.team_id === onClockTeam));
    const side = (s, owner) => {
      const teamN = s === 'home' ? g.home_team : g.away_team;
      const sp = s === 'home' ? g.home_spread : g.away_spread;
      const shown = owner ? owner.spread : sp;          // owned sides always show their FROZEN spread
      const ot = owner && U.team(S, owner.team_id);
      const can = pickable && !owner && !mineOther;
      const fresh = owner && freshPickIds.has(owner.id);
      return `<${can ? 'button' : 'div'} class="side ${owner ? 'taken' : ''} ${can ? 'can' : ''} ${!owner && mineOther ? 'blocked' : ''} ${fresh ? 'lock-in' : ''}" ${ot ? tstyle(ot) : ''} ${can ? `data-act="pick" data-kind="${kind}" data-g="${g.id}" data-s="${s}"` : ''}>
        <span class="s-ha">${s === 'home' ? 'HOME' : 'AWAY'}</span>
        <span class="s-team">${esc(teamN)}</span><span class="s-line">${U.fmtSpread(shown)}</span>
        ${ot ? `<span class="owner"><svg class="lock-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>LOCKED • ${tlabel(ot).toUpperCase()} #${owner.pick_no}</span>` : !owner && mineOther ? '<span class="owner muted-owner">YOU OWN THE OTHER SIDE</span>' : ''}
      </${can ? 'button' : 'div'}>`;
    };
    const when = gameWhen(g);
    return `<div class="gcard ${oa && oh ? 'exhausted' : ''}"><div class="gmeta"><span>${esc(when)}</span><span>${g.demo ? 'DEMO LINE' : ''}${oa && oh ? `${g.demo ? ' • ' : ''}BOTH SIDES DRAFTED` : ''}</span></div>
      <div class="sides">${side('away', oa)}${side('home', oh)}</div></div>`;
  }).join('')}</div></section>`;
}

function recentPicks(kind) {
  const ps = U.picksFor(S, kind).slice().reverse().slice(0, 8);
  if (!ps.length) return '';
  return `<section class="section"><div class="sec-head"><h2 class="sec-title">Latest picks</h2></div><div class="panel">
    ${ps.map((p) => { const t = U.team(S, p.team_id); return `<div class="row tbar pick" ${tstyle(t)}><span class="pick-no">${p.pick_no}</span>
      <span class="pick-main"><b>${esc(p.selected_team)} ${U.fmtSpread(p.spread)}</b><div>${esc(t.name)} • vs ${esc(p.opponent)} • R${p.round}</div></span>${teamMark(t, 'sm')}</div>`; }).join('')}
  </div></section>`;
}

const RESULT_PILL = { win: '<span class="pill win">Win ✓</span>', loss: '<span class="pill loss">Loss ✕</span>', push: '<span class="pill push">Push</span>' };
function pickStatus(p) {
  const when = p.kickoff ? ` • ${esc(U.fmtKick(p.kickoff))} ET` : '';
  return { pill: RESULT_PILL[p.result] || '<span class="pill">Pending</span>', sub: `vs ${esc(p.opponent)}${when}` };
}

function picksView(kind) {
  const d = U.draft(S, kind); const ps = U.picksFor(S, kind); const per = d.rounds;
  if (!ps.length) {
    return `<div class="section"><div class="panel"><div class="empty"><b>${d.status === 'setup' ? 'Draft not started' : 'No picks yet'}</b>${per} rounds, straight order, 60 second clock. Picks appear here the moment they are drafted.</div></div></div>`;
  }
  const seg = `<div class="seg" role="group" style="margin-top:8px">${[['team', 'By team'], ['round', 'By round']].map(([k, l]) => `<button data-act="pickgroup" data-v="${k}" aria-pressed="${ui.pickGroup === k}">${l}</button>`).join('')}</div>`;
  const row = (p) => { const st = pickStatus(p); const t = U.team(S, p.team_id);
    return `<div class="row pick tbar ${p.result ? `res-${p.result}` : ''}" ${tstyle(t)}><span class="pick-no">${ui.pickGroup === 'team' ? p.round : p.pick_no}</span>
      <span class="pick-main"><b>${esc(p.selected_team)} ${U.fmtSpread(p.spread)}</b><div>${ui.pickGroup === 'round' ? `${esc(t.name)} • ` : ''}${st.sub}</div></span>${st.pill}</div>`; };
  if (ui.pickGroup === 'round') {
    const rounds = [...new Set(ps.map((p) => p.round))];
    return `${seg}${rounds.map((r) => `<section class="section"><div class="sec-head"><h2 class="sec-title">Round ${r}</h2></div><div class="panel">${ps.filter((p) => p.round === r).map(row).join('')}</div></section>`).join('')}`;
  }
  const order = d.order || [1, 2, 3];
  return `${seg}${order.map((tid) => { const t = U.team(S, tid); const r = U.atsRecord(S, kind, tid); const st = S.standings.find((x) => x.team_id === tid);
    return `<section class="section"><div class="panel"><div class="team-head" ${tstyle(t)}>${teamMark(t)}<span class="team-name">${esc(t.name)}</span>
      <span class="rec">${st[kind]}<small>/ ${per} ${kind.toUpperCase()} PTS</small></span></div>
      ${U.picksFor(S, kind, tid).map(row).join('') || '<div class="empty">No picks yet</div>'}
      <div class="rec-line">${r.w}-${r.l}-${r.p}${r.pending ? ` • ${r.pending} pending` : ''}</div></div></section>`; }).join('')}`;
}

// ---------------------------------------------------------------- STANDINGS
function viewStandings() {
  const bj = S.blackjack; const g = S.golf; const tb = S.tiebreaker;
  return `${final() ? championCard() : ''}
  <section class="section"><div class="sec-head"><h2 class="sec-title">Championship</h2><span class="sec-meta">${preEvent() ? 'Not started • ' : ''}Max 17 pts</span></div>
    <div class="panel"><table class="tbl"><thead><tr><th></th><th class="l">Team</th><th>Cas</th><th>Golf</th><th>CFB</th><th>NFL</th><th>Tot</th></tr></thead><tbody>
    ${S.standings.map((s) => { const t = U.team(S, s.team_id); return `<tr class="tbar" ${tstyle(t)}><td class="muted">${preEvent() ? '-' : s.rnk}</td><td class="l"><span style="display:inline-flex;gap:8px;align-items:center">${teamMark(t, 'sm')}${esc(t.short_name)}</span></td>
      <td>${s.blackjack}</td><td>${s.golf}</td><td>${s.cfb}</td><td>${s.nfl}</td><td class="big">${s.total}</td></tr>`; }).join('')}
    </tbody></table></div></section>
  ${tb.status !== 'none' ? tiebreakerCard() : ''}
  <section class="section"><div class="sec-head"><h2 class="sec-title">Event results</h2></div><div class="panel">
    <div class="row ev"><span class="ev-name">Casino Night</span><span class="ev-sub">${bj.finalized ? `1st ${tname(bj.first_team)} • 2nd ${tname(bj.second_team)} • 3rd ${tname(bj.third_team)}` : 'Not final'}</span>${bj.finalized ? '<span class="pill final">3 / 2 / 1</span>' : '<span class="pill">Pending</span>'}</div>
    <div class="row ev"><span class="ev-name">Golf</span><span class="ev-sub">${g.placements ? `1st ${tname(g.placements[0])} • 2nd ${tname(g.placements[1])} • 3rd ${tname(g.placements[2])}` : g.tie_pending ? 'Tie, awaiting commissioner' : 'In progress'}</span>${g.placements ? '<span class="pill final">4 / 2 / 1</span>' : '<span class="pill">Pending</span>'}</div>
    ${['cfb', 'nfl'].map((k) => `<div class="row ev"><span class="ev-name">${k === 'cfb' ? 'College ATS' : 'NFL ATS'}</span><span class="ev-sub">${S.teams.map((t) => { const r = U.atsRecord(S, k, t.id); return `${esc(t.short_name)} ${r.w}-${r.l}-${r.p}`; }).join(' • ')}</span><span class="pill">${k === 'cfb' ? '4' : '6'} picks</span></div>`).join('')}
  </div></section>`;
}

function tbSides(tb) {
  if (!tb.first_side) return null;
  const other = tb.first_team === tb.team_a ? tb.team_b : tb.team_a;
  const sideTeam = (side) => (side === 'home' ? tb.home_team : tb.away_team);
  const sideSpread = (side) => (side === 'home' ? Number(tb.home_spread) : -Number(tb.home_spread));
  const otherSide = tb.first_side === 'home' ? 'away' : 'home';
  return [
    { team: tb.first_team, side: tb.first_side, name: sideTeam(tb.first_side), spread: sideSpread(tb.first_side), how: 'won the coin flip' },
    { team: other, side: otherSide, name: sideTeam(otherSide), spread: sideSpread(otherSide), how: 'assigned the opposite side' },
  ];
}
function tiebreakerCard() {
  const tb = S.tiebreaker; if (tb.status === 'none') return '';
  const sides = tbSides(tb);
  const verdict = (team) => (tb.result === 'push' ? '<span class="pill push">Push</span>' : tb.winner_team ? `<span class="pill ${tb.winner_team === team ? 'win' : 'loss'}">${tb.winner_team === team ? 'Covers ✓' : 'Out'}</span>` : '<span class="pill">Pending</span>');
  return `<section class="section"><div class="sec-head"><h2 class="sec-title">SNF sudden death</h2><span class="sec-meta">${esc(tb.away_team)} at ${esc(tb.home_team)}</span></div><div class="panel">
    ${sides ? sides.map((x, i) => `<div class="row tbar pick" ${tstyle(U.team(S, x.team))}><span class="pick-no">${i + 1}</span><span class="pick-main"><b>${esc(x.name)} ${U.fmtSpread(x.spread)}</b><div>${tname(x.team)} • ${x.how}</div></span>${verdict(x.team)}</div>`).join('')
      : `<div class="empty"><b>${tname(tb.team_a)} vs ${tname(tb.team_b)}</b>Waiting on the coin flip.</div>`}
    ${tb.result === 'push' ? `<div class="note warn" style="margin:0;border:0">${final() ? `The SNF game pushed. The commissioner named ${tname(S.competition.champion_team_id)} champion.` : 'The SNF game pushed. The commissioner will name the champion.'}</div>` : ''}
    <div class="note" style="margin:0;border:0">Spread frozen when the coin-flip winner chose. The team that covers is Weekend Champion; this is not a +1 point.</div>
  </div></section>`;
}

// ---------------------------------------------------------------- MORE
function viewMore() {
  if (ui.more === 'blackjack') return casinoPage();
  if (ui.more === 'teams') return sub('Teams', teamsView());
  if (ui.more === 'archive') return sub('Archive', archiveView());
  if (ui.more === 'commish' && isCommish()) return sub('Commissioner', commishView());
  const items = [['blackjack', 'Casino Night', 'Blackjack + Roulette results and the Mug'], ['teams', 'Teams & members', 'Rosters, scorekeepers, drafters'], ['archive', 'Archive', final() ? 'Final results from the weekend' : 'Full record, locks when final']];
  if (isCommish()) items.push(['commish', 'Commissioner', 'Control center']);
  return `<section class="section"><div class="panel">${items.map(([k, l, s]) => `<button class="row" data-act="more" data-v="${k}"><span style="flex:1"><span class="team-name" style="font-size:18px">${l}</span><div class="muted" style="font-size:13px">${s}</div></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`).join('')}</div></section>
  <section class="section page-pad"><button class="btn block" data-act="logout">Sign out / switch user</button>
    <p class="help" style="margin-top:10px;text-align:center">Signed in as ${esc(me().name)} • ${tname(me().team_id)}</p></section>`;
}
const sub = (title, body) => `<div class="page-pad" style="padding-top:12px"><button class="btn sm" data-act="more" data-v="">‹ More</button></div>${body}`;

function casinoPage() {
  return `<section class="hero casino"><div class="casino-deco">${ART.roulette()}${ART.card('A', '♠', 'c2')}${ART.card('K', '♥')}${ART.chip('var(--chip-r)', 'k1')}${ART.chip('var(--chip-g)', 'k2')}${ART.chip('var(--chip-b)', 'k3')}</div>
    <div class="hero-in"><div class="hero-kicker">Friday • October 9</div><div class="hero-title">Casino Night</div><div class="hero-sub">Blackjack + Roulette</div></div></section>
  <div class="page-pad" style="padding-top:12px"><button class="btn sm" data-act="more" data-v="">‹ More</button></div>
  ${blackjackView()}
  <div class="rail-foot">${ART.beerCan()}<span>One combined result • 3 / 2 / 1</span></div>`;
}
function blackjackView() {
  const bj = S.blackjack;
  if (!bj.finalized) return '<div class="section"><div class="panel felt-panel"><div class="empty"><b>Casino Night results pending</b>Blackjack and roulette count as one event. The commissioner enters the final 1st, 2nd and 3rd place teams when the tables close.</div></div></div>';
  const rows = [[bj.first_team, 1, 3], [bj.second_team, 2, 2], [bj.third_team, 3, 1]];
  const mug = U.member(S, bj.mug_member_id);
  return `<section class="section"><div class="sec-head"><h2 class="sec-title">Casino Night</h2><span class="sec-meta">Final</span></div>
    <div class="panel felt-panel"><div class="board-head"><span>BLACKJACK + ROULETTE</span><b>FINAL</b></div>
    ${rows.map(([tid, r, pt]) => { const t = U.team(S, tid); return `<div class="row tbar casino-place" ${tstyle(t)}><span class="rank">${r}</span>${teamMark(t)}<span class="team-name">${esc(t.name)}</span><span class="pts">${pt}<small>${pt === 1 ? 'PT' : 'PTS'}</small></span></div>`; }).join('')}
  </div></section>
  <section class="section"><div class="sec-head"><h2 class="sec-title">Mug winner</h2><span class="sec-meta">Individual • 0 pts</span></div><div class="panel felt-panel">
    <div class="mug-card"><span class="mug-icon"><svg viewBox="0 0 24 24"><path d="M5 6h11v11a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><path d="M16 9h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2"/><path d="M8 3v1M11 2v2M14 3v1"/></svg></span>
      ${mug ? `<span style="min-width:0"><b>${esc(mug.name)}</b><small>${esc(U.team(S, mug.team_id)?.name || '')}</small></span>` : '<span class="muted">Not awarded</span>'}</div></div></section>`;
}

function teamsView() {
  return S.teams.map((t) => `<section class="section"><div class="panel"><div class="team-head" ${tstyle(t)}>${teamMark(t)}<span class="team-name">${esc(t.name)}</span></div>
    ${S.members.filter((m) => m.team_id === t.id).map((m) => {
      const tags = [];
      if (m.role === 'commissioner') tags.push('<span class="pill gold">Commissioner</span>');
      if (m.role === 'scorekeeper') tags.push('<span class="pill">Golf scorekeeper</span>');
      for (const d of S.drafts) if (d.drafters[t.id] === m.id) tags.push(`<span class="pill">${d.kind.toUpperCase()} drafter</span>`);
      return `<div class="row"><span style="flex:1;font-weight:600">${esc(m.name)}</span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${tags.join('')}</span></div>`;
    }).join('')}</div></section>`).join('');
}

function archiveView() {
  return `<section class="hero home" style="height:110px">${ART.mountains('night')}<div class="topo-layer"></div><div class="hero-in"><div class="home-id"><b>The Record</b><span>${esc(B('eventName', "QUYLE'S"))} ${esc(B('eventTagline', 'BACHELOR PARTY'))} • ${esc(B('year', '2026'))}</span></div></div></section>
  ${final() ? championCard() : '<div class="note warn">The weekend is still in progress. This page becomes the permanent record once the commissioner finalizes.</div>'}
  <section class="section"><div class="sec-head"><h2 class="sec-title">Final standings</h2></div>${standingsList()}</section>
  ${S.tiebreaker.status !== 'none' ? tiebreakerCard() : ''}
  ${blackjackView()}
  ${golfBoard()}
  ${S.teams.map((t) => `<section class="section">${scorecard(t.id)}</section>`).join('')}
  <div class="sec-head" style="margin:22px 16px 0"><h2 class="sec-title">College football picks</h2></div>${picksView('cfb')}
  <div class="sec-head" style="margin:22px 16px 0"><h2 class="sec-title">NFL picks</h2></div>${picksView('nfl')}`;
}

// ---------------------------------------------------------------- COMMISSIONER
function acc(key, title, body, badge = '') {
  const open = !!ui.acc[key];
  return `<div class="acc"><button data-act="acc" data-v="${key}" aria-expanded="${open}"><span>${title}</span><span style="display:flex;gap:8px;align-items:center">${badge}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span></button>${open ? `<div class="acc-body">${body()}</div>` : ''}</div>`;
}
const teamOpts = (sel, blank = true) => `${blank ? '<option value="">Choose</option>' : ''}${S.teams.map((t) => `<option value="${t.id}" ${+sel === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;

function commishView() {
  const c = S.competition;
  return `<section class="section"><div class="panel">
    ${acc('weekend', 'Weekend', cWeekend, `<span class="pill ${c.status === 'final' ? 'final' : c.status === 'live' ? 'live' : ''}">${c.status}</span>`)}
    ${acc('bj', 'Casino Night', cBlackjack, S.blackjack.finalized ? '<span class="pill final">Final</span>' : '')}
    ${acc('golf', 'Golf', cGolf, S.golf.tie_pending ? '<span class="pill gold">Tie</span>' : '')}
    ${acc('cfbslate', 'CFB draft slate', () => cSlate('cfb'), `<span class="pill">${S.games.filter((g) => g.kind === 'cfb' && g.active).length} games</span>`)}
    ${acc('cfb', 'CFB draft', () => cDraft('cfb'), `<span class="pill">${U.draft(S, 'cfb').status}</span>`)}
    ${acc('cfbres', 'CFB results', () => cResults('cfb'), resBadge('cfb'))}
    ${acc('nflslate', 'NFL draft slate', () => cSlate('nfl'), `<span class="pill">${S.games.filter((g) => g.kind === 'nfl' && g.active).length} games</span>`)}
    ${acc('nfl', 'NFL draft', () => cDraft('nfl'), `<span class="pill">${U.draft(S, 'nfl').status}</span>`)}
    ${acc('nflres', 'NFL results', () => cResults('nfl'), resBadge('nfl'))}
    ${acc('tb', 'Tiebreaker', cTiebreaker, S.tiebreaker.status !== 'none' ? `<span class="pill live">${S.tiebreaker.status}</span>` : '')}
    ${acc('test', 'Testing & reset', cTesting, testMode() ? '<span class="test-flag">TEST</span>' : '<span class="pill final">Production</span>')}
  </div></section>`;
}

function cWeekend() {
  const c = S.competition; const top = Math.max(...S.standings.map((s) => s.total));
  const tied = S.standings.filter((s) => s.total === top).length > 1;
  return `<div class="sub-h">Competition status</div>
  <div class="btn-row">${['setup', 'live'].map((s) => `<button class="btn sm ${c.status === s ? 'primary' : ''}" data-act="c-status" data-v="${s}" ${final() ? 'disabled' : ''}>${s}</button>`).join('')}</div>
  <div class="sub-h">Champion</div>
  ${final() ? `<p class="help">Final: ${tname(c.champion_team_id)} (${esc(c.champion_method)}).</p><button class="btn block" data-act="c-reopen">Reopen weekend</button>` : `
    <p class="help">${preEvent() ? 'Competition has not started yet.' : tied && S.tiebreaker.winner_team == null ? 'Teams are tied at the top. Run the SNF tiebreaker, or name the champion below.' : 'Finalizing locks scoring and switches the app to the champion and archive view.'}</p>
    <div class="field"><label for="fz">Champion override (only if needed)</label><select id="fz" data-k="fin.team"><option value="">Use points / tiebreaker</option>${teamOpts(null, false)}</select></div>
    <button class="btn primary block" data-act="c-finalize">Finalize weekend</button>`}
  <div class="sub-h">Teams (names, colors, logos)</div>
  ${S.teams.map((t) => `<div class="field"><label>Team ${t.id} name</label><input data-k="tm.${t.id}.name" value="${esc(t.name)}"></div>
     <div class="grid-2"><div class="field"><label>Short (max 4)</label><input data-k="tm.${t.id}.short" value="${esc(t.short_name)}" maxlength="4"></div>
     <div class="field"><label>Color</label><input type="color" data-k="tm.${t.id}.color" value="${esc(t.color)}"></div></div>
     <div class="field"><label>Logo URL (optional)</label><input data-k="tm.${t.id}.logo" value="${esc(t.logo_url || '')}" placeholder="https://..."></div>
     <button class="btn sm" data-act="c-team" data-team="${t.id}" style="margin-bottom:14px">Save ${esc(t.short_name)}</button>`).join('')}
`;
}

function cBlackjack() {
  const bj = S.blackjack;
  const mugOpts = `<option value="">No Mug winner</option>${S.teams.map((t) => `<optgroup label="${esc(t.name)}">${S.members.filter((m) => m.team_id === t.id).map((m) => `<option value="${m.id}" ${bj.mug_member_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}`;
  return `<p class="help">Blackjack + Roulette count as one combined event. Enter the final team order: 1st = 3 pts, 2nd = 2, 3rd = 1. The Mug is an individual award worth 0.</p>
  <div class="grid-3">${[['first', '1st', bj.first_team], ['second', '2nd', bj.second_team], ['third', '3rd', bj.third_team]].map(([k, l, v]) =>
    `<div class="field"><label>${l}</label><select data-k="bj.${k}">${teamOpts(v)}</select></div>`).join('')}</div>
  <div class="field"><label>Mug winner</label><select data-k="bj.mug">${mugOpts}</select></div>
  <div class="btn-row"><button class="btn primary" data-act="c-bj" data-final="1">${bj.finalized ? 'Update final' : 'Finalize results'}</button>
  ${bj.finalized ? '<button class="btn danger" data-act="c-bjclear">Clear</button>' : ''}</div>`;
}

function cGolf() {
  const g = S.golf;
  return `<p class="help">Use Golf > Enter scores to correct any team's card. Every correction is announced in the ticker.</p>
  <button class="btn block" data-act="goto" data-tab="golf" data-golfview="entry">Open golf correction mode</button>
  <div class="sub-h">Resolve tie</div>
  ${g.summary.every((s) => s.complete) ? `<p class="help">${g.tie_pending ? 'Teams are tied on strokes. Set the final order.' : g.golf_order_override ? 'Order set manually.' : 'No tie. Order was set automatically.'}</p>
    <div class="grid-3">${[1, 2, 3].map((i) => `<div class="field"><label>${U.ordinal(i)}</label><select data-k="gt.${i}">${teamOpts((S.competition.golf_order_override || g.placements || [])[i - 1])}</select></div>`).join('')}</div>
    <div class="btn-row"><button class="btn primary" data-act="c-golftie">Set golf order</button>${S.competition.golf_order_override ? '<button class="btn" data-act="c-golftieclear">Clear override</button>' : ''}</div>`
    : '<p class="help">Available once all three teams have finished 18.</p>'}`;
}

function cDraft(kind) {
  const d = U.draft(S, kind); const ps = U.picksFor(S, kind);
  const games = S.games.filter((g) => g.kind === kind);
  const locked = ps.length > 0;
  return `<div class="kv"><span>Status</span><span>${esc(d.status)} • ${d.pick_count} of ${d.total_picks} picks</span></div>
  <div class="sub-h">Draft order (straight, not snake)</div>
  <div class="grid-3">${[1, 2, 3].map((i) => `<div class="field"><label>Pick ${i}</label><select data-k="do.${kind}.${i}" ${locked ? 'disabled' : ''}>${teamOpts(d.order?.[i - 1])}</select></div>`).join('')}</div>
  ${locked ? '<p class="help">Order is locked once picks exist. Undo all picks to change it.</p>' : ''}
  <div class="sub-h">Designated drafters</div>
  <div class="grid-3">${S.teams.map((t) => `<div class="field"><label>${esc(t.short_name)}</label><select data-k="dd.${kind}.${t.id}"><option value="">Choose</option>${S.members.filter((m) => m.team_id === t.id).map((m) => `<option value="${m.id}" ${d.drafters[t.id] === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`).join('')}</div>
  <button class="btn block" data-act="c-draftcfg" data-kind="${kind}">Save order &amp; drafters</button>
  <div class="sub-h">Draft controls</div>
  <div class="btn-row">
    ${d.status === 'setup' || (d.status === 'complete' && d.pick_count < d.total_picks) ? `<button class="btn primary" data-act="c-dc" data-kind="${kind}" data-v="open">Open draft</button>` : ''}
    ${d.status === 'open' ? `<button class="btn" data-act="c-dc" data-kind="${kind}" data-v="pause">Pause</button>` : ''}
    ${d.status === 'paused' ? `<button class="btn primary" data-act="c-dc" data-kind="${kind}" data-v="resume">Resume</button>` : ''}
    ${d.status === 'open' || d.status === 'paused' ? `<button class="btn" data-act="c-dc" data-kind="${kind}" data-v="reset_clock">Reset clock</button>` : ''}
    ${ps.length ? `<button class="btn danger" data-act="c-undo" data-kind="${kind}">Undo last pick</button>` : ''}
    ${d.status === 'open' || d.status === 'paused' ? `<button class="btn" data-act="c-dc" data-kind="${kind}" data-v="close">Close draft</button>` : ''}
  </div>
  <p class="help" style="margin-top:8px">There is no auto-pick. When the clock hits zero it shows TIME EXPIRED and waits for you. The drafter can still make the pick, or you can pause or reset the clock.</p>
  <p class="help">Games and spreads live in the ${kind.toUpperCase()} draft slate section above.</p>
  ${ps.length ? `<div class="sub-h">Correct a pick</div>${ps.map((p) => `<div class="mini-game"><div><b>#${p.pick_no} ${esc(p.selected_team)} ${U.fmtSpread(p.spread)}</b><div class="muted">${tname(p.team_id)} • R${p.round}</div></div><button class="btn sm" data-act="c-replace" data-p="${p.id}">Replace</button></div>`).join('')}` : ''}`;
}

function resBadge(kind) {
  const ps = U.picksFor(S, kind); if (!ps.length) return '';
  const done = ps.filter((p) => p.result).length;
  return `<span class="pill ${done === ps.length ? 'final' : ''}">${done}/${ps.length}</span>`;
}

function cSlate(kind) {
  const games = S.games.filter((g) => g.kind === kind);
  const d = U.draft(S, kind); const need = Math.ceil((d.rounds * 3) / 2);
  const act = games.filter((g) => g.active).length;
  return `<p class="help">Only the active games below appear in the ${kind.toUpperCase()} draft room. You are the only source for games and spreads; nothing is imported. Editing a line never changes a pick that was already drafted.</p>
  <div class="kv"><span>Active games</span><span>${act}${act < need ? ` • need at least ${need} to open the draft` : ''}</span></div>
  <button class="btn primary block" data-act="c-game" data-kind="${kind}" style="margin-top:10px">+ Add game</button>
  ${games.map((g, i) => {
    const oa = U.sideOwner(S, g.id, 'away'), oh = U.sideOwner(S, g.id, 'home'); const picked = oa || oh;
    const own = (o) => (o ? ` <span class="own-tag" ${tstyle(U.team(S, o.team_id))}>${esc(U.team(S, o.team_id).short_name)} ${U.fmtSpread(o.spread)}</span>` : '');
    return `<div class="slate-row ${g.active ? '' : 'inactive'}">
      <div class="slate-move"><button class="btn xs" data-act="c-move" data-g="${g.id}" data-v="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button><button class="btn xs" data-act="c-move" data-g="${g.id}" data-v="1" ${i === games.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></div>
      <div class="slate-main"><div class="slate-line"><span>${esc(g.away_team)}</span><b>${U.fmtSpread(g.away_spread)}</b>${own(oa)}</div>
        <div class="slate-line"><span>@ ${esc(g.home_team)}</span><b>${U.fmtSpread(g.home_spread)}</b>${own(oh)}</div>
        <div class="muted slate-meta">${esc(gameWhen(g) || 'No kickoff entered')}${g.demo ? ' • DEMO' : ''}${picked ? ' • drafted' : ''}${g.active ? '' : ' • INACTIVE'}</div></div>
      <div class="slate-acts"><button class="btn sm" data-act="c-game" data-kind="${kind}" data-g="${g.id}">Edit</button>
        <button class="btn sm ${g.active ? '' : 'primary'}" data-act="c-active" data-g="${g.id}" data-v="${g.active ? 0 : 1}">${g.active ? 'Deactivate' : 'Activate'}</button></div>
    </div>`; }).join('') || '<p class="help" style="margin-top:10px">No games yet. Tap + Add game.</p>'}`;
}

function cResults(kind) {
  const d = U.draft(S, kind); const ps = U.picksFor(S, kind);
  if (!ps.length) return '<p class="help">Results appear here once picks are drafted.</p>';
  const order = d.order || [1, 2, 3];
  return `<p class="help">Tap WIN, LOSS or PUSH. Each tap saves instantly and standings update for everyone. Tap a lit button again to set it back to pending. Points are counted from WIN results, so edits can never double count.</p>
  ${order.map((tid) => { const t = U.team(S, tid); const mine = ps.filter((p) => p.team_id === tid); const pts = mine.filter((p) => p.result === 'win').length;
    return `<div class="res-team" ${tstyle(t)}><div class="res-head">${teamMark(t, 'sm')}<span class="team-name">${esc(t.name)}</span><span class="res-pts">${pts} / ${d.rounds} PTS</span></div>
    ${mine.map((p) => `<div class="res-row"><div class="res-pick"><b>${esc(p.selected_team)} ${U.fmtSpread(p.spread)}</b><span class="muted">vs ${esc(p.opponent)} • pick ${p.pick_no}</span></div>
      <div class="res-btns" role="group" aria-label="Result for ${esc(p.selected_team)}">${['win', 'loss', 'push'].map((r) => `<button class="rb rb-${r}" data-act="c-res" data-p="${p.id}" data-v="${r}" aria-pressed="${p.result === r}">${r.toUpperCase()}</button>`).join('')}</div></div>`).join('')}</div>`; }).join('')}`;
}

function cTiebreaker() {
  const tb = S.tiebreaker;
  const top = Math.max(...S.standings.map((s) => s.total)); const tied = S.standings.filter((s) => s.total === top).map((s) => s.team_id);
  const nfl = U.picksFor(S, 'nfl'); const nflDone = nfl.length && nfl.every((p) => p.result);
  let body = `<p class="help">${preEvent() ? 'Competition has not started.' : tied.length === 2 ? `${tname(tied[0])} and ${tname(tied[1])} are tied at ${top}.` : tied.length === 3 ? 'All three teams are tied. Three-way ties are not handled by sudden death; name the champion under Weekend.' : 'No tie at the top right now.'} ${nflDone ? 'All NFL results are in.' : 'Some NFL results are still pending.'}</p>`;
  if (tb.status === 'none' || tb.status === 'setup') {
    const v = (k, d) => (ui.f[k] ?? d ?? '');
    body += `<div class="sub-h">${tb.status === 'setup' ? 'SNF game (editable until the coin flip)' : 'Enter the SNF game'}</div>
    <div class="grid-2"><div class="field"><label>Tied team</label><select data-k="tb.a">${teamOpts(tb.team_a ?? tied[0])}</select></div><div class="field"><label>Tied team</label><select data-k="tb.b">${teamOpts(tb.team_b ?? tied[1])}</select></div></div>
    <div class="grid-2"><div class="field"><label>SNF away team</label><input data-k="tb.away" value="${esc(v('tb.away', tb.away_team))}" placeholder="Giants"></div>
      <div class="field"><label>Away spread</label><input inputmode="decimal" data-k="tb.aspread" data-pair="tb.hspread" value="${esc(v('tb.aspread', tb.home_spread == null ? '' : U.fmtSpread(-tb.home_spread)))}" placeholder="+3.5"></div></div>
    <div class="grid-2"><div class="field"><label>SNF home team</label><input data-k="tb.home" value="${esc(v('tb.home', tb.home_team))}" placeholder="Commanders"></div>
      <div class="field"><label>Home spread</label><input inputmode="decimal" data-k="tb.hspread" data-pair="tb.aspread" value="${esc(v('tb.hspread', tb.home_spread == null ? '' : U.fmtSpread(tb.home_spread)))}" placeholder="-3.5"></div></div>
    <button class="btn ${tb.status === 'setup' ? '' : 'primary'} block" data-act="c-tbstart">${tb.status === 'setup' ? 'Save SNF game' : 'Start sudden death'}</button>`;
  }
  if (tb.status === 'setup') {
    body += `<div class="sub-h">Coin flip</div><p class="help">Flip the coin in person. The winner picks a side; the other tied team gets the opposite side. The spread freezes when you confirm.</p>
      <div class="field"><label>Coin flip winner</label><select data-k="tb.first">${[tb.team_a, tb.team_b].map((id) => `<option value="${id}">${tname(id)}</option>`).join('')}</select></div>
      <div class="field"><label>Side they choose</label><select data-k="tb.side"><option value="away">${esc(tb.away_team)} ${U.fmtSpread(-tb.home_spread)}</option><option value="home">${esc(tb.home_team)} ${U.fmtSpread(tb.home_spread)}</option></select></div>
      <button class="btn primary block" data-act="c-tbpick">Freeze and assign sides</button>`;
  }
  if (tb.status === 'picked' || tb.status === 'final') {
    const sides = tbSides(tb);
    body += `<div class="sub-h">Frozen sides</div>${sides.map((x) => `<div class="kv"><span>${tname(x.team)}</span><span>${esc(x.name)} ${U.fmtSpread(x.spread)}</span></div>`).join('')}
      <div class="sub-h">Which side covered?</div>
      <div class="res-btns tb-res">${sides.map((x) => `<button class="rb rb-win" data-act="c-tbres" data-v="${x.side}" aria-pressed="${tb.result === x.side}" ${tb.status === 'final' ? 'disabled' : ''}>${esc(x.name)} ${U.fmtSpread(x.spread)}</button>`).join('')}
        <button class="rb rb-push" data-act="c-tbres" data-v="push" aria-pressed="${tb.result === 'push'}" ${tb.status === 'final' ? 'disabled' : ''}>PUSH</button></div>
      <div class="kv" style="margin-top:10px"><span>Champion by tiebreaker</span><span>${tb.winner_team ? tname(tb.winner_team) : tb.result === 'push' ? 'None (push). Name the champion under Weekend.' : 'Pending'}</span></div>
      ${tb.winner_team && !final() ? '<p class="help">Next: Weekend > Finalize weekend.</p>' : ''}`;
  }
  if (tb.status !== 'none' && tb.status !== 'final') body += '<button class="btn danger block" style="margin-top:12px" data-act="c-tbcancel">Cancel tiebreaker</button>';
  return body;
}

function cTesting() {
  return `<p class="help">${testMode() ? 'Test mode is on. Demo slates, auto-fill and commissioner proxy picks are enabled.' : 'Production mode. Test helpers are disabled.'}</p>
  ${testMode() ? `<div class="sub-h">Demo data (clearly marked DEMO; not real lines)</div>
  <div class="btn-row"><button class="btn sm" data-act="c-seed" data-kind="cfb">Seed CFB slate</button><button class="btn sm" data-act="c-seed" data-kind="nfl">Seed NFL slate</button></div>
  <div class="grid-2" style="margin-top:10px"><div class="field"><label>Fill golf for</label><select data-k="dg.team">${teamOpts(1, false)}</select></div><div class="field"><label>Through hole</label><select data-k="dg.thru">${Array.from({ length: 18 }, (_, i) => `<option ${i === 8 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div></div>
  <button class="btn sm block" data-act="c-demogolf">Fill golf scores</button>
  <div class="btn-row" style="margin-top:10px"><button class="btn sm" data-act="c-demores" data-kind="cfb">Random CFB results</button><button class="btn sm" data-act="c-demores" data-kind="nfl">Random NFL results</button></div>` : ''}
  <div class="sub-h">Reset a section</div>
  <div class="btn-row">${[['blackjack', 'Casino Night'], ['golf', 'Golf'], ['cfb_picks', 'CFB picks'], ['nfl_picks', 'NFL picks'], ['cfb', 'CFB all'], ['nfl', 'NFL all'], ['tiebreaker', 'Tiebreaker'], ['ticker', 'Ticker'], ['final', 'Un-finalize']].map(([k, l]) => `<button class="btn sm danger" data-act="c-reset" data-v="${k}">${l}</button>`).join('')}</div>
  <button class="btn danger block" style="margin-top:10px" data-act="c-reset" data-v="all">Reset everything</button>
  <div class="sub-h">Go live</div>
  <p class="help">Wipes every result, pick, score, game and ticker item, turns off test helpers, and signs out everyone except you. Teams, members, PINs and pars are kept.</p>
  ${testMode() ? '<button class="btn primary block" data-act="c-golive">Start clean for the real weekend</button>' : '<button class="btn block" data-act="c-testmode">Switch back to test mode</button>'}`;
}

// ---------------------------------------------------------------- modals
function modal() {
  const m = ui.modal; if (!m) return '';
  let body = '';
  if (m.type === 'confirm') {
    body = `<h3>${esc(m.title)}</h3>${m.kicker ? `<div class="sheet-kicker">${esc(m.kicker)}</div>` : ''}${m.big ? `<div class="big-pick">${esc(m.big)}</div>` : ''}${m.meta ? `<div class="sheet-meta">${esc(m.meta)}</div>` : ''}<p>${esc(m.body)}</p>
      <div class="btn-row"><button class="btn" data-act="m-close">Cancel</button><button class="btn ${m.danger ? 'danger' : 'primary'}" data-act="m-ok">${esc(m.ok)}</button></div>`;
  } else if (m.type === 'game') {
    const g = m.id ? U.game(S, m.id) : null; const picked = g && S.picks.some((p) => p.game_id === g.id);
    const v = (k, d) => esc(ui.f[k] ?? d ?? '');
    body = `<h3>${g ? 'Edit game' : `Add ${m.kind.toUpperCase()} game`}</h3>
      <div class="grid-2 gf-grid"><div class="field"><label>Away team</label><input data-k="gf.away" value="${v('gf.away', g?.away_team)}" placeholder="Alabama" autocomplete="off"></div>
      <div class="field"><label>Away spread</label><input inputmode="decimal" data-k="gf.aspread" data-pair="gf.hspread" value="${v('gf.aspread', g ? U.fmtSpread(g.away_spread) : '')}" placeholder="-7.5"></div></div>
      <div class="grid-2 gf-grid"><div class="field"><label>Home team</label><input data-k="gf.home" value="${v('gf.home', g?.home_team)}" placeholder="Auburn" autocomplete="off"></div>
      <div class="field"><label>Home spread</label><input inputmode="decimal" data-k="gf.hspread" data-pair="gf.aspread" value="${v('gf.hspread', g ? U.fmtSpread(g.home_spread) : '')}" placeholder="+7.5"></div></div>
      <p class="help">Typing one spread fills in the other. Use PK or 0 for a pick 'em.</p>
      <div class="field"><label>Kickoff time, Eastern (optional)</label><input type="datetime-local" data-k="gf.kick" value="${v('gf.kick', U.isoToEtLocal(g?.kickoff))}"></div>
      <div class="field"><label>Game date (optional)</label><input type="date" data-k="gf.date" value="${v('gf.date', g?.game_date)}"></div>
      <label class="check"><input type="checkbox" data-k="gf.active" ${(ui.f['gf.active'] ?? (g ? g.active : true)) ? 'checked' : ''}> Active on the ${m.kind.toUpperCase()} draft slate</label>
      ${picked ? '<p class="help">A side of this game is drafted. Name and kickoff fixes carry over to that pick, but its spread stays frozen at the drafted number.</p>' : ''}
      <div class="btn-row" style="margin-top:14px"><button class="btn" data-act="m-close">Cancel</button><button class="btn primary" data-act="m-savegame">${g ? 'Save changes' : 'Save to slate'}</button></div>
      ${g && !picked ? '<button class="btn danger block" style="margin-top:10px" data-act="m-delgame">Delete game</button>' : ''}`;
  } else if (m.type === 'replace') {
    const p = S.picks.find((x) => x.id === m.id);
    const opts = S.games.filter((g) => g.kind === p.kind).flatMap((g) => ['away', 'home'].map((s) => ({ g, s, owner: U.sideOwner(S, g.id, s), other: U.sideOwner(S, g.id, s === 'home' ? 'away' : 'home') })))
      .filter((o) => (!o.owner || o.owner.id === p.id) && !(o.other && o.other.team_id === p.team_id && o.other.id !== p.id));
    body = `<h3>Replace pick #${p.pick_no} • ${tname(p.team_id)}</h3>
      <div class="field"><label>New side</label><select data-k="rp.side">${opts.map((o) => `<option value="${o.g.id}:${o.s}">${esc(o.s === 'home' ? o.g.home_team : o.g.away_team)} ${U.fmtSpread(o.owner && o.owner.id === p.id ? p.spread : o.s === 'home' ? o.g.home_spread : o.g.away_spread)} (vs ${esc(o.s === 'home' ? o.g.away_team : o.g.home_team)})</option>`).join('')}</select></div>
      <div class="field"><label>Frozen spread override (optional)</label><input inputmode="decimal" data-k="rp.spread" placeholder="Blank = current slate line"></div>
      <div class="btn-row"><button class="btn" data-act="m-close">Cancel</button><button class="btn primary" data-act="m-replace">Replace pick</button></div>`;
  }
  return `<div class="scrim" data-act="m-scrim"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}

// ---------------------------------------------------------------- actions
const num = (v) => (v === '' || v == null ? null : Number(v));
// "-7.5", "+3", "7", "PK", "pick" -> number; "" -> null; junk -> NaN
function parseSpread(v) {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase();
  if (!t || t === '--') return null;
  if (t === 'pk' || t === 'pick' || t === "pick'em" || t === 'even') return 0;
  const n = Number(t.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : NaN;
}
// Fast result entry: optimistic, never blocked by other in-flight actions,
// sent strictly in tap order. The server remains the source of truth.
let resultQueue = Promise.resolve();
function setResult(pickId, result) {
  const p = S.picks.find((x) => x.id === pickId); if (!p) return;
  p.result = result; render();
  resultQueue = resultQueue.then(() => api.rpc('pick_set_result', { p_pick_id: pickId, p_result: result }))
    .then(() => { toast(result ? `${p.selected_team} ${U.fmtSpread(p.spread)}: ${result.toUpperCase()}` : 'Set to pending'); return refresh(true); })
    .catch((e) => { if (e.code === 'NOT_SIGNED_IN') return signOut(true); toast(e.message, 'err'); return refresh(true); });
}
const A = {
  retry: () => start(),
  tab: (el) => { ui.tab = el.dataset.tab; ui.more = null; render(); window.scrollTo(0, 0); },
  goto: (el) => {
    ui.tab = el.dataset.tab;
    if (el.dataset.kind === 'blackjack') ui.more = 'blackjack';
    else if (el.dataset.kind) ui.fbKind = el.dataset.kind;
    if (el.dataset.golfview) ui.golfView = el.dataset.golfview;
    render(); window.scrollTo(0, 0);
  },
  expand: (el) => { ui.expanded[el.dataset.id] = !ui.expanded[el.dataset.id]; render(); },
  golfview: (el) => { ui.golfView = el.dataset.v; ui.entryHole = null; ui.entryVal = null; render(); },
  golfteam: (el) => { ui.golfTeam = +el.dataset.team; ui.entryHole = null; ui.entryVal = null; render(); },
  golfcard: (el) => { ui.golfTeam = +el.dataset.team; ui.golfView = 'card'; render(); window.scrollTo(0, 0); },
  hole: (el) => { ui.entryHole = +el.dataset.h; ui.entryVal = null; render(); },
  step: (el) => {
    const teamId = scoringTeam() && !isCommish() ? scoringTeam() : ui.golfTeam;
    const saved = S.golf.scores.find((x) => x.team_id === teamId && x.hole === ui.entryHole)?.strokes;
    const par = S.golf.holes.find((h) => h.hole === ui.entryHole).par;
    ui.entryVal = Math.min(15, Math.max(1, (ui.entryVal ?? saved ?? par) + +el.dataset.d)); render();
  },
  savehole: async (el) => {
    const teamId = +el.dataset.team; const hole = ui.entryHole;
    const saved = S.golf.scores.find((x) => x.team_id === teamId && x.hole === hole)?.strokes;
    const v = ui.entryVal ?? saved ?? S.golf.holes.find((h) => h.hole === hole).par;
    if (await run('golf_set_score', { p_team: teamId, p_hole: hole, p_strokes: v }, `Hole ${hole}: ${v}`)) {
      const sc = new Set(S.golf.scores.filter((x) => x.team_id === teamId).map((x) => x.hole));
      const next = S.golf.holes.find((h) => h.hole > hole && !sc.has(h.hole)) || S.golf.holes.find((h) => !sc.has(h.hole));
      ui.entryHole = next ? next.hole : hole; ui.entryVal = null; render();
      cheer(v - S.golf.holes.find((h) => h.hole === hole).par);
    }
  },
  clearhole: (el) => confirmThen({ title: 'Clear score', body: `Remove the score on hole ${ui.entryHole}?`, ok: 'Clear', danger: true },
    () => run('golf_set_score', { p_team: +el.dataset.team, p_hole: ui.entryHole, p_strokes: null }, 'Cleared').then(() => { ui.entryVal = null; })),
  fbkind: (el) => { ui.fbKind = el.dataset.kind; render(); },
  fbview: (el) => { ui.fbView[ui.fbKind] = el.dataset.v; render(); },
  pickgroup: (el) => { ui.pickGroup = el.dataset.v; render(); },
  pick: (el) => {
    const g = U.game(S, +el.dataset.g); const s = el.dataset.s; const kind = el.dataset.kind;
    const sp = s === 'home' ? g.home_spread : g.away_spread; const tm = s === 'home' ? g.home_team : g.away_team;
    const cp = canPickNow(kind);
    const oc = U.onClock(S, kind);
    confirmThen({ title: 'Confirm pick', kicker: U.team(S, cp.team)?.name || '', big: `${tm} ${U.fmtSpread(sp)}`, meta: `${kind === 'cfb' ? 'CFB' : 'NFL'} • ROUND ${oc.round} • PICK ${oc.overall}`, body: `vs ${s === 'home' ? g.away_team : g.home_team}. This spread locks the moment you draft it.`, ok: 'Draft' },
      () => run('draft_pick', { p_kind: kind, p_game_id: g.id, p_side: s, p_for_team: cp.proxy ? cp.team : null }, `Drafted ${tm} ${U.fmtSpread(sp)}`));
  },
  more: (el) => { ui.more = el.dataset.v || null; render(); window.scrollTo(0, 0); },
  replay: () => showReveal(),
  logout: () => confirmThen({ title: 'Sign out', body: 'You will need your PIN to sign back in.', ok: 'Sign out' }, () => signOut()),
  acc: (el) => { ui.acc[el.dataset.v] = !ui.acc[el.dataset.v]; render(); },

  // commissioner
  'c-status': (el) => run('comp_set', { p_status: el.dataset.v }, `Status: ${el.dataset.v}`),
  'c-finalize': () => {
    const o = num(val('fin.team'));
    confirmThen({ title: 'Finalize weekend', body: o ? `Name ${tname(o)} champion by commissioner decision and lock the weekend?` : 'Crown the champion from points (or the SNF tiebreaker) and lock the weekend?', ok: 'Finalize' },
      () => run('weekend_finalize', { p_override_team: o }, 'Weekend finalized').then(() => delete ui.f['fin.team']));
  },
  'c-reopen': () => confirmThen({ title: 'Reopen weekend', body: 'Remove the champion and unlock scoring?', ok: 'Reopen', danger: true }, () => run('weekend_reopen', {}, 'Reopened')),
  'c-team': (el) => { const id = el.dataset.team; run('team_update', { p_team: +id, p_name: val(`tm.${id}.name`), p_short: val(`tm.${id}.short`), p_color: val(`tm.${id}.color`), p_logo: val(`tm.${id}.logo`) }, 'Team saved').then(() => clearForm(`tm.${id}.`)); },
  'c-bj': () => {
    const args = { p_first: num(val('bj.first')), p_second: num(val('bj.second')), p_third: num(val('bj.third')), p_mug: num(val('bj.mug')), p_finalize: true };
    confirmThen({ title: 'Finalize Casino Night', body: `1st ${tname(args.p_first)}, 2nd ${tname(args.p_second)}, 3rd ${tname(args.p_third)}. Awards 3 / 2 / 1.`, ok: 'Finalize' },
      () => run('bj_save', args, 'Casino Night final').then(() => clearForm('bj.')));
  },
  'c-bjclear': () => confirmThen({ title: 'Clear Casino Night', body: 'Remove Casino Night placements and points?', ok: 'Clear', danger: true }, () => run('bj_clear', {}, 'Cleared')),
  'c-golftie': () => { const o = [1, 2, 3].map((i) => num(val(`gt.${i}`))); confirmThen({ title: 'Set golf order', body: `1st ${tname(o[0])}, 2nd ${tname(o[1])}, 3rd ${tname(o[2])}.`, ok: 'Set order' }, () => run('golf_resolve_tie', { p_order: o }, 'Golf order set').then(() => clearForm('gt.'))); },
  'c-golftieclear': () => run('golf_resolve_tie', { p_order: null }, 'Override cleared'),
  'c-draftcfg': (el) => {
    const k = el.dataset.kind; const d = U.draft(S, k);
    const order = [1, 2, 3].map((i) => num(val(`do.${k}.${i}`)));
    const drafters = Object.fromEntries(S.teams.map((t) => [t.id, num(val(`dd.${k}.${t.id}`))]));
    const hasPicks = S.picks.some((p) => p.kind === k);
    if (!hasPicks && order.some((x) => !x)) return toast('Choose a team for each draft slot', 'err');
    if (!hasPicks && new Set(order).size !== 3) return toast('Each team can only hold one draft slot', 'err');
    void d;
    run('draft_configure', { p_kind: k, p_order: hasPicks ? null : order, p_drafters: drafters }, 'Draft setup saved')
      .then(() => { clearForm(`do.${k}.`); clearForm(`dd.${k}.`); });
  },
  'c-dc': (el) => {
    const { kind, v } = el.dataset;
    const go = () => run('draft_control', { p_kind: kind, p_action: v }, `${kind.toUpperCase()} draft: ${v.replace('_', ' ')}`);
    if (v === 'open' || v === 'close') confirmThen({ title: `${v === 'open' ? 'Open' : 'Close'} ${kind.toUpperCase()} draft`, body: v === 'open' ? 'The clock starts immediately for the first team.' : 'Stops the draft. Picks already made are kept.', ok: v === 'open' ? 'Open draft' : 'Close draft' }, go);
    else go();
  },
  'c-undo': (el) => { const k = el.dataset.kind; const p = U.picksFor(S, k).slice(-1)[0];
    confirmThen({ title: 'Undo last pick', big: `#${p.pick_no} ${p.selected_team} ${U.fmtSpread(p.spread)}`, body: `Removes ${tname(p.team_id)}'s pick, frees that side, and puts them back on the clock.`, ok: 'Undo pick', danger: true },
      () => run('draft_undo_last', { p_kind: k }, 'Pick undone')); },
  'c-active': (el) => {
    const on = el.dataset.v === '1'; const g = U.game(S, +el.dataset.g);
    const go = () => run('game_upsert', { p: { id: g.id, active: on } }, on ? 'Game active' : 'Game inactive');
    if (on) return go();
    const picked = S.picks.some((p) => p.game_id === g.id);
    confirmThen({ title: 'Deactivate game', body: `Hide ${g.away_team} at ${g.home_team} from the draft room?${picked ? ' Any side already drafted stays with its team; the other side just cannot be drafted.' : ''}`, ok: 'Deactivate' }, go);
  },
  'c-move': (el) => run('game_move', { p_game_id: +el.dataset.g, p_dir: +el.dataset.v }),
  'c-res': (el) => {
    const p = S.picks.find((x) => x.id === +el.dataset.p); const v = el.dataset.v;
    if (p.result === v) return confirmThen({ title: 'Set back to pending', body: `${p.selected_team} ${U.fmtSpread(p.spread)} is marked ${v.toUpperCase()}. Clear it to pending?`, ok: 'Clear result' }, () => setResult(p.id, null));
    setResult(p.id, v);
  },
  'c-game': (el) => { clearForm('gf.'); ui.modal = { type: 'game', kind: el.dataset.kind, id: el.dataset.g ? +el.dataset.g : null }; render(); },
  'c-replace': (el) => { clearForm('rp.'); ui.modal = { type: 'replace', id: +el.dataset.p }; render(); },
  'c-tbstart': () => {
    const tb = S.tiebreaker;
    const a = num(val('tb.a') ?? tb.team_a), b = num(val('tb.b') ?? tb.team_b);
    const away = (val('tb.away') ?? tb.away_team ?? '').trim(), home = (val('tb.home') ?? tb.home_team ?? '').trim();
    const hs = parseSpread(val('tb.hspread') ?? (tb.home_spread == null ? '' : String(tb.home_spread)));
    const as = parseSpread(val('tb.aspread') ?? (tb.home_spread == null ? '' : String(-tb.home_spread)));
    const home_spread = hs ?? (as == null ? null : -as);
    if (!a || !b || a === b) return toast('Choose the two tied teams', 'err');
    if (!away || !home) return toast('Enter both SNF teams', 'err');
    if (home_spread == null || Number.isNaN(home_spread)) return toast('Enter the spread, like -3.5', 'err');
    if (hs != null && as != null && hs !== -as) return toast('Away and home spreads must be opposites', 'err');
    const save = () => run('tb_start', { p_team_a: a, p_team_b: b, p_away: away, p_home: home, p_home_spread: home_spread }, tb.status === 'setup' ? 'SNF game saved' : 'Tiebreaker started').then(() => clearForm('tb.'));
    if (tb.status === 'setup') return save();
    confirmThen({ title: 'Start sudden death', body: `${tname(a)} vs ${tname(b)} on ${away} at ${home} (${home} ${U.fmtSpread(home_spread)}).`, ok: 'Start' }, save);
  },
  'c-tbpick': () => { const tb = S.tiebreaker; const f = num(val('tb.first')) || tb.team_a, s = val('tb.side') || 'away';
    const sp = s === 'home' ? Number(tb.home_spread) : -Number(tb.home_spread);
    confirmThen({ title: 'Freeze tiebreaker', big: `${s === 'home' ? tb.home_team : tb.away_team} ${U.fmtSpread(sp)}`, body: `${tname(f)} takes this side. ${tname(f === tb.team_a ? tb.team_b : tb.team_a)} gets ${s === 'home' ? tb.away_team : tb.home_team} ${U.fmtSpread(-sp)}. The spread freezes now.`, ok: 'Freeze' },
      () => run('tb_pick', { p_first_team: f, p_side: s }, 'Sides assigned')); },
  'c-tbres': (el) => {
    const tb = S.tiebreaker; const v = el.dataset.v;
    if (tb.result === v) return run('tb_set_result', { p_result: null }, 'Result cleared');
    const sides = tbSides(tb); const x = sides.find((y) => y.side === v);
    confirmThen({ title: 'SNF result', body: v === 'push' ? 'Mark the SNF game a push? There is no tiebreaker winner; you will name the champion.' : `${x.name} ${U.fmtSpread(x.spread)} covered, so ${tname(x.team)} wins sudden death?`, ok: 'Confirm' },
      () => run('tb_set_result', { p_result: v }, 'SNF result saved'));
  },
  'c-tbcancel': () => confirmThen({ title: 'Cancel tiebreaker', body: 'Clears the tiebreaker entirely.', ok: 'Cancel it', danger: true }, () => run('tb_cancel', {}, 'Tiebreaker cleared')),
  'c-seed': (el) => run('admin_seed_demo', { p_kind: el.dataset.kind }, 'Demo slate added'),
  'c-demogolf': () => run('admin_demo_golf', { p_team: num(val('dg.team')) || 1, p_through: num(val('dg.thru')) || 9 }, 'Golf filled'),
  'c-demores': (el) => confirmThen({ title: 'Random results', body: `Mark every pending ${el.dataset.kind.toUpperCase()} pick with a random WIN, LOSS or PUSH? (Test mode only.)`, ok: 'Generate' }, () => run('admin_demo_results', { p_kind: el.dataset.kind }, 'Results generated')),
  'c-reset': (el) => confirmThen({ title: 'Reset', body: el.dataset.v === 'all' ? 'Erase ALL results, picks, games, golf scores and ticker items?' : `Reset ${el.textContent.trim()}? This cannot be undone.`, ok: 'Reset', danger: true },
    () => run('admin_reset', { p_scope: el.dataset.v }, 'Reset done')),
  'c-golive': () => confirmThen({ title: 'Start the real weekend', body: 'Erase all test data, disable test helpers and sign out all 11 other users. Continue?', ok: 'Go live', danger: true }, () => run('admin_go_live', {}, 'Production mode. Clean slate.')),
  'c-testmode': () => run('admin_set_mode', { p_mode: 'test' }, 'Test mode on'),

  // modal actions
  'm-close': () => { ui.modal = null; pendingConfirm = null; render(); },
  'm-scrim': (el, ev) => { if (ev.target === el) A['m-close'](); },
  'm-ok': async () => { const fn = pendingConfirm; ui.modal = null; pendingConfirm = null; render(); if (fn) await fn(); },
  'm-savegame': async () => {
    const m = ui.modal; const g = m.id ? U.game(S, m.id) : null;
    const away = (val('gf.away') ?? g?.away_team ?? '').trim(), home = (val('gf.home') ?? g?.home_team ?? '').trim();
    const as = parseSpread(val('gf.aspread') ?? (g ? String(g.away_spread) : '')), hs = parseSpread(val('gf.hspread') ?? (g ? String(g.home_spread) : ''));
    if (!away || !home) return toast('Enter both teams', 'err');
    if (away.toLowerCase() === home.toLowerCase()) return toast('Away and home must be different teams', 'err');
    if (Number.isNaN(as) || Number.isNaN(hs)) return toast('Spreads must look like -7.5, +3 or PK', 'err');
    if (as == null && hs == null) return toast('Enter the spread', 'err');
    if (as != null && hs != null && as !== -hs) return toast('Away and home spreads must be opposites', 'err');
    const p = { kind: m.kind, away_team: away, home_team: home, away_spread: as, home_spread: hs ?? -as,
      kickoff: val('gf.kick') !== undefined ? U.etLocalToISO(val('gf.kick')) : g?.kickoff ?? null,
      game_date: val('gf.date') !== undefined ? (val('gf.date') || null) : g?.game_date ?? null,
      active: val('gf.active') !== undefined ? !!val('gf.active') : (g ? g.active : true) };
    if (m.id) p.id = m.id;
    const moved = g && S.picks.some((x) => x.game_id === g.id) && Number(p.home_spread) !== Number(g.home_spread);
    const save = async () => { if (await run('game_upsert', { p }, m.id ? 'Game updated' : `Added ${away} at ${home}`)) { ui.modal = null; clearForm('gf.'); render(); } };
    if (moved) return confirmThen({ title: 'Change a drafted line', body: `You are moving the slate line for a game that already has a drafted side. The drafted pick keeps its original spread. Only the undrafted side uses the new line.`, ok: 'Save line' }, save);
    save();
  },
  'm-delgame': () => { const g = U.game(S, ui.modal.id); confirmThen({ title: 'Delete game', body: `Remove ${g.away_team} at ${g.home_team} from the slate?`, ok: 'Delete', danger: true }, () => run('game_delete', { p_game_id: g.id }, 'Game deleted')); },
  'm-replace': async () => {
    const id = ui.modal.id; const [g, s] = (val('rp.side') || '').split(':');
    if (await run('draft_replace_pick', { p_pick_id: id, p_game_id: +g, p_side: s, p_spread: num(val('rp.spread')) }, 'Pick replaced')) { ui.modal = null; clearForm('rp.'); render(); }
  },
};

document.addEventListener('click', (ev) => {
  const pinBtn = ev.target.closest('[data-pin]');
  if (pinBtn) return pinKey(pinBtn.dataset.pin);
  const el = ev.target.closest('[data-act]');
  if (!el || !A[el.dataset.act]) return;
  if (el.dataset.act === 'm-scrim') return A['m-scrim'](el, ev);
  A[el.dataset.act](el, ev);
});
document.addEventListener('input', (ev) => {
  const t = ev.target; const k = t.dataset && t.dataset.k; if (!k) return;
  ui.f[k] = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.pair) {            // typing one spread fills the opposite side
    const n = parseSpread(t.value); const other = document.querySelector(`[data-k="${t.dataset.pair}"]`);
    if (other && n != null && !Number.isNaN(n)) { const o = U.fmtSpread(-n); other.value = o; ui.f[t.dataset.pair] = o; }
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target; const k = t.dataset && t.dataset.k;
  if (k) ui.f[k] = t.type === 'checkbox' ? t.checked : t.value;
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ui.modal) A['m-close'](); });

// ---------------------------------------------------------------- broadcast moments
// "The pick is in": every connected phone, about two seconds, never blocks taps.
function announcePick(p) {
  if (!p) return;
  const t = U.team(S, p.team_id);
  document.querySelector('.announce')?.remove();
  const el = document.createElement('div');
  el.className = 'announce'; el.setAttribute('role', 'status');
  el.innerHTML = `<div class="announce-card" ${tstyle(t)}><div class="an-top">THE PICK IS IN</div>
    <div class="an-team">${t ? `<b>${esc(t.name)}</b>SELECTS` : ''}</div>
    <div class="an-pick">${esc(p.selected_team)} ${U.fmtSpread(p.spread)}</div>
    <div class="an-foot">${p.kind === 'cfb' ? 'CFB' : 'NFL'} DRAFT • ROUND ${p.round} • PICK ${p.pick_no}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}
// Championship reveal: plays once per phone when the weekend is finalized; replayable.
const REVEAL_KEY = 'qk26.revealed';
function maybeReveal(wasFinal) {
  const f = S.competition.status === 'final' && S.competition.finalized_at;
  if (!f) return;
  let seen = null; try { seen = localStorage.getItem(REVEAL_KEY); } catch (e) { /* private mode */ }
  if (seen === f) return;
  try { localStorage.setItem(REVEAL_KEY, f); } catch (e) { /* ignore */ }
  void wasFinal;
  showReveal();
}
function showReveal() {
  const c = S.competition; const t = U.team(S, c.champion_team_id); if (!t) return;
  const s = S.standings.find((x) => x.team_id === t.id);
  document.querySelector('.reveal-ov')?.remove();
  const el = document.createElement('div');
  el.className = 'reveal-ov'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Weekend champions');
  const conf = Array.from({ length: 36 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-duration:${3.2 + ((i * 13) % 20) / 10}s;animation-delay:${1.4 + ((i * 7) % 30) / 10}s"></i>`).join('');
  el.innerHTML = `<div class="confetti">${conf}</div>${ART.mountains('night')}
    <div class="rv-year">${esc(B('year', '2026'))}</div>
    <div class="rv-event">${B('eventLogo', null) ? `<img src="${esc(B('eventLogo'))}" alt="">` : `<b>${esc(B('eventName', "QUYLE'S"))}</b><span>${esc(B('eventTagline', 'BACHELOR PARTY'))}</span>`}</div>
    <div class="rv-trophy">${ART.trophy()}</div>
    <div class="rv-label">WEEKEND CHAMPIONS</div>
    <div class="rv-team" ${tstyle(t)}>${esc(t.name)}</div>
    <div class="rv-pts">${s ? s.total : ''} PTS</div>
    <div class="rv-loc">${esc(titleCase(B('location', 'ASHEVILLE, NORTH CAROLINA')))}</div>
    <div class="rv-skip">TAP TO CONTINUE</div>`;
  const close = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), 600); };
  el.addEventListener('click', close);
  document.body.appendChild(el);
  setTimeout(close, 7500);
}
// Golf: brief, never blocking, only for good holes.
function cheer(rel) {
  const msg = rel <= -2 ? 'WHAT A SHOT!' : rel === -1 ? 'NICE BIRDIE!' : rel === 0 ? 'SOLID PAR' : null;
  if (!msg) return;
  document.querySelector('.cheer')?.remove();
  const el = document.createElement('div');
  el.className = `cheer ${rel === 0 ? 'par' : ''}`; el.textContent = msg; el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ---------------------------------------------------------------- boot
if (!api.configured) {
  $app.innerHTML = `<div class="login"><div class="login-sky"></div>${ART.mountains('dusk')}<div class="login-fade"></div><div class="login-mark"><div class="event-id"><div class="eid-name" style="font-size:44px">SETUP NEEDED</div></div></div>
    <p class="muted" style="text-align:center;max-width:330px">Add your Supabase URL and anon key to <b>config.js</b>. See SETUP.md.</p></div>`;
} else if (api.token) {
  start();
} else {
  renderLogin();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
