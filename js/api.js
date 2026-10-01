// Data access layer. The browser never touches tables: every read is
// get_state(token) and every write is a named server function that
// re-checks permissions. Realtime is a single heartbeat row
// (app_version); any change anywhere bumps it and every phone refetches.

const CFG = window.APP_CONFIG || {};
const TOKEN_KEY = 'qk26.session';

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseError(raw) {
  const msg = (raw && (raw.message || raw.error || raw.hint)) || String(raw || 'Request failed');
  const m = /^([A-Z_]+):\s*(.*)$/.exec(msg);
  return m ? new ApiError(m[1], m[2]) : new ApiError('ERROR', msg);
}

export const api = {
  configured: !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY),
  token: localStorage.getItem(TOKEN_KEY),

  async rpc(fn, args = {}, { auth = true } = {}) {
    const body = auth ? { p_token: this.token, ...args } : args;
    let res;
    try {
      res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CFG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK', 'No connection. Check signal and try again.');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw parseError(data);
    if (data && typeof data === 'object' && data.error) throw parseError({ message: data.error });
    return data;
  },

  async login(pin) {
    const r = await this.rpc('login', { p_pin: pin }, { auth: false });
    this.token = r.token;
    localStorage.setItem(TOKEN_KEY, r.token);
    return r;
  },

  async logout() {
    try { if (this.token) await this.rpc('logout'); } catch { /* ignore */ }
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
  },

  getState() { return this.rpc('get_state'); },
};

// Live updates: Supabase Realtime on the heartbeat row, with polling as a
// safety net (fast when realtime is down, slow when it is up).
export function startLiveUpdates(onChange, onStatus) {
  let realtimeUp = false;
  let pollTimer = null;
  let channel = null;
  const schedule = () => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { onChange('poll'); schedule(); }, realtimeUp ? 20000 : 3000);
  };
  try {
    if (window.supabase && CFG.SUPABASE_URL) {
      const client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      channel = client.channel('heartbeat')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_version' }, () => onChange('realtime'))
        .subscribe((status) => {
          const up = status === 'SUBSCRIBED';
          if (up !== realtimeUp) { realtimeUp = up; onStatus && onStatus(up ? 'live' : 'polling'); schedule(); }
          if (up) onChange('resubscribed');
        });
    }
  } catch { realtimeUp = false; }
  onStatus && onStatus('polling');
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange('visible'); });
  window.addEventListener('online', () => onChange('online'));
  return () => { clearTimeout(pollTimer); channel && channel.unsubscribe(); };
}
