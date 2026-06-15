const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT c.*, u.nome as publicado_por_nome
      FROM comunicados c LEFT JOIN usuarios u ON u.id = c.publicado_por
      WHERE c.empresa_id = $1 AND c.ativo = 1
      ORDER BY c.created_at DESC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, conteudo, tipo, fixado, categoria, tema, data_inicio, data_fim, responsavel, etapa, vagas_limite } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO comunicados (id, empresa_id, titulo, conteudo, tipo, publicado_por, data_publicacao, fixado, categoria, tema, data_inicio, data_fim, responsavel, etapa, vagas_limite)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [id, req.usuario.empresa_id, titulo, conteudo||null, tipo||'comunicado', req.usuario.id, fixado?1:0, categoria||'geral', tema||'padrao', data_inicio||null, data_fim||null, responsavel||null, etapa||null, vagas_limite||null]);
    res.status(201).json({ id, titulo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, conteudo, tipo, ativo, fixado, categoria, tema, data_inicio, data_fim, responsavel, etapa, vagas_limite } = req.body;
    await run(`UPDATE comunicados SET titulo=$1, conteudo=$2, tipo=$3, ativo=$4, fixado=$5, categoria=$6, tema=$7, data_inicio=$8, data_fim=$9, responsavel=$10, etapa=$11, vagas_limite=$12 WHERE id=$13 AND empresa_id=$14`,
      [titulo, conteudo||null, tipo||'comunicado', ativo !== undefined ? ativo : 1, fixado?1:0, categoria||'geral', tema||'padrao', data_inicio||null, data_fim||null, responsavel||null, etapa||null, vagas_limite||null, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('UPDATE comunicados SET ativo=0 WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
