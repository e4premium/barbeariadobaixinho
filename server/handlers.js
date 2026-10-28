// As 5 funções do sistema, portadas do Netlify para o Cloudflare (mesma lógica, mesmas regras).
import {
  firestore, authAdmin, verificarToken, hojeBR, proximoVencimento,
  slugValido, acharBarbearia, emDia, resp,
} from './firebase.js';

const PRINCIPAL = (id) => `barbearias/${id}/dados/principal`;
const lerJson = async (req) => { try { return await req.json(); } catch (e) { return null; } };
const tokenDe = (req) => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

// =====================================================================
// agenda-publica: só nome, logo, barbeiros e serviços (nunca clientes/caixa)
// =====================================================================
async function agendaPublica(req, env, url, cors) {
  if (req.method !== 'GET') return resp(405, { ok: false }, cors);
  const slug = String(url.searchParams.get('b') || '').toLowerCase();
  if (!slugValido(slug)) return resp(404, { ok: false }, cors);

  const fs = firestore(env);
  const snap = await acharBarbearia(fs, slug);
  if (!snap) return resp(404, { ok: false }, cors);
  const cfg = snap.data;
  if (!emDia(cfg)) return resp(403, { ok: false, indisponivel: true }, cors);

  const d = await fs.get(PRINCIPAL(snap.id));
  const S = d ? d.data : {};
  return resp(200, {
    ok: true,
    nome: cfg.nome || 'Barbearia',
    logo: cfg.logo || '',
    barbers: (S.barbers || []).map((b) => ({ id: b.id, name: b.name })),
    services: (S.services || []).map((s) => ({ id: s.id, name: s.name, price: s.price })),
    horarios: horariosDaBarbearia(S.horarios),
  }, cors);
}

// =====================================================================
// agendar: grava o agendamento (valida tudo; o cliente nunca acessa o banco)
// =====================================================================
// Horários de cada barbearia ficam em dados/principal -> horarios (o dono edita em Cadastros).
// Cada tipo de dia tem duas faixas (manhã a–b, tarde c–d), de 30 em 30 minutos.
// Barbearia sem "horarios" salvos usa o padrão abaixo (o mesmo de antes).
const PADRAO_HORARIOS = {
  semana:  { a: '09:00', b: '12:00', c: '15:00', d: '19:30' },
  sabado:  { a: '09:00', b: '13:30', c: '15:00', d: '20:30' },
  domingo: { a: '10:00', b: '13:30', c: '',      d: ''      },
};
const reHora = /^([01]\d|2[0-3]):[0-5]\d$/;
const emMinutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
const deMinutos = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function faixaDeHorarios(ini, fim) {
  if (!reHora.test(String(ini || '')) || !reHora.test(String(fim || ''))) return [];
  const out = [];
  for (let m = emMinutos(ini); m <= emMinutos(fim); m += 30) out.push(deMinutos(m));
  return out;
}
function horariosDaBarbearia(H) {
  const r = {};
  for (const k of Object.keys(PADRAO_HORARIOS)) {
    const g = H && typeof H[k] === 'object' && H[k] ? H[k] : PADRAO_HORARIOS[k];
    r[k] = [...new Set([...faixaDeHorarios(g.a, g.b), ...faixaDeHorarios(g.c, g.d)])].sort();
  }
  return r;
}
function horariosDoDia(iso, H) {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay();
  const l = horariosDaBarbearia(H);
  return dow === 0 ? l.domingo : dow === 6 ? l.sabado : l.semana;
}
const novoId = () =>
  [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 7);

