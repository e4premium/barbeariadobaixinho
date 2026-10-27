const admin = require('firebase-admin');

// Inicializa o Firebase Admin uma única vez (a chave vem em base64 na variável de ambiente)
function getDb() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 não configurada');
    const chave = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(chave) });
  }
  return admin.firestore();
}

// Data de hoje no Brasil (UTC-3, sem horário de verão) no formato AAAA-MM-DD
function hojeBR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Soma 1 mês a uma data AAAA-MM-DD, mantendo o dia (ou o último dia do mês, se não existir)
function somaMes(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const ty = m === 12 ? y + 1 : y;
  const tm = m === 12 ? 1 : m + 1;
  const ultimoDia = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const dd = Math.min(d, ultimoDia);
  return `${ty}-${String(tm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Pagou adiantado: soma 1 mês ao vencimento atual. Venceu: conta 1 mês a partir de hoje.
function proximoVencimento(atual) {
  const hoje = hojeBR();
  const valido = typeof atual === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(atual);
  const base = valido && atual > hoje ? atual : hoje;
  return somaMes(base);
}

function resposta(status, obj, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(obj),
  };
}

module.exports = { admin, getDb, hojeBR, somaMes, proximoVencimento, resposta };
