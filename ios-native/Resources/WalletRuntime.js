// Platform adapters for the bundled, headless wallet library. No HTML, no remote
// scripts, no browser navigation. The host validates every operation and URL.
(() => {
  const pending = new Map();
  let next = 0;
  globalThis.nativeCall = (operation, args) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    __nativeAsync(id, operation, JSON.stringify(args, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  });
  globalThis.__settle = (id, ok, text) => {
    const item = pending.get(id); if (!item) return;
    pending.delete(id);
    if (ok) item.resolve(JSON.parse(text)); else item.reject(new Error(text));
  };
  const sync = (op, args) => {
    const result = JSON.parse(__nativeSync(op, JSON.stringify(args)));
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const timers = new Map();
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++next; timers.set(id, () => callback(...args));
    __nativeTimer(id, Math.max(0, delay)); return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); __nativeCancelTimer(id); };
  globalThis.__fireTimer = id => { const f = timers.get(id); timers.delete(id); if (f) f(); };
  globalThis.queueMicrotask = f => Promise.resolve().then(f);
  globalThis.crypto = { getRandomValues(array) {
    if (!ArrayBuffer.isView(array) || array.byteLength > 65536) throw new Error('Invalid random byte request');
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(sync('random', { count: array.byteLength })); return array;
  } };
  globalThis.TextEncoder = class { encode(text = '') { return Uint8Array.from(sync('encodeUTF8', { text })); } };
  globalThis.TextDecoder = class { decode(data = []) { return sync('decodeUTF8', { bytes: Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength)) }); } };
  globalThis.btoa = text => sync('base64encode', { bytes: Array.from(text, x => x.charCodeAt(0)) });
  globalThis.atob = text => String.fromCharCode(...sync('base64decode', { text }));
  globalThis.Headers = class {
    constructor(input = {}) { this.values = new Map(input instanceof Headers ? input.values : Array.isArray(input) ? input.map(([k,v]) => [k.toLowerCase(), String(v)]) : Object.entries(input).map(([k,v]) => [k.toLowerCase(), String(v)])); }
    get(k) { return this.values.get(k.toLowerCase()) ?? null; }
    set(k, v) { this.values.set(k.toLowerCase(), String(v)); }
    has(k) { return this.values.has(k.toLowerCase()); }
    entries() { return this.values.entries(); }
    [Symbol.iterator]() { return this.entries(); }
  };
  globalThis.URLSearchParams = class {
    constructor(text = '') { this.items = String(text).replace(/^\?/, '').split('&').filter(Boolean).map(x => { const p = x.split('='); return p.map(v => decodeURIComponent(v.replace(/\+/g, ' '))); }); }
    get(key) { return this.items.find(p => p[0] === key)?.[1] ?? null; }
    has(key) { return this.items.some(p => p[0] === key); }
    set(key, value) { this.items = this.items.filter(p => p[0] !== key); this.items.push([key, String(value)]); }
    toString() { return this.items.map(p => p.map(encodeURIComponent).join('=')).join('&'); }
  };
  globalThis.URL = class {
    constructor(url, base) { Object.assign(this, sync('parseURL', { url: String(url), base: base ? String(base) : null })); this.searchParams = new URLSearchParams(this.search); }
    toString() { return sync('formatURL', { scheme: this.protocol.replace(':', ''), host: this.hostname, port: this.port, path: this.pathname, query: this.search.replace(/^\?/, ''), username: this.username, password: this.password }); }
    get href() { return this.toString(); }
  };
  globalThis.AbortController = class {
    constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {}, throwIfAborted() { if (this.aborted) throw new Error('Aborted'); } }; }
    abort() { this.signal.aborted = true; }
  };
  globalThis.AbortSignal = { timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; } };
  globalThis.Request = class {
    constructor(input, options = {}) { this.url = input instanceof Request ? input.url : String(input); Object.assign(this, input instanceof Request ? input : {}, options); this.headers = new Headers(options.headers || this.headers || {}); this.method ||= 'GET'; }
    toString() { return this.url; }
  };
  globalThis.fetch = async (input, options = {}) => {
    if (input instanceof Request) options = { ...input, ...options };
    if (options.signal?.aborted) throw new Error('Aborted');
    const metadata = WalletEngine.rpcMetadata(options.body || null);
    const result = await nativeCall('fetch', { url: String(input), method: options.method || 'GET', body: options.body || null, metadata, headers: Object.fromEntries(new Headers(options.headers || {})) });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, headers: new Headers(result.headers || {}),
      async text() { return result.body; }, async json() { return JSON.parse(result.body); } };
  };
  globalThis.localStorage = {
    getItem(key) { return sync('storageGet', { key }); },
    setItem(key, value) { sync('storageSet', { key, value }); },
    removeItem(key) { sync('storageRemove', { key }); },
    key(index) { return sync('storageKeys', {})[index] ?? null; },
    get length() { return sync('storageKeys', {}).length; },
  };
  globalThis.window = { location: { origin: 'https://app.merrymen.dev' } };
  globalThis.__runWallet = async (id, operation, input) => {
    try {
      if (!['capabilities', 'recoverIdentity', 'create', 'restore', 'preview', 'plan', 'withdraw', 'reconcile'].includes(operation)) throw new Error('Unsupported wallet operation');
      const result = await WalletEngine[operation](JSON.parse(input));
      __nativeResult(id, true, JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    } catch (error) { __nativeResult(id, false, error?.message || 'Wallet operation failed'); }
  };
})();