async function agendar(req, env, url, cors) {
  if (req.method !== 'POST') return resp(405, { error: 'Método não permitido' }, cors);
  const b = await lerJson(req);
  if (!b) return resp(400, { error: 'Dados inválidos.' }, cors);

  const slug = String(b.b || '').toLowerCase();
  const nome = String(b.nome || '').trim().slice(0, 80);
  const fone = String(b.fone || '').replace(/[^\d()\-+ ]/g, '').slice(0, 20);
  const data = String(b.data || '');
  const hora = String(b.hora || '');
  const barberId = String(b.barberId || '');
  const servId = String(b.servId || '');

  if (!slugValido(slug) || nome.length < 2 || !barberId || !servId) {
    return resp(400, { error: 'Preencha todos os campos.' }, cors);
  }
  const hoje = hojeBR();
  const limite = new Date(Date.parse(hoje + 'T00:00:00Z') + 90 * 864e5).toISOString().slice(0, 10);
  const dataReal = /^\d{4}-\d{2}-\d{2}$/.test(data) && !isNaN(Date.parse(data + 'T00:00:00Z'))
    && new Date(data + 'T00:00:00Z').toISOString().slice(0, 10) === data;
  if (!dataReal || data < hoje || data > limite) {
    return resp(400, { error: 'Escolha uma data a partir de hoje (até 90 dias).' }, cors);
  }

  const fs = firestore(env);
  const snap = await acharBarbearia(fs, slug);
  if (!snap) return resp(404, { error: 'Barbearia não encontrada.' }, cors);
  if (!emDia(snap.data)) return resp(403, { indisponivel: true, error: 'Agendamento indisponível.' }, cors);

  const caminho = PRINCIPAL(snap.id);
  const r = await fs.transaction(async (tx) => {
    const d = await tx.get(caminho);
    const S = d ? d.data : {};
    S.appts = S.appts || [];
    S.clients = S.clients || [];

    const barb = (S.barbers || []).find((x) => x.id === barberId);
    const serv = (S.services || []).find((x) => x.id === servId);
    if (!barb || !serv) return { status: 400, error: 'Barbeiro ou serviço inválido.' };
    if (!horariosDoDia(data, S.horarios).includes(hora)) return { status: 400, error: 'Horário inválido para este dia.' };

    if (S.appts.some((a) => a.date === data && a.time === hora && a.bid === barberId && a.status === 'agendado')) {
      return { status: 409, error: `O horário ${hora} já está ocupado para este barbeiro. Escolha outro.` };
    }

    let k = S.clients.find((x) => x.name && x.name.toLowerCase() === nome.toLowerCase());
    if (!k) { k = { id: novoId(), name: nome, phone: fone }; S.clients.push(k); }
    else if (!k.phone && fone) k.phone = fone;

    S.appts.push({
      id: novoId(), date: data, time: hora, client: k.name, cid: k.id,
      bid: barb.id, bn: barb.name, sn: serv.name, price: serv.price, status: 'agendado',
    });
    // Grava só os dois campos alterados (não mexe no resto do documento)
    tx.update(caminho, { appts: S.appts, clients: S.clients }, ['appts', 'clients']);
    return { status: 200 };
  });

  if (r.status !== 200) return resp(r.status, { error: r.error }, cors);
  return resp(200, { ok: true }, cors);
}

// =====================================================================
// criar-cobranca: gera o link de pagamento (identifica a barbearia pelo login)
// =====================================================================
const LINKS_URL = 'https://api.checkout.infinitepay.io/links';
const REUSO_MS = 30 * 60 * 1000;

