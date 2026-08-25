const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', autenticar, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const [acoes, metas, okrs, indicadores] = await Promise.all([
      all(`SELECT status, COUNT(*) AS n FROM acoes WHERE empresa_id=$1 AND excluido_em IS NULL GROUP BY status`, [eid]),
      all(`SELECT status, COUNT(*) AS n FROM metas WHERE empresa_id=$1 GROUP BY status`, [eid]),
      all(`SELECT status, COUNT(*) AS n FROM okrs WHERE empresa_id=$1 GROUP BY status`, [eid]),
      get(`SELECT COUNT(*) AS n FROM indicadores WHERE empresa_id=$1 AND status='ativo'`, [eid]),
    ]);
    res.json({ acoes, metas, okrs, indicadores: indicadores.n });
  } catch { res.status(500).json({ erro: 'Erro ao buscar stats' }); }
});

// ── METAS ────────────────────────────────────────────────────────────────────
router.get('/metas', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT m.*, d.nome AS departamento_nome, u.nome AS responsavel_nome
       FROM metas m
       LEFT JOIN departamentos d ON d.id = m.departamento_id
       LEFT JOIN usuarios u ON u.id = m.responsavel_id
       WHERE m.empresa_id=$1 ORDER BY m.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar metas' }); }
});

router.post('/metas', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, valor_meta, valor_atual, unidade, departamento_id, responsavel_id, data_inicio, data_fim, status } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO metas (id,empresa_id,titulo,descricao,valor_meta,valor_atual,unidade,departamento_id,responsavel_id,data_inicio,data_fim,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, valor_meta || 0, valor_atual || 0, unidade || '%', departamento_id || null, responsavel_id || null, data_inicio || null, data_fim || null, status || 'ativa']
    );
    res.status(201).json(await get(`SELECT * FROM metas WHERE id=$1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar meta' }); }
});

router.put('/metas/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, valor_meta, valor_atual, unidade, departamento_id, responsavel_id, data_inicio, data_fim, status } = req.body;
    await run(
      `UPDATE metas SET titulo=$1,descricao=$2,valor_meta=$3,valor_atual=$4,unidade=$5,departamento_id=$6,responsavel_id=$7,data_inicio=$8,data_fim=$9,status=$10 WHERE id=$11 AND empresa_id=$12`,
      [titulo, descricao || null, valor_meta || 0, valor_atual || 0, unidade || '%', departamento_id || null, responsavel_id || null, data_inicio || null, data_fim || null, status || 'ativa', req.params.id, req.usuario.empresa_id]
    );
    res.json(await get(`SELECT * FROM metas WHERE id=$1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar meta' }); }
});

router.delete('/metas', autenticar, async (req, res) => {
  res.status(405).json({ erro: 'Método não permitido neste endpoint' });
});

router.delete('/metas/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir meta' }); }
});

// ── OKRs ─────────────────────────────────────────────────────────────────────
router.get('/okrs', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT o.*, u.nome AS responsavel_nome FROM okrs o
       LEFT JOIN usuarios u ON u.id = o.responsavel_id
       WHERE o.empresa_id=$1 ORDER BY o.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows.map(o => ({ ...o, resultados_chave: o.resultados_chave ? JSON.parse(o.resultados_chave) : [] })));
  } catch { res.status(500).json({ erro: 'Erro ao buscar OKRs' }); }
});

router.post('/okrs', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { objetivo, resultados_chave, responsavel_id, data_inicio, data_fim, ciclo } = req.body;
    if (!objetivo) return res.status(400).json({ erro: 'Objetivo obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO okrs (id,empresa_id,objetivo,resultados_chave,responsavel_id,data_inicio,data_fim,ciclo,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativo')`,
      [id, req.usuario.empresa_id, objetivo, JSON.stringify(resultados_chave || []), responsavel_id || null, data_inicio || null, data_fim || null, ciclo || null]
    );
    res.status(201).json(await get(`SELECT * FROM okrs WHERE id=$1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar OKR' }); }
});

