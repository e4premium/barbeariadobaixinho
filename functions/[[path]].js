// Ponto de entrada do Cloudflare Pages Functions.
// Atende os mesmos endereços de antes (/.netlify/functions/NOME), então
// index.html, agenda.html e admin.html continuam funcionando sem mudança.
import { HANDLERS } from '../server/handlers.js';
import { resp } from '../server/firebase.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const nome = url.pathname.replace(/\/+$/, '').split('/').pop();

  const cors = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const handler = HANDLERS[nome];
  if (!handler) return resp(404, { error: 'Não encontrado' }, cors);
  try {
    return await handler(request, env, url, cors);
  } catch (e) {
    console.error('Erro em ' + nome + ':', e);
    return resp(500, { error: 'Erro interno' }, cors);
  }
}
