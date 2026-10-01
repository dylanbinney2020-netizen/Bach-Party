// Pure helpers: formatting and derived read-only selectors. No scoring
// math lives here; points, grades and golf ranks come from the server.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TZ = 'America/New_York'; // Asheville

export function fmtSpread(n) {
  if (n === null || n === undefined || n === '') return '--';
  const v = Number(n);
  if (v === 0) return 'PK';
  return (v > 0 ? '+' : '') + (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));
}
export const fmtPar = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

export function fmtKick(iso, withDay = true) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  if (!withDay) return t;
  const day = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  return `${day} ${t}`;
}
export const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// datetime-local value interpreted as Eastern time -> ISO string
export function etLocalToISO(local) {
  if (!local) return null;
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const offsetAt = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms)).reduce((a, x) => ((a[x.type] = x.value), a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  const ms = guess - offsetAt(guess);
  return new Date(ms - (offsetAt(ms) - offsetAt(guess))).toISOString();
}
export function isoToEtLocal(iso) {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const ordinal = (n) => ['', '1st', '2nd', '3rd'][n] || `${n}th`;

// ----- selectors over server state -----
export const team = (S, id) => S.teams.find((t) => t.id === id);
export const member = (S, id) => S.members.find((m) => m.id === id);
export const draft = (S, kind) => S.drafts.find((d) => d.kind === kind);
export const game = (S, id) => S.games.find((g) => g.id === id);
export const picksFor = (S, kind, teamId) => S.picks.filter((p) => p.kind === kind && (teamId == null || p.team_id === teamId));

export function onClock(S, kind) {
  const d = draft(S, kind);
  if (!d || !d.order || d.pick_count >= d.total_picks) return null;
  return {
    team: d.order[d.pick_count % 3],
    round: Math.floor(d.pick_count / 3) + 1,
    pickInRound: (d.pick_count % 3) + 1,
    overall: d.pick_count + 1,
  };
}
export function upcoming(S, kind, n = 6) {
  const d = draft(S, kind);
  if (!d || !d.order) return [];
  const out = [];
  for (let i = d.pick_count; i < Math.min(d.total_picks, d.pick_count + n); i++) out.push({ overall: i + 1, round: Math.floor(i / 3) + 1, team: d.order[i % 3] });
  return out;
}
export function sideOwner(S, gameId, side) {
  return S.picks.find((p) => p.game_id === gameId && p.side === side) || null;
}
export function atsRecord(S, kind, teamId) {
  const ps = picksFor(S, kind, teamId);
  const c = (r) => ps.filter((p) => p.result === r).length;
  return { w: c('win'), l: c('loss'), p: c('push'), pending: ps.filter((p) => !p.result).length, n: ps.length };
}
export function tickerText(S, text) {
  return text.replace(/\{T([123])\}/g, (_, id) => (team(S, +id)?.name || `Team ${id}`).toUpperCase());
}
