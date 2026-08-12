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
    tpz.nome AS trilha_principal_nome,
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
  LEFT JOIN treinamento_trilhas_principais tpz ON tpz.id = t.trilha_principal_id
`;

async function trDaEmpresa(id, eid) {
  return await get('SELECT id FROM treinamentos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [id, eid]);
}

// Lista as trilhas ATRIBUÍDAS (eh_modelo=0) — o que aparece em "Treinamentos".
// Os MODELOS (montados em "Trilhas de Aprendizagem") não entram aqui, senão
// apareceriam misturados com trilhas reais de colaboradores.
router.get('/', async (req, res) => {
  try {
    const itens = await all(`${SELECT_TREINAMENTO} WHERE t.empresa_id = $1 AND t.excluido_em IS NULL AND COALESCE(t.eh_modelo,0) = 0 ORDER BY (CASE WHEN t.ordem > 0 THEN t.ordem ELSE 999999 END) ASC, t.created_at DESC`, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Lista os MODELOS de trilha (montados em "Trilhas de Aprendizagem") — usado
// tanto pra gerenciar o modelo em si quanto pro seletor "Atribuir trilha" em Treinamentos.
router.get('/modelos', async (req, res) => {
  try {
    const itens = await all(`${SELECT_TREINAMENTO} WHERE t.empresa_id = $1 AND t.excluido_em IS NULL AND t.eh_modelo = 1 ORDER BY (CASE WHEN t.ordem > 0 THEN t.ordem ELSE 999999 END) ASC, t.created_at DESC`, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── REORDENAR (dentro da mesma pasta/lista) ─────────────────────────────────
// ids: array com os ids na nova ordem (o índice+1 vira o número de cada uma).
// Precisa vir ANTES de PUT /:id, senão "reordenar" seria lido como um id.
router.put('/reordenar', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ erro: 'ids deve ser array' });
    for (const [i, id] of ids.entries()) {
      await run('UPDATE treinamentos SET ordem=$1 WHERE id=$2 AND empresa_id=$3', [i + 1, id, req.usuario.empresa_id]);
    }
    res.json({ mensagem: 'Reordenado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── TRILHAS PRINCIPAIS (departamento agrupando "trilhas do dia") ────────────
// A mesma pasta (ex.: "CALL CENTER") é usada tanto por Treinamentos (trilhas
// ATRIBUÍDAS, eh_modelo=0) quanto por Trilhas de Aprendizagem (MODELOS,
// eh_modelo=1) — sem duplicar a pasta, cada tela só conta/lista o que é dela.
// ?eh_modelo=0 ou 1 filtra a contagem; sem o parâmetro, conta tudo.
router.get('/trilhas-principais', async (req, res) => {
  try {
    const filtroModelo = req.query.eh_modelo === '0' || req.query.eh_modelo === '1'
      ? ` AND COALESCE(t.eh_modelo,0) = ${req.query.eh_modelo === '1' ? 1 : 0}` : '';
    const itens = await all(`
      SELECT tpz.*, d.nome AS departamento_nome,
        (SELECT COUNT(*) FROM treinamentos t WHERE t.trilha_principal_id = tpz.id AND t.excluido_em IS NULL${filtroModelo}) AS total_trilhas,
        (SELECT STRING_AGG(DISTINCT u.nome, ', ') FROM treinamentos t
          LEFT JOIN usuarios u ON u.id = t.colaborador_id
          WHERE t.trilha_principal_id = tpz.id AND t.excluido_em IS NULL AND u.nome IS NOT NULL${filtroModelo}
        ) AS colaboradores_nomes
      FROM treinamento_trilhas_principais tpz
      LEFT JOIN departamentos d ON d.id = tpz.departamento_id
      WHERE tpz.empresa_id = $1
      ORDER BY tpz.nome ASC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/trilhas-principais', async (req, res) => {
  try {
    const { nome, departamento_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO treinamento_trilhas_principais (id, empresa_id, nome, departamento_id) VALUES ($1,$2,$3,$4)',
      [id, req.usuario.empresa_id, nome, departamento_id || null]);
    res.status(201).json({ id, nome });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/trilhas-principais/:id', async (req, res) => {
  try {
    const { nome, departamento_id } = req.body;
    await run('UPDATE treinamento_trilhas_principais SET nome=$1, departamento_id=$2 WHERE id=$3 AND empresa_id=$4',
      [nome, departamento_id || null, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/trilhas-principais/:id', async (req, res) => {
  try {
    // Não apaga as trilhas do dia — só desvincula (elas continuam existindo soltas).
    await run('UPDATE treinamentos SET trilha_principal_id=NULL WHERE trilha_principal_id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    await run('DELETE FROM treinamento_trilhas_principais WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removida' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meus', async (req, res) => {
  try {
    const isAdmin = req.usuario.perfil === 'admin';
    // colaborador_id (t ou do módulo, no modo dividido) = quem VAI SER TREINADO.
    // instrutor_id de um tópico ou responsavel_id da trilha = quem VAI TREINAR.
    // Manda os dois flags pro front decidir em qual seção mostrar — sem eles, dava
    // pra confundir "seu módulo pra ser treinado" com "você é o instrutor".
    const itens = await all(`
      SELECT z.*,
        (z.colaborador_id = $3 OR EXISTS (SELECT 1 FROM treinamento_modulos tm WHERE tm.treinamento_id = z.id AND tm.colaborador_id = $3)) AS sou_treinando,
        (z.responsavel_id = $3
          OR EXISTS (SELECT 1 FROM treinamento_pops tp WHERE tp.treinamento_id = z.id AND tp.instrutor_id = $3)
          OR EXISTS (SELECT 1 FROM treinamento_modulos tm WHERE tm.treinamento_id = z.id AND tm.instrutor_id = $3)
        ) AS sou_instrutor
      FROM (${SELECT_TREINAMENTO}
        WHERE t.empresa_id = $1 AND t.excluido_em IS NULL AND (
          $2 = 1 OR t.colaborador_id = $3 OR t.responsavel_id = $3
          OR EXISTS (SELECT 1 FROM treinamento_pops tp WHERE tp.treinamento_id = t.id AND tp.instrutor_id = $3)
          OR EXISTS (SELECT 1 FROM treinamento_modulos tm WHERE tm.treinamento_id = t.id AND (tm.colaborador_id = $3 OR tm.instrutor_id = $3))
        )
      ) z
      ORDER BY z.data_hora ASC
    `, [req.usuario.empresa_id, isAdmin ? 1 : 0, req.usuario.id]);
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

// Salva os módulos de uma trilha (e os pops/sub-módulos de cada um). Usado
// tanto na criação quanto na edição — sempre substitui tudo do zero, é mais
// simples e evita ordem/id dessincronizados entre módulos e pops.
async function salvarModulos(treinamentoId, modulos) {
  await run(`DELETE FROM treinamento_pops WHERE treinamento_id=$1 AND modulo_id IS NOT NULL`, [treinamentoId]);
  await run(`DELETE FROM treinamento_modulos WHERE treinamento_id=$1`, [treinamentoId]);
  if (!Array.isArray(modulos)) return;
  for (const [mi, mod] of modulos.entries()) {
    const moduloId = uuidv4();
    await run(`INSERT INTO treinamento_modulos (id, treinamento_id, nome, ordem, colaborador_id, instrutor_id, data_prevista) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [moduloId, treinamentoId, mod.nome, mi, mod.colaborador_id || null, mod.instrutor_id || null, mod.data_prevista || null]);
    for (const [pi, item] of (mod.pops || []).entries()) {
      // Sub-módulo pode ser só um tópico em texto (sem POP) — titulo/descricao
      // valem nesse caso; com POP, o título vem do próprio POP, mas a
      // descrição (texto explicando o tópico) continua podendo ser usada.
      await run(`INSERT INTO treinamento_pops
        (id, treinamento_id, pop_id, ordem, instrutor_id, tempo_estimado, topicos, versao_pop, data_prevista, modulo_id, titulo, descricao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT versao FROM pops WHERE id = $3),$8,$9,$10,$11)
        ON CONFLICT DO NOTHING
      `, [uuidv4(), treinamentoId, item.pop_id || null, pi, item.instrutor_id || null, item.tempo_estimado || 0, item.topicos || null, item.data_prevista || null, moduloId, item.titulo || null, item.descricao || null]);
    }
  }
}

router.post('/', async (req, res) => {
  try {
    const { titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, pop_ids, modo_repasse, modulos, trilha_principal_id, eh_modelo, ordem } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO treinamentos
      (id, empresa_id, titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, status_agenda, modo_repasse, trilha_principal_id, eh_modelo, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'agendado',$10,$11,$12,$13)
    `, [id, req.usuario.empresa_id, titulo, tipo_trilha || 'onboarding', departamento_id || null, responsavel_id || null, colaborador_id || null, data_hora || null, observacoes || null, modo_repasse || 'completa', trilha_principal_id || null, eh_modelo ? 1 : 0, Number(ordem) || 0]);

    // Trilha com módulos (o formato novo) — pop_ids solto continua existindo
    // pra treinamento "avulso" (sem estrutura de módulo, mais simples).
    if (Array.isArray(modulos) && modulos.length) {
      await salvarModulos(id, modulos);
    } else if (Array.isArray(pop_ids) && pop_ids.length) {
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

    // pop_id é opcional agora (sub-módulo pode ser só um tópico em texto) — por
    // isso LEFT JOIN, e o título exibido usa o do POP quando tem, senão o
    // título digitado à mão (tp.titulo). A descrição (texto explicando o
    // tópico) é sempre a de tp.descricao, tenha POP ou não.
    // tp.ordem é a posição DENTRO do módulo (cada módulo recomeça do 0) — sem
    // ordenar primeiro pelo módulo, tópicos de módulos diferentes com a mesma
    // posição ficavam embaralhados na lista plana (ex.: um tópico do módulo 3
    // aparecendo antes de um do módulo 1). Mesma ordem usada no bloqueio
    // sequencial (ver PUT /:id/pops/:pop_id/concluir).
    const pops = await all(`
      SELECT tp.id, tp.treinamento_id, tp.pop_id, tp.concluido, tp.ordem, tp.instrutor_id,
             tp.tempo_estimado, tp.tempo_realizado, tp.topicos, tp.versao_pop, tp.data_prevista,
             tp.status_pop, tp.modulo_id, tp.descricao, tp.checklist_marcado,
             tp.data_inicio_real, tp.data_fim_real,
             COALESCE(p.titulo, tp.titulo) AS titulo, p.codigo, p.versao AS versao_atual,
             u.nome AS instrutor_nome,
             CASE WHEN tp.pop_id IS NOT NULL AND tp.versao_pop IS NOT NULL AND tp.versao_pop != p.versao THEN 1 ELSE 0 END AS precisa_reciclagem
      FROM treinamento_pops tp
      LEFT JOIN pops p ON p.id = tp.pop_id
      LEFT JOIN usuarios u ON u.id = tp.instrutor_id
      LEFT JOIN treinamento_modulos m ON m.id = tp.modulo_id
      WHERE tp.treinamento_id = $1
      ORDER BY COALESCE(m.ordem, -1) ASC, tp.ordem ASC
    `, [req.params.id]);

    const avaliacoes = await all('SELECT * FROM treinamento_avaliacoes WHERE treinamento_id = $1 ORDER BY ordem ASC', [req.params.id]);
    const anotacoes = await all(`
      SELECT ta.*, u.nome AS autor_nome
      FROM treinamento_anotacoes ta
      LEFT JOIN usuarios u ON u.id = ta.usuario_id
      WHERE ta.treinamento_id = $1 ORDER BY ta.created_at DESC
    `, [req.params.id]);

    // Módulos da trilha, com o colaborador designado (modo dividido) e o tempo
    // somado dos sub-módulos (pops) de cada um — pra saber quanto cada módulo
    // leva, e não só a trilha inteira.
    const modulosRaw = await all(`
      SELECT m.*, u.nome AS colaborador_nome, ui.nome AS instrutor_nome
      FROM treinamento_modulos m
      LEFT JOIN usuarios u ON u.id = m.colaborador_id
      LEFT JOIN usuarios ui ON ui.id = m.instrutor_id
      WHERE m.treinamento_id = $1 ORDER BY m.ordem ASC
    `, [req.params.id]);
    const modulos = modulosRaw.map(m => {
      const popsDoModulo = pops.filter(p => p.modulo_id === m.id);
      return {
        ...m,
        pops: popsDoModulo,
        tempo_estimado: popsDoModulo.reduce((s, p) => s + (p.tempo_estimado || 0), 0),
        tempo_realizado: popsDoModulo.reduce((s, p) => s + (p.tempo_realizado || 0), 0),
        concluidos: popsDoModulo.filter(p => p.concluido).length,
        total: popsDoModulo.length,
      };
    });
    const popsSemModulo = pops.filter(p => !p.modulo_id); // treinamento avulso, sem módulo

    res.json({ ...t, pops, popsSemModulo, modulos, avaliacoes, anotacoes });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Rota estreita só pra trocar o status_agenda (iniciar/concluir treinamento) —
// usada pelo próprio colaborador/instrutor em "Meu Treinamento". Não aceita
// titulo/modulos/pop_ids etc., então é segura pra liberar geral (ver
// ROTAS_PESSOAIS em utils/permissoes.js), diferente do PUT /:id completo que
// reconstrói a trilha inteira e por isso fica restrito a admin/gestor/líder.
router.put('/:id/status', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { status_agenda } = req.body;
    if (!['agendado', 'em_andamento', 'concluido'].includes(status_agenda)) return res.status(400).json({ erro: 'Status inválido' });
    await run('UPDATE treinamentos SET status_agenda=$1 WHERE id=$2 AND empresa_id=$3', [status_agenda, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, status_agenda, pop_ids, modo_repasse, modulos, trilha_principal_id, ordem } = req.body;
    // trilha_principal_id e ordem usam COALESCE: quando a chamada não manda
    // esses campos (ex.: os PUTs "minimalistas" que só mudam status/tempo),
    // mantém o valor já salvo em vez de apagar/zerar.
    await run(`UPDATE treinamentos SET
      titulo=$1, tipo_trilha=$2, departamento_id=$3, responsavel_id=$4, colaborador_id=$5, data_hora=$6, observacoes=$7, status_agenda=$8, modo_repasse=$9,
      trilha_principal_id=COALESCE($12, trilha_principal_id),
      ordem=COALESCE($13, ordem)
      WHERE id=$10 AND empresa_id=$11
    `, [titulo, tipo_trilha || 'onboarding', departamento_id || null, responsavel_id || null, colaborador_id || null, data_hora || null, observacoes || null, status_agenda || 'agendado', modo_repasse || 'completa', req.params.id, req.usuario.empresa_id, trilha_principal_id || null, ordem !== undefined && ordem !== '' ? Number(ordem) : null]);

    if (Array.isArray(modulos)) {
      await salvarModulos(req.params.id, modulos);
    } else if (Array.isArray(pop_ids)) {
      await run('DELETE FROM treinamento_pops WHERE treinamento_id=$1 AND modulo_id IS NULL', [req.params.id]);
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

// Adiciona POPs a um módulo já existente de uma trilha, SEM apagar o que já
// tem (diferente do PUT /:id, que substitui tudo do zero) — usado pela tela de
// POPs, pra selecionar vários POPs de uma vez e jogar direto num módulo.
// modulo_id = "__novo__" cria um módulo novo com o nome vindo em `novo_modulo_nome`.
router.post('/:id/modulos/:modulo_id/pops', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { pop_ids, novo_modulo_nome } = req.body;
    if (!Array.isArray(pop_ids) || !pop_ids.length) return res.status(400).json({ erro: 'Selecione ao menos um POP' });

    let moduloId = req.params.modulo_id;
    if (moduloId === '__novo__') {
      moduloId = uuidv4();
      const maxOrdem = await get('SELECT COALESCE(MAX(ordem),-1) AS m FROM treinamento_modulos WHERE treinamento_id=$1', [req.params.id]);
      await run('INSERT INTO treinamento_modulos (id, treinamento_id, nome, ordem) VALUES ($1,$2,$3,$4)',
        [moduloId, req.params.id, novo_modulo_nome || 'Novo módulo', (maxOrdem?.m ?? -1) + 1]);
    } else {
      const modulo = await get('SELECT id FROM treinamento_modulos WHERE id=$1 AND treinamento_id=$2', [moduloId, req.params.id]);
      if (!modulo) return res.status(404).json({ erro: 'Módulo não encontrado' });
    }

    const jaTem = await all('SELECT pop_id FROM treinamento_pops WHERE treinamento_id=$1', [req.params.id]);
    const idsJaNaTrilha = new Set(jaTem.map(p => p.pop_id));
    const maxOrdemPop = await get('SELECT COALESCE(MAX(ordem),-1) AS m FROM treinamento_pops WHERE treinamento_id=$1 AND modulo_id=$2', [req.params.id, moduloId]);
    let ordem = (maxOrdemPop?.m ?? -1) + 1;
    let adicionados = 0;
    for (const popId of pop_ids) {
      if (idsJaNaTrilha.has(popId)) continue; // já está na trilha (em qualquer módulo) — não duplica
      await run(`INSERT INTO treinamento_pops (id, treinamento_id, pop_id, ordem, versao_pop, modulo_id)
        VALUES ($1,$2,$3,$4,(SELECT versao FROM pops WHERE id=$3),$5)`,
        [uuidv4(), req.params.id, popId, ordem++, moduloId]);
      adicionados++;
    }
    res.json({ mensagem: 'Adicionado', modulo_id: moduloId, adicionados, ignorados: pop_ids.length - adicionados });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Atualiza campos de um POP específico na trilha — só os campos que vierem no
// corpo são alterados (COALESCE mantém o que já estava), pra registrar só o
// tempo realizado, por exemplo, sem apagar instrutor/checklist/etc.
// :pop_id aceita tanto o id do POP quanto o id da própria linha (treinamento_pops)
// — necessário pra tópicos sem POP, onde não existe um pop_id de verdade.
router.put('/:id/pops/:pop_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { instrutor_id, tempo_estimado, tempo_realizado, topicos, data_prevista, status_pop, checklist_marcado } = req.body;
    await run(`UPDATE treinamento_pops SET
      instrutor_id=COALESCE($1, instrutor_id),
      tempo_estimado=COALESCE($2, tempo_estimado),
      tempo_realizado=COALESCE($3, tempo_realizado),
      topicos=COALESCE($4, topicos),
      data_prevista=COALESCE($5, data_prevista),
      status_pop=COALESCE($6, status_pop),
      checklist_marcado=COALESCE($9, checklist_marcado)
      WHERE treinamento_id=$7 AND (pop_id=$8 OR id=$8)
    `, [instrutor_id ?? null, tempo_estimado ?? null, tempo_realizado ?? null, topicos ?? null, data_prevista ?? null, status_pop ?? null, req.params.id, req.params.pop_id, checklist_marcado ?? null]);
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
      // Tópico sem POP real (só texto) não tem pop_id — o id da própria linha
      // é usado como referência nesse caso, igual às outras rotas de tópico.
      await run('UPDATE treinamento_pops SET ordem=$1 WHERE treinamento_id=$2 AND (pop_id=$3 OR id=$3)', [i, req.params.id, pop_id]);
    }
    res.json({ mensagem: 'Reordenado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Registra a data/hora REAL de início do tópico (automático, na hora que o
// cronômetro é ligado) — só grava na primeira vez (COALESCE mantém o que já
// tinha), pra não perder o horário original se a pessoa reabrir/pausar depois.
// Se é o primeiro tópico do módulo a começar, marca o início real do módulo
// também — assim o módulo tem sua própria data/hora real de início, mesmo que
// a prevista não bata por algum imprevisto.
router.put('/:id/pops/:pop_id/iniciar', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const agora = new Date().toISOString();
    const tp = await get('SELECT modulo_id FROM treinamento_pops WHERE treinamento_id=$1 AND (pop_id=$2 OR id=$2)', [req.params.id, req.params.pop_id]);
    if (!tp) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`UPDATE treinamento_pops SET data_inicio_real=COALESCE(data_inicio_real,$1)
      WHERE treinamento_id=$2 AND (pop_id=$3 OR id=$3)`, [agora, req.params.id, req.params.pop_id]);
    if (tp.modulo_id) {
      await run('UPDATE treinamento_modulos SET data_inicio_real=COALESCE(data_inicio_real,$1) WHERE id=$2', [agora, tp.modulo_id]);
    }
    res.json({ mensagem: 'Registrado', data_inicio_real: agora });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Toggle conclusão de um sub-módulo — SEQUENCIAL: só marca concluído se todos
// os sub-módulos ANTERIORES da trilha (por módulo, depois por ordem dentro do
// módulo) já estiverem concluídos. O colaborador não pode pular pro próximo
// tópico sem ter passado pelo anterior. Desmarcar (voltar pra pendente) é
// sempre permitido, sem essa checagem.
router.put('/:id/pops/:pop_id/concluir', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const tp = await get('SELECT * FROM treinamento_pops WHERE treinamento_id=$1 AND (pop_id=$2 OR id=$2)', [req.params.id, req.params.pop_id]);
    if (!tp) return res.status(404).json({ erro: 'Não encontrado' });
    const novoConcluido = tp.concluido ? 0 : 1;

    if (novoConcluido) {
      const todos = await all(`
        SELECT tp.id, tp.concluido, tp.ordem, COALESCE(m.ordem, -1) AS modulo_ordem
        FROM treinamento_pops tp LEFT JOIN treinamento_modulos m ON m.id = tp.modulo_id
        WHERE tp.treinamento_id = $1
        ORDER BY modulo_ordem ASC, tp.ordem ASC
      `, [req.params.id]);
      const posAtual = todos.findIndex(x => x.id === tp.id);
      const anteriorPendente = todos.slice(0, posAtual).some(x => !x.concluido);
      if (anteriorPendente) return res.status(400).json({ erro: 'Conclua os tópicos anteriores antes de avançar.' });
    }

    const novoStatus = novoConcluido ? 'concluido' : 'pendente';
    const agora = new Date().toISOString();
    // Ao concluir, garante que início e fim reais existam (se por algum motivo
    // o /iniciar nunca foi chamado, pelo menos o fim fica registrado certo).
    await run(`UPDATE treinamento_pops SET concluido=$1, status_pop=$2,
      data_inicio_real=COALESCE(data_inicio_real,$5), data_fim_real=$5
      WHERE treinamento_id=$3 AND (pop_id=$4 OR id=$4)`, [novoConcluido, novoStatus, req.params.id, req.params.pop_id, novoConcluido ? agora : null]);

    // Se esse era o último tópico pendente do módulo, marca o fim real do módulo também.
    if (novoConcluido && tp.modulo_id) {
      const pendentesDoModulo = await get(`SELECT COUNT(*) AS n FROM treinamento_pops WHERE treinamento_id=$1 AND modulo_id=$2 AND concluido=0`, [req.params.id, tp.modulo_id]);
      if (Number(pendentesDoModulo?.n) === 0) {
        await run('UPDATE treinamento_modulos SET data_fim_real=$1 WHERE id=$2', [agora, tp.modulo_id]);
      }
    }
    res.json({ concluido: !!novoConcluido });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── AVALIAÇÕES ────────────────────────────────────────────────────────────────

router.post('/:id/avaliacoes', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { titulo, tipo, perguntas, pop_id, modulo_id, obrigatorio, ordem } = req.body;
    if (!titulo || !tipo || !perguntas) return res.status(400).json({ erro: 'Título, tipo e perguntas obrigatórios' });
    const id = uuidv4();
    await run(`INSERT INTO treinamento_avaliacoes (id, treinamento_id, pop_id, modulo_id, titulo, tipo, perguntas, obrigatorio, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, req.params.id, pop_id || null, modulo_id || null, titulo, tipo, JSON.stringify(perguntas), obrigatorio !== false ? 1 : 0, ordem || 0]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id/avaliacoes/:av_id', async (req, res) => {
  try {
    if (!(await trDaEmpresa(req.params.id, req.usuario.empresa_id))) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    const { titulo, tipo, perguntas, obrigatorio, ordem, pop_id, modulo_id } = req.body;
    await run('UPDATE treinamento_avaliacoes SET titulo=$1, tipo=$2, perguntas=$3, obrigatorio=$4, ordem=$5, pop_id=$6, modulo_id=$7 WHERE id=$8 AND treinamento_id=$9',
      [titulo, tipo, JSON.stringify(perguntas), obrigatorio !== false ? 1 : 0, ordem || 0, pop_id || null, modulo_id || null, req.params.av_id, req.params.id]);
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

    // Compara a resposta do colaborador com o gabarito de cada tipo de questão.
    // Tipos sem gabarito objetivo (aberta, prática, leitura, checklist) não geram nota.
    function acertou(p, resposta) {
      if (av.tipo === 'multipla_escolha' || av.tipo === 'verdadeiro_falso') {
        return String(resposta) === String(p.resposta_correta);
      }
      if (av.tipo === 'multiplas_respostas') {
        const certo = (p.respostas_corretas || []).map(String).sort();
        const dado = (Array.isArray(resposta) ? resposta : []).map(String).sort();
        return certo.length > 0 && JSON.stringify(certo) === JSON.stringify(dado);
      }
      if (av.tipo === 'associacao') {
        const pares = p.pares || [];
        const dado = resposta || {};
        return pares.length > 0 && pares.every((par, i) => String(dado[i]) === String(par.direita));
      }
      if (av.tipo === 'lacunas') {
        return String(resposta || '').trim().toLowerCase() === String(p.resposta_correta || '').trim().toLowerCase();
      }
      return null;
    }

    if (['multipla_escolha', 'verdadeiro_falso', 'multiplas_respostas', 'associacao', 'lacunas'].includes(av.tipo)) {
      let acertos = 0;
      perguntas.forEach((p, i) => { if (acertou(p, respostas[i])) acertos++; });
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
    const { texto, tipo, pop_id, trecho } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO treinamento_anotacoes (id, treinamento_id, pop_id, usuario_id, tipo, texto, trecho)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [id, req.params.id, pop_id || null, req.usuario.id, tipo || 'observacao', texto, trecho || null]);
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

// ── PDF DA TRILHA COMPLETA ──────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  try {
    const t = await get(`${SELECT_TREINAMENTO} WHERE t.id = $1 AND t.empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!t) return res.status(404).json({ erro: 'Não encontrado' });
    // completo=1 traz o conteúdo inteiro de cada POP (objetivo, procedimento,
    // documentos, segurança, penalidades) — não só título e checklist.
    const completo = req.query.completo === '1';
    const camposPop = completo
      ? 'p.objetivo, p.campo_aplicacao, p.procedimento, p.documentos, p.seguranca, p.penalidade'
      : '';
    // Mesma correção do GET /:id: ordenar só por tp.ordem (posição DENTRO do
    // módulo, reinicia em cada um) embaralhava a sequência entre módulos
    // diferentes no PDF — precisa ordenar pelo módulo primeiro.
    const pops = await all(`
      SELECT tp.id, tp.pop_id, tp.concluido, tp.ordem, tp.tempo_estimado, tp.tempo_realizado,
             tp.topicos, tp.data_prevista, tp.modulo_id, tp.descricao,
             COALESCE(p.titulo, tp.titulo) AS titulo, p.codigo ${camposPop ? ', ' + camposPop : ''}, u.nome AS instrutor_nome
      FROM treinamento_pops tp LEFT JOIN pops p ON p.id = tp.pop_id
      LEFT JOIN usuarios u ON u.id = tp.instrutor_id
      LEFT JOIN treinamento_modulos m ON m.id = tp.modulo_id
      WHERE tp.treinamento_id = $1 ORDER BY COALESCE(m.ordem, -1) ASC, tp.ordem ASC
    `, [req.params.id]);
    const modulosRaw = await all(`
      SELECT m.*, u.nome AS colaborador_nome, ui.nome AS instrutor_nome FROM treinamento_modulos m
      LEFT JOIN usuarios u ON u.id = m.colaborador_id
      LEFT JOIN usuarios ui ON ui.id = m.instrutor_id
      WHERE m.treinamento_id = $1 ORDER BY m.ordem ASC
    `, [req.params.id]);
    const modulos = modulosRaw.map(m => ({ ...m, pops: pops.filter(p => p.modulo_id === m.id) }));
    const popsSemModulo = pops.filter(p => !p.modulo_id);

    const { gerarPDFTrilha } = require('../utils/gerarPDFTrilha');
    const pdfBuffer = await gerarPDFTrilha({ ...t, pops, popsSemModulo, modulos }, completo);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="trilha-${(t.titulo || 'treinamento').replace(/[^a-zA-Z0-9]/g, '-')}${completo ? '-completa' : ''}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PDF resumo de uma TRILHA PRINCIPAL inteira (ex.: CALL CENTER) — uma seção por
// trilha do dia que tem dentro, com módulos e títulos dos tópicos.
router.get('/trilhas-principais/:id/pdf', async (req, res) => {
  try {
    const principal = await get(`
      SELECT tpz.*, d.nome AS departamento_nome
      FROM treinamento_trilhas_principais tpz
      LEFT JOIN departamentos d ON d.id = tpz.departamento_id
      WHERE tpz.id = $1 AND tpz.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!principal) return res.status(404).json({ erro: 'Não encontrada' });

    // Mesma pasta compartilhada por Treinamentos (eh_modelo=0) e Trilhas de
    // Aprendizagem (eh_modelo=1) — ?eh_modelo= filtra qual dos dois entra no PDF.
    const filtroModelo = req.query.eh_modelo === '0' || req.query.eh_modelo === '1'
      ? ` AND COALESCE(t.eh_modelo,0) = ${req.query.eh_modelo === '1' ? 1 : 0}` : '';
    // Agrupa por colaborador (não intercala pessoas diferentes) e, dentro de
    // cada um, ordena pelo número da trilha (ex.: "TRILHA 1", "TRILHA 2"...) —
    // "ordem" e data_hora quando existem, com o número extraído do título como
    // desempate. Sem isso, trilhas com a mesma data/hora (comum: o dia todo
    // marcado pra 08:00) saíam em ordem instável/invertida.
    const trilhasBase = await all(`${SELECT_TREINAMENTO} WHERE t.trilha_principal_id = $1 AND t.excluido_em IS NULL${filtroModelo}
      ORDER BY t.colaborador_id NULLS LAST,
               (CASE WHEN t.ordem > 0 THEN t.ordem ELSE 999999 END) ASC,
               COALESCE((regexp_match(t.titulo, '(\\d+)'))[1]::int, 999999) ASC,
               t.data_hora ASC`, [req.params.id]);
    const trilhas = [];
    for (const t of trilhasBase) {
      const pops = await all(`
        SELECT tp.id, tp.pop_id, tp.concluido, tp.ordem, tp.modulo_id, tp.data_prevista,
               COALESCE(p.titulo, tp.titulo) AS titulo, p.codigo, u.nome AS instrutor_nome
        FROM treinamento_pops tp LEFT JOIN pops p ON p.id = tp.pop_id
        LEFT JOIN usuarios u ON u.id = tp.instrutor_id
        LEFT JOIN treinamento_modulos m ON m.id = tp.modulo_id
        WHERE tp.treinamento_id = $1 ORDER BY COALESCE(m.ordem, -1) ASC, tp.ordem ASC
      `, [t.id]);
      const modulosRaw = await all(`
        SELECT m.*, u.nome AS colaborador_nome, ui.nome AS instrutor_nome FROM treinamento_modulos m
        LEFT JOIN usuarios u ON u.id = m.colaborador_id
        LEFT JOIN usuarios ui ON ui.id = m.instrutor_id
        WHERE m.treinamento_id = $1 ORDER BY m.ordem ASC
      `, [t.id]);
      const modulos = modulosRaw.map(m => ({ ...m, pops: pops.filter(p => p.modulo_id === m.id) }));
      const popsSemModulo = pops.filter(p => !p.modulo_id);
      trilhas.push({ ...t, pops, popsSemModulo, modulos });
    }

    const { gerarPDFTrilhaPrincipal } = require('../utils/gerarPDFTrilha');
    const pdfBuffer = await gerarPDFTrilhaPrincipal(principal, trilhas);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="trilha-principal-${(principal.nome || 'resumo').replace(/[^a-zA-Z0-9]/g, '-')}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── CLONE (base de "duplicar" e "atribuir modelo a colaborador") ────────────
// Copia a trilha/modelo inteiro (módulos, sub-módulos/POPs, checklist,
// instrutor, avaliações) pra uma trilha nova — sem duplicar progresso nem
// anotações, que são específicas de quem foi treinado antes.
async function clonarTrilha(origemId, empresaId, overrides = {}) {
  const original = await get('SELECT * FROM treinamentos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [origemId, empresaId]);
  if (!original) return null;

  const novoId = uuidv4();
  await run(`INSERT INTO treinamentos
    (id, empresa_id, titulo, tipo_trilha, departamento_id, responsavel_id, colaborador_id, data_hora, observacoes, status_agenda, modo_repasse, trilha_principal_id, eh_modelo, modelo_origem_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'agendado',$10,$11,0,$12)
  `, [novoId, empresaId, overrides.titulo || original.titulo,
      original.tipo_trilha, original.departamento_id,
      overrides.responsavel_id !== undefined ? (overrides.responsavel_id || null) : original.responsavel_id,
      overrides.colaborador_id || null, overrides.data_hora || null,
      overrides.observacoes !== undefined ? (overrides.observacoes || null) : original.observacoes,
      original.modo_repasse, original.trilha_principal_id, origemId]);

  const modulos = await all('SELECT * FROM treinamento_modulos WHERE treinamento_id=$1 ORDER BY ordem', [origemId]);
  const mapaModulo = new Map();
  for (const m of modulos) {
    const novoModuloId = uuidv4();
    mapaModulo.set(m.id, novoModuloId);
    // modo "completa": não copia o colaborador do módulo antigo (o novo treinamento
    // já tem o colaborador dele); modo "dividido" mantém quem estava em cada módulo,
    // já que a divisão por módulo é independente de quem faz a trilha toda.
    await run('INSERT INTO treinamento_modulos (id, treinamento_id, nome, ordem, colaborador_id) VALUES ($1,$2,$3,$4,$5)',
      [novoModuloId, novoId, m.nome, m.ordem, original.modo_repasse === 'dividido' ? m.colaborador_id : null]);
  }

  const pops = await all('SELECT * FROM treinamento_pops WHERE treinamento_id=$1 ORDER BY ordem', [origemId]);
  for (const p of pops) {
    const novoPopRowId = uuidv4();
    await run(`INSERT INTO treinamento_pops
      (id, treinamento_id, pop_id, ordem, instrutor_id, tempo_estimado, topicos, versao_pop, data_prevista, modulo_id, titulo, descricao)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [novoPopRowId, novoId, p.pop_id, p.ordem, p.instrutor_id, p.tempo_estimado, p.topicos, p.versao_pop,
        p.data_prevista, p.modulo_id ? mapaModulo.get(p.modulo_id) : null, p.titulo, p.descricao]);
  }

  const avaliacoes = await all('SELECT * FROM treinamento_avaliacoes WHERE treinamento_id=$1 ORDER BY ordem', [origemId]);
  for (const av of avaliacoes) {
    await run(`INSERT INTO treinamento_avaliacoes (id, treinamento_id, pop_id, modulo_id, titulo, tipo, perguntas, obrigatorio, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), novoId, av.pop_id, av.modulo_id ? mapaModulo.get(av.modulo_id) : null, av.titulo, av.tipo, av.perguntas, av.obrigatorio, av.ordem]);
  }

  return novoId;
}

// ── DUPLICAR ──────────────────────────────────────────────────────────────────
// Copia uma trilha JÁ ATRIBUÍDA pra treinar outra pessoa com o mesmo conteúdo.
router.post('/:id/duplicar', async (req, res) => {
  try {
    const { colaborador_id, data_hora, titulo } = req.body;
    const novoId = await clonarTrilha(req.params.id, req.usuario.empresa_id, {
      colaborador_id, data_hora, titulo: titulo || undefined,
    });
    if (!novoId) return res.status(404).json({ erro: 'Treinamento não encontrado' });
    res.status(201).json({ id: novoId, mensagem: 'Trilha duplicada' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ATRIBUIR MODELO A COLABORADOR(ES) ───────────────────────────────────────
// A trilha é montada 1x em "Trilhas de Aprendizagem" (eh_modelo=1) e aqui é
// atribuída a um ou mais colaboradores — cada um ganha sua própria cópia
// (eh_modelo=0), com progresso e anotações independentes.
router.post('/:id/atribuir', async (req, res) => {
  try {
    const modelo = await get('SELECT id, titulo FROM treinamentos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, req.usuario.empresa_id]);
    if (!modelo) return res.status(404).json({ erro: 'Modelo de trilha não encontrado' });

    const { colaboradores_ids, data_hora, responsavel_id, observacoes } = req.body;
    if (!Array.isArray(colaboradores_ids) || !colaboradores_ids.length) {
      return res.status(400).json({ erro: 'Selecione ao menos um colaborador' });
    }

    const criados = [];
    for (const colaborador_id of colaboradores_ids) {
      const novoId = await clonarTrilha(req.params.id, req.usuario.empresa_id, {
        colaborador_id, data_hora, responsavel_id, observacoes,
      });
      if (novoId) criados.push(novoId);
    }
    res.status(201).json({ criados, mensagem: `Trilha atribuída a ${criados.length} colaborador(es)` });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
