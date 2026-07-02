const express = require('express');
const router = express.Router();
const { run, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// GET /api/ceps — retorna os CEPs da empresa do usuário
router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT cep, log, tipo, bairro, cidade FROM ceps WHERE empresa_id = ? ORDER BY cidade, bairro, log', [req.usuario.empresa_id]);
    res.json(rows);
  } catch (err) {
    console.error('[ceps GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar CEPs' });
  }
});

// POST /api/ceps/importar — importa lista de CEPs (substitui por cidade)
router.post('/importar', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { ceps, cidade } = req.body;
    if (!Array.isArray(ceps) || ceps.length === 0) {
      return res.status(400).json({ erro: 'Lista de CEPs vazia' });
    }

    const cidadeNorm = (cidade || 'Mãe do Rio').trim();
    const eid = req.usuario.empresa_id;

    // Remove CEPs anteriores da cidade (apenas da empresa do usuário)
    await run('DELETE FROM ceps WHERE cidade = ? AND empresa_id = ?', [cidadeNorm, eid]);

    // Insere novos
    let inseridos = 0;
    for (const item of ceps) {
      const cep   = (item.cep   || '').toString().trim().replace(/[^\d-]/g, '');
      const log   = (item.log   || '').trim();
      const tipo  = (item.tipo  || '').trim();
      const bairro = (item.bairro || '').trim();
      if (!cep || !log) continue;
      await run(
        'INSERT INTO ceps (cep, log, tipo, bairro, cidade, empresa_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (cep, bairro, log) DO UPDATE SET tipo=EXCLUDED.tipo, cidade=EXCLUDED.cidade, empresa_id=EXCLUDED.empresa_id',
        [cep, log, tipo, bairro, cidadeNorm, eid]
      );
      inseridos++;
    }

    res.json({ ok: true, inseridos, cidade: cidadeNorm });
  } catch (err) {
    console.error('[ceps importar]', err.message);
    res.status(500).json({ erro: 'Erro ao importar CEPs' });
  }
});

module.exports = router;
