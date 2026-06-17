const express = require('express');
const router = express.Router();
const { run, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

// GET /api/ceps — retorna todos os CEPs do banco
router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT cep, log, tipo, bairro, cidade FROM ceps ORDER BY cidade, bairro, log');
    res.json(rows);
  } catch (err) {
    console.error('[ceps GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar CEPs' });
  }
});

// POST /api/ceps/importar — importa lista de CEPs (substitui por cidade)
router.post('/importar', autenticar, async (req, res) => {
  try {
    const { ceps, cidade } = req.body;
    if (!Array.isArray(ceps) || ceps.length === 0) {
      return res.status(400).json({ erro: 'Lista de CEPs vazia' });
    }

    const cidadeNorm = (cidade || 'Mãe do Rio').trim();

    // Remove CEPs anteriores da cidade
    await run('DELETE FROM ceps WHERE cidade = ?', [cidadeNorm]);

    // Insere novos
    let inseridos = 0;
    for (const item of ceps) {
      const cep   = (item.cep   || '').toString().trim().replace(/[^\d-]/g, '');
      const log   = (item.log   || '').trim();
      const tipo  = (item.tipo  || '').trim();
      const bairro = (item.bairro || '').trim();
      if (!cep || !log) continue;
      await run(
        'INSERT INTO ceps (cep, log, tipo, bairro, cidade) VALUES (?, ?, ?, ?, ?) ON CONFLICT (cep, bairro, log) DO UPDATE SET tipo=EXCLUDED.tipo, cidade=EXCLUDED.cidade',
        [cep, log, tipo, bairro, cidadeNorm]
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
