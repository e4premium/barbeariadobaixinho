const { getDb, resposta, slugValido, acharBarbearia, emDia } = require('../lib/comum');

// Página do cliente: devolve SÓ o que o cliente precisa ver (nome, logo, barbeiros e serviços).
// Nunca devolve clientes, caixa ou telefones.
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod !== 'GET') return resposta(405, { ok: false }, cors);

  const slug = String((event.queryStringParameters || {}).b || '').toLowerCase();
  if (!slugValido(slug)) return resposta(404, { ok: false }, cors);

  try {
    const db = getDb();
    const snap = await acharBarbearia(db, slug);
    if (!snap) return resposta(404, { ok: false }, cors);

    const cfg = snap.data();
    if (!emDia(cfg)) return resposta(403, { ok: false, indisponivel: true }, cors);

    const d = await snap.ref.collection('dados').doc('principal').get();
    const S = d.exists ? d.data() : {};
    return resposta(200, {
      ok: true,
      nome: cfg.nome || 'Barbearia',
      logo: cfg.logo || '',
      barbers: (S.barbers || []).map((b) => ({ id: b.id, name: b.name })),
      services: (S.services || []).map((s) => ({ id: s.id, name: s.name, price: s.price })),
    }, cors);
  } catch (e) {
    console.error('Erro em agenda-publica:', e);
    return resposta(500, { ok: false }, cors);
  }
};
