const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const SELECT_TREINAMENTO = `
  SELECT t.*,
    d.nome AS departamento_nome,
    r.nome AS responsavel_nome,
    c.nome AS colaborador_nome,
    (SELECT COUNT(*) FROM treinamento_pops tp WHERE tp.treinamento_id = t.id) AS total_pops,
    (SELECT COUNT(*) FROM treinamento_pops tp WHERE tp.treinamento_id = t.id AND tp.concluido = 1) AS pops_concluidos,
    (SELECT COALESCE(SUM(tp.tempo_estimado),0) FROM treinamento_pops tp WHERE tp.treinamento_id = t.id) AS tempo_total_estimado,
    (SELECT COALESCE(SUM(tp.tempo_realizado),0) FROM treinamento_pops tp WHERE tp.treinamento_id = t.id) AS tempo_total_realizado,
    (SELECT COUNT(*) FROM treinamento_pops tp
      JOIN pops p ON p.id = tp.pop_id
      WHERE tp.treinamento_id = t.id AND tp.versao_pop IS NOT NULL AND tp.versao_pop != p.versao
    ) AS alertas_reciclagem
  FROM treinamentos t
  LEFT JOIN departamentos d ON d.id = t.departamento_id
  LEFT JOIN usuarios r ON r.id = t.responsavel_id
  LEFT JOIN usuarios c ON c.id = t.colaborador_id
`;

