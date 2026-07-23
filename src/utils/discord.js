const { run, get } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// Registra um envio no histórico (não quebra o fluxo em caso de erro)
async function registrarEnvio(empresaId, evento, titulo, ok, erro) {
  try {
    await garantirTabela();
    await run(
      'INSERT INTO discord_envios (id, empresa_id, evento, titulo, ok, erro) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), empresaId, evento || null, (titulo || '').slice(0, 300), ok ? 1 : 0, erro ? String(erro).slice(0, 300) : null]
    );
  } catch (e) { /* histórico é best-effort */ }
}

// Configuração da integração com Discord por empresa
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
    try {
      await run(`CREATE TABLE IF NOT EXISTS discord_envios (
        id TEXT PRIMARY KEY,
        empresa_id TEXT,
        evento TEXT,
        titulo TEXT,
        ok INTEGER DEFAULT 1,
        erro TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    } catch {}
    tabelaPronta = true;
  } catch (e) { console.error('[Discord] tabela', e.message); }
}
garantirTabela();

async function getConfig(empresaId) {
  await garantirTabela();
  return get('SELECT * FROM integracao_discord WHERE empresa_id = $1', [empresaId]);
}

// Mapa evento → coluna de habilitação
const EVENTO_COL = {
  ciencia: 'ev_ciencia',
  pop: 'ev_pop',
  processo: 'ev_processo',
  aniversario: 'ev_aniversario',
  comunicado: 'ev_comunicado',
  manual: null, // "Comunicar à equipe" sempre permitido quando ativo
};

// Envia um embed para o webhook. Não lança erro (falha de Discord nunca
// deve quebrar a operação principal do sistema).
async function postWebhook(url, embed, conteudo) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Kronos',
        content: conteudo || undefined,
        embeds: embed ? [embed] : undefined,
      }),
    });
    return resp.ok;
  } catch (e) {
    console.error('[Discord] envio', e.message);
    return false;
  }
}

/**
 * Notifica um evento no Discord, respeitando a configuração da empresa.
 * @param {string} empresaId
 * @param {string} evento  chave em EVENTO_COL
 * @param {object} embed   { title, description, color, fields, url, footer }
 */
const URL_PADRAO = 'https://kronos.lcvirtualnet.com.br';

async function notificar(empresaId, evento, embed) {
  try {
    const cfg = await getConfig(empresaId);
    if (!cfg || !cfg.ativo || !cfg.webhook_url) return false;
    const col = EVENTO_COL[evento];
    if (col && !cfg[col]) return false; // evento desativado

    // Link clicável: se o embed tiver linkPath, monta a URL do sistema e a
    // aplica no título (embed.url) + um campo "Abrir no Kronos".
    if (embed && embed.linkPath) {
      const base = (cfg.sistema_url || URL_PADRAO).replace(/\/+$/, '');
      const url = base + embed.linkPath;
      embed.url = url;
      embed.fields = [...(embed.fields || []), { name: '🔗 Link', value: `[Abrir no Kronos](${url})` }];
      delete embed.linkPath;
    }
    const tituloLimpo = (embed?.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const ok = await postWebhook(cfg.webhook_url, embed);
    registrarEnvio(empresaId, evento, tituloLimpo, ok, ok ? null : 'Falha no envio');
    return ok;
  } catch (e) {
    console.error('[Discord] notificar', e.message);
    return false;
  }
}

const COR = {
  roxo: 0x7B55F1,
  verde: 0x10b981,
  azul: 0x0ea5e9,
  laranja: 0xf59e0b,
  vermelho: 0xef4444,
};

module.exports = { getConfig, notificar, postWebhook, garantirTabela, registrarEnvio, COR, EVENTO_COL };
