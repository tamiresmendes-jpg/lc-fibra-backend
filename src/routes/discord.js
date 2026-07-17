const express = require('express');
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { getConfig, postWebhook, notificar, COR } = require('../utils/discord');

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
    res.json({
      ativo: !!cfg.ativo,
      webhook_url: cfg.webhook_url || '',
      sistema_url: cfg.sistema_url || '',
      ev_ciencia: cfg.ev_ciencia !== 0,
      ev_pop: cfg.ev_pop !== 0,
      ev_processo: cfg.ev_processo !== 0,
      ev_aniversario: cfg.ev_aniversario !== 0,
      ev_comunicado: cfg.ev_comunicado !== 0,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT — salva configuração
router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { ativo, webhook_url, sistema_url, ev_ciencia, ev_pop, ev_processo, ev_aniversario, ev_comunicado } = req.body;
    const b = v => (v ? 1 : 0);
    await run(
      `INSERT INTO integracao_discord (empresa_id, webhook_url, sistema_url, ativo, ev_ciencia, ev_pop, ev_processo, ev_aniversario, ev_comunicado, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         webhook_url = EXCLUDED.webhook_url, sistema_url = EXCLUDED.sistema_url, ativo = EXCLUDED.ativo,
         ev_ciencia = EXCLUDED.ev_ciencia, ev_pop = EXCLUDED.ev_pop,
         ev_processo = EXCLUDED.ev_processo, ev_aniversario = EXCLUDED.ev_aniversario,
         ev_comunicado = EXCLUDED.ev_comunicado, atualizado_em = NOW()`,
      [req.usuario.empresa_id, (webhook_url || '').trim() || null, (sistema_url || '').trim() || null, b(ativo),
       b(ev_ciencia), b(ev_pop), b(ev_processo), b(ev_aniversario), b(ev_comunicado)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST — envia mensagem de teste
router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const cfg = await getConfig(req.usuario.empresa_id);
    const url = (req.body.webhook_url || cfg?.webhook_url || '').trim();
    if (!url) return res.status(400).json({ erro: 'Informe a URL do webhook' });
    const ok = await postWebhook(url, {
      title: '✅ Integração Kronos × Discord',
      description: 'Tudo certo! Este canal vai receber os avisos do Kronos.',
      color: COR.roxo,
      footer: { text: 'Kronos — Sistema de Gestão' },
    });
    if (!ok) return res.status(502).json({ erro: 'Não foi possível enviar. Verifique a URL do webhook.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST — "Comunicar à equipe" (aviso manual do que foi alterado)
router.post('/comunicar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { titulo, descricao, categoria, link_path } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Informe o título' });
    const corMap = { atualizacao: COR.roxo, correcao: COR.laranja, novidade: COR.verde, aviso: COR.azul };
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
    });
    if (!ok) return res.status(400).json({ erro: 'Discord não configurado ou desativado. Ative em Configurações.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