async function trDaEmpresa(id, eid) {
  return await get('SELECT id FROM treinamentos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [id, eid]);
}

router.get('/', async (req, res) => {
  try {
    const itens = await all(`${SELECT_TREINAMENTO} WHERE t.empresa_id = $1 AND t.excluido_em IS NULL ORDER BY t.created_at DESC`, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meus', async (req, res) => {
  try {
    const isAdmin = req.usuario.perfil === 'admin';
    const itens = await all(`${SELECT_TREINAMENTO}
      WHERE t.empresa_id = $1 AND t.excluido_em IS NULL AND ($2 = 1 OR t.colaborador_id = $3 OR t.responsavel_id = $4)
      ORDER BY t.data_hora ASC
    `, [req.usuario.empresa_id, isAdmin ? 1 : 0, req.usuario.id, req.usuario.id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/alertas-reciclagem', async (req, res) => {
  try {
    const alertas = await all(`
      SELECT t.id, t.titulo, t.colaborador_id, c.nome AS colaborador_nome,
             p.id AS pop_id, p.titulo AS pop_titulo, p.versao AS versao_atual, tp.versao_pop AS versao_treinada
      FROM treinamento_pops tp
      JOIN treinamentos t ON t.id = tp.treinamento_id
      JOIN pops p ON p.id = tp.pop_id
      LEFT JOIN usuarios c ON c.id = t.colaborador_id
      WHERE t.empresa_id = $1 AND tp.versao_pop IS NOT NULL AND tp.versao_pop != p.versao
      ORDER BY t.created_at DESC
    `, [req.usuario.empresa_id]);
    res.json(alertas);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, pop_ids } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO treinamentos
      (id, empresa_id, titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, status_agenda)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'agendado')
    `, [id, req.usuario.empresa_id, titulo, tipo_trilha || 'onboarding', departamento_id || null, responsavel_id || null, colaborador_id || null, data_hora || null, observacoes || null]);

    if (Array.isArray(pop_ids) && pop_ids.length) {
      for (const [i, item] of pop_ids.entries()) {
        const pid = typeof item === 'object' ? item.pop_id : item;
        const instrutor = typeof item === 'object' ? item.instrutor_id : null;
        const tempo = typeof item === 'object' ? (item.tempo_estimado || 0) : 0;
        const topicos = typeof item === 'object' ? item.topicos : null;
        const dataPrev = typeof item === 'object' ? item.data_prevista : null;
        await run(`INSERT INTO treinamento_pops
          (id, treinamento_id, pop_id, ordem, instrutor_id, tempo_estimado, topicos, versao_pop, data_prevista)
          VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT versao FROM pops WHERE id = $8),$9)
          ON CONFLICT DO NOTHING
        `, [uuidv4(), id, pid, i, instrutor || null, tempo, topicos || null, pid, dataPrev || null]);
      }
    }
    res.status(201).json({ id, titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const t = await get(`${SELECT_TREINAMENTO} WHERE t.id = $1 AND t.empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!t) return res.status(404).json({ erro: 'Não encontrado' });

    const pops = await all(`
      SELECT tp.*, p.titulo, p.codigo, p.versao AS versao_atual,
             u.nome AS instrutor_nome,
             CASE WHEN tp.versao_pop IS NOT NULL AND tp.versao_pop != p.versao THEN 1 ELSE 0 END AS precisa_reciclagem
      FROM treinamento_pops tp
      JOIN pops p ON p.id = tp.pop_id
      LEFT JOIN usuarios u ON u.id = tp.instrutor_id
      WHERE tp.treinamento_id = $1
      ORDER BY tp.ordem ASC
    `, [req.params.id]);

    const avaliacoes = await all('SELECT * FROM treinamento_avaliacoes WHERE treinamento_id = $1 ORDER BY ordem ASC', [req.params.id]);
    const anotacoes = await all(`
      SELECT ta.*, u.nome AS autor_nome
      FROM treinamento_anotacoes ta
      LEFT JOIN usuarios u ON u.id = ta.usuario_id
      WHERE ta.treinamento_id = $1 ORDER BY ta.created_at DESC
    `, [req.params.id]);

    res.json({ ...t, pops, avaliacoes, anotacoes });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, status_agenda, pop_ids } = req.body;
    await run(`UPDATE treinamentos SET
      titulo=$1, tipo_trilha=$2, departamento_id=$3, responsavel_id=$4, colaborador_id=$5, data_hora=$6, observacoes=$7, status_agenda=$8
      WHERE id=$9 AND empresa_id=$10
    `, [titulo, tipo_trilha || 'onboarding', departamento_id || null, responsavel_id || null, colaborador_id || null, data_hora || null, observacoes || null, status_agenda || 'agendado', req.params.id, req.usuario.empresa_id]);

    if (Array.isArray(pop_ids)) {
      await run('DELETE FROM treinamento_pops WHERE treinamento_id=$1', [req.params.id]);
      for (const [i, item] of pop_ids.entries()) {
        const pid = typeof item === 'object' ? item.pop_id : item;
        const instrutor = typeof item === 'object' ? item.instrutor_id : null;
        const tempo = typeof item === 'object' ? (item.tempo_estimado || 0) : 0;
        const topicos = typeof item === 'object' ? item.topicos : null;
        const dataPrev = typeof item === 'object' ? item.data_prevista : null;
        await run(`INSERT INTO treinamento_pops
          (id, treinamento_id, pop_id, ordem, instrutor_id, tempo_estimado, topicos, versao_pop, data_prevista)
          VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT versao FROM pops WHERE id = $8),$9)
          ON CONFLICT DO NOTHING
        `, [uuidv4(), req.params.id, pid, i, instrutor || null, tempo, topicos || null, pid, dataPrev || null]);
      }
    }
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Atualiza campos de um POP específico na trilha
router.put('/:id/pops/:pop_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { instrutor_id, tempo_estimado, tempo_realizado, topicos, data_prevista, status_pop } = req.body;
    await run(`UPDATE treinamento_pops SET
      instrutor_id=$1, tempo_estimado=$2, tempo_realizado=$3, topicos=$4, data_prevista=$5, status_pop=$6
      WHERE treinamento_id=$7 AND pop_id=$8
    `, [instrutor_id || null, tempo_estimado || 0, tempo_realizado || 0, topicos || null, data_prevista || null, status_pop || 'pendente', req.params.id, req.params.pop_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Reordenar POPs da trilha
router.put('/:id/pops/reordenar', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { ordem } = req.body; // array de pop_ids na nova ordem
    if (!Array.isArray(ordem)) return res.status(400).json({ erro: 'ordem deve ser array' });
    for (const [i, pop_id] of ordem.entries()) {
      await run('UPDATE treinamento_pops SET ordem=$1 WHERE treinamento_id=$2 AND pop_id=$3', [i, req.params.id, pop_id]);
    }
    res.json({ mensagem: 'Reordenado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Toggle conclusão de um POP
router.put('/:id/pops/:pop_id/concluir', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const tp = await get('SELECT * FROM treinamento_pops WHERE treinamento_id=$1 AND pop_id=$2', [req.params.id, req.params.pop_id]);
    if (!tp) return res.status(404).json({ erro: 'Não encontrado' });
    const novoConcluido = tp.concluido ? 0 : 1;
    const novoStatus = novoConcluido ? 'concluido' : 'pendente';
    await run('UPDATE treinamento_pops SET concluido=$1, status_pop=$2 WHERE treinamento_id=$3 AND pop_id=$4', [novoConcluido, novoStatus, req.params.id, req.params.pop_id]);
    res.json({ concluido: !!novoConcluido });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── AVALIAÇÕES ────────────────────────────────────────────────────────────────

router.post('/:id/avaliacoes', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { titulo, tipo, perguntas, pop_id, obrigatorio, ordem } = req.body;
    if (!titulo || !tipo || !perguntas) return res.status(400).json({ erro: 'Título, tipo e perguntas obrigatórios' });
    const id = uuidv4();
    await run(`INSERT INTO treinamento_avaliacoes (id, treinamento_id, pop_id, titulo, tipo, perguntas, obrigatorio, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [id, req.params.id, pop_id || null, titulo, tipo, JSON.stringify(perguntas), obrigatorio !== false ? 1 : 0, ordem || 0]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id/avaliacoes/:av_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { titulo, tipo, perguntas, obrigatorio, ordem } = req.body;
    await run('UPDATE treinamento_avaliacoes SET titulo=$1, tipo=$2, perguntas=$3, obrigatorio=$4, ordem=$5 WHERE id=$6 AND treinamento_id=$7',
      [titulo, tipo, JSON.stringify(perguntas), obrigatorio !== false ? 1 : 0, ordem || 0, req.params.av_id, req.params.id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id/avaliacoes/:av_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    await run('DELETE FROM treinamento_respostas WHERE avaliacao_id=$1', [req.params.av_id]);
    await run('DELETE FROM treinamento_avaliacoes WHERE id=$1 AND treinamento_id=$2', [req.params.av_id, req.params.id]);
    res.json({ mensagem: 'Removido' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/:id/avaliacoes/:av_id/responder', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { respostas } = req.body;
    const av = await get('SELECT * FROM treinamento_avaliacoes WHERE id=$1 AND treinamento_id=$2', [req.params.av_id, req.params.id]);
    if (!av) return res.status(404).json({ erro: 'Avaliação não encontrada' });

    const perguntas = JSON.parse(av.perguntas);
    let nota = null;

    // Calcula nota para múltipla escolha e V/F
    if (av.tipo === 'multipla_escolha' || av.tipo === 'verdadeiro_falso') {
      let acertos = 0;
      perguntas.forEach((p, i) => {
        if (String(respostas[i]) === String(p.resposta_correta)) acertos++;
      });
      nota = perguntas.length > 0 ? Math.round((acertos / perguntas.length) * 10 * 10) / 10 : 0;
    }

    const id = uuidv4();
    await run(`INSERT INTO treinamento_respostas (id, avaliacao_id, treinamento_id, colaborador_id, respostas, nota, concluido)
      VALUES ($1,$2,$3,$4,$5,$6,1) ON CONFLICT(avaliacao_id, colaborador_id)
      DO UPDATE SET respostas=excluded.respostas, nota=excluded.nota, concluido=1
    `, [id, req.params.av_id, req.params.id, req.usuario.id, JSON.stringify(respostas), nota]);

    res.json({ nota, mensagem: 'Avaliação registrada' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ANOTAÇÕES ─────────────────────────────────────────────────────────────────

router.get('/:id/anotacoes', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const lista = await all(`
      SELECT ta.*, u.nome AS autor_nome
      FROM treinamento_anotacoes ta
      LEFT JOIN usuarios u ON u.id = ta.usuario_id
      WHERE ta.treinamento_id = $1 ORDER BY ta.created_at DESC
    `, [req.params.id]);
    res.json(lista);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/:id/anotacoes', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { texto, tipo, pop_id } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO treinamento_anotacoes (id, treinamento_id, pop_id, usuario_id, tipo, texto)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [id, req.params.id, pop_id || null, req.usuario.id, tipo || 'observacao', texto]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id/anotacoes/:an_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const an = await get('SELECT usuario_id FROM treinamento_anotacoes WHERE id=$1 AND treinamento_id=$2', [req.params.an_id, req.params.id]);
    if (!an) return res.status(404).json({ erro: 'Anotação não encontrada' });
    const isAdmin = ['admin','gestor'].includes(req.usuario.perfil);
    if (!isAdmin && an.usuario_id !== req.usuario.id)
      return res.status(403).json({ erro: 'Sem permissão para remover esta anotação' });
    await run('DELETE FROM treinamento_anotacoes WHERE id=$1 AND treinamento_id=$2', [req.params.an_id, req.params.id]);
    res.json({ mensagem: 'Removido' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── DELETE ────────────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const tr = await get('SELECT titulo FROM treinamentos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, req.usuario.empresa_id]);
    if (!tr) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    await run(
      `UPDATE treinamentos SET excluido_em=NOW(), excluido_por=$1, excluido_por_nome=$2 WHERE id=$3 AND empresa_id=$4`,
      [req.usuario.id, req.usuario.nome, req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Removido', titulo: tr.titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