router.put('/okrs/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { objetivo, resultados_chave, responsavel_id, data_inicio, data_fim, ciclo, status } = req.body;
    await run(
      `UPDATE okrs SET objetivo=$1,resultados_chave=$2,responsavel_id=$3,data_inicio=$4,data_fim=$5,ciclo=$6,status=$7 WHERE id=$8 AND empresa_id=$9`,
      [objetivo, JSON.stringify(resultados_chave || []), responsavel_id || null, data_inicio || null, data_fim || null, ciclo || null, status || 'ativo', req.params.id, req.usuario.empresa_id]
    );
    res.json(await get(`SELECT * FROM okrs WHERE id=$1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar OKR' }); }
});

router.delete('/okrs/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir OKR' }); }
});

// ── RANKING DE INDICADORES ────────────────────────────────────────────────────
router.get('/ranking-indicadores', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT i.*, d.nome AS departamento_nome,
        CASE WHEN i.meta > 0 THEN ROUND((i.valor_atual / i.meta) * 100, 1) ELSE 0 END AS percentual
       FROM indicadores i
       LEFT JOIN departamentos d ON d.id = i.departamento_id
       WHERE i.empresa_id=$1 AND i.status='ativo'
       ORDER BY percentual DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar ranking' }); }
});

// ── META DO COMERCIAL ───────────────────────────────────────────────────────
// Vendas sincronizadas do HubSoft (meta_comercial_venda_sync) + config de meta/bônus
// por vendedor (meta_comercial_vendedor) + faixas de premiação do supervisor.
const PODE_EDITAR_META_COMERCIAL = ['admin', 'gestor', 'lider'];
// Ajustar ORDEM/TAMANHO dos painéis é mais restrito que editar meta: só admin e gestor.
const PODE_AJUSTAR_LAYOUT_ANALISE = ['admin', 'gestor'];

// A Meta do Comercial expõe salário do supervisor e bônus por vendedor, então a LEITURA
// também é verificada no servidor (o middleware global só cobre POST/PUT/DELETE).
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');
// Vendedor logado que tem o próprio cadastro vinculado (meta_comercial_vendedor.usuario_id)
// pode ver a TELA, mas só a PRÓPRIA linha — sem permissão de módulo, sem ver os colegas.
async function vendedorVinculado(req) {
  return get(
    'SELECT id, nome FROM meta_comercial_vendedor WHERE empresa_id=$1 AND usuario_id=$2 AND ativo=true',
    [req.usuario.empresa_id, req.usuario.id]
  );
}

async function exigirVerMetaComercial(req, res, next) {
  try {
    const u = req.usuario;
    if (u.perfil === 'admin') return next();
    // Líder do setor ou e-mail liberado na lista extra (mesmo mecanismo do
    // Financeiro/Call Center/Cobrança) também vê todo mundo, não só a própria linha.
    const { podeVerTudoNaMeta } = require('../utils/visibilidadeMeta');
    if (await podeVerTudoNaMeta(u, 'comercial')) return next();

    // Vendedor com cadastro vinculado NÃO entra aqui: a aba Meta (com salário do
    // supervisor e bônus de todo mundo) fica restrita a quem tem a permissão de
    // módulo — só a aba Análise é liberada pro vínculo próprio (exigirVerAnaliseMetaComercial).

    let ownPerms = null;
    try {
      const row = await get('SELECT permissoes_modulos FROM usuarios WHERE id = $1', [u.id]);
      if (row?.permissoes_modulos) ownPerms = JSON.parse(row.permissoes_modulos);
    } catch { /* usa só os grupos */ }
    const perms = await buscarPermsEfetivas(u.id, u.empresa_id, ownPerms);
    if (temPermissaoServer(perms, 'gestao.meta-comercial', 'visualizar')) return next();

    return res.status(403).json({ erro: 'Você não tem permissão para ver a Meta do Comercial.' });
  } catch {
    return res.status(500).json({ erro: 'Erro ao verificar permissão.' }); // fail-closed
  }
}

// Aba Análise: além de quem já vê a Meta inteira, o vendedor com cadastro vinculado
// (meta_comercial_vendedor.usuario_id) também entra, mas travado na PRÓPRIA linha.
async function exigirVerAnaliseMetaComercial(req, res, next) {
  const u = req.usuario;
  if (u.perfil === 'admin') return next();
  try {
    const { podeVerTudoNaMeta } = require('../utils/visibilidadeMeta');
    if (await podeVerTudoNaMeta(u, 'comercial')) return next();
  } catch { /* segue pra próxima checagem */ }

  const proprio = await vendedorVinculado(req).catch(() => null);
  if (proprio) { req.somenteVendedorId = proprio.id; return next(); }

  return exigirVerMetaComercial(req, res, next);
}

function mesRefDe(query) {
  // "YYYY-MM"; padrão = mês atual (America/Sao_Paulo)
  const s = (query.mes || '').match(/^\d{4}-\d{2}$/) ? query.mes : null;
  if (s) return s;
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return hoje.slice(0, 7);
}
function mesAnteriorDe(mesRef) {
  const [a, m] = mesRef.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Calcula o relatório completo da Meta Comercial (vendedores + supervisor). Reutilizado
// pela tela (JSON) e pelo PDF, para nunca divergir entre os dois.
async function montarMetaComercial(eid, mesRef, perfil) {
    const mesAnt = mesAnteriorDe(mesRef);

    // Quando há usuario_id vinculado, o nome/avatar vêm do cadastro real do Kronos (usuarios) —
    // se o nome do colaborador for corrigido lá, reflete aqui automaticamente.
    const vendedores = await all(
      `SELECT v.*, u.nome AS usuario_nome, u.avatar AS usuario_avatar, u.email AS usuario_email
       FROM meta_comercial_vendedor v
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.empresa_id=$1 AND v.ativo=true
       ORDER BY v.meta DESC, v.ordem, v.nome`, [eid]);
    // Meta daquele mês, quando foi ajustada. Sem registro, vale a do cadastro —
    // por isso mexer na meta de um mês não altera o que já foi apurado nos outros.
    const doMes = await all(
      `SELECT vendedor_id, meta, bonus_meta, bonus_gap FROM meta_comercial_vendedor_mes
       WHERE empresa_id=$1 AND mes=$2`, [eid, mesRef]);
    const mapaMes = Object.fromEntries(doMes.map(m => [String(m.vendedor_id), m]));
    for (const v of vendedores) {
      const m = mapaMes[String(v.id)];
      if (!m) continue;
      if (m.meta !== null && m.meta !== undefined) v.meta = m.meta;
      if (m.bonus_meta !== null && m.bonus_meta !== undefined) v.bonus_meta = m.bonus_meta;
      if (m.bonus_gap !== null && m.bonus_gap !== undefined) v.bonus_gap = m.bonus_gap;
      v.meta_do_mes = true;   // a tela mostra que este mês tem meta própria
    }
    vendedores.sort((a, b) => (b.meta || 0) - (a.meta || 0) || (a.ordem || 0) - (b.ordem || 0) || String(a.nome).localeCompare(String(b.nome)));

    const supervisor = await get(`SELECT * FROM meta_comercial_supervisor WHERE empresa_id=$1`, [eid])
      || { empresa_id: eid, nome: null, faixa1_pct: 15, faixa1_valor: 0, faixa2_pct: 25, faixa2_valor: 0, salario: 0 };
    const syncStatus = await get(`SELECT * FROM meta_comercial_sync_status WHERE empresa_id=$1`, [eid]);

    // Vendas do mês de referência, por vendedor (email em minúsculo casa com o sync).
    // Venda cancelada DENTRO DO PRÓPRIO MÊS não conta (nasceu e morreu no mesmo mês) — é a
    // mesma regra do relatório oficial do HubSoft, conferido registro a registro em jul/2026.
    // Se cancelar num mês seguinte, aí sim entra como cancelamento naquele mês.
    const vendasMes = await all(
      `SELECT LOWER(vendedor_email) AS email, COUNT(*)::int AS qtd
       FROM meta_comercial_venda_sync
       WHERE empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2
         AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$2)
       GROUP BY 1`, [eid, mesRef]);
    const mapaVendas = Object.fromEntries(vendasMes.map(v => [v.email, v.qtd]));

    // Cancelamentos: vendas do MÊS ANTERIOR do vendedor com DATA DE CANCELAMENTO preenchida
    // dentro do MÊS DE REFERÊNCIA (desconta do saldo de quem vendeu). Conta pela data
    // preenchida, não pelo texto do status (o HubSoft nem sempre rotula como "cancelado").
    const cancelamentos = await all(
      `SELECT LOWER(vendedor_email) AS email, COUNT(*)::int AS qtd
       FROM meta_comercial_venda_sync
       WHERE empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2
         AND data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$3
       GROUP BY 1`, [eid, mesAnt, mesRef]);
    const mapaCancel = Object.fromEntries(cancelamentos.map(v => [v.email, v.qtd]));

    const itens = vendedores.map(v => {
      const email = (v.hubsoft_email || '').toLowerCase();
      const qtdVendas = mapaVendas[email] || 0;
      const cancelamento = mapaCancel[email] || 0;
      const saldo = qtdVendas - cancelamento;
      const gap = saldo - (v.meta || 0);
      const bateMeta = v.conta_meta ? saldo >= (v.meta || 0) : null;
      const bonusMeta = v.conta_meta && bateMeta ? Number(v.bonus_meta || 0) : 0;
      const bonusGap = v.conta_meta && gap > 0 ? gap * Number(v.bonus_gap || 0) : 0;
      return {
        ...v, nome: v.usuario_nome || v.nome, // nome do sistema (Kronos) tem prioridade quando vinculado
        qtd_vendas: qtdVendas, cancelamento, saldo, gap,
        bate_meta: bateMeta, bonus_meta_valor: bonusMeta, bonus_gap_valor: bonusGap,
        total_bonus: Math.round((bonusMeta + bonusGap) * 100) / 100,
      };
    })
      // Quem TEM meta aparece sempre (mesmo sem venda no mês, senão a meta do setor encolheria
      // e o supervisor seria beneficiado). Quem não tem meta (Call Center, Financeiro, etc.)
      // só aparece no mês em que teve venda.
      .filter(i => (i.conta_meta && (i.meta || 0) > 0) || i.qtd_vendas > 0);

    // Vendedores detectados nas vendas sincronizadas mas SEM cadastro de meta ainda.
    // Para cada um, sugere o usuário do Kronos com o mesmo e-mail (vínculo automático por
    // e-mail) — ela só confirma com 1 clique; se não achar ninguém, cadastra manual mesmo.
    const emailsCadastrados = new Set(vendedores.map(v => (v.hubsoft_email || '').toLowerCase()).filter(Boolean));
    const naoConfigurados = await all(
      `SELECT LOWER(vendedor_email) AS email, MAX(vendedor_nome) AS nome, COUNT(*)::int AS qtd
       FROM meta_comercial_venda_sync
       WHERE empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2 AND vendedor_email IS NOT NULL
         AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$2)
       GROUP BY 1 ORDER BY qtd DESC`, [eid, mesRef]);
    const detectados = naoConfigurados.filter(n => !emailsCadastrados.has(n.email));
    const usuariosSistema = detectados.length
      ? await all(`SELECT id, nome, email, avatar FROM usuarios WHERE empresa_id=$1 AND ativo=1`, [eid])
      : [];
    const usuarioPorEmail = new Map(usuariosSistema.map(u => [(u.email || '').toLowerCase(), u]));
    const detectadosSemConfig = detectados.map(d => {
      const sugestao = usuarioPorEmail.get(d.email) || null;
      return { ...d, usuario_sugerido: sugestao ? { id: sugestao.id, nome: sugestao.nome, avatar: sugestao.avatar } : null };
    });

    // Total geral do mês (soma TODAS as vendas sincronizadas, inclusive setores sem meta
    // individual como Financeiro/Call Center/Cobrança — conta_meta=false ainda entra na soma geral)
    const totalGeralRow = await get(
      `SELECT COUNT(*)::int AS n FROM meta_comercial_venda_sync
       WHERE empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2
         AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$2)`,
      [eid, mesRef]);

    const totalMeta = itens.reduce((s, i) => s + (i.conta_meta ? (i.meta || 0) : 0), 0);
    // A meta do supervisor é medida pelas VENDAS do mês (não pelo saldo): o cancelamento
    // desconta do vendedor que vendeu, mas não da apuração do supervisor.
    const totalSaldo = itens.reduce((s, i) => s + i.qtd_vendas, 0);
    const totalGapMeta = totalSaldo - totalMeta;
    const pctAtingido = totalMeta ? Math.round((totalSaldo / totalMeta) * 1000) / 10 : 0;
    // Faixa dispara quando SUPERA a meta no percentual: faixa de 15% = atingir 115% da meta.
    // O prêmio é esse mesmo percentual aplicado sobre o SALÁRIO do supervisor.
    const f1 = Number(supervisor.faixa1_pct || 0);
    const f2 = Number(supervisor.faixa2_pct || 0);
    const bateFaixa1 = totalMeta > 0 && pctAtingido >= 100 + f1;
    const bateFaixa2 = totalMeta > 0 && pctAtingido >= 100 + f2;
    const salarioSup = Number(supervisor.salario || 0);
    const pctPremio = bateFaixa2 ? f2 : (bateFaixa1 ? f1 : 0);
    const valorPremiacao = Math.round(salarioSup * (pctPremio / 100) * 100) / 100;

    return {
      mes: mesRef,
      itens,
      detectados_sem_config: detectadosSemConfig,
      supervisor: {
        ...supervisor,
        total_meta: totalMeta, total_saldo: totalSaldo, gap_meta: totalGapMeta, percentual_atingido: pctAtingido,
        bate_faixa1: bateFaixa1, bate_faixa2: bateFaixa2,
        // metas de venda necessárias para cada faixa (para exibir na tela)
        alvo_faixa1: Math.ceil(totalMeta * (1 + f1 / 100)),
        alvo_faixa2: Math.ceil(totalMeta * (1 + f2 / 100)),
        pct_premio: pctPremio,
        valor_premiacao: valorPremiacao,
      },
      total_geral_vendas_mes: totalGeralRow?.n || 0,
      sync: syncStatus || null,
      pode_editar: PODE_EDITAR_META_COMERCIAL.includes(perfil),
    };
}

router.get('/meta-comercial', autenticar, exigirVerMetaComercial, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const mesRef = mesRefDe(req.query);
    const dados = await montarMetaComercial(eid, mesRef, req.usuario.perfil);
    if (req.somenteVendedorId) {
      // Vendedor comum: só a própria linha, sem ver colegas, supervisor ou quem falta cadastrar
      dados.itens = (dados.itens || []).filter(i => String(i.id) === String(req.somenteVendedorId));
      dados.supervisor = null;
      dados.detectados_sem_config = [];
      dados.somente_proprio = true;
    }
    res.json(dados);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meta-comercial/pdf', autenticar, exigirVerMetaComercial, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const mesRef = mesRefDe(req.query);
    const dados = await montarMetaComercial(eid, mesRef, req.usuario.perfil);
    const { gerarPDFMetaComercial } = require('../utils/gerarPDFMetaComercial');
    const pdfBuffer = await gerarPDFMetaComercial(dados);

    // Guarda uma cópia no servidor para acompanhamento posterior (histórico de PDFs)
    try {
      const fs = require('fs'); const path = require('path');
      const dir = path.join(__dirname, '../../uploads/meta-comercial');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const nome = `meta-${mesRef}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(dir, nome), pdfBuffer);
      const totVendas = (dados.itens || []).reduce((s, i) => s + (i.qtd_vendas || 0), 0);
      const totBonus = (dados.itens || []).reduce((s, i) => s + (i.total_bonus || 0), 0);
      await run(
        `INSERT INTO meta_comercial_pdf (id, empresa_id, mes, arquivo, gerado_por, gerado_por_nome, total_vendas, total_bonus)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv4(), eid, mesRef, `/uploads/meta-comercial/${nome}`, req.usuario.id, req.usuario.nome || null, totVendas, totBonus]
      );
    } catch (e) { console.error('[meta-comercial/pdf] histórico:', e.message); }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Meta-Comercial-${mesRef}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── Meta de um MÊS específico ───────────────────────────────────────────────
// Ajusta a meta só naquele mês, sem tocar nos outros nem no cadastro do vendedor.
// Enviar meta vazia remove o ajuste e o mês volta a usar a meta padrão.
router.put('/meta-comercial/vendedor/:id/mes/:mes', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { id, mes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido (use AAAA-MM).' });
    const existe = await get('SELECT id FROM meta_comercial_vendedor WHERE id=$1 AND empresa_id=$2', [id, req.usuario.empresa_id]);
    if (!existe) return res.status(404).json({ erro: 'Vendedor não encontrado' });

    const vazio = (v) => v === '' || v === null || v === undefined;
    if (vazio(req.body.meta) && vazio(req.body.bonus_meta) && vazio(req.body.bonus_gap)) {
      await run('DELETE FROM meta_comercial_vendedor_mes WHERE empresa_id=$1 AND vendedor_id=$2 AND mes=$3',
        [req.usuario.empresa_id, id, mes]);
      return res.json({ ok: true, removido: true });
    }
    await run(
      `INSERT INTO meta_comercial_vendedor_mes (empresa_id, vendedor_id, mes, meta, bonus_meta, bonus_gap, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (empresa_id, vendedor_id, mes) DO UPDATE SET
         meta=EXCLUDED.meta, bonus_meta=EXCLUDED.bonus_meta, bonus_gap=EXCLUDED.bonus_gap, atualizado_em=NOW()`,
      [req.usuario.empresa_id, id, mes,
       vazio(req.body.meta) ? null : parseInt(req.body.meta, 10) || 0,
       vazio(req.body.bonus_meta) ? null : Number(req.body.bonus_meta) || 0,
       vazio(req.body.bonus_gap) ? null : Number(req.body.bonus_gap) || 0]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── Layout dos painéis da Análise (ordem e tamanho) ─────────────────────────
// Ajuste é de admin/gestor e vale para todo mundo que abre a tela — não é por usuário.
router.get('/meta-comercial/analise/layout', autenticar, exigirVerAnaliseMetaComercial, async (req, res) => {
  try {
    const row = await get('SELECT layout FROM meta_comercial_analise_layout WHERE empresa_id=$1', [req.usuario.empresa_id]);
    res.json({ layout: row?.layout || null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta-comercial/analise/layout', autenticar, async (req, res) => {
  try {
    if (!PODE_AJUSTAR_LAYOUT_ANALISE.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const layout = req.body.layout;
    if (!Array.isArray(layout)) return res.status(400).json({ erro: 'Layout inválido' });
    await run(
      `INSERT INTO meta_comercial_analise_layout (empresa_id, layout, atualizado_em)
       VALUES ($1,$2,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET layout=EXCLUDED.layout, atualizado_em=NOW()`,
      [req.usuario.empresa_id, JSON.stringify(layout)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mesma ideia, pro layout da Análise da Meta de Cobrança.
router.get('/meta-cobranca/analise/layout', autenticar, async (req, res) => {
  try {
    // PODE_EDITAR_META_COMERCIAL (admin/gestor/líder) é genérico demais aqui: um líder de
    // OUTRO setor (Call Center, Comercial, Financeiro) caía nele e via a Análise de Cobrança
    // inteira. Só quem tem visão de tudo NESSE setor (podeVerTudoNaMeta) pode ver.
    const { podeVerTudoNaMeta } = require('../utils/visibilidadeMeta');
    if (req.usuario.perfil !== 'admin' && !(await podeVerTudoNaMeta(req.usuario, 'cobranca'))) {
      return res.status(403).json({ erro: 'Sem permissão' });
    }
    const row = await get('SELECT layout FROM meta_cobranca_analise_layout WHERE empresa_id=$1', [req.usuario.empresa_id]);
    res.json({ layout: row?.layout || null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta-cobranca/analise/layout', autenticar, async (req, res) => {
  try {
    if (!PODE_AJUSTAR_LAYOUT_ANALISE.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const layout = req.body.layout;
    if (!Array.isArray(layout)) return res.status(400).json({ erro: 'Layout inválido' });
    await run(
      `INSERT INTO meta_cobranca_analise_layout (empresa_id, layout, atualizado_em)
       VALUES ($1,$2,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET layout=EXCLUDED.layout, atualizado_em=NOW()`,
      [req.usuario.empresa_id, JSON.stringify(layout)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── Visibilidade das Metas: quem vê TODOS, além de admin/gestor/líder ───────
// (confirmado 08/08/2026: cada colaborador só vê a própria linha, casada pelo
// e-mail; admin/gestor/líder veem tudo por padrão; esta lista libera mais gente
// específica, por departamento, sem precisar mudar o perfil da pessoa)
const DEPARTAMENTOS_META = ['comercial', 'financeiro', 'callcenter', 'cobranca'];
router.get('/metas/visibilidade', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const linhas = await all(
      'SELECT departamento, email FROM meta_visibilidade_extra WHERE empresa_id=$1 ORDER BY departamento, email',
      [req.usuario.empresa_id]
    );
    res.json({ linhas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/metas/visibilidade', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { departamento, email } = req.body;
    if (!DEPARTAMENTOS_META.includes(departamento)) return res.status(400).json({ erro: 'Departamento inválido' });
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido' });
    await run(
      `INSERT INTO meta_visibilidade_extra (empresa_id, departamento, email) VALUES ($1,$2,$3)
       ON CONFLICT (empresa_id, departamento, email) DO NOTHING`,
      [req.usuario.empresa_id, departamento, email.trim().toLowerCase()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/metas/visibilidade', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { departamento, email } = req.query;
    await run(
      'DELETE FROM meta_visibilidade_extra WHERE empresa_id=$1 AND departamento=$2 AND LOWER(email)=LOWER($3)',
      [req.usuario.empresa_id, departamento, email]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Diz pro front, num único lugar, o que o usuário logado pode ver em cada meta —
// evita duplicar a lógica de "é líder/admin/tá na lista extra" no React.
router.get('/metas/meu-acesso', autenticar, async (req, res) => {
  try {
    const { podeVerTudoNaMeta } = require('../utils/visibilidadeMeta');
    const resultado = {};
    for (const dep of DEPARTAMENTOS_META) resultado[dep] = await podeVerTudoNaMeta(req.usuario, dep) ? 'tudo' : 'proprio';
    res.json(resultado);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── Acompanhamento e Análise da Meta (dados do HubSoft) ─────────────────────
// Cidade vem da FILIAL do vendedor: a API de integração do HubSoft não devolve
// endereço do cliente em nenhum endpoint (conferido em ago/2026).
const CIDADE_POR_FILIAL = {
  sln: 'Salinópolis', cdp: 'Concórdia do Pará', smg: 'São Miguel do Guamá',
  nep: 'Nova Esperança do Piriá', acr: 'Acará', adp: 'Aurora do Pará',
  gdn: 'Garrafão do Norte', ipx: 'Ipixuna do Pará', mdr: 'Mãe do Rio',
  centro: 'Centro', matriz: 'Matriz',
};
function cidadeDaFilial(filial) {
  const f = (filial || '').trim();
  if (!f) return 'Sem filial';
  const sigla = f.split('-').pop().trim().toLowerCase();
  if (CIDADE_POR_FILIAL[sigla]) return CIDADE_POR_FILIAL[sigla];
  // "Mãe do rio - PAP", "Concórdia - PAP", "Ipixuna - PAP" → a cidade vem antes do traço
  const antes = f.split('-')[0].trim();
  return antes || f;
}

// ─── Meta de Cobrança (efetividade de remoção/recebimento) ───────────────────
// ATENÇÃO: o endpoint de O.S. espera data em yyyy-mm-dd. Mandar dd/mm/yyyy (como
// era antes) faz a API IGNORAR o filtro de período e devolver tudo (conferido em
// 07/08/2026: 11.502 registros em vez dos 405 esperados na janela certa).
// Acha o e-mail do usuário do sistema cujo nome corresponde ao nome do cobrador
// vindo do HubSoft (ex.: "Ronald Rego" → "Ronald Rego De Sousa" no cadastro).
// Mesma ideia da resolução de nome completo do Chatmix: casa por SEQUÊNCIA de
// palavras, e só aceita se achar exatamente UM colaborador ativo — ambíguo não afirma nada.
function semAcento(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
async function emailDoNomeHubsoft(empresaId, nomeHubsoft) {
  const busca = semAcento(nomeHubsoft).split(/\s+/).filter(Boolean);
  if (!busca.length) return null;
  const usuarios = await all('SELECT nome, email FROM usuarios WHERE empresa_id=$1 AND ativo=1', [empresaId]);
  const achados = usuarios.filter(u => {
    const tokens = semAcento(u.nome).split(/\s+/).filter(Boolean);
    for (let i = 0; i <= tokens.length - busca.length; i++) {
      if (busca.every((t, j) => tokens[i + j] === t)) return true;
    }
    return false;
  });
  return achados.length === 1 ? achados[0].email : null;
}

// A Meta de Cobrança busca tudo em tempo real no HubSoft, o que é lento — um
// job em segundo plano (syncMetaCobranca) recalcula a cada poucos minutos e
// guarda em cache. Lê daqui primeiro; só recalcula na hora se o cache ainda
// não existir (ex.: mês muito antigo, ou logo depois do servidor subir) ou
// estiver velho demais (job parado por algum motivo).
async function metaCobrancaCacheada(mesRef, dataInicio, dataFim) {
  const row = await get('SELECT dados, atualizado_em FROM meta_cobranca_cache WHERE mes=$1', [mesRef]);
  const idadeMin = row ? (Date.now() - new Date(row.atualizado_em).getTime()) / 60000 : Infinity;
  if (row && idadeMin < 15) return { dados: row.dados, cache_atualizado_em: row.atualizado_em };
  const { montarMetaCobranca } = require('../jobs/metaCobranca');
  return { dados: await montarMetaCobranca({ dataInicio, dataFim }), cache_atualizado_em: null };
}
async function analiseCobrancaCacheada(mesRef, dataInicio, dataFim) {
  const row = await get('SELECT dados, atualizado_em FROM meta_cobranca_analise_cache WHERE mes=$1', [mesRef]);
  const idadeMin = row ? (Date.now() - new Date(row.atualizado_em).getTime()) / 60000 : Infinity;
  if (row && idadeMin < 15) return { dados: row.dados, cache_atualizado_em: row.atualizado_em };
  const { montarAnaliseCobranca } = require('../jobs/metaCobranca');
  return { dados: await montarAnaliseCobranca({ dataInicio, dataFim }), cache_atualizado_em: null };
}

router.get('/meta-cobranca', autenticar, async (req, res) => {
  try {
    const { podeVerTudoNaMeta, mesmoEmail } = require('../utils/visibilidadeMeta');
    const vTudo = await podeVerTudoNaMeta(req.usuario, 'cobranca');
    // Sem ver tudo: só entra se ele mesmo for um dos cobradores (casado pelo
    // e-mail mais abaixo) — a checagem de permissão de módulo não se aplica
    // mais aqui sozinha, porque o próprio cobrador pode não ter perfil líder/admin.
    const mesRef = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [ano, mes] = mesRef.split('-').map(Number);
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const { dados, cache_atualizado_em } = await metaCobrancaCacheada(mesRef, iso(1), iso(ultimoDia));

    if (vTudo) return res.json({ mes: mesRef, cache_atualizado_em, ...dados });

    // Casa cada item com o e-mail do usuário do sistema, pra achar a PRÓPRIA linha.
    const comEmail = await Promise.all(dados.itens.map(async i => ({ ...i, _email: await emailDoNomeHubsoft(req.usuario.empresa_id, i.nome) })));
    const propria = comEmail.filter(i => mesmoEmail(i._email, req.usuario.email));
    if (!propria.length) return res.status(403).json({ erro: 'Você não tem permissão para ver a Meta de Cobrança.' });

    const itens = propria.map(({ _email, ...i }) => i);
    const nomesProprios = new Set(itens.map(i => i.nome));
    const recebimentos = (dados.recebimentos || []).filter(r => nomesProprios.has(r.cobrador));
    res.json({
      mes: mesRef, cache_atualizado_em, meta_efetividade: dados.meta_efetividade, itens, recebimentos, somente_proprio: true,
      resumo: {
        colaboradores: itens.length,
        total_os: itens.reduce((s, i) => s + i.total_os, 0),
        total_removidas: itens.reduce((s, i) => s + i.os_removido, 0),
        total_pagamentos: itens.reduce((s, i) => s + i.os_pagamento, 0),
        bonus_total: itens.reduce((s, i) => s + i.bonus_total, 0),
        valor_pendente_confirmar: itens.some(i => i.valor_recebido_pendente),
      },
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Análise da Cobrança: visão ampla (todos os técnicos/cobradores, motivos de
// fechamento, valores recebidos) — igual em espírito à Análise do Comercial.
// PDF da Meta de Cobrança — mesma restrição de visibilidade da tela: se o
// próprio cobrador pedir, só sai a linha dele.
router.get('/meta-cobranca/pdf', autenticar, async (req, res) => {
  try {
    const { podeVerTudoNaMeta, mesmoEmail } = require('../utils/visibilidadeMeta');
    const vTudo = await podeVerTudoNaMeta(req.usuario, 'cobranca');
    const mesRef = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [ano, mes] = mesRef.split('-').map(Number);
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const { dados } = await metaCobrancaCacheada(mesRef, iso(1), iso(ultimoDia));

    let payload = { mes: mesRef, ...dados };
    if (!vTudo) {
      const comEmail = await Promise.all(dados.itens.map(async i => ({ ...i, _email: await emailDoNomeHubsoft(req.usuario.empresa_id, i.nome) })));
      const propria = comEmail.filter(i => mesmoEmail(i._email, req.usuario.email)).map(({ _email, ...i }) => i);
      if (!propria.length) return res.status(403).json({ erro: 'Você não tem permissão para ver a Meta de Cobrança.' });
      const nomesProprios = new Set(propria.map(i => i.nome));
      payload = { mes: mesRef, meta_efetividade: dados.meta_efetividade, itens: propria, recebimentos: (dados.recebimentos || []).filter(r => nomesProprios.has(r.cobrador)) };
    }

    const { gerarPDFMetaCobranca } = require('../utils/gerarPDFMetaCobranca');
    const pdfBuffer = await gerarPDFMetaCobranca(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="meta-cobranca-${mesRef}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meta-cobranca/analise', autenticar, async (req, res) => {
  try {
    // Mesmo motivo do /analise/layout: líder de outro setor não pode entrar aqui.
    // A Análise é visão AGREGADA (motivos, cidade, equipamentos) — não existe uma versão
    // "só a própria linha" pra um cobrador comum, então quem não vê tudo não vê nada.
    const { podeVerTudoNaMeta } = require('../utils/visibilidadeMeta');
    if (req.usuario.perfil !== 'admin' && !(await podeVerTudoNaMeta(req.usuario, 'cobranca'))) {
      return res.status(403).json({ erro: 'Você não tem permissão para ver a Análise de Cobrança.' });
    }
    const mesRef = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const [ano, mes] = mesRef.split('-').map(Number);
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const { dados, cache_atualizado_em } = await analiseCobrancaCacheada(mesRef, iso(1), iso(ultimoDia));
    res.json({ mes: mesRef, cache_atualizado_em, ...dados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Dias úteis do mês pra dividir a meta mensal em meta diária — comercial trabalha
// de segunda a sábado, só domingo não conta (conferido com o setor em 20/08/2026).
function diasUteisDoMes(ano, mes) {
  const ultimoDia = new Date(ano, mes, 0).getDate();
  let uteis = 0;
  for (let d = 1; d <= ultimoDia; d++) {
    if (new Date(ano, mes - 1, d).getDay() !== 0) uteis++;
  }
  return uteis;
}
// Quantos desses dias úteis já passaram até `ateDia` (inclusive) — usado pra saber
// quanto da meta já deveria ter sido vendido "no ritmo" até hoje.
function diasUteisAte(ano, mes, ateDia) {
  let uteis = 0;
  for (let d = 1; d <= ateDia; d++) {
    if (new Date(ano, mes - 1, d).getDay() !== 0) uteis++;
  }
  return uteis;
}

// Monta os dados da aba "Acompanhamento e Análise" — extraído à parte pra ser
// reaproveitado tanto pelo endpoint JSON (tela) quanto pelo PDF (mesmo filtro,
// mesmos números, nunca diverge entre os dois).
async function montarAnaliseMetaComercial(req) {
  {
    const eid = req.usuario.empresa_id;
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const setor = (req.query.setor || 'todos').toLowerCase(); // todos | comercial | pap | escritorio
    // Data específica (opcional): "AAAA-MM-DD" dentro do mês selecionado. Quando
    // vem preenchida, todos os cortes passam a olhar só aquele dia, não o mês inteiro.
    const [anoMes, mesMes] = mes.split('-').map(Number);
    const ultimoDiaMesRef = new Date(anoMes, mesMes, 0).getDate();
    const dataParam = (req.query.data || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.data : null;
    const data = (dataParam && dataParam.slice(0, 7) === mes && Number(dataParam.slice(8, 10)) <= ultimoDiaMesRef)
      ? dataParam : null;

    const base = await montarMetaComercial(eid, mes, req.usuario.perfil);
    // 1) Filtra pelo setor. A lista de vendedores do seletor sai daqui, então em
    //    "Comercial" só aparecem os do Comercial; em "Geral", todos.
    const doSetor = (base.itens || []).filter(i => {
      if (setor === 'todos') return true;
      const f = (i.filial || '').toLowerCase();
      if (setor === 'escritorio') return f.includes('esc');
      if (setor === 'pap') return f.includes('pap');
      if (setor === 'comercial') return f.includes('comercial');
      return true;
    });
    // 2) Dentro do setor, pode restringir a um vendedor — vendedor comum é sempre
    //    forçado à própria linha, ignorando setor e o que veio na URL.
    const vendedorId = req.somenteVendedorId ? String(req.somenteVendedorId) : (req.query.vendedor || '').trim();
    const base_ = req.somenteVendedorId ? (base.itens || []) : doSetor;
    let itens = vendedorId ? base_.filter(i => String(i.id) === vendedorId) : base_;
    const emails = itens.map(i => (i.hubsoft_email || '').toLowerCase()).filter(Boolean);

    // Vendas do mês inteiro, ou só do dia escolhido (excluindo canceladas no mesmo
    // recorte — mesma regra do painel, só muda a janela de tempo).
    const filtroVendas = data
      ? `empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM-DD')=$2
         AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM-DD')=$2)
         AND LOWER(vendedor_email) = ANY($3)`
      : `empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2
       AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$2)
       AND LOWER(vendedor_email) = ANY($3)`;
    const p = [eid, data || mes, emails.length ? emails : ['']];

    const [porDia, porServico, porTipo, porVencimento, porStatus, porGenero, receita] = await Promise.all([
      all(`SELECT TO_CHAR(data_venda,'DD') AS dia, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 1`, p),
      all(`SELECT COALESCE(NULLIF(nome_servico,''),'Sem plano') AS servico, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, p),
      all(`SELECT CASE WHEN LOWER(COALESCE(tipo_pessoa,''))='pj' THEN 'Pessoa Jurídica'
                       WHEN LOWER(COALESCE(tipo_pessoa,''))='pf' THEN 'Pessoa Física'
                       ELSE 'Não informado' END AS tipo, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT CASE WHEN vencimento='ultimo_dia' THEN 'Último dia' WHEN vencimento IS NOT NULL THEN 'Dia ' || vencimento
                       ELSE 'Não informado' END AS vencimento, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1, vencimento
           ORDER BY (vencimento = 'ultimo_dia'), NULLIF(vencimento,'ultimo_dia')::int`, p),
      // Status do serviço vem do próprio cadastro do serviço (não da ordem de serviço)
      all(`SELECT INITCAP(REPLACE(COALESCE(NULLIF(status_prefixo,''),'nao_informado'),'_',' ')) AS status,
                  COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      // Gênero: o HubSoft ADIVINHA pelo primeiro nome do cliente, não é dado real
      // informado por ele — pode vir errado às vezes (avisado na tela).
      all(`SELECT INITCAP(COALESCE(NULLIF(genero,''),'não informado')) AS genero, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      get(`SELECT COALESCE(SUM(valor),0)::float AS total, COALESCE(AVG(valor),0)::float AS ticket
           FROM meta_comercial_venda_sync WHERE ${filtroVendas}`, p),
    ]);

    // Cortes que dependem do Relatório de Serviços do painel (cidade real, bairro,
    // origem e contrato). Ficam vazios até o enriquecimento rodar.
    const [porCidadeReal, porBairro, porOrigem, porContrato, porPacote, receitaPacotes, clientes] = await Promise.all([
      all(`SELECT cidade, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND cidade IS NOT NULL AND cidade <> ''
           GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT bairro, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND bairro IS NOT NULL AND bairro <> ''
           GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT INITCAP(origem) AS origem, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND origem IS NOT NULL AND origem <> ''
           GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT COALESCE(NULLIF(situacao_contrato,''),'Não informado') AS contrato, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      // Uma venda pode ter vários pacotes juntos ("Watch TV, Telemedicina") — separa
      // por vírgula para contar cada adicional individualmente.
      all(`SELECT TRIM(pacote) AS pacote, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync, LATERAL unnest(string_to_array(pacotes, ',')) AS pacote
           WHERE ${filtroVendas} AND pacotes IS NOT NULL AND pacotes <> ''
           GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, p),
      get(`SELECT COALESCE(SUM(valor_pacotes),0)::float AS total, COUNT(*) FILTER (WHERE valor_pacotes > 0)::int AS vendas_com_pacote
           FROM meta_comercial_venda_sync WHERE ${filtroVendas}`, p),
      all(`SELECT nome_cliente, nome_servico, cidade, bairro, origem, servico_status, pacotes,
                  vendedor_nome, TO_CHAR(data_venda,'DD/MM/YYYY') AS data_venda,
                  CASE WHEN LOWER(COALESCE(tipo_pessoa,''))='pj' THEN 'PJ' ELSE 'PF' END AS tipo
           FROM meta_comercial_venda_sync WHERE ${filtroVendas}
           ORDER BY vendedor_nome, data_venda, nome_cliente LIMIT 1000`, p),
    ]);

    // Meta por dia: divide a meta do mês pelos dias úteis (seg-sáb) — não é uma meta
    // configurável à parte, é a mesma meta mensal fatiada pra dar um ritmo diário.
    const [anoNum, mesNum] = mes.split('-').map(Number);
    const uteisNoMes = diasUteisDoMes(anoNum, mesNum);
    const ehDomingoSelecionado = data ? new Date(anoNum, mesNum - 1, Number(data.slice(8, 10))).getDay() === 0 : false;

    // Quando um dia específico foi escolhido, vendas/saldo por vendedor não podem
    // vir do total do MÊS (itens, calculado por montarMetaComercial) — precisam ser
    // recontados só para aquele dia, com a mesma regra de cancelamento (mesmo recorte).
    let vendasPorEmail = null, cancelPorEmail = null;
    if (data) {
      const [vendasDia, cancelDia] = await Promise.all([
        all(`SELECT LOWER(vendedor_email) AS email, COUNT(*)::int AS qtd
             FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1`, p),
        all(`SELECT LOWER(vendedor_email) AS email, COUNT(*)::int AS qtd
             FROM meta_comercial_venda_sync
             WHERE empresa_id=$1 AND TO_CHAR(data_cancelamento,'YYYY-MM-DD')=$2
               AND LOWER(vendedor_email) = ANY($3)
             GROUP BY 1`, p),
      ]);
      vendasPorEmail = Object.fromEntries(vendasDia.map(v => [v.email, v.qtd]));
      cancelPorEmail = Object.fromEntries(cancelDia.map(v => [v.email, v.qtd]));
    }

    // Por filial (meta x vendas x %) e por cidade — a partir dos itens já calculados
    // (ou recontados por dia, quando uma data específica foi escolhida)
    const porFilial = [];
    const cidades = {};
    let totalCancel = 0;
    for (const i of itens) {
      const email = (i.hubsoft_email || '').toLowerCase();
      const metaMensal = i.conta_meta ? (i.meta || 0) : 0;
      const metaI = data ? (ehDomingoSelecionado ? 0 : Math.round((uteisNoMes ? metaMensal / uteisNoMes : 0) * 100) / 100) : metaMensal;
      const qtdVendas = data ? (vendasPorEmail[email] || 0) : (i.qtd_vendas || 0);
      const cancelamento = data ? (cancelPorEmail[email] || 0) : (i.cancelamento || 0);
      const saldo = data ? (qtdVendas - cancelamento) : (i.saldo || 0);
      totalCancel += cancelamento;
      porFilial.push({
        id: i.id, discord_id: i.discord_id || null,
        filial: i.filial || 'Sem filial',
        vendedor: i.nome,
        meta: metaI,
        vendas: qtdVendas,
        saldo,
        pct: metaI > 0 ? Math.round((saldo / metaI) * 100) : null,
      });
      const cid = cidadeDaFilial(i.filial);
      cidades[cid] = (cidades[cid] || 0) + qtdVendas;
    }
    porFilial.sort((a, b) => b.vendas - a.vendas);

    const totalMeta = porFilial.reduce((s, i) => s + (i.meta || 0), 0);
    const totalVendas = porFilial.reduce((s, i) => s + (i.vendas || 0), 0);
    const totalSaldo = porFilial.reduce((s, i) => s + (i.saldo || 0), 0);
    const totalBateram = porFilial.filter(i => i.meta > 0 && i.saldo >= i.meta).length;

    const metaPorDiaUtil = uteisNoMes ? (itens.reduce((s, i) => s + (i.conta_meta ? (i.meta || 0) : 0), 0)) / uteisNoMes : 0;
    const hojeSP = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const [anoHoje, mesHoje, diaHoje] = hojeSP.split('-').map(Number);
    const diaReferencia = (anoHoje === anoNum && mesHoje === mesNum) ? diaHoje
      : (anoHoje > anoNum || (anoHoje === anoNum && mesHoje > mesNum)) ? new Date(anoNum, mesNum, 0).getDate() : 0;
    const uteisAteHoje = diaReferencia ? diasUteisAte(anoNum, mesNum, diaReferencia) : 0;
    const metaEsperadaAteHoje = Math.round(metaPorDiaUtil * uteisAteHoje);
    // Preenche TODOS os dias do mês (não só os que tiveram venda), senão o
    // acumulado pula dias vazios e o gráfico/ritmo fica errado.
    const ultimoDiaMes = new Date(anoNum, mesNum, 0).getDate();
    const qtdPorDia = Object.fromEntries(porDia.map(d => [parseInt(d.dia, 10), d.qtd]));
    let acumulado = 0;
    const porDiaComMeta = [];
    for (let dia = 1; dia <= ultimoDiaMes; dia++) {
      const qtd = qtdPorDia[dia] || 0;
      acumulado += qtd;
      const domingo = new Date(anoNum, mesNum - 1, dia).getDay() === 0;
      porDiaComMeta.push({
        dia, qtd, acumulado,
        meta_dia: domingo ? 0 : Math.round(metaPorDiaUtil * 100) / 100,
        meta_acumulada: Math.round(metaPorDiaUtil * diasUteisAte(anoNum, mesNum, dia)),
      });
    }

    return {
      mes, setor, data: data || null,
      resumo: {
        meta: totalMeta,
        vendas: totalVendas,
        cancelamentos: totalCancel,
        saldo: totalSaldo,
        gap: totalSaldo - totalMeta,
        pct: totalMeta > 0 ? Math.round((totalSaldo / totalMeta) * 100) : null,
        bateram: totalBateram,
        vendedores: itens.length,
        receita: Math.round((receita?.total || 0) * 100) / 100,
        ticket_medio: Math.round((receita?.ticket || 0) * 100) / 100,
        meta_por_dia: Math.round(metaPorDiaUtil * 100) / 100,
        meta_esperada_ate_hoje: (!data && diaReferencia) ? metaEsperadaAteHoje : null,
        dias_uteis_mes: uteisNoMes,
      },
      por_filial: porFilial,
      // Cidade real do serviço quando o relatório já preencheu; senão, a unidade do vendedor
      por_cidade: porCidadeReal.length ? porCidadeReal
        : Object.entries(cidades).map(([cidade, qtd]) => ({ cidade, qtd }))
            .filter(c => c.qtd > 0).sort((a, b) => b.qtd - a.qtd),
      cidade_real: porCidadeReal.length > 0,
      por_bairro: porBairro,
      por_origem: porOrigem,
      por_contrato: porContrato,
      por_pacote: porPacote,
      pacotes_resumo: {
        receita: Math.round((receitaPacotes?.total || 0) * 100) / 100,
        vendas_com_pacote: receitaPacotes?.vendas_com_pacote || 0,
      },
      clientes,
      // Só os do setor selecionado, para o seletor não misturar times
      vendedores: doSetor.map(i => ({ id: i.id, nome: i.nome, filial: i.filial })),
      vendedor_selecionado: vendedorId || null,
      por_dia: porDiaComMeta,
      por_servico: porServico,
      por_tipo: porTipo,
      por_genero: porGenero,
      por_vencimento: porVencimento,
      ultima_sincronizacao: (await get(
        'SELECT ultima_sync FROM meta_comercial_sync_status WHERE empresa_id=$1', [eid]
      ))?.ultima_sync || null,
      por_status: porStatus,
    };
  }
}

