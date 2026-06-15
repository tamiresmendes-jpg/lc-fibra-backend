const express = require('express');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;

    const rowColaboradores = await get("SELECT COUNT(*) as total FROM usuarios WHERE empresa_id=$1 AND ativo=1", [eid]);
    const totalColaboradores = rowColaboradores.total;
    const rowDepartamentos = await get("SELECT COUNT(*) as total FROM departamentos WHERE empresa_id=$1", [eid]);
    const totalDepartamentos = rowDepartamentos.total;
    const rowPops = await get("SELECT COUNT(*) as total FROM pops WHERE empresa_id=$1", [eid]);
    const totalPops = rowPops.total;
    const rowPopsAtivos = await get("SELECT COUNT(*) as total FROM pops WHERE empresa_id=$1 AND status='ativo'", [eid]);
    const popsAtivos = rowPopsAtivos.total;
    const rowAuditorias = await get("SELECT COUNT(*) as total FROM auditorias WHERE empresa_id=$1", [eid]);
    const totalAuditorias = rowAuditorias.total;
    const rowMedia = await get("SELECT AVG(score) as media FROM auditorias WHERE empresa_id=$1 AND score IS NOT NULL", [eid]);
    const mediaScore = rowMedia.media;
    const rowAbertas = await get("SELECT COUNT(*) as total FROM acoes WHERE empresa_id=$1 AND status='aberta'", [eid]);
    const acoesAbertas = rowAbertas.total;
    const rowConcluidas = await get("SELECT COUNT(*) as total FROM acoes WHERE empresa_id=$1 AND status='concluida'", [eid]);
    const acoesConcluidas = rowConcluidas.total;
    const rowComunicados = await get("SELECT COUNT(*) as total FROM comunicados WHERE empresa_id=$1 AND ativo=1", [eid]);
    const totalComunicados = rowComunicados.total;
    const rowTreinamentos = await get("SELECT COUNT(*) as total FROM treinamentos WHERE empresa_id=$1", [eid]);
    const totalTreinamentos = rowTreinamentos.total;

    const ultimasAuditorias = await all(`
      SELECT a.titulo, a.score, a.status, a.created_at, u.nome as auditado_nome
      FROM auditorias a LEFT JOIN usuarios u ON u.id = a.auditado_id
      WHERE a.empresa_id=$1 ORDER BY a.created_at DESC LIMIT 5
    `, [eid]);

    const ultimasAcoes = await all(`
      SELECT a.titulo, a.prioridade, a.status, a.data_prazo, u.nome as responsavel_nome
      FROM acoes a LEFT JOIN usuarios u ON u.id = a.responsavel_id
      WHERE a.empresa_id=$1 ORDER BY a.created_at DESC LIMIT 5
    `, [eid]);

    const ultimosComunicados = await all(`
      SELECT c.titulo, c.tipo, c.created_at, u.nome as publicado_por_nome
      FROM comunicados c LEFT JOIN usuarios u ON u.id = c.publicado_por
      WHERE c.empresa_id=$1 AND c.ativo=1 ORDER BY c.created_at DESC LIMIT 5
    `, [eid]);

    const proximasReunioes = await all(`
      SELECT r.titulo, r.tipo, r.data_reuniao, r.local, u.nome as criado_por_nome
      FROM reunioes r LEFT JOIN usuarios u ON u.id = r.criado_por
      WHERE r.empresa_id=$1 AND r.status='agendada' AND r.data_reuniao >= TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
      ORDER BY r.data_reuniao ASC LIMIT 5
    `, [eid]);

    const rowIndicadores = await get("SELECT COUNT(*) as total FROM indicadores WHERE empresa_id=$1", [eid]);
    const totalIndicadores = rowIndicadores.total;
    const rowProcessos = await get("SELECT COUNT(*) as total FROM processos WHERE empresa_id=$1 AND status='ativo'", [eid]);
    const totalProcessos = rowProcessos.total;

    // POPs em revisão
    const popsEmRevisao = await all(`
      SELECT p.id, p.titulo, p.versao, p.updated_at, u.nome as criado_por_nome
      FROM pops p LEFT JOIN usuarios u ON u.id = p.criado_por
      WHERE p.empresa_id=$1 AND p.status='revisao'
      ORDER BY p.updated_at DESC LIMIT 10
    `, [eid]);

    // Lançamentos recentes (status ativo, ordenados por data de criação)
    const popsLancados = await all(`
      SELECT p.id, p.titulo, p.versao, p.created_at, u.nome as criado_por_nome,
             c.nome as categoria_nome, c.cor as categoria_cor
      FROM pops p
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      WHERE p.empresa_id=$1 AND p.status='ativo'
      ORDER BY p.created_at DESC LIMIT 5
    `, [eid]);

    // Solicitações de auditoria pendentes
    const solicitacoesAuditoria = await all(`
      SELECT s.id, s.tipo, s.descricao, s.status, s.created_at,
             p.titulo as pop_titulo, p.versao as pop_versao,
             u.nome as solicitante_nome
      FROM auditoria_solicitacoes s
      LEFT JOIN pops p ON p.id = s.pop_id
      LEFT JOIN usuarios u ON u.id = s.solicitante_id
      WHERE s.empresa_id=$1 AND s.status='pendente'
      ORDER BY s.created_at DESC LIMIT 5
    `, [eid]);

    // POPs mais visualizados (excluindo admin)
    const popsMaisVistos = await all(`
      SELECT p.id, p.titulo, p.versao, p.total_visualizacoes,
             c.nome as categoria_nome, c.cor as categoria_cor
      FROM pops p
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      WHERE p.empresa_id=$1 AND p.status='ativo' AND p.total_visualizacoes > 0
      ORDER BY p.total_visualizacoes DESC LIMIT 5
    `, [eid]);

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
      popsMaisVistos
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
