const { run, get } = require('../config/database');

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
async function notificar(empresaId, evento, embed) {
  try {
    const cfg = await getConfig(empresaId);
    if (!cfg || !cfg.ativo || !cfg.webhook_url) return false;
    const col = EVENTO_COL[evento];
    if (col && !cfg[col]) return false; // evento desativado
    return postWebhook(cfg.webhook_url, embed);
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

module.exports = { getConfig, notificar, postWebhook, garantirTabela, COR, EVENTO_COL };
