const express = require('express');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { getConfig, getCanais, postWebhook, notificar, registrarEnvio, COR } = require('../utils/discord');

const router = express.Router();
router.use(autenticar);

function soAdminGestor(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) {
    res.status(403).json({ erro: 'Sem permissão' });
    return false;
  }
  return true;
}

// GET — configuração atual (webhook oculto parcialmente)
router.get('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const cfg = await getConfig(req.usuario.empresa_id) || {};
    const canais = await getCanais(req.usuario.empresa_id);
    let canaisEvento = {};
    try { canaisEvento = cfg.canais_evento ? JSON.parse(cfg.canais_evento) : {}; } catch {}
    res.json({
      ativo: !!cfg.ativo,
      sistema_url: cfg.sistema_url || '',
      ev_ciencia: cfg.ev_ciencia !== 0,
      ev_pop: cfg.ev_pop !== 0,
      ev_processo: cfg.ev_processo !== 0,
      ev_aniversario: cfg.ev_aniversario !== 0,
      ev_comunicado: cfg.ev_comunicado !== 0,
      ev_coffee: cfg.ev_coffee !== 0,
      ev_mural: cfg.ev_mural !== 0,
      canais_evento: canaisEvento,
      canais,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Canais (webhooks) ──────────────────────────────────────────────────────
router.get('/canais', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    res.json(await getCanais(req.usuario.empresa_id));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/canais', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { nome, webhook_url } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome do canal' });
    if (!/^https?:\/\//i.test(webhook_url || '')) return res.status(400).json({ erro: 'URL de webhook inválida' });
    const id = uuidv4();
    await run('INSERT INTO discord_canais (id, empresa_id, nome, webhook_url) VALUES ($1,$2,$3,$4)',
      [id, req.usuario.empresa_id, nome.trim(), webhook_url.trim()]);
    res.status(201).json({ id, nome: nome.trim(), webhook_url: webhook_url.trim() });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/canais/:id', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { nome, webhook_url } = req.body;
    await run('UPDATE discord_canais SET nome=$1, webhook_url=$2 WHERE id=$3 AND empresa_id=$4',
      [(nome || '').trim(), (webhook_url || '').trim(), req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/canais/:id', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await run('DELETE FROM discord_canais WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT — salva configuração
router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { ativo, sistema_url, ev_ciencia, ev_pop, ev_processo, ev_aniversario, ev_comunicado, ev_coffee, ev_mural, canais_evento } = req.body;
    const b = v => (v ? 1 : 0);
    const mapaJson = canais_evento && typeof canais_evento === 'object' ? JSON.stringify(canais_evento) : null;
    await run(
      `INSERT INTO integracao_discord (empresa_id, sistema_url, ativo, ev_ciencia, ev_pop, ev_processo, ev_aniversario, ev_comunicado, ev_coffee, ev_mural, canais_evento, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         sistema_url = EXCLUDED.sistema_url, ativo = EXCLUDED.ativo,
         ev_ciencia = EXCLUDED.ev_ciencia, ev_pop = EXCLUDED.ev_pop,
         ev_processo = EXCLUDED.ev_processo, ev_aniversario = EXCLUDED.ev_aniversario,
         ev_comunicado = EXCLUDED.ev_comunicado, ev_coffee = EXCLUDED.ev_coffee, ev_mural = EXCLUDED.ev_mural,
         canais_evento = EXCLUDED.canais_evento, atualizado_em = NOW()`,
      [req.usuario.empresa_id, (sistema_url || '').trim() || null, b(ativo),
       b(ev_ciencia), b(ev_pop), b(ev_processo), b(ev_aniversario), b(ev_comunicado), b(ev_coffee), b(ev_mural), mapaJson]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST — envia mensagem de teste
router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    let url = (req.body.webhook_url || '').trim();
    let nomeCanal = 'teste';
    if (!url && req.body.canal_id) {
      const canais = await getCanais(req.usuario.empresa_id);
      const c = canais.find(x => x.id === req.body.canal_id);
      if (c) { url = c.webhook_url; nomeCanal = c.nome; }
    }
    if (!url) {
      const canais = await getCanais(req.usuario.empresa_id);
      if (canais[0]) { url = canais[0].webhook_url; nomeCanal = canais[0].nome; }
    }
    if (!url) return res.status(400).json({ erro: 'Cadastre um canal (webhook) primeiro.' });
    const ok = await postWebhook(url, {
      title: '✅ Integração Kronos × Discord',
      description: 'Tudo certo! Este canal vai receber os avisos do Kronos.',
      color: COR.roxo,
      footer: { text: 'Kronos — Sistema de Gestão' },
    });
    registrarEnvio(req.usuario.empresa_id, 'teste', 'Mensagem de teste', ok, ok ? null : 'Falha no envio', nomeCanal);
    if (!ok) return res.status(502).json({ erro: 'Não foi possível enviar. Verifique a URL do webhook.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST — "Comunicar à equipe" (aviso manual do que foi alterado)
router.post('/comunicar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { titulo, descricao, categoria, link_path, canal_id } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Informe o título' });
    const corMap = { atualizacao: COR.roxo, correcao: COR.laranja, novidade: COR.verde, aviso: COR.azul };
    let canalNome;
    if (canal_id) { const c = (await getCanais(req.usuario.empresa_id)).find(x => x.id === canal_id); canalNome = c?.nome; }
    const ok = await notificar(req.usuario.empresa_id, 'manual', {
      title: `📢 ${titulo.trim()}`,
      description: (descricao || '').trim() || undefined,
      color: corMap[categoria] || COR.roxo,
      fields: [
        { name: 'Comunicado por', value: req.usuario.nome || '—', inline: true },
        ...(categoria ? [{ name: 'Tipo', value: categoria, inline: true }] : []),
      ],
      linkPath: (link_path && /^\/[\w\-/]*$/.test(link_path)) ? link_path : undefined,
      footer: { text: 'Kronos — Comunicado da equipe' },
      timestamp: new Date().toISOString(),
    }, { canalId: canal_id, canalNome });
    if (!ok) return res.status(400).json({ erro: 'Discord não configurado ou desativado. Ative em Configurações.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// GET — histórico dos avisos enviados ao Discord
router.get('/historico', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const limite = Math.min(parseInt(req.query.limit) || 100, 300);
    const rows = await all(
      `SELECT id, evento, titulo, canal, ok, erro, created_at
       FROM discord_envios WHERE empresa_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.usuario.empresa_id, limite]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
