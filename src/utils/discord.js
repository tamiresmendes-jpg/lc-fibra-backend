const { run, get, all } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const URL_PADRAO = 'https://kronos.lcvirtualnet.com.br';

const COR = {
  roxo: 0x7B55F1,
  verde: 0x10b981,
  azul: 0x0ea5e9,
  laranja: 0xf59e0b,
  vermelho: 0xef4444,
};

// Eventos que podem ser direcionados a um canal
const EVENTOS = ['ciencia', 'pop', 'processo', 'aniversario', 'comunicado', 'coffee', 'mural', 'cultura'];
// Mapa evento → coluna de habilitação (liga/desliga)
const EVENTO_COL = {
  ciencia: 'ev_ciencia', pop: 'ev_pop', processo: 'ev_processo',
  aniversario: 'ev_aniversario', comunicado: 'ev_comunicado', manual: 'ev_comunicado',
  coffee: 'ev_coffee', mural: 'ev_mural', cultura: 'ev_cultura',
};

// ── Migração / criação de tabelas ─────────────────────────────────────────
let tabelaPronta = false;
async function garantirTabela() {
  if (tabelaPronta) return;
  try {
    await run(`CREATE TABLE IF NOT EXISTS integracao_discord (
      empresa_id TEXT PRIMARY KEY,
      webhook_url TEXT,
      ativo INTEGER DEFAULT 0,
      ev_ciencia INTEGER DEFAULT 1,
      ev_pop INTEGER DEFAULT 1,
      ev_processo INTEGER DEFAULT 1,
      ev_aniversario INTEGER DEFAULT 1,
      ev_comunicado INTEGER DEFAULT 1,
      atualizado_em TIMESTAMP DEFAULT NOW()
    )`);
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ultimo_aniv_env TEXT'); } catch {}
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS sistema_url TEXT'); } catch {}
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS canais_evento TEXT'); } catch {}
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ev_coffee INTEGER DEFAULT 1'); } catch {}
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ev_mural INTEGER DEFAULT 1'); } catch {}
    try { await run('ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ev_cultura INTEGER DEFAULT 1'); } catch {}
    try {
      await run(`CREATE TABLE IF NOT EXISTS discord_canais (
        id TEXT PRIMARY KEY,
        empresa_id TEXT,
        nome TEXT,
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    } catch {}
    try {
      await run(`CREATE TABLE IF NOT EXISTS discord_envios (
        id TEXT PRIMARY KEY,
        empresa_id TEXT,
        evento TEXT,
        titulo TEXT,
        canal TEXT,
        ok INTEGER DEFAULT 1,
        erro TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    } catch {}
    try { await run('ALTER TABLE discord_envios ADD COLUMN IF NOT EXISTS canal TEXT'); } catch {}
    tabelaPronta = true;
  } catch (e) { console.error('[Discord] tabela', e.message); }
}
garantirTabela();

// Cria o canal "Principal" a partir do webhook antigo, se ainda não houver canais
async function migrarCanalPrincipal(empresaId, cfg) {
  try {
    const existe = await get('SELECT id FROM discord_canais WHERE empresa_id = $1 LIMIT 1', [empresaId]);
    if (existe) return;
    if (cfg && cfg.webhook_url) {
      const id = uuidv4();
      await run('INSERT INTO discord_canais (id, empresa_id, nome, webhook_url) VALUES ($1,$2,$3,$4)',
        [id, empresaId, 'Principal', cfg.webhook_url]);
      // aponta todos os eventos para esse canal
      const mapa = {}; EVENTOS.forEach(ev => { mapa[ev] = id; });
      await run('UPDATE integracao_discord SET canais_evento = $1 WHERE empresa_id = $2', [JSON.stringify(mapa), empresaId]);
    }
  } catch (e) { /* best-effort */ }
}

async function getConfig(empresaId) {
  await garantirTabela();
  const cfg = await get('SELECT * FROM integracao_discord WHERE empresa_id = $1', [empresaId]);
  if (cfg) await migrarCanalPrincipal(empresaId, cfg);
  return cfg;
}

async function getCanais(empresaId) {
  await garantirTabela();
  return all('SELECT id, nome, webhook_url FROM discord_canais WHERE empresa_id = $1 ORDER BY created_at ASC', [empresaId]);
}

// Resolve o webhook do canal para um evento (ou canal específico)
async function resolverWebhook(empresaId, cfg, evento, canalId) {
  const canais = await getCanais(empresaId);
  if (!canais.length) return cfg?.webhook_url || null;
  let alvo = null;
  if (canalId) alvo = canais.find(c => c.id === canalId);
  if (!alvo) {
    let mapa = {};
    try { mapa = cfg?.canais_evento ? JSON.parse(cfg.canais_evento) : {}; } catch {}
    const ev = evento === 'manual' ? 'comunicado' : evento;
    const id = mapa[ev];
    alvo = canais.find(c => c.id === id);
  }
  if (!alvo) alvo = canais[0]; // fallback: primeiro canal
  return alvo?.webhook_url || cfg?.webhook_url || null;
}

async function registrarEnvio(empresaId, evento, titulo, ok, erro, canal) {
  try {
    await garantirTabela();
    await run(
      'INSERT INTO discord_envios (id, empresa_id, evento, titulo, canal, ok, erro) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv4(), empresaId, evento || null, (titulo || '').slice(0, 300), canal || null, ok ? 1 : 0, erro ? String(erro).slice(0, 300) : null]
    );
  } catch (e) { /* histórico best-effort */ }
}

// Envia um embed para o webhook. Nunca lança erro.
async function postWebhook(url, embed, conteudo) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Kronos', content: conteudo || undefined, embeds: embed ? [embed] : undefined }),
    });
    return resp.ok;
  } catch (e) {
    console.error('[Discord] envio', e.message);
    return false;
  }
}

/**
 * Notifica um evento no Discord, respeitando a config da empresa e o canal.
 * @param {object} opts { canalId, canalNome }
 */
async function notificar(empresaId, evento, embed, opts = {}) {
  try {
    const cfg = await getConfig(empresaId);
    if (!cfg || !cfg.ativo) return false;
    const col = EVENTO_COL[evento];
    if (col && !cfg[col]) return false; // evento desativado

    const url = await resolverWebhook(empresaId, cfg, evento, opts.canalId);
    if (!url) return false;

    const base = (cfg.sistema_url || URL_PADRAO).replace(/\/+$/, '');
    if (embed && embed.linkPath) {
      const link = base + embed.linkPath;
      embed.url = link;
      embed.fields = [...(embed.fields || []), { name: '🔗 Link', value: `[Abrir no Kronos](${link})` }];
      delete embed.linkPath;
    }
    // Imagem: aceita URL absoluta, data: (ignorada) ou caminho /uploads (vira absoluta)
    if (embed && embed.imagem) {
      let img = embed.imagem;
      if (/^\//.test(img)) img = base + img;
      if (/^https?:\/\//i.test(img)) embed.image = { url: img };
      delete embed.imagem;
    }
    const tituloLimpo = (embed?.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const ok = await postWebhook(url, embed);
    registrarEnvio(empresaId, evento, tituloLimpo, ok, ok ? null : 'Falha no envio', opts.canalNome);
    return ok;
  } catch (e) {
    console.error('[Discord] notificar', e.message);
    return false;
  }
}

module.exports = { getConfig, getCanais, resolverWebhook, notificar, postWebhook, garantirTabela, registrarEnvio, COR, EVENTO_COL, EVENTOS };
