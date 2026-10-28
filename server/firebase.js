// Cliente mínimo do Firebase para o Cloudflare (substitui o firebase-admin).
// Usa as APIs REST do Google com a mesma chave de serviço (FIREBASE_SERVICE_ACCOUNT_B64).
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const deB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const cache = { sa: null, token: null, exp: 0, jwks: null, jwksExp: 0 };

export function conta(env) {
  if (!cache.sa) {
    if (!env.FIREBASE_SERVICE_ACCOUNT_B64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 não configurada');
    cache.sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT_B64));
  }
  return cache.sa;
}

// ---------- token de acesso (OAuth2 com a chave de serviço) ----------
async function tokenAcesso(env) {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  const sa = conta(env);
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const corpo = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: agora,
    exp: agora + 3600,
  })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const chave = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, enc.encode(`${cab}.${corpo}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${cab}.${corpo}.${b64url(assinatura)}`,
    }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('Falha ao obter token do Google: ' + JSON.stringify(d));
  cache.token = d.access_token;
  cache.exp = Date.now() + (d.expires_in || 3600) * 1000;
  return cache.token;
}

async function google(env, url, { method = 'POST', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + (await tokenAcesso(env)), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ---------- conversão de valores do Firestore ----------
function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  return { mapValue: { fields: toFields(v) } };
}
const toFields = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toVal(x)]));

function fromVal(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
const fromFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, x]) => [k, fromVal(x)]));

// ---------- Firestore ----------
export function firestore(env) {
  const pid = conta(env).project_id;
  const raiz = `projects/${pid}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${raiz}`;
  const lerDoc = (d) => ({ id: d.name.split('/').pop(), path: d.name.slice(raiz.length + 1), data: fromFields(d.fields) });
  const escrita = (path, data, mascara) => {
    const w = { update: { name: `${raiz}/${path}`, fields: toFields(data) } };
    if (mascara) w.updateMask = { fieldPaths: mascara };
    return w;
  };

  async function get(path, tx) {
    const r = await google(env, `${base}/${path}` + (tx ? `?transaction=${encodeURIComponent(tx)}` : ''), { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firestore get ${path}: ${r.status} ${JSON.stringify(r.data)}`);
    return lerDoc(r.data);
  }

  async function query(colecao, igual = {}, limite) {
    const filtros = Object.entries(igual).map(([k, v]) => ({
      fieldFilter: { field: { fieldPath: k }, op: 'EQUAL', value: toVal(v) },
    }));
    const sq = { from: [{ collectionId: colecao }] };
    if (filtros.length === 1) sq.where = filtros[0];
    if (filtros.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: filtros } };
    if (limite) sq.limit = limite;
    const r = await google(env, `${base}:runQuery`, { body: { structuredQuery: sq } });
    if (!r.ok) throw new Error(`Firestore query ${colecao}: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.filter((x) => x.document).map((x) => lerDoc(x.document));
  }

  const commit = (writes, tx) => google(env, `${base}:commit`, { body: tx ? { writes, transaction: tx } : { writes } });
  const exigir = (r, o) => { if (!r.ok) throw new Error(`Firestore ${o}: ${r.status} ${JSON.stringify(r.data)}`); };

  return {
    get: (path) => get(path),
    query,
    // set = substitui o documento inteiro; update = mexe só nos campos informados
    set: async (path, data) => exigir(await commit([escrita(path, data)]), 'set'),
    update: async (path, data) => exigir(await commit([escrita(path, data, Object.keys(data))]), 'update'),

    // Transação com tentativas (se outra gravação mexer no mesmo documento, repete)
    async transaction(fn) {
      for (let i = 0; i < 4; i++) {
        const b = await google(env, `${base}:beginTransaction`, { body: { options: { readWrite: {} } } });
        exigir(b, 'beginTransaction');
        const tx = b.data.transaction;
        const writes = [];
        const res = await fn({
          get: (p) => get(p, tx),
          update: (p, d, mascara) => writes.push(escrita(p, d, mascara || Object.keys(d))),
        });
        if (!writes.length) {
          await google(env, `${base}:rollback`, { body: { transaction: tx } });
          return res;
        }
        const c = await commit(writes, tx);
        if (c.ok) return res;
        if (c.status !== 409) exigir(c, 'commit');
      }
      throw new Error('Muitas tentativas na transação');
    },
  };
}

// ---------- Firebase Auth (administração de usuários) ----------
export function authAdmin(env) {
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${conta(env).project_id}`;
  return {
    criar: (email, password, displayName) => google(env, `${base}/accounts`, { body: { email, password, displayName } }),
    apagar: (localId) => google(env, `${base}/accounts:delete`, { body: { localId } }),
    senha: (localId, password) => google(env, `${base}/accounts:update`, { body: { localId, password } }),
    async emails(ids) {
      const mapa = {};
      for (let i = 0; i < ids.length; i += 100) {
        const r = await google(env, `${base}/accounts:lookup`, { body: { localId: ids.slice(i, i + 100) } });
        (r.data.users || []).forEach((u) => (mapa[u.localId] = u.email));
      }
      return mapa;
    },
  };
}

// Confere o token de login (idToken) enviado pelo navegador
export async function verificarToken(env, token) {
  const pid = conta(env).project_id;
  const partes = String(token || '').split('.');
  if (partes.length !== 3) throw new Error('token inválido');
  const cab = JSON.parse(dec.decode(deB64url(partes[0])));
  const pay = JSON.parse(dec.decode(deB64url(partes[1])));
  if (cab.alg !== 'RS256') throw new Error('algoritmo inválido');

  if (!cache.jwks || Date.now() > cache.jwksExp) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    cache.jwks = await r.json();
    cache.jwksExp = Date.now() + 3600 * 1000;
  }
  const jwk = (cache.jwks.keys || []).find((k) => k.kid === cab.kid);
  if (!jwk) throw new Error('chave desconhecida');
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, deB64url(partes[2]), enc.encode(`${partes[0]}.${partes[1]}`));
  if (!ok || pay.aud !== pid || pay.iss !== `https://securetoken.google.com/${pid}` || pay.exp < Date.now() / 1000 || !pay.sub) {
    throw new Error('token inválido');
  }
  return { uid: pay.sub, email: pay.email || '' };
}

// ---------- utilidades (iguais às do comum.js antigo) ----------
export const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

export function somaMes(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const ty = m === 12 ? y + 1 : y;
  const tm = m === 12 ? 1 : m + 1;
  const ultimoDia = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, ultimoDia)).padStart(2, '0')}`;
}

export function proximoVencimento(atual) {
  const hoje = hojeBR();
  const valido = typeof atual === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(atual);
  return somaMes(valido && atual > hoje ? atual : hoje);
}

export const slugValido = (s) => /^[a-z0-9-]{2,60}$/.test(s);

export async function acharBarbearia(fs, slug) {
  return (await fs.query('barbearias', { slug }, 1))[0] || null;
}

export function emDia(cfg) {
  const v = cfg && cfg.vencimento;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && hojeBR() <= v;
}

export const resp = (status, obj, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
