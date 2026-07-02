const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { gerarPDFProcesso } = require('../utils/gerarPDF');

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
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS setor TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS responsavel TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS categoria_id TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMP`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_por TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_por_nome TEXT`);
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

// Sigla a partir do nome da categoria (mesma lógica dos POPs)
function siglaCategoria(nome) {
  if (!nome) return 'GER';
  const palavras = nome.trim().split(/\s+/).filter(Boolean);
  let sigla;
  if (palavras.length >= 2) sigla = palavras.slice(0, 3).map(p => p[0].toUpperCase()).join('');
  else sigla = nome.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');
  return sigla || 'GER';
}

// Próximo código — por categoria (PROC-FIN-001) ou geral (PROC-GER-001)
async function proximoCodigo(empresa_id, categoria_id) {
  let sigla = 'GER';
  if (categoria_id) {
    const cat = await get('SELECT nome FROM categorias_pop WHERE id=$1 AND empresa_id=$2', [categoria_id, empresa_id]);
    if (cat) sigla = siglaCategoria(cat.nome);
  }
  const prefixo = `PROC-${sigla}-`;
  const existentes = await all(
    'SELECT codigo FROM processos WHERE empresa_id=$1 AND codigo LIKE $2',
    [empresa_id, prefixo + '%']
  );
  let maior = 0;
  for (const row of existentes) {
    const num = parseInt(String(row.codigo).replace(prefixo, ''), 10);
    if (!isNaN(num) && num > maior) maior = num;
  }
  return `${prefixo}${String(maior + 1).padStart(3, '0')}`;
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
      `SELECT p.*, c.nome as categoria_nome, c.cor as categoria_cor
       FROM processos p
       LEFT JOIN categorias_pop c ON c.id = p.categoria_id
       WHERE p.empresa_id=$1 AND p.excluido_em IS NULL
       ORDER BY p.codigo ASC, p.created_at DESC`,
      [eid(req)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Próximo código sugerido conforme categoria (usado pelo editor)
router.get('/proximo-codigo', async (req, res) => {
  try {
    const codigo = await proximoCodigo(eid(req), req.query.categoria_id || null);
    res.json({ codigo });
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

// Busca o processo completo (com categoria e autor) para exportação
async function processoCompleto(id, empresa_id) {
  return get(
    `SELECT p.*, c.nome as categoria_nome, u.nome as criado_por_nome
     FROM processos p
     LEFT JOIN categorias_pop c ON c.id = p.categoria_id
     LEFT JOIN usuarios u ON u.id = p.criado_por_id
     WHERE p.id=$1 AND p.empresa_id=$2 AND p.excluido_em IS NULL`,
    [id, empresa_id]
  );
}

function parseArr(val) { try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; } }

function gerarWordProcesso(proc) {
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const txtHtml = t => t ? esc(t).replace(/\n/g, '<br>') : '<span class="vazio">(não preenchido)</span>';
  const pops = parseArr(proc.pops_relacionados).map(p => typeof p === 'string' ? p : [p.codigo, p.titulo].filter(Boolean).join(' – '));
  const res  = parseArr(proc.resultado_esperado).map(r => typeof r === 'string' ? r : (r.item || ''));
  const listaHtml = (arr) => arr.filter(Boolean).length
    ? `<ul>${arr.filter(Boolean).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '<span class="vazio">(nenhum)</span>';
  const statusLabel = { ativo:'Ativo', rascunho:'Rascunho', revisao:'Em Revisão', inativo:'Inativo' }[proc.status] || proc.status || '';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${esc(proc.codigo||'PROC')} - ${esc(proc.titulo)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;color:#0f172a;margin:2cm;font-size:11pt}
.cabecalho{background:#7B55F1;color:#fff;padding:20px 24px;margin:-2cm -2cm 24px}
.cabecalho h1{margin:0 0 4px;font-size:18pt}.cabecalho .sub{font-size:10pt;opacity:.85}
.secao{margin-bottom:18px}h2{font-size:12pt;border-bottom:2px solid #7B55F1;padding-bottom:4px}
.grade{width:100%;border-collapse:collapse;margin-bottom:18px;background:#f8fafc;border:1px solid #e2e8f0}
.grade td{padding:8px 12px;border-right:1px solid #e2e8f0;font-size:10pt}
.grade .lbl{font-size:7pt;text-transform:uppercase;color:#64748b;display:block}
.vazio{color:#94a3b8;font-style:italic}ul{margin:6px 0;padding-left:20px}li{margin:3px 0}</style></head>
<body><div class="cabecalho"><h1>${esc(proc.titulo)}</h1>
<div class="sub">${esc(proc.codigo||'')} · ${esc(statusLabel)} · LC FIBRA</div></div>
<table class="grade"><tr>
<td><span class="lbl">Responsável</span>${esc(proc.responsavel||'—')}</td>
<td><span class="lbl">Setor</span>${esc(proc.setor||'—')}</td>
<td><span class="lbl">Categoria</span>${esc(proc.categoria_nome||'—')}</td>
</tr></table>
<div class="secao"><h2>Objetivo</h2><div>${txtHtml(proc.objetivo)}</div></div>
<div class="secao"><h2>Descrição do Processo</h2><div>${txtHtml(proc.descricao)}</div></div>
<div class="secao"><h2>POPs Relacionados</h2>${listaHtml(pops)}</div>
<div class="secao"><h2>Resultado Esperado</h2>${listaHtml(res)}</div>
<div style="margin-top:28px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:8pt;color:#64748b;text-align:center">LC FIBRA — ${esc(proc.codigo||'')} — Gerado em ${new Date().toLocaleString('pt-BR')}</div>
</body></html>`;
}

function nomeArquivoProc(proc, ext) {
  const base = `${proc.codigo || 'PROC'}-${String(proc.titulo||'processo').replace(/[^a-zA-Z0-9\s]/g,'').trim().replace(/\s+/g,'_')}`;
  return `${base}.${ext}`;
}

router.get('/:id/exportar/:formato', async (req, res) => {
  try {
    const proc = await processoCompleto(req.params.id, eid(req));
    if (!proc) return res.status(404).json({ erro: 'Processo não encontrado' });
    if (req.params.formato === 'pdf') {
      const pdf = await gerarPDFProcesso(proc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivoProc(proc,'pdf'))}"`);
      return res.send(pdf);
    }
    if (req.params.formato === 'word') {
      const html = gerarWordProcesso(proc);
      res.setHeader('Content-Type', 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivoProc(proc,'doc'))}"`);
      return res.send(html);
    }
    res.status(400).json({ erro: 'Formato inválido' });
  } catch(e) { console.error('[processos exportar]', e.message); res.status(500).json({ erro: 'Erro ao exportar' }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados, categoria_id } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id     = uuidv4();
    // usa o código sugerido pelo editor; se estiver ativo e sem código, gera pela categoria
    let codigo = req.body.codigo || null;
    if (!codigo && status === 'ativo') codigo = await proximoCodigo(eid(req), categoria_id || null);
    await run(
      `INSERT INTO processos
         (id,empresa_id,codigo,titulo,objetivo,descricao,setor,responsavel,status,
          resultado_esperado,pops_relacionados,categoria_id,criado_por_id,criado_por_nome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, eid(req), codigo, titulo, objetivo||null, descricao||null, setor||null,
       responsavel||null, status||'rascunho', resultado_esperado||null, pops_relacionados||null,
       categoria_id||null, req.usuario.id, req.usuario.nome]
    );
    await registrarHistorico(id, eid(req), req.usuario, 'criado', { titulo, codigo, status });
    res.status(201).json({ id, titulo, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão para editar processos' });
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados, categoria_id } = req.body;
    const antes = await get('SELECT * FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!antes) return res.status(404).json({ erro: 'Não encontrado' });

    // código: mantém o existente; usa o sugerido pelo editor; ou gera ao ativar
    let codigo = req.body.codigo || antes.codigo;
    if (status === 'ativo' && !codigo) {
      codigo = await proximoCodigo(eid(req), categoria_id || antes.categoria_id || null);
    }

    await run(
      `UPDATE processos SET titulo=$1,objetivo=$2,descricao=$3,setor=$4,responsavel=$5,status=$6,
       resultado_esperado=$7,pops_relacionados=$8,codigo=$9,categoria_id=$10,updated_at=NOW()
       WHERE id=$11 AND empresa_id=$12`,
      [titulo, objetivo||null, descricao||null, setor||null, responsavel||null, status||'rascunho',
       resultado_esperado||null, pops_relacionados||null, codigo, categoria_id||null, req.params.id, eid(req)]
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
    if (!['admin', 'gestor'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão para excluir processos' });
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