async function criarCobranca(req, env, url, cors) {
  if (req.method !== 'POST') return resp(405, { error: 'Método não permitido' }, cors);
  const handle = env.INFINITEPAY_HANDLE;
  if (!handle) return resp(500, { error: 'INFINITEPAY_HANDLE não configurada' }, cors);

  let uid;
  try { uid = (await verificarToken(env, tokenDe(req))).uid; }
  catch (e) { return resp(401, { error: 'Faça login novamente.' }, cors); }

  const fs = firestore(env);
  const pend = await fs.query('cobrancas', { uid, status: 'pendente' });
  const recente = pend
    .map((d) => d.data)
    .filter((u) => u.url && Date.now() - u.criadoEmMs < REUSO_MS)
    .sort((a, b) => b.criadoEmMs - a.criadoEmMs)[0];
  if (recente) return resp(200, { url: recente.url }, cors);

  const valor = Number(env.VALOR_CENTAVOS || 500);
  const orderNsu = `mens-${Date.now()}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const base = String(env.SITE_URL || url.origin).replace(/\/$/, '');
  const caminho = `cobrancas/${orderNsu}`;

  // Registra ANTES de criar o link: o webhook só aceita pedidos que existem aqui
  await fs.set(caminho, { uid, status: 'pendente', valor, criadoEmMs: Date.now() });

  const payload = {
    handle,
    order_nsu: orderNsu,
    items: [{ quantity: 1, price: valor, description: 'Mensalidade do sistema' }],
    webhook_url: `${base}/.netlify/functions/webhook-infinitepay`,
  };
  if (env.APP_URL) payload.redirect_url = env.APP_URL;

  const r = await fetch(LINKS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url) {
    console.error('Falha ao criar link InfinitePay:', r.status, JSON.stringify(data));
    await fs.update(caminho, { status: 'erro' });
    return resp(502, { error: 'Não foi possível gerar o pagamento agora.' }, cors);
  }
  await fs.update(caminho, { url: data.url });
  return resp(200, { url: data.url }, cors);
}

// =====================================================================
// webhook-infinitepay: libera a barbearia certa depois do pagamento
// =====================================================================
const PAYMENT_CHECK_URL = 'https://api.checkout.infinitepay.io/payment_check';

async function webhookInfinitepay(req, env) {
  if (req.method !== 'POST') return resp(405, { error: 'Método não permitido' });
  const body = await lerJson(req);
  if (!body) return resp(400, { error: 'JSON inválido' });

  const orderNsu = String(body.order_nsu || '');
  const transactionNsu = String(body.transaction_nsu || '');
  const slug = String(body.invoice_slug || '');
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(orderNsu) || !transactionNsu || !slug) {
    return resp(400, { error: 'Campos obrigatórios ausentes' });
  }
  const handle = env.INFINITEPAY_HANDLE;
  if (!handle) return resp(500, { error: 'INFINITEPAY_HANDLE não configurada' });

  try {
    const fs = firestore(env);
    const caminho = `cobrancas/${orderNsu}`;
    const snap = await fs.get(caminho);
    if (!snap) return resp(200, { ignorado: 'pedido desconhecido' });
    const cobranca = snap.data;
    if (!cobranca.uid) return resp(200, { ignorado: 'cobrança sem barbearia' });
    if (cobranca.status === 'pago') return resp(200, { ok: true, jaProcessado: true });

    // O webhook sozinho não prova nada: confirma direto na InfinitePay
    const r = await fetch(PAYMENT_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug }),
    });
    const check = await r.json().catch(() => ({}));
    const confirmado = check && check.success === true && check.paid === true
      && Number(check.amount) >= Number(cobranca.valor);
    if (!confirmado) {
      console.warn('Pagamento não confirmado para', orderNsu, JSON.stringify(check));
      return resp(400, { error: 'Pagamento não confirmado' });
    }

    // Transação: se o webhook chegar duas vezes, só soma uma vez
    await fs.transaction(async (tx) => {
      const atual = await tx.get(caminho);
      if (atual && atual.data.status === 'pago') return;
      const assinaturaCaminho = `barbearias/${cobranca.uid}`;
      const ass = await tx.get(assinaturaCaminho);
      const novoVencimento = proximoVencimento(ass ? ass.data.vencimento : null);

      tx.update(assinaturaCaminho, {
        vencimento: novoVencimento, atualizadoEm: new Date(), ultimoPedido: orderNsu,
      });
      tx.update(caminho, {
        status: 'pago', pagoEm: new Date(), transaction_nsu: transactionNsu, slug,
        capture_method: check.capture_method || null,
        receipt_url: body.receipt_url || null, novoVencimento,
      });
    });
    return resp(200, { ok: true });
  } catch (e) {
    console.error('Erro no webhook:', e);
    return resp(400, { error: 'Erro ao processar' });
  }
}

// =====================================================================
// admin-barbearias: listar, cadastrar e atualizar (só o ADMIN_EMAIL)
// =====================================================================
const dataMais = (dias) => {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const gerarSlug = (nome) =>
  nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'barbearia';
const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const reData = /^\d{4}-\d{2}-\d{2}$/;
const logoOk = (l) => l === '' || /^https:\/\//i.test(l);

async function adminBarbearias(req, env, url, cors) {
  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  let quem;
  try { quem = await verificarToken(env, tokenDe(req)); } catch (e) { quem = null; }
  if (!adminEmail || !quem || quem.email.toLowerCase() !== adminEmail) {
    return resp(403, { erro: 'Acesso negado.' }, cors);
  }
  const fs = firestore(env);
  const auth = authAdmin(env);

  if (req.method === 'GET') {
    const docs = await fs.query('barbearias');
    const emails = await auth.emails(docs.map((d) => d.id));
    const lista = docs.map((d) => ({
      id: d.id, nome: d.data.nome || '', slug: d.data.slug || '', logo: d.data.logo || '',
      vencimento: d.data.vencimento || '', email: emails[d.id] || '',
    })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return resp(200, { barbearias: lista }, cors);
  }
  if (req.method !== 'POST') return resp(405, { erro: 'Método não permitido.' }, cors);

  const b = await lerJson(req);
  if (!b) return resp(400, { erro: 'Requisição inválida.' }, cors);

  if (b.acao === 'cadastrar') {
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    const logo = String(b.logo || '').trim();
    const dias = b.dias === undefined || b.dias === '' ? 7 : parseInt(b.dias, 10);
    if (!nome || nome.length > 80) return resp(400, { erro: 'Informe o nome (até 80 caracteres).' }, cors);
    if (!reEmail.test(email)) return resp(400, { erro: 'E-mail inválido.' }, cors);
    if (senha.length < 6) return resp(400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' }, cors);
    if (!logoOk(logo)) return resp(400, { erro: 'O logo precisa ser um link que comece com https://' }, cors);
    if (!Number.isInteger(dias) || dias < 0 || dias > 365) {
      return resp(400, { erro: 'Dias de teste deve ser um número de 0 a 365.' }, cors);
    }

    const u = await auth.criar(email, senha, nome);
    if (!u.ok) {
      const m = (u.data.error && u.data.error.message) || '';
      if (m.startsWith('EMAIL_EXISTS')) return resp(409, { erro: 'Esse e-mail já está cadastrado.' }, cors);
      if (m.startsWith('WEAK_PASSWORD')) return resp(400, { erro: 'Senha inválida (mínimo 6 caracteres).' }, cors);
      if (m.startsWith('INVALID_EMAIL')) return resp(400, { erro: 'E-mail inválido.' }, cors);
      return resp(500, { erro: 'Não foi possível criar o login: ' + m }, cors);
    }
    const uid = u.data.localId;
    try {
      const base = gerarSlug(nome);
      let slug = base, n = 1;
      while ((await fs.query('barbearias', { slug }, 1)).length) slug = `${base}-${++n}`;
      const vencimento = dataMais(dias);
      await fs.set(`barbearias/${uid}`, { nome, logo, slug, vencimento, criadoEm: new Date() });
      return resp(200, { ok: true, id: uid, slug, vencimento, link: `${url.origin}/agenda.html?b=${slug}` }, cors);
    } catch (e) {
      await auth.apagar(uid).catch(() => {});
      return resp(500, { erro: 'Não foi possível gravar a barbearia: ' + e.message }, cors);
    }
  }

  if (b.acao === 'atualizar') {
    const id = String(b.id || '');
    if (!id) return resp(400, { erro: 'Barbearia não informada.' }, cors);
    if (!(await fs.get(`barbearias/${id}`))) return resp(404, { erro: 'Barbearia não encontrada.' }, cors);

    const campos = {};
    if (b.nome !== undefined) {
      const nome = String(b.nome).trim();
      if (!nome || nome.length > 80) return resp(400, { erro: 'Nome inválido.' }, cors);
      campos.nome = nome;
    }
    if (b.logo !== undefined) {
      const logo = String(b.logo).trim();
      if (!logoOk(logo)) return resp(400, { erro: 'O logo precisa começar com https://' }, cors);
      campos.logo = logo;
    }
    if (b.vencimento !== undefined) {
      if (!reData.test(String(b.vencimento))) return resp(400, { erro: 'Vencimento inválido (use AAAA-MM-DD).' }, cors);
      campos.vencimento = String(b.vencimento);
    }
    if (b.senha && String(b.senha).length < 6) {
      return resp(400, { erro: 'A nova senha precisa ter pelo menos 6 caracteres.' }, cors);
    }
    if (Object.keys(campos).length) await fs.update(`barbearias/${id}`, campos);
    if (b.senha) await auth.senha(id, String(b.senha));
    return resp(200, { ok: true }, cors);
  }
  return resp(400, { erro: 'Ação desconhecida.' }, cors);
}

export const HANDLERS = {
  'agenda-publica': agendaPublica,
  'agendar': agendar,
  'criar-cobranca': criarCobranca,
  'webhook-infinitepay': (req, env) => webhookInfinitepay(req, env),
  'admin-barbearias': adminBarbearias,
};
