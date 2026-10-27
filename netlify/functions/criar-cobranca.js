const crypto = require('crypto');
const { admin, getDb, resposta } = require('../lib/comum');

const LINKS_URL = 'https://api.checkout.infinitepay.io/links';
const REUSO_MS = 30 * 60 * 1000; // reaproveita o link pendente por 30 minutos

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return resposta(405, { error: 'Método não permitido' }, cors);

  const handle = process.env.INFINITEPAY_HANDLE;
  if (!handle) return resposta(500, { error: 'INFINITEPAY_HANDLE não configurada' }, cors);

  try {
    const db = getDb(); // também inicializa o Admin SDK

    // Descobre QUAL barbearia está pagando, pelo login (token do Firebase Auth)
    const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    let uid;
    try {
      uid = (await admin.auth().verifyIdToken(token)).uid;
    } catch (e) {
      return resposta(401, { error: 'Faça login novamente.' }, cors);
    }

    const col = db.collection('cobrancas');

    // Evita criar vários links se o botão for clicado repetidas vezes (por barbearia)
    const pend = await col.where('uid', '==', uid).where('status', '==', 'pendente').get();
    const recente = pend.docs
      .map((d) => d.data())
      .filter((u) => u.url && Date.now() - u.criadoEmMs < REUSO_MS)
      .sort((a, b) => b.criadoEmMs - a.criadoEmMs)[0];
    if (recente) return resposta(200, { url: recente.url }, cors);

    const valor = Number(process.env.VALOR_CENTAVOS || 500); // em centavos: 500 = R$ 5,00
    const orderNsu = `mens-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const base = (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');

    // Registra ANTES de criar o link: o webhook só aceita pedidos que existem aqui
    const ref = col.doc(orderNsu);
    await ref.set({ uid, status: 'pendente', valor, criadoEmMs: Date.now() });

    const payload = {
      handle,
      order_nsu: orderNsu,
      items: [{ quantity: 1, price: valor, description: 'Mensalidade do sistema' }],
      webhook_url: `${base}/.netlify/functions/webhook-infinitepay`,
    };
    if (process.env.APP_URL) payload.redirect_url = process.env.APP_URL;

    const r = await fetch(LINKS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data.url) {
      console.error('Falha ao criar link InfinitePay:', r.status, JSON.stringify(data));
      await ref.update({ status: 'erro' });
      return resposta(502, { error: 'Não foi possível gerar o pagamento agora.' }, cors);
    }

    await ref.update({ url: data.url });
    return resposta(200, { url: data.url }, cors);
  } catch (e) {
    console.error('Erro em criar-cobranca:', e);
    return resposta(500, { error: 'Erro interno' }, cors);
  }
};
