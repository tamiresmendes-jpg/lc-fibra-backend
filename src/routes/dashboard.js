const express = require('express');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;

    // Todas as queries em paralelo — reduz de ~20 awaits sequenciais para 2 rodadas paralelas
    const [
      rowResumo,
      ultimasAuditorias,
      ultimasAcoes,
      ultimosComunicados,
      proximasReunioes,
      popsEmRevisao,
      popsLancados,
      solicitacoesAuditoria,
      popsMaisVistos,
    ] = await Promise.all([
      get(`SELECT
        (SELECT COUNT(*) FROM usuarios     WHERE empresa_id=$1 AND ativo=1)           as total_colaboradores,
        (SELECT COUNT(*) FROM departamentos WHERE empresa_id=$1)                       as total_departamentos,
        (SELECT COUNT(*) FROM pops          WHERE empresa_id=$1)                       as total_pops,
        (SELECT COUNT(*) FROM pops          WHERE empresa_id=$1 AND status='ativo')    as pops_ativos,
        (SELECT COUNT(*) FROM auditorias    WHERE empresa_id=$1)                       as total_auditorias,
        (SELECT AVG(score) FROM auditorias  WHERE empresa_id=$1 AND score IS NOT NULL) as media_score,
        (SELECT COUNT(*) FROM acoes         WHERE empresa_id=$1 AND status='aberta')   as acoes_abertas,
        (SELECT COUNT(*) FROM acoes         WHERE empresa_id=$1 AND status='concluida') as acoes_concluidas,
        (SELECT COUNT(*) FROM comunicados   WHERE empresa_id=$1 AND ativo=1)           as total_comunicados,
        (SELECT COUNT(*) FROM treinamentos  WHERE empresa_id=$1)                       as total_treinamentos,
        (SELECT COUNT(*) FROM indicadores   WHERE empresa_id=$1)                       as total_indicadores,
        (SELECT COUNT(*) FROM processos     WHERE empresa_id=$1 AND status='ativo')    as total_processos
      `, [eid]),
      all(`SELECT a.titulo, a.score, a.status, a.created_at, u.nome as auditado_nome
           FROM auditorias a LEFT JOIN usuarios u ON u.id = a.auditado_id
           WHERE a.empresa_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [eid]),
      all(`SELECT a.titulo, a.prioridade, a.status, a.data_prazo, u.nome as responsavel_nome
           FROM acoes a LEFT JOIN usuarios u ON u.id = a.responsavel_id
           WHERE a.empresa_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [eid]),
      all(`SELECT c.titulo, c.tipo, c.created_at, u.nome as publicado_por_nome
           FROM comunicados c LEFT JOIN usuarios u ON u.id = c.publicado_por
           WHERE c.empresa_id=$1 AND c.ativo=1 ORDER BY c.created_at DESC LIMIT 5`, [eid]),
      all(`SELECT r.titulo, r.tipo, r.data_reuniao, r.local, u.nome as criado_por_nome
           FROM reunioes r LEFT JOIN usuarios u ON u.id = r.criado_por
           WHERE r.empresa_id=$1 AND r.status='agendada'
             AND r.data_reuniao >= TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
           ORDER BY r.data_reuniao ASC LIMIT 5`, [eid]),
      all(`SELECT p.id, p.titulo, p.versao, p.updated_at, u.nome as criado_por_nome
           FROM pops p LEFT JOIN usuarios u ON u.id = p.criado_por
           WHERE p.empresa_id=$1 AND p.status='revisao'
           ORDER BY p.updated_at DESC LIMIT 10`, [eid]),
      all(`SELECT p.id, p.titulo, p.versao, p.created_at, u.nome as criado_por_nome,
                  c.nome as categoria_nome, c.cor as categoria_cor
           FROM pops p LEFT JOIN usuarios u ON u.id = p.criado_por
           LEFT JOIN categorias_pop c ON c.id = p.categoria_id
           WHERE p.empresa_id=$1 AND p.status='ativo'
           ORDER BY p.created_at DESC LIMIT 5`, [eid]),
      all(`SELECT s.id, s.tipo, s.descricao, s.status, s.created_at,
                  p.titulo as pop_titulo, p.versao as pop_versao, u.nome as solicitante_nome
           FROM auditoria_solicitacoes s LEFT JOIN pops p ON p.id = s.pop_id
           LEFT JOIN usuarios u ON u.id = s.solicitante_id
           WHERE s.empresa_id=$1 AND s.status='pendente'
           ORDER BY s.created_at DESC LIMIT 5`, [eid]),
      all(`SELECT p.id, p.titulo, p.versao, p.total_visualizacoes,
                  c.nome as categoria_nome, c.cor as categoria_cor
           FROM pops p LEFT JOIN categorias_pop c ON c.id = p.categoria_id
           WHERE p.empresa_id=$1 AND p.status='ativo' AND p.total_visualizacoes > 0
           ORDER BY p.total_visualizacoes DESC LIMIT 5`, [eid]),
    ]);

    // Queries opcionais — não quebram o dashboard se a tabela não existir ainda
    const safe = async (fn) => { try { return await fn(); } catch { return []; } };
    const [proximosCoffeeBreaks] = await Promise.all([
      safe(() => all(`SELECT id, unidade, data, horario, titulo, observacao
           FROM coffee_breaks
           WHERE empresa_id=$1 AND ativo=1
             AND data >= TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD')
           ORDER BY data ASC LIMIT 5`, [eid])),
    ]);

    const totalColaboradores = rowResumo.total_colaboradores;
    const totalDepartamentos = rowResumo.total_departamentos;
    const totalPops          = rowResumo.total_pops;
    const popsAtivos         = rowResumo.pops_ativos;
    const totalAuditorias    = rowResumo.total_auditorias;
    const mediaScore         = rowResumo.media_score;
    const acoesAbertas       = rowResumo.acoes_abertas;
    const acoesConcluidas    = rowResumo.acoes_concluidas;
    const totalComunicados   = rowResumo.total_comunicados;
    const totalTreinamentos  = rowResumo.total_treinamentos;
    const totalIndicadores   = rowResumo.total_indicadores;
    const totalProcessos     = rowResumo.total_processos;

    res.json({
      resumo: {
        totalColaboradores,
        totalDepartamentos,
        totalPops,
        popsAtivos,
        totalAuditorias,
        mediaScore: mediaScore ? Math.round(mediaScore * 10) / 10 : null,
        acoesAbertas,
        acoesConcluidas,
        totalComunicados,
        totalTreinamentos,
        totalIndicadores,
        totalProcessos
      },
      ultimasAuditorias,
      ultimasAcoes,
      ultimosComunicados,
      proximasReunioes,
      popsLancados,
      popsEmRevisao,
      solicitacoesAuditoria,
      popsMaisVistos,
      proximosCoffeeBreaks,
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
