const { getDb, proximoVencimento, resposta } = require('../lib/comum');

const PAYMENT_CHECK_URL = 'https://api.checkout.infinitepay.io/payment_check';
const { FieldValue } = require('firebase-admin/firestore');

// A InfinitePay chama esta URL quando um pagamento é aprovado.
// Responder 200 = recebido. Responder 400 = a InfinitePay tenta de novo.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resposta(405, { error: 'Método não permitido' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return resposta(400, { error: 'JSON inválido' });
  }

  const orderNsu = String(body.order_nsu || '');
  const transactionNsu = String(body.transaction_nsu || '');
  const slug = String(body.invoice_slug || '');

  // Só aceita os IDs que a nossa própria função gera (evita caracteres estranhos)
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(orderNsu) || !transactionNsu || !slug) {
    return resposta(400, { error: 'Campos obrigatórios ausentes' });
  }

  const handle = process.env.INFINITEPAY_HANDLE;
  if (!handle) return resposta(500, { error: 'INFINITEPAY_HANDLE não configurada' });

  try {
    const db = getDb();
    const ref = db.collection('cobrancas').doc(orderNsu);
    const snap = await ref.get();

    // Pedido que não foi criado por nós: ignora (200 para a InfinitePay não insistir)
    if (!snap.exists) return resposta(200, { ignorado: 'pedido desconhecido' });

    const cobranca = snap.data();
    if (!cobranca.uid) return resposta(200, { ignorado: 'cobrança sem barbearia' });
    if (cobranca.status === 'pago') return resposta(200, { ok: true, jaProcessado: true });

    // O webhook sozinho não prova nada: confirma direto na InfinitePay
    const r = await fetch(PAYMENT_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        order_nsu: orderNsu,
        transaction_nsu: transactionNsu,
        slug,
      }),
    });
    const check = await r.json().catch(() => ({}));

    const confirmado =
      check && check.success === true && check.paid === true && Number(check.amount) >= Number(cobranca.valor);

    if (!confirmado) {
      console.warn('Pagamento não confirmado para', orderNsu, JSON.stringify(check));
      return resposta(400, { error: 'Pagamento não confirmado' });
    }

    // Tudo numa transação: se o webhook chegar duas vezes, só soma uma vez
    await db.runTransaction(async (tx) => {
      const atualSnap = await tx.get(ref);
      if (atualSnap.data().status === 'pago') return;

      const assinaturaRef = db.collection('barbearias').doc(cobranca.uid);
      const assinaturaSnap = await tx.get(assinaturaRef);
      const vencimentoAtual = assinaturaSnap.exists ? assinaturaSnap.data().vencimento : null;
      const novoVencimento = proximoVencimento(vencimentoAtual);

      tx.set(
        assinaturaRef,
        { vencimento: novoVencimento, atualizadoEm: FieldValue.serverTimestamp(), ultimoPedido: orderNsu },
        { merge: true }
      );
      tx.update(ref, {
        status: 'pago',
        pagoEm: FieldValue.serverTimestamp(),
        transaction_nsu: transactionNsu,
        slug,
        capture_method: check.capture_method || null,
        receipt_url: body.receipt_url || null,
        novoVencimento,
      });
    });

    return resposta(200, { ok: true });
  } catch (e) {
    console.error('Erro no webhook:', e);
    return resposta(400, { error: 'Erro ao processar' });
  }
};
