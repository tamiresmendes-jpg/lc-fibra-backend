const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Garante que fluxos e checklists tenham vínculo com categoria (idempotente)
;(async () => {
  try {
    await run(`ALTER TABLE fluxos ADD COLUMN IF NOT EXISTS categoria_id TEXT`);
    await run(`ALTER TABLE checklists ADD COLUMN IF NOT EXISTS categoria_id TEXT`);
  } catch (_) {}
})();

// Tipos de documento que ficam dentro das pastas (categorias)
const DOCS = [
  { tipo: 'pop',       tabela: 'pops',       titulo: 'titulo', soft: true },
  { tipo: 'processo',  tabela: 'processos',  titulo: 'titulo', soft: true },
  { tipo: 'fluxo',     tabela: 'fluxos',     titulo: 'titulo' },
  { tipo: 'checklist', tabela: 'checklists', titulo: 'titulo' },
];

// Lista plana com total_pops — usada no modal de seleção (mantida p/ compatibilidade)
router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT c.*, COUNT(p.id) as total_pops
      FROM categorias_pop c
      LEFT JOIN pops p ON p.categoria_id = c.id
      WHERE c.empresa_id = ?
      GROUP BY c.id ORDER BY c.nome
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Contagem de documentos por categoria (para todos os tipos)
async function contagensPorCategoria(empresaId) {
  const mapa = {}; // categoria_id -> total de docs
  for (const d of DOCS) {
    try {
      const rows = await all(
        `SELECT categoria_id, COUNT(*) AS n FROM ${d.tabela} WHERE empresa_id = ? AND categoria_id IS NOT NULL${d.soft ? ' AND excluido_em IS NULL' : ''} GROUP BY categoria_id`,
        [empresaId]
      );
      for (const r of rows) mapa[r.categoria_id] = (mapa[r.categoria_id] || 0) + Number(r.n);
    } catch (_) { /* tabela/coluna ausente → ignora */ }
  }
  return mapa;
}

// Árvore recursiva (N níveis) — usada no explorador de pastas
router.get('/arvore', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const todas = await all('SELECT * FROM categorias_pop WHERE empresa_id = ? ORDER BY nome', [eid]);
    const contagens = await contagensPorCategoria(eid);

    const porPai = {};
    for (const c of todas) {
      const k = c.parent_id || '__root__';
      (porPai[k] = porPai[k] || []).push(c);
    }
    function montar(paiId) {
      const filhos = porPai[paiId || '__root__'] || [];
      return filhos.map(c => {
        const sub = montar(c.id);
        const docsDescendentes = sub.reduce((a, s) => a + (s.total_docs_total || 0), 0);
        const proprios = contagens[c.id] || 0;
        return {
          ...c,
          total_docs: proprios,                       // docs diretamente nesta pasta
          total_docs_total: proprios + docsDescendentes, // inclui subpastas
          filhos: sub,
        };
      });
    }
    res.json(montar(null));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Conteúdo direto de uma pasta: documentos de todos os tipos
router.get('/:id/conteudo', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const cid = req.params.id;
    const out = { pops: [], processos: [], fluxos: [], checklists: [] };
    const keys = { pop: 'pops', processo: 'processos', fluxo: 'fluxos', checklist: 'checklists' };
    for (const d of DOCS) {
      try {
        const filtroExcluido = d.soft ? ' AND excluido_em IS NULL' : '';
        const rows = await all(
          `SELECT id, ${d.titulo} AS titulo FROM ${d.tabela} WHERE empresa_id = ? AND categoria_id = ?${filtroExcluido} ORDER BY ${d.titulo}`,
          [eid, cid]
        );
        out[keys[d.tipo]] = rows.map(r => ({ ...r, tipo: d.tipo }));
      } catch (_) { /* ignora tabela/coluna ausente */ }
    }
    res.json(out);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Move um documento para outra pasta (ou remove da pasta com categoria_id null)
router.post('/mover-doc', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { tipo, doc_id, categoria_id } = req.body;
    const def = DOCS.find(d => d.tipo === tipo);
    if (!def || !doc_id) return res.status(400).json({ erro: 'Dados inválidos' });
    // valida categoria destino (se informada)
    if (categoria_id) {
      const cat = await get('SELECT id FROM categorias_pop WHERE id=? AND empresa_id=?', [categoria_id, req.usuario.empresa_id]);
      if (!cat) return res.status(404).json({ erro: 'Categoria destino não encontrada' });
    }
    await run(`UPDATE ${def.tabela} SET categoria_id=? WHERE id=? AND empresa_id=?`, [categoria_id || null, doc_id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, cor, parent_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO categorias_pop (id, empresa_id, nome, descricao, cor, parent_id) VALUES (?, ?, ?, ?, ?, ?)', [
      id, req.usuario.empresa_id, nome, descricao || null, cor || '#7B55F1', parent_id || null
    ]);
    res.status(201).json({ id, nome });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, cor, parent_id } = req.body;
    // impede que uma pasta vire filha de si mesma
    if (parent_id && parent_id === req.params.id) return res.status(400).json({ erro: 'Uma pasta não pode ser subpasta de si mesma' });
    await run('UPDATE categorias_pop SET nome=?, descricao=?, cor=?, parent_id=? WHERE id=? AND empresa_id=?', [
      nome, descricao || null, cor || '#7B55F1', parent_id || null, req.params.id, req.usuario.empresa_id
    ]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const eid = req.usuario.empresa_id;
    const item = await get('SELECT id FROM categorias_pop WHERE id=? AND empresa_id=?', [req.params.id, eid]);
    if (!item) return res.status(404).json({ erro: 'Não encontrada' });

    // Coleta a pasta + todas as subpastas (recursivo)
    const todas = await all('SELECT id, parent_id FROM categorias_pop WHERE empresa_id = ?', [eid]);
    const paraExcluir = [];
    (function coletar(pid) {
      paraExcluir.push(pid);
      todas.filter(c => c.parent_id === pid).forEach(f => coletar(f.id));
    })(req.params.id);

    // Desvincula documentos de todos os tipos e remove as pastas
    for (const cid of paraExcluir) {
      for (const d of DOCS) {
        try { await run(`UPDATE ${d.tabela} SET categoria_id=NULL WHERE categoria_id=? AND empresa_id=?`, [cid, eid]); } catch (_) {}
      }
    }
    for (const cid of paraExcluir) {
      await run('DELETE FROM categorias_pop WHERE id=? AND empresa_id=?', [cid, eid]);
    }
    res.json({ mensagem: 'Removido' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
