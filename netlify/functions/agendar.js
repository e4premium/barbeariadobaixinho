const crypto = require('crypto');
const { getDb, hojeBR, resposta, slugValido, acharBarbearia, emDia } = require('../lib/comum');

// Horários de atendimento (os mesmos da página do cliente)
function horariosDoDia(iso) {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0 = domingo
  if (dow === 0) return ['10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30'];
  if (dow === 6) return ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
    '15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30'];
  return ['09:00','09:30','10:00','10:30','11:00','11:30','12:00',
    '15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30'];
}
const uid = () => crypto.randomBytes(5).toString('hex').slice(0, 7);

// O cliente nunca grava no banco: quem grava é esta função, depois de validar tudo.
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return resposta(405, { error: 'Método não permitido' }, cors);

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return resposta(400, { error: 'Dados inválidos.' }, cors); }

  const slug = String(b.b || '').toLowerCase();
  const nome = String(b.nome || '').trim().slice(0, 80);
  const fone = String(b.fone || '').replace(/[^\d()\-+ ]/g, '').slice(0, 20);
  const data = String(b.data || '');
  const hora = String(b.hora || '');
  const barberId = String(b.barberId || '');
  const servId = String(b.servId || '');

  if (!slugValido(slug) || nome.length < 2 || !barberId || !servId) {
    return resposta(400, { error: 'Preencha todos os campos.' }, cors);
  }
  const hoje = hojeBR();
  const limite = new Date(Date.parse(hoje + 'T00:00:00Z') + 90 * 864e5).toISOString().slice(0, 10);
  const dataReal = /^\d{4}-\d{2}-\d{2}$/.test(data) && !isNaN(Date.parse(data + 'T00:00:00Z'))
    && new Date(data + 'T00:00:00Z').toISOString().slice(0, 10) === data;
  if (!dataReal || data < hoje || data > limite) {
    return resposta(400, { error: 'Escolha uma data a partir de hoje (até 90 dias).' }, cors);
  }
  if (!horariosDoDia(data).includes(hora)) {
    return resposta(400, { error: 'Horário inválido para este dia.' }, cors);
  }

  try {
    const db = getDb();
    const snap = await acharBarbearia(db, slug);
    if (!snap) return resposta(404, { error: 'Barbearia não encontrada.' }, cors);
    if (!emDia(snap.data())) return resposta(403, { indisponivel: true, error: 'Agendamento indisponível.' }, cors);

    const ref = snap.ref.collection('dados').doc('principal');

    // Transação: dois clientes no mesmo horário não passam os dois
    const r = await db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      const S = d.exists ? d.data() : {};
      S.appts = S.appts || [];
      S.clients = S.clients || [];

      const barb = (S.barbers || []).find((x) => x.id === barberId);
      const serv = (S.services || []).find((x) => x.id === servId);
      if (!barb || !serv) return { status: 400, error: 'Barbeiro ou serviço inválido.' };

      if (S.appts.some((a) => a.date === data && a.time === hora && a.bid === barberId && a.status === 'agendado')) {
        return { status: 409, error: `O horário ${hora} já está ocupado para este barbeiro. Escolha outro.` };
      }

      let k = S.clients.find((x) => x.name && x.name.toLowerCase() === nome.toLowerCase());
      if (!k) { k = { id: uid(), name: nome, phone: fone }; S.clients.push(k); }
      else if (!k.phone && fone) k.phone = fone;

      S.appts.push({
        id: uid(), date: data, time: hora, client: k.name, cid: k.id,
        bid: barb.id, bn: barb.name, sn: serv.name, price: serv.price, status: 'agendado',
      });
      tx.set(ref, S);
      return { status: 200 };
    });

    if (r.status !== 200) return resposta(r.status, { error: r.error }, cors);
    return resposta(200, { ok: true }, cors);
  } catch (e) {
    console.error('Erro em agendar:', e);
    return resposta(500, { error: 'Erro ao realizar agendamento. Tente novamente.' }, cors);
  }
};
