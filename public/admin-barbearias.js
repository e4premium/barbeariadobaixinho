// Administração das barbearias: listar, cadastrar e atualizar.
// Só funciona para o e-mail definido em ADMIN_EMAIL (variável de ambiente do Netlify).
const admin = require('firebase-admin');

function iniciar() {
  if (admin.apps.length) return;
  const sa = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
  );
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

const resp = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

// Data de hoje no Brasil (UTC-3) + n dias, no formato AAAA-MM-DD
function dataMais(dias) {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function gerarSlug(nome) {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'barbearia';
}

async function slugLivre(db, base) {
  let slug = base;
  let n = 2;
  while (!(await db.collection('barbearias').where('slug', '==', slug).limit(1).get()).empty) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

async function verificarAdmin(event) {
  const cab = event.headers.authorization || event.headers.Authorization || '';
  const token = cab.startsWith('Bearer ') ? cab.slice(7) : '';
  if (!token) return false;
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) return false;
  try {
    const dec = await admin.auth().verifyIdToken(token);
    return (dec.email || '').toLowerCase() === adminEmail;
  } catch (e) {
    return false;
  }
}

const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const reData = /^\d{4}-\d{2}-\d{2}$/;
const logoOk = (l) => l === '' || /^https:\/\//i.test(l);

async function listar(db) {
  const snap = await db.collection('barbearias').get();
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const emails = {};
  for (let i = 0; i < docs.length; i += 100) {
    const lote = docs.slice(i, i + 100).map((d) => ({ uid: d.id }));
    const r = await admin.auth().getUsers(lote);
    r.users.forEach((u) => (emails[u.uid] = u.email));
  }
  const lista = docs
    .map((d) => ({
      id: d.id,
      nome: d.nome || '',
      slug: d.slug || '',
      logo: d.logo || '',
      vencimento: d.vencimento || '',
      email: emails[d.id] || '',
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return resp(200, { barbearias: lista });
}

async function cadastrar(db, event, b) {
  const nome = String(b.nome || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const senha = String(b.senha || '');
  const logo = String(b.logo || '').trim();
  const dias = b.dias === undefined || b.dias === '' ? 7 : parseInt(b.dias, 10);

  if (!nome || nome.length > 80) return resp(400, { erro: 'Informe o nome (até 80 caracteres).' });
  if (!reEmail.test(email)) return resp(400, { erro: 'E-mail inválido.' });
  if (senha.length < 6) return resp(400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (!logoOk(logo)) return resp(400, { erro: 'O logo precisa ser um link que comece com https://' });
  if (!Number.isInteger(dias) || dias < 0 || dias > 365) {
    return resp(400, { erro: 'Dias de teste deve ser um número de 0 a 365.' });
  }

  let usuario;
  try {
    usuario = await admin.auth().createUser({ email, password: senha, displayName: nome });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') return resp(409, { erro: 'Esse e-mail já está cadastrado.' });
    if (e.code === 'auth/invalid-password') return resp(400, { erro: 'Senha inválida (mínimo 6 caracteres).' });
    return resp(500, { erro: 'Não foi possível criar o login: ' + e.message });
  }

  try {
    const slug = await slugLivre(db, gerarSlug(nome));
    await db.collection('barbearias').doc(usuario.uid).set({
      nome,
      logo,
      slug,
      vencimento: dataMais(dias),
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    const host = event.headers['x-forwarded-host'] || event.headers.host;
    return resp(200, {
      ok: true,
      id: usuario.uid,
      slug,
      vencimento: dataMais(dias),
      link: `https://${host}/agenda.html?b=${slug}`,
    });
  } catch (e) {
    // Desfaz o login para não ficar um usuário sem barbearia
    await admin.auth().deleteUser(usuario.uid).catch(() => {});
    return resp(500, { erro: 'Não foi possível gravar a barbearia: ' + e.message });
  }
}

async function atualizar(db, b) {
  const id = String(b.id || '');
  if (!id) return resp(400, { erro: 'Barbearia não informada.' });
  const ref = db.collection('barbearias').doc(id);
  if (!(await ref.get()).exists) return resp(404, { erro: 'Barbearia não encontrada.' });

  const campos = {};
  if (b.nome !== undefined) {
    const nome = String(b.nome).trim();
    if (!nome || nome.length > 80) return resp(400, { erro: 'Nome inválido.' });
    campos.nome = nome;
  }
  if (b.logo !== undefined) {
    const logo = String(b.logo).trim();
    if (!logoOk(logo)) return resp(400, { erro: 'O logo precisa começar com https://' });
    campos.logo = logo;
  }
  if (b.vencimento !== undefined) {
    const v = String(b.vencimento);
    if (!reData.test(v)) return resp(400, { erro: 'Vencimento inválido (use AAAA-MM-DD).' });
    campos.vencimento = v;
  }
  if (Object.keys(campos).length) await ref.update(campos);

  if (b.senha) {
    if (String(b.senha).length < 6) return resp(400, { erro: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    await admin.auth().updateUser(id, { password: String(b.senha) });
  }
  return resp(200, { ok: true });
}

exports.handler = async (event) => {
  try {
    iniciar();
    if (!(await verificarAdmin(event))) return resp(403, { erro: 'Acesso negado.' });
    const db = admin.firestore();

    if (event.httpMethod === 'GET') return await listar(db);
    if (event.httpMethod !== 'POST') return resp(405, { erro: 'Método não permitido.' });

    let b = {};
    try {
      b = JSON.parse(event.body || '{}');
    } catch (e) {
      return resp(400, { erro: 'Requisição inválida.' });
    }
    if (b.acao === 'cadastrar') return await cadastrar(db, event, b);
    if (b.acao === 'atualizar') return await atualizar(db, b);
    return resp(400, { erro: 'Ação desconhecida.' });
  } catch (e) {
    console.error(e);
    return resp(500, { erro: 'Erro interno.' });
  }
};