router.get('/meta-comercial/analise', autenticar, exigirVerAnaliseMetaComercial, async (req, res) => {
  try {
    res.json(await montarAnaliseMetaComercial(req));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PDF da aba Análise — respeita os MESMOS filtros da tela (mês, dia, setor, vendedor).
// Quando um vendedor específico está selecionado, o nome dele entra no título e no
// nome do arquivo, pra dar pra imprimir/enviar a análise individual de cada um.
router.get('/meta-comercial/analise/pdf', autenticar, exigirVerAnaliseMetaComercial, async (req, res) => {
  try {
    const dados = await montarAnaliseMetaComercial(req);
    const { gerarPDFMetaComercialAnalise } = require('../utils/gerarPDFMetaComercialAnalise');
    const pdfBuffer = await gerarPDFMetaComercialAnalise(dados);
    const vendedorSel = dados.vendedor_selecionado
      ? (dados.vendedores || []).find(v => String(v.id) === String(dados.vendedor_selecionado))
      : null;
    const sufixo = vendedorSel ? `-${vendedorSel.nome}` : (dados.data ? `-${dados.data}` : '');
    const nomeArquivo = `Analise-Meta-Comercial-${dados.mes}${sufixo}.pdf`
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9.\-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Texto da DM individual — editável por admin/gestor/líder (tela "Editar mensagem"
// na Análise). Placeholders: {nome} {periodo} {meta} {vendas} {saldo} {pct} {filial}
const MSG_DISCORD_PADRAO = {
  titulo: '📊 Sua análise de vendas',
  corpo: 'Período: **{periodo}**',
};
function aplicarPlaceholders(texto, valores) {
  return String(texto || '').replace(/\{(\w+)\}/g, (m, chave) => (valores[chave] ?? m));
}

router.get('/meta-comercial/mensagem-discord', autenticar, exigirVerMetaComercial, async (req, res) => {
  try {
    const row = await get('SELECT titulo, corpo FROM meta_comercial_mensagem_discord WHERE empresa_id=$1', [req.usuario.empresa_id]);
    res.json({
      titulo: row?.titulo ?? MSG_DISCORD_PADRAO.titulo,
      corpo: row?.corpo ?? MSG_DISCORD_PADRAO.corpo,
      padrao: MSG_DISCORD_PADRAO,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta-comercial/mensagem-discord', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, corpo } = req.body;
    await run(
      `INSERT INTO meta_comercial_mensagem_discord (empresa_id, titulo, corpo, atualizado_em)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET titulo=EXCLUDED.titulo, corpo=EXCLUDED.corpo, atualizado_em=NOW()`,
      [req.usuario.empresa_id, titulo || null, corpo || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Manda a análise individual (meta x vendas x saldo do período filtrado) pra cada
// vendedor do setor filtrado, por DM no Discord — não é o webhook de canal usado nos
// avisos de cancelamento, é o bot (src/utils/discordBot.js) abrindo conversa privada.
// Extraída à parte pra ser reaproveitada pelo botão manual (rota abaixo) e pelo
// disparo automático (jobs/metaComercialSupervisorAuto.js) — cada vendedor recebe
// SÓ a própria análise (com a lista dos próprios clientes), nunca a do setor inteiro.
async function enviarAnalisesIndividuaisVendedores(empresa_id, query = {}, somenteVendedorId = null) {
  const usuarioFake = { empresa_id, perfil: 'admin' };
  const dados = await montarAnaliseMetaComercial({ usuario: usuarioFake, somenteVendedorId, query });
  const { enviarDM } = require('../utils/discordBot');
  const { gerarPDFMetaComercialAnalise } = require('../utils/gerarPDFMetaComercialAnalise');
  const [anoP, mesP] = dados.mes.split('-').map(Number);
  const periodo = dados.data
    ? new Date(anoP, mesP - 1, Number(dados.data.slice(8, 10))).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date(anoP, mesP - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const msgConfig = await get('SELECT titulo, corpo FROM meta_comercial_mensagem_discord WHERE empresa_id=$1', [empresa_id]);
  const titulo = msgConfig?.titulo ?? MSG_DISCORD_PADRAO.titulo;
  const corpo = msgConfig?.corpo ?? MSG_DISCORD_PADRAO.corpo;

  const alvos = (dados.por_filial || []).filter(v => v.id);
  const enviados = [], semDiscord = [], erros = [];
  for (const v of alvos) {
    if (!v.discord_id) { semDiscord.push(v.vendedor); continue; }
    try {
      // O PDF anexado é a análise SÓ daquele vendedor (com os próprios clientes) —
      // reconta tudo com o filtro travado nele, não usa o total do setor.
      const dadosVendedor = await montarAnaliseMetaComercial({
        usuario: usuarioFake, somenteVendedorId,
        query: { ...query, vendedor: String(v.id) },
      });
      const pdfBuffer = await gerarPDFMetaComercialAnalise(dadosVendedor);
      const nomeArquivo = `Analise-Meta-Comercial-${dados.mes}-${v.vendedor}.pdf`
        .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9.\-]/g, '_');

      const placeholders = {
        nome: v.vendedor, periodo, meta: v.meta > 0 ? v.meta : '—', vendas: v.vendas,
        saldo: v.saldo, pct: v.pct == null ? '—' : `${v.pct}%`, filial: v.filial || '—',
      };
      await enviarDM(v.discord_id, {
        embed: {
          title: aplicarPlaceholders(titulo, placeholders),
          description: aplicarPlaceholders(corpo, placeholders),
          fields: [
            { name: 'Meta', value: v.meta > 0 ? String(v.meta) : '—', inline: true },
            { name: 'Vendas', value: String(v.vendas), inline: true },
            { name: 'Saldo', value: String(v.saldo), inline: true },
            { name: '% da meta', value: v.pct == null ? '—' : `${v.pct}%`, inline: true },
            { name: 'Filial', value: v.filial || '—', inline: true },
          ],
          color: (v.pct ?? 0) >= 100 ? 0x16a34a : 0xf59e0b,
          footer: { text: 'Kronos — Meta do Comercial' },
          timestamp: new Date().toISOString(),
        },
        arquivo: { nome: nomeArquivo, buffer: pdfBuffer, mime: 'application/pdf' },
      });
      enviados.push(v.vendedor);
    } catch (e) { erros.push({ vendedor: v.vendedor, erro: e.message }); }
  }
  return { enviados, sem_discord: semDiscord, erros };
}

router.post('/meta-comercial/analise/enviar-discord', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const resultado = await enviarAnalisesIndividuaisVendedores(req.usuario.empresa_id, req.query, req.somenteVendedorId);
    res.json(resultado);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Manda o relatório GERAL (todos os vendedores, sem filtro) pro supervisor — mesma
// DM com texto (resumo do setor) + PDF completo anexado, igual em espírito ao envio
// individual acima, só que sem travar em ninguém. Extraída à parte pra ser reaproveitada
// pelo botão manual (rota abaixo) e pelo disparo automático (jobs/metaComercialSupervisorAuto.js).
async function enviarRelatorioGeralSupervisor(empresa_id, query = {}) {
  const supervisor = await get(`SELECT nome, discord_id FROM meta_comercial_supervisor WHERE empresa_id=$1`, [empresa_id]);
  if (!supervisor?.discord_id) throw new Error('Supervisor sem ID do Discord cadastrado.');

  const reqGeral = { usuario: { empresa_id, perfil: 'admin' }, query: { ...query, vendedor: undefined, setor: query.setor || 'todos' } };
  const dados = await montarAnaliseMetaComercial(reqGeral);
  const { enviarDM } = require('../utils/discordBot');
  const { gerarPDFMetaComercialAnalise } = require('../utils/gerarPDFMetaComercialAnalise');
  // Relatório do supervisor é o GERAL do setor — não leva nome de cliente nenhum,
  // só quem está com a própria análise individual recebe a lista de clientes.
  const pdfBuffer = await gerarPDFMetaComercialAnalise(dados, { semClientes: true });
  const [anoP, mesP] = dados.mes.split('-').map(Number);
  const periodo = dados.data
    ? new Date(anoP, mesP - 1, Number(dados.data.slice(8, 10))).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date(anoP, mesP - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const r = dados.resumo || {};
  const nomeArquivo = `Analise-Meta-Comercial-Geral-${dados.mes}`
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9.\-]/g, '_') + '.pdf';

  await enviarDM(supervisor.discord_id, {
    content: `📊 **Relatório geral do Comercial — ${periodo}**\n`
      + `Meta: **${r.meta ?? '—'}** | Vendas: **${r.vendas ?? '—'}** | Cancelamentos: **${r.cancelamentos ?? '—'}** | Saldo: **${r.saldo ?? '—'}**\n`
      + `% da meta: **${r.pct == null ? '—' : `${r.pct}%`}** | Vendedores que bateram: **${r.bateram ?? '—'} de ${r.vendedores ?? '—'}**`,
    embed: {
      title: '📊 Relatório geral do Comercial',
      description: `Período: **${periodo}**`,
      fields: [
        { name: 'Meta', value: String(r.meta ?? '—'), inline: true },
        { name: 'Vendas', value: String(r.vendas ?? '—'), inline: true },
        { name: 'Cancelamentos', value: String(r.cancelamentos ?? '—'), inline: true },
        { name: 'Saldo', value: String(r.saldo ?? '—'), inline: true },
        { name: '% da meta', value: r.pct == null ? '—' : `${r.pct}%`, inline: true },
        { name: 'Bateram a meta', value: `${r.bateram ?? '—'} de ${r.vendedores ?? '—'}`, inline: true },
      ],
      color: (r.pct ?? 0) >= 100 ? 0x16a34a : 0xf59e0b,
      footer: { text: 'Kronos — Meta do Comercial' },
      timestamp: new Date().toISOString(),
    },
    arquivo: { nome: nomeArquivo, buffer: pdfBuffer, mime: 'application/pdf' },
  });
  return supervisor.nome || 'supervisor';
}

router.post('/meta-comercial/analise/enviar-discord-supervisor', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const enviado_para = await enviarRelatorioGeralSupervisor(req.usuario.empresa_id, req.query);
    res.json({ ok: true, enviado_para });
  } catch (e) { res.status(e.message.includes('Discord') ? 400 : 500).json({ erro: e.message }); }
});

// Histórico dos PDFs já gerados (acompanhamento)
router.get('/meta-comercial/pdfs', autenticar, exigirVerMetaComercial, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, mes, arquivo, gerado_por_nome, total_vendas, total_bonus, created_at
       FROM meta_comercial_pdf WHERE empresa_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.usuario.empresa_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/meta-comercial/vendedor', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    let { nome, filial, hubsoft_email, hubsoft_id_vendedor, usuario_id, meta, bonus_meta, bonus_gap, conta_meta, ordem, discord_id } = req.body;
    // Vínculo com usuário real do Kronos: confirma que pertence à mesma empresa e usa o nome de lá.
    if (usuario_id) {
      const u = await get(`SELECT id, nome FROM usuarios WHERE id=$1 AND empresa_id=$2`, [usuario_id, req.usuario.empresa_id]);
      if (!u) return res.status(400).json({ erro: 'Usuário inválido' });
      nome = u.nome;
    }
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO meta_comercial_vendedor (id,empresa_id,usuario_id,nome,filial,hubsoft_email,hubsoft_id_vendedor,meta,bonus_meta,bonus_gap,conta_meta,ordem,discord_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, req.usuario.empresa_id, usuario_id || null, nome, filial || null, (hubsoft_email || '').toLowerCase() || null, hubsoft_id_vendedor || null,
       meta || 0, bonus_meta || 0, bonus_gap || 0, conta_meta !== false, ordem || 0, (discord_id || '').replace(/\D/g, '') || null]
    );
    res.status(201).json(await get(`SELECT * FROM meta_comercial_vendedor WHERE id=$1`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta-comercial/vendedor/:id', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM meta_comercial_vendedor WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    let { nome, filial, hubsoft_email, hubsoft_id_vendedor, usuario_id, meta, bonus_meta, bonus_gap, conta_meta, ativo, ordem, discord_id } = req.body;
    if (usuario_id) {
      const u = await get(`SELECT id, nome FROM usuarios WHERE id=$1 AND empresa_id=$2`, [usuario_id, req.usuario.empresa_id]);
      if (!u) return res.status(400).json({ erro: 'Usuário inválido' });
      nome = u.nome;
    }
    await run(
      `UPDATE meta_comercial_vendedor SET
         nome=$1, filial=$2, hubsoft_email=$3, hubsoft_id_vendedor=$4, usuario_id=$5, meta=$6, bonus_meta=$7, bonus_gap=$8,
         conta_meta=$9, ativo=$10, ordem=$11, discord_id=$12
       WHERE id=$13 AND empresa_id=$14`,
      [nome, filial || null, (hubsoft_email || '').toLowerCase() || null, hubsoft_id_vendedor || null, usuario_id || null,
       meta || 0, bonus_meta || 0, bonus_gap || 0, conta_meta !== false, ativo !== false, ordem || 0,
       (discord_id || '').replace(/\D/g, '') || null,
       req.params.id, req.usuario.empresa_id]
    );
    res.json(await get(`SELECT * FROM meta_comercial_vendedor WHERE id=$1`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/meta-comercial/vendedor/:id', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run(`DELETE FROM meta_comercial_vendedor WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta-comercial/supervisor', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, faixa1_pct, faixa1_valor, faixa2_pct, faixa2_valor, salario, discord_id } = req.body;
    await run(
      `INSERT INTO meta_comercial_supervisor (empresa_id,nome,faixa1_pct,faixa1_valor,faixa2_pct,faixa2_valor,salario,discord_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (empresa_id) DO UPDATE SET nome=$2,faixa1_pct=$3,faixa1_valor=$4,faixa2_pct=$5,faixa2_valor=$6,salario=$7,discord_id=$8`,
      [req.usuario.empresa_id, nome || null, faixa1_pct ?? 15, faixa1_valor || 0, faixa2_pct ?? 25, faixa2_valor || 0, salario || 0,
       (discord_id || '').replace(/\D/g, '') || null]
    );
    res.json(await get(`SELECT * FROM meta_comercial_supervisor WHERE empresa_id=$1`, [req.usuario.empresa_id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Sincronização manual (a usuária dispara conscientemente; tem cooldown de 10 min
// para evitar clique repetido sobrecarregando o ERP).
let _ultimaSyncManual = {};
router.post('/meta-comercial/sync-agora', autenticar, async (req, res) => {
  try {
    if (!PODE_EDITAR_META_COMERCIAL.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const eid = req.usuario.empresa_id;
    const agora = Date.now();
    if (_ultimaSyncManual[eid] && agora - _ultimaSyncManual[eid] < 2 * 60 * 1000) {
      return res.status(429).json({ erro: 'Aguarde alguns minutos antes de sincronizar novamente.' });
    }
    _ultimaSyncManual[eid] = agora;
    const { sincronizarEmpresa } = require('../jobs/syncMetaComercial');
    const n = await sincronizarEmpresa(eid);
    // Também busca cidade, bairro, origem, status e situação do contrato —
    // senão o botão "Atualizar agora" traria a venda, mas sem esses dados.
    const enriquecido = await require('../jobs/enriquecerVendas').enriquecerRecentes(eid).catch(e => ({ erro: e.message }));
    res.json({ ok: true, servicos_sincronizados: n, enriquecido, quando: new Date().toISOString() });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exposto para os jobs (aviso de meta batida, rankings automáticos)
router.montarMetaComercial = montarMetaComercial;
router.enviarRelatorioGeralSupervisor = enviarRelatorioGeralSupervisor;
router.enviarAnalisesIndividuaisVendedores = enviarAnalisesIndividuaisVendedores;
module.exports = router;
