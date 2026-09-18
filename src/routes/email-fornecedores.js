const express = require('express');
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { testarConexao, sincronizarEmpresa } = require('../utils/emailFornecedoresSync');

const router = express.Router();
router.use(autenticar);

function soAdmin(req, res) {
  if (req.usuario.perfil !== 'admin') { res.status(403).json({ erro: 'Sem permissão' }); return false; }
  return true;
}

router.get('/config', async (req, res) => {
  try {
    if (!soAdmin(req, res)) return;
    const cfg = await get(`
      SELECT *, TO_CHAR(data_inicio_historico, 'YYYY-MM-DD') AS data_inicio_historico_fmt
      FROM integracao_email_fornecedores WHERE empresa_id = $1
    `, [req.usuario.empresa_id]) || {};
    res.json({
      imap_host: cfg.imap_host || 'imap.uhserver.com',
      imap_port: cfg.imap_port || 993,
      email_usuario: cfg.email_usuario || '',
      data_inicio_historico: cfg.data_inicio_historico_fmt || '2026-01-01',
      ativo: !!cfg.ativo,
      tem_senha: !!cfg.email_senha,
      ultima_sync: cfg.ultima_sync || null,
      ultimo_status: cfg.ultimo_status || null,
      ultimo_erro: cfg.ultimo_erro || null,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdmin(req, res)) return;
    const { imap_host, imap_port, email_usuario, email_senha, data_inicio_historico, ativo } = req.body;
    const atual = await get('SELECT email_senha FROM integracao_email_fornecedores WHERE empresa_id = $1', [req.usuario.empresa_id]);
    const senhaFinal = (email_senha && email_senha.trim()) ? email_senha.trim() : (atual?.email_senha || null);
    await run(
      `INSERT INTO integracao_email_fornecedores (empresa_id, imap_host, imap_port, email_usuario, email_senha, data_inicio_historico, ativo, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port, email_usuario=EXCLUDED.email_usuario,
         email_senha=EXCLUDED.email_senha, data_inicio_historico=EXCLUDED.data_inicio_historico, ativo=EXCLUDED.ativo, atualizado_em=NOW()`,
      [
        req.usuario.empresa_id, (imap_host || '').trim() || 'imap.uhserver.com', imap_port || 993,
        (email_usuario || '').trim() || null, senhaFinal, data_inicio_historico || '2026-01-01', ativo ? 1 : 0,
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/testar', async (req, res) => {
  try {
    if (!soAdmin(req, res)) return;
    const atual = await get('SELECT * FROM integracao_email_fornecedores WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    const cfg = {
      imap_host: (req.body.imap_host || atual.imap_host || 'imap.uhserver.com').trim(),
      imap_port: req.body.imap_port || atual.imap_port || 993,
      email_usuario: (req.body.email_usuario || atual.email_usuario || '').trim(),
      email_senha: (req.body.email_senha && req.body.email_senha.trim()) ? req.body.email_senha.trim() : atual.email_senha,
    };
    if (!cfg.email_usuario || !cfg.email_senha) return res.status(400).json({ erro: 'Informe o e-mail e a senha.' });
    const resultado = await testarConexao(cfg);
    res.json(resultado);
  } catch (e) { res.json({ ok: false, erro: 'Falha de conexão: ' + e.message }); }
});

router.post('/sync-agora', async (req, res) => {
  try {
    if (!soAdmin(req, res)) return;
    const resultado = await sincronizarEmpresa(req.usuario.empresa_id);
    res.json(resultado);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
