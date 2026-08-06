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

// A Meta do Comercial expõe salário do supervisor e bônus por vendedor, então a LEITURA
// também é verificada no servidor (o middleware global só cobre POST/PUT/DELETE).
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');
async function exigirVerMetaComercial(req, res, next) {
  try {
    const u = req.usuario;
    if (u.perfil === 'admin') return next();
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

router.get('/meta-comercial/analise', autenticar, exigirVerMetaComercial, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const setor = (req.query.setor || 'todos').toLowerCase(); // todos | comercial | pap | escritorio

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
    // 2) Dentro do setor, pode restringir a um vendedor
    const vendedorId = (req.query.vendedor || '').trim();
    let itens = vendedorId ? doSetor.filter(i => String(i.id) === vendedorId) : doSetor;
    const emails = itens.map(i => (i.hubsoft_email || '').toLowerCase()).filter(Boolean);

    // Vendas do mês (excluindo as canceladas dentro do próprio mês — mesma regra do painel)
    const filtroVendas = `empresa_id=$1 AND TO_CHAR(data_venda,'YYYY-MM')=$2
       AND NOT (data_cancelamento IS NOT NULL AND TO_CHAR(data_cancelamento,'YYYY-MM')=$2)
       AND LOWER(vendedor_email) = ANY($3)`;
    const p = [eid, mes, emails.length ? emails : ['']];

    const [porDia, porServico, porTipo, porTecnologia, porStatus, receita] = await Promise.all([
      all(`SELECT TO_CHAR(data_venda,'DD') AS dia, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 1`, p),
      all(`SELECT COALESCE(NULLIF(nome_servico,''),'Sem plano') AS servico, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, p),
      all(`SELECT CASE WHEN LOWER(COALESCE(tipo_pessoa,''))='pj' THEN 'Pessoa Jurídica'
                       WHEN LOWER(COALESCE(tipo_pessoa,''))='pf' THEN 'Pessoa Física'
                       ELSE 'Não informado' END AS tipo, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT COALESCE(NULLIF(tecnologia,''),'Não informada') AS tecnologia, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      // Status do serviço vem do próprio cadastro do serviço (não da ordem de serviço)
      all(`SELECT INITCAP(REPLACE(COALESCE(NULLIF(status_prefixo,''),'nao_informado'),'_',' ')) AS status,
                  COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      get(`SELECT COALESCE(SUM(valor),0)::float AS total, COALESCE(AVG(valor),0)::float AS ticket
           FROM meta_comercial_venda_sync WHERE ${filtroVendas}`, p),
    ]);

    // Cortes que dependem do Relatório de Serviços do painel (cidade real, bairro,
    // origem e contrato). Ficam vazios até o enriquecimento rodar.
    const [porCidadeReal, porBairro, porOrigem, porContrato, clientes] = await Promise.all([
      all(`SELECT cidade, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND cidade IS NOT NULL AND cidade <> ''
           GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT bairro, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND bairro IS NOT NULL AND bairro <> ''
           GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, p),
      all(`SELECT INITCAP(origem) AS origem, COUNT(*)::int AS qtd FROM meta_comercial_venda_sync
           WHERE ${filtroVendas} AND origem IS NOT NULL AND origem <> ''
           GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT COALESCE(NULLIF(situacao_contrato,''),'Não informado') AS contrato, COUNT(*)::int AS qtd
           FROM meta_comercial_venda_sync WHERE ${filtroVendas} GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT nome_cliente, nome_servico, cidade, bairro, origem, servico_status,
                  TO_CHAR(data_venda,'DD/MM/YYYY') AS data_venda,
                  CASE WHEN LOWER(COALESCE(tipo_pessoa,''))='pj' THEN 'PJ' ELSE 'PF' END AS tipo
           FROM meta_comercial_venda_sync WHERE ${filtroVendas}
           ORDER BY data_venda, nome_cliente LIMIT 400`, p),
    ]);

    // Por filial (meta x vendas x %) e por cidade — a partir dos itens já calculados
    const porFilial = [];
    const cidades = {};
    for (const i of itens) {
      const metaI = i.conta_meta ? (i.meta || 0) : 0;
      porFilial.push({
        filial: i.filial || 'Sem filial',
        vendedor: i.nome,
        meta: metaI,
        vendas: i.qtd_vendas || 0,
        saldo: i.saldo || 0,
        pct: metaI > 0 ? Math.round(((i.saldo || 0) / metaI) * 100) : null,
      });
      const cid = cidadeDaFilial(i.filial);
      cidades[cid] = (cidades[cid] || 0) + (i.qtd_vendas || 0);
    }
    porFilial.sort((a, b) => b.vendas - a.vendas);

    const totalMeta = itens.reduce((s, i) => s + (i.conta_meta ? (i.meta || 0) : 0), 0);
    const totalVendas = itens.reduce((s, i) => s + (i.qtd_vendas || 0), 0);
    const totalCancel = itens.reduce((s, i) => s + (i.cancelamento || 0), 0);
    const totalSaldo = itens.reduce((s, i) => s + (i.saldo || 0), 0);

    res.json({
      mes, setor,
      resumo: {
        meta: totalMeta,
        vendas: totalVendas,
        cancelamentos: totalCancel,
        saldo: totalSaldo,
        pct: totalMeta > 0 ? Math.round((totalSaldo / totalMeta) * 100) : null,
        bateram: itens.filter(i => i.bate_meta).length,
        vendedores: itens.length,
        receita: Math.round((receita?.total || 0) * 100) / 100,
        ticket_medio: Math.round((receita?.ticket || 0) * 100) / 100,
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
      clientes,
      // Só os do setor selecionado, para o seletor não misturar times
      vendedores: doSetor.map(i => ({ id: i.id, nome: i.nome, filial: i.filial })),
      vendedor_selecionado: vendedorId || null,
      por_dia: porDia.map(d => ({ dia: parseInt(d.dia, 10), qtd: d.qtd })),
      por_servico: porServico,
      por_tipo: porTipo,
      por_tecnologia: porTecnologia,
      por_status: porStatus,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
    let { nome, filial, hubsoft_email, hubsoft_id_vendedor, usuario_id, meta, bonus_meta, bonus_gap, conta_meta, ordem } = req.body;
    // Vínculo com usuário real do Kronos: confirma que pertence à mesma empresa e usa o nome de lá.
    if (usuario_id) {
      const u = await get(`SELECT id, nome FROM usuarios WHERE id=$1 AND empresa_id=$2`, [usuario_id, req.usuario.empresa_id]);
      if (!u) return res.status(400).json({ erro: 'Usuário inválido' });
      nome = u.nome;
    }
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO meta_comercial_vendedor (id,empresa_id,usuario_id,nome,filial,hubsoft_email,hubsoft_id_vendedor,meta,bonus_meta,bonus_gap,conta_meta,ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.usuario.empresa_id, usuario_id || null, nome, filial || null, (hubsoft_email || '').toLowerCase() || null, hubsoft_id_vendedor || null,
       meta || 0, bonus_meta || 0, bonus_gap || 0, conta_meta !== false, ordem || 0]
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
    const { nome, faixa1_pct, faixa1_valor, faixa2_pct, faixa2_valor, salario } = req.body;
    await run(
      `INSERT INTO meta_comercial_supervisor (empresa_id,nome,faixa1_pct,faixa1_valor,faixa2_pct,faixa2_valor,salario)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (empresa_id) DO UPDATE SET nome=$2,faixa1_pct=$3,faixa1_valor=$4,faixa2_pct=$5,faixa2_valor=$6,salario=$7`,
      [req.usuario.empresa_id, nome || null, faixa1_pct ?? 15, faixa1_valor || 0, faixa2_pct ?? 25, faixa2_valor || 0, salario || 0]
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
    res.json({ ok: true, servicos_sincronizados: n });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exposto para os jobs (aviso de meta batida, rankings automáticos)
router.montarMetaComercial = montarMetaComercial;
module.exports = router;
