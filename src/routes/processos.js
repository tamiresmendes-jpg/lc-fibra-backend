const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

// Garantir colunas e tabelas (idempotente)
;(async () => {
  try {
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS objetivo TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS resultado_esperado TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS pops_relacionados TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS codigo VARCHAR(20)`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS criado_por_id TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS criado_por_nome TEXT`);
    await run(`
      CREATE TABLE IF NOT EXISTS processo_historico (
        id TEXT PRIMARY KEY,
        processo_id TEXT NOT NULL,
        empresa_id TEXT NOT NULL,
        alterado_por_id TEXT,
        alterado_por_nome TEXT,
        acao TEXT NOT NULL,
        snapshot TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch {}
})();

// Próximo código
async function proximoCodigo(empresa_id) {
  const row = await get(
    `SELECT codigo FROM processos WHERE empresa_id=$1 AND codigo IS NOT NULL AND codigo LIKE 'PROC-%'
     ORDER BY CAST(SUBSTRING(codigo FROM 6) AS INTEGER) DESC LIMIT 1`,
    [empresa_id]
  );
  if (!row) return 'PROC-001';
  const num = parseInt(row.codigo.replace('PROC-', ''), 10) || 0;
  return `PROC-${String(num + 1).padStart(3, '0')}`;
}

// Registrar histórico
async function registrarHistorico(processo_id, empresa_id, usuario, acao, snapshot) {
  try {
    await run(
      `INSERT INTO processo_historico (id,processo_id,empresa_id,alterado_por_id,alterado_por_nome,acao,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), processo_id, empresa_id, usuario.id, usuario.nome, acao, snapshot ? JSON.stringify(snapshot) : null]
    );
  } catch {}
}

// ── Rotas ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM processos WHERE empresa_id=$1 AND excluido_em IS NULL ORDER BY codigo ASC, created_at DESC',
      [eid(req)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/:id/historico', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM processo_historico WHERE processo_id=$1 AND empresa_id=$2 ORDER BY created_at DESC',
      [req.params.id, eid(req)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id     = uuidv4();
    // código só é gerado quando o processo está ativo
    const codigo = (status === 'ativo') ? await proximoCodigo(eid(req)) : null;
    await run(
      `INSERT INTO processos
         (id,empresa_id,codigo,titulo,objetivo,descricao,setor,responsavel,status,
          resultado_esperado,pops_relacionados,criado_por_id,criado_por_nome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, eid(req), codigo, titulo, objetivo||null, descricao||null, setor||null,
       responsavel||null, status||'rascunho', resultado_esperado||null, pops_relacionados||null,
       req.usuario.id, req.usuario.nome]
    );
    await registrarHistorico(id, eid(req), req.usuario, 'criado', { titulo, codigo, status });
    res.status(201).json({ id, titulo, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados } = req.body;
    const antes = await get('SELECT * FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!antes) return res.status(404).json({ erro: 'Não encontrado' });

    // gera código se está sendo ativado pela primeira vez
    let codigo = antes.codigo;
    if (status === 'ativo' && !codigo) {
      codigo = await proximoCodigo(eid(req));
    }

    await run(
      `UPDATE processos SET titulo=$1,objetivo=$2,descricao=$3,setor=$4,responsavel=$5,status=$6,
       resultado_esperado=$7,pops_relacionados=$8,codigo=$9,updated_at=NOW() WHERE id=$10 AND empresa_id=$11`,
      [titulo, objetivo||null, descricao||null, setor||null, responsavel||null, status||'rascunho',
       resultado_esperado||null, pops_relacionados||null, codigo, req.params.id, eid(req)]
    );
    const mudancas = [];
    if (antes.titulo !== titulo)   mudancas.push(`Título: "${antes.titulo}" → "${titulo}"`);
    if (antes.status !== status)   mudancas.push(`Status: ${antes.status} → ${status}`);
    if (!antes.codigo && codigo)   mudancas.push(`Código gerado: ${codigo}`);
    if (antes.objetivo !== (objetivo||null)) mudancas.push('Objetivo atualizado');
    if (antes.descricao !== (descricao||null)) mudancas.push('Descrição atualizada');
    if (antes.responsavel !== (responsavel||null)) mudancas.push(`Responsável: "${antes.responsavel}" → "${responsavel}"`);
    if (antes.pops_relacionados !== (pops_relacionados||null)) mudancas.push('POPs relacionados atualizados');
    if (antes.resultado_esperado !== (resultado_esperado||null)) mudancas.push('Resultado esperado atualizado');
    if (mudancas.length) await registrarHistorico(req.params.id, eid(req), req.usuario, 'editado', { mudancas, titulo });
    res.json({ ok: true, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await get('SELECT titulo FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!item) return res.status(404).json({ erro: 'Não encontrado' });
    await run(
      'UPDATE processos SET excluido_em=NOW(), excluido_por=$1, excluido_por_nome=$2 WHERE id=$3 AND empresa_id=$4',
      [req.usuario.id, req.usuario.nome, req.params.id, eid(req)]
    );
    await registrarHistorico(req.params.id, eid(req), req.usuario, 'excluido', { titulo: item.titulo });
    res.json({ ok: true, titulo: item.titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
