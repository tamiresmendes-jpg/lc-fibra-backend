// ─────────────────────────────────────────────────────────────────────────────
// Assistente do ERP (HubSoft) — MÓDULO SEPARADO do sistema de gestão.
//
// POST /api/erp/consultar — responde perguntas em linguagem natural consultando
// dados reais do ERP HubSoft. Usa "tool use" (function calling): o Claude decide
// QUAL consulta fazer, o backend executa a chamada real na API do HubSoft e
// devolve os dados; o Claude então redige a resposta. O número/valor vem SEMPRE
// do ERP, nunca é inventado.
//
// Este arquivo NÃO se mistura com o assistente de POPs (routes/ia.js).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { autenticar } = require('../middleware/auth');
const hubsoft = require('../services/hubsoft');
const { get: pget } = require('../config/database');
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');

const router = express.Router();
router.use(autenticar);

// Bloqueia o acesso ao ERP (inclusive leitura) para quem não tem 'erp.consultar'.
router.use(async (req, res, next) => {
  try {
    if (req.usuario.perfil === 'admin') return next();
    let ownPerms = null;
    try {
      const u = await pget('SELECT permissoes_modulos FROM usuarios WHERE id = ?', [req.usuario.id]);
      if (u?.permissoes_modulos) ownPerms = JSON.parse(u.permissoes_modulos);
    } catch { ownPerms = null; }
    const perms = await buscarPermsEfetivas(req.usuario.id, req.usuario.empresa_id, ownPerms);
    if (!perms) return next(); // sem restrição configurada → liberado
    if (temPermissaoServer(perms, 'erp.consultar', 'visualizar')) return next();
    return res.status(403).json({ erro: 'Você não tem permissão para acessar o ERP.' });
  } catch { return res.status(500).json({ erro: 'Erro ao verificar permissão.' }); }
});

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada no .env');
  return new Anthropic({ apiKey: key });
}

// Ferramentas expostas ao modelo. Comece pequeno (equipamentos) e amplie depois.
const FERRAMENTAS = [
  {
    name: 'consultar_equipamentos',
    description:
      'Consulta os equipamentos de rede cadastrados no ERP (roteadores, access points, ONUs, etc.). ' +
      'Use para responder quantidades e listagens por tipo, modelo ou fabricante. ' +
      'Retorna o total encontrado e uma quebra por modelo.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Filtra pelo tipo, ex: ROTEADOR, ACCESS POINT, ONU. Opcional.' },
        modelo: { type: 'string', description: 'Filtra pelo modelo, ex: AX1200. Correspondência parcial. Opcional.' },
        fabricante: { type: 'string', description: 'Filtra pelo fabricante. Opcional.' },
      },
    },
  },
  {
    name: 'consultar_estoque',
    description:
      'Consulta o catálogo de produtos do estoque do ERP (roteadores, ONUs, ferramentas, materiais, etc.). ' +
      'Use para responder quantos produtos existem, buscar por nome, marca ou categoria. ' +
      'Retorna o total de produtos que batem com o filtro e uma quebra por marca e por categoria.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Filtra pelo nome do produto, ex: ROTEADOR, AX1500. Correspondência parcial. Opcional.' },
        marca: { type: 'string', description: 'Filtra pela marca, ex: MULTILASER, INTELBRAS. Opcional.' },
        categoria: { type: 'string', description: 'Filtra pela categoria, ex: FERRAMENTAS. Opcional.' },
      },
    },
  },
];

// Executa a ferramenta pedida pelo modelo e devolve o resultado (objeto JS).
async function executarFerramenta(nome, entrada) {
  if (nome === 'consultar_equipamentos') {
    const { tipo, modelo, fabricante } = entrada || {};
    let lista = await hubsoft.listarEquipamentos();
    if (!Array.isArray(lista)) lista = [];

    const contem = (campo, filtro) =>
      !filtro || String(campo || '').toLowerCase().includes(String(filtro).toLowerCase());

    const filtrados = lista.filter(
      (e) => contem(e.tipo, tipo) && contem(e.modelo, modelo) && contem(e.fabricante, fabricante)
    );

    const porModelo = {};
    for (const e of filtrados) {
      const chave = e.modelo || '(sem modelo)';
      porModelo[chave] = (porModelo[chave] || 0) + 1;
    }

    return {
      total: filtrados.length,
      por_modelo: porModelo,
      amostra: filtrados.slice(0, 20).map((e) => ({
        nome: e.nome, tipo: e.tipo, modelo: e.modelo, fabricante: e.fabricante,
      })),
    };
  }

  if (nome === 'consultar_estoque') {
    const { nome: fNome, marca, categoria } = entrada || {};
    let lista = await hubsoft.listarProdutos();
    if (!Array.isArray(lista)) lista = [];

    const contem = (campo, filtro) =>
      !filtro || String(campo || '').toLowerCase().includes(String(filtro).toLowerCase());
    const temCategoria = (p, filtro) =>
      !filtro || (p.produto_categoria || []).some((c) => contem(c.descricao, filtro));

    const filtrados = lista.filter(
      (p) => contem(p.nome, fNome) && contem(p.produto_marca?.nome, marca) && temCategoria(p, categoria)
    );

    const porMarca = {};
    const porCategoria = {};
    for (const p of filtrados) {
      const m = p.produto_marca?.nome || '(sem marca)';
      porMarca[m] = (porMarca[m] || 0) + 1;
      for (const c of p.produto_categoria || [{ descricao: '(sem categoria)' }]) {
        const cat = c.descricao || '(sem categoria)';
        porCategoria[cat] = (porCategoria[cat] || 0) + 1;
      }
    }

    return {
      total: filtrados.length,
      por_marca: porMarca,
      por_categoria: porCategoria,
      observacao: 'Este é o catálogo de produtos cadastrados. Não representa a quantidade física em estoque (saldo).',
      amostra: filtrados.slice(0, 25).map((p) => ({
        nome: p.nome, marca: p.produto_marca?.nome, categoria: (p.produto_categoria || [])[0]?.descricao,
      })),
    };
  }

  throw new Error(`Ferramenta desconhecida: ${nome}`);
}

const SYSTEM_CONSULTA = `Você é um assistente de consultas do ERP HubSoft de um provedor de internet.
Responda em português brasileiro, de forma direta e objetiva.
Use SEMPRE as ferramentas para obter dados reais — nunca invente números, quantidades ou valores.
Se a ferramenta não retornar dados suficientes, diga o que encontrou e o que faltou.
Ao dar quantidades, seja específico (ex: "Você tem 78 roteadores do modelo AX1200").`;

// GET /api/erp/relatorio — dados estruturados pra exibição como relatório (sem IA)
router.get('/relatorio', async (req, res) => {
  try {
    const [rede, produtos] = await Promise.all([
      hubsoft.listarEquipamentos(),
      hubsoft.listarProdutos(),
    ]);

    // ── Rede ──────────────────────────────────────────────────────────────────
    const porTipoRede = {};
    const porFabricante = {};
    for (const e of rede) {
      const t = e.tipo || 'Outro';
      const f = e.fabricante || 'Sem fabricante';
      porTipoRede[t] = (porTipoRede[t] || 0) + 1;
      porFabricante[f] = (porFabricante[f] || 0) + 1;
    }

    // ── Estoque ───────────────────────────────────────────────────────────────
    const porCategoria = {};
    const porMarca = {};
    for (const p of produtos) {
      const m = p.produto_marca?.nome || 'Sem marca';
      porMarca[m] = (porMarca[m] || 0) + 1;
      for (const c of p.produto_categoria || [{ descricao: 'Sem categoria' }]) {
        const cat = c.descricao || 'Sem categoria';
        porCategoria[cat] = (porCategoria[cat] || 0) + 1;
      }
    }

    // ── Estoque — detalhes extras ─────────────────────────────────────────────
    const porTipo = {};
    let comPatrimonial = 0, comEpi = 0;
    for (const p of produtos) {
      const t = p.produto_tipo?.nome || 'Sem tipo';
      porTipo[t] = (porTipo[t] || 0) + 1;
      if (p.controle_patrimonial) comPatrimonial++;
      if (p.epi) comEpi++;
    }

    res.json({
      rede: {
        total: rede.length,
        por_tipo: porTipoRede,
        por_fabricante: porFabricante,
        equipamentos: rede.map((e) => ({
          id: e.id_equipamento, nome: e.nome, tipo: e.tipo,
          modelo: e.modelo, fabricante: e.fabricante, ipv4: e.ipv4,
        })),
      },
      estoque: {
        total: produtos.length,
        com_controle_patrimonial: comPatrimonial,
        com_epi: comEpi,
        por_categoria: porCategoria,
        por_marca: porMarca,
        por_tipo: porTipo,
        produtos: produtos.map((p) => ({
          id: p.id_produto,
          nome: p.nome,
          codigo: p.codigo,
          marca: p.produto_marca?.nome,
          tipo: p.produto_tipo?.nome,
          categoria: (p.produto_categoria || []).map(c => c.descricao).join(', '),
          valor_compra: p.valor_compra,
          valor_venda: p.valor_venda,
          controle_patrimonial: p.controle_patrimonial,
          epi: p.epi,
          unidade: p.unidade_medida?.abreviacao,
          ncm: p.ncm?.codigo,
          data_cadastro: p.data_cadastro,
        })),
      },
    });
  } catch (e) {
    console.error('Erro /erp/relatorio:', e.message);
    res.status(500).json({ erro: e.message.includes('HUBSOFT')
      ? 'Não foi possível consultar o ERP: ' + e.message.replace('HUBSOFT:', '').trim()
      : 'Erro ao buscar dados do ERP.' });
  }
});

// ── POST /api/erp/importar — lê Excel exportado do HubSoft e retorna totais ──
const multer     = require('multer');
const XLSX       = require('xlsx');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const db         = require('../config/database');
const uploadTemp = multer({ dest: require('os').tmpdir() });

// ── Persistência: salvar / listar / excluir relatórios processados ──
router.post('/relatorios/salvar', async (req, res) => {
  try {
    const { tipo, mes, arquivo, dados } = req.body;
    if (!tipo || !dados) return res.status(400).json({ erro: 'tipo e dados são obrigatórios' });
    const id = uuidv4();
    await db.run(
      `INSERT INTO erp_relatorios (id, empresa_id, tipo, mes, arquivo, dados, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, String(tipo).toLowerCase(), mes || '', arquivo || '',
       JSON.stringify(dados), req.usuario.id || null]
    );
    res.json({ id });
  } catch (e) {
    console.error('Erro /erp/relatorios/salvar:', e.message);
    res.status(500).json({ erro: 'Erro ao salvar relatório.' });
  }
});

router.get('/relatorios', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, tipo, mes, arquivo, dados, created_at
         FROM erp_relatorios
        WHERE empresa_id = ?
        ORDER BY created_at DESC`,
      [req.usuario.empresa_id]
    );
    const relatorios = rows.map(r => ({
      id: r.id, tipo: r.tipo, mes: r.mes, arquivo: r.arquivo,
      created_at: r.created_at,
      ...(JSON.parse(r.dados || '{}')),
    }));
    res.json({ relatorios });
  } catch (e) {
    console.error('Erro /erp/relatorios:', e.message);
    res.status(500).json({ erro: 'Erro ao listar relatórios.' });
  }
});

// ── GET /api/erp/agenda — agenda de técnicos (OSs programadas) por intervalo ──
router.get('/agenda', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(hoje);
    const dataFim = req.query.data_fim || iso(new Date(hoje.getTime() + 7 * 864e5));

    const ordens = await hubsoft.listarOrdensServico({ dataInicio, dataFim });

    const os = ordens.map((o) => {
      // técnico(s) reais (relação "tecnicos"); fallback: equipe/carro da agenda
      const tecnicos = Array.isArray(o.tecnicos)
        ? o.tecnicos.map(t => t.name || t.display).filter(Boolean)
        : [];
      const equipe = o.agenda_ordem_servico && !Array.isArray(o.agenda_ordem_servico)
        ? o.agenda_ordem_servico.descricao
        : (Array.isArray(o.agenda_ordem_servico) && o.agenda_ordem_servico[0]?.descricao) || null;
      const tel = o.dados_cliente?.telefones || {};
      return {
        id: o.id_ordem_servico,
        numero: o.numero,
        tipo: o.tipo,
        status: o.status,
        programado_inicio: o.data_inicio_programado,
        programado_fim: o.data_termino_programado,
        disponibilidade: o.disponibilidade,
        tecnico: tecnicos.join(', ') || equipe || 'Sem técnico',
        equipe: equipe || null,
        cliente: o.dados_cliente?.nome_razaosocial || o.cliente,
        codigo_cliente: o.dados_cliente?.codigo_cliente,
        telefone: tel.telefone_primario,
        telefone2: tel.telefone_secundario,
        servico: o.dados_servico?.descricao || o.servico,
        endereco: o.endereco_instalacao,
        data_abertura: o.data_cadastro,
        usuario_fechamento: o.usuario_fechamento?.name,
        descricao_abertura: o.descricao_abertura,
        descricao_servico: o.descricao_servico,
        descricao_fechamento: o.descricao_fechamento,
        executado_inicio: o.data_inicio_executado,
        executado_fim: o.data_termino_executado,
        atendimento: o.atendimento?.tipo_atendimento,
      };
    });

    // Agrupa por técnico
    const porEquipe = {};
    for (const o of os) {
      (porEquipe[o.tecnico] = porEquipe[o.tecnico] || []).push(o);
    }

    res.json({
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
      total: os.length,
      por_equipe: porEquipe,
      ordens: os,
    });
  } catch (e) {
    console.error('Erro /erp/agenda:', e.message);
    res.status(500).json({ erro: e.message.includes('HUBSOFT')
      ? 'Não foi possível consultar a agenda: ' + e.message.replace('HUBSOFT', 'HubSoft')
      : 'Erro ao buscar a agenda de técnicos.' });
  }
});

// ── GET /api/erp/movimentacao — produtos utilizados (saídas p/ cliente) por técnico ──
router.get('/movimentacao', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(hoje);
    const soCliente = req.query.todos !== '1'; // por padrão só saídas para cliente

    const movimentos = await hubsoft.listarMovimentosEstoque({ dataInicio, dataFim });

    // parse do campo "produto": "NOME: 2 Unitário - (UN)"
    const parseProduto = (str) => {
      const s = String(str || '');
      const nome = s.replace(/:\s*[\d.,]+\s+.*$/, '').trim() || s.trim();
      const un = (s.match(/\(([^)]+)\)\s*$/) || [])[1] || 'UN';
      return { nome, unidade: un.toUpperCase() };
    };

    const totais = {};       // id_produto -> { nome, unidade, total }
    const porTecnico = {};   // tecnico -> { id_produto: qtd }
    let saidasCliente = 0;

    for (const m of movimentos) {
      const ehSaida = m.tipo === 'saida';
      const ehCliente = m.vinculo_destino?.tipo_vinculo === 'servico_cliente';
      if (soCliente && !(ehSaida && ehCliente)) continue;

      const tecnico = m.vinculo_origem?.display || m.origem || '(sem técnico)';
      if (ehSaida && ehCliente) saidasCliente++;

      for (const p of (m.produtos || [])) {
        const { nome, unidade } = parseProduto(p.produto);
        const chave = String(p.id_produto);
        const qtd = Number(p.quantidade || 0);
        if (qtd <= 0) continue;
        if (!totais[chave]) totais[chave] = { nome, unidade, total: 0 };
        totais[chave].total += qtd;
        if (!porTecnico[tecnico]) porTecnico[tecnico] = {};
        porTecnico[tecnico][chave] = (porTecnico[tecnico][chave] || 0) + qtd;
      }
    }

    const denom = saidasCliente || movimentos.length || 1;
    const itens = Object.entries(totais)
      .map(([chave, v]) => ({
        chave, nome: v.nome, unidade: v.unidade, total: v.total,
        media: Math.round((v.total / denom) * 1000) / 1000,
      }))
      .sort((a, b) => b.total - a.total);

    const tecnicos = Object.entries(porTecnico)
      .map(([nome, mapa]) => ({ nome, produtos: mapa, total: Object.values(mapa).reduce((s, x) => s + x, 0) }))
      .filter(t => t.total > 0 && t.nome && t.nome !== '(sem técnico)')
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    res.json({
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
      total_movimentos: movimentos.length,
      total_saidas: saidasCliente,
      so_cliente: soCliente,
      itens, tecnicos,
    });
  } catch (e) {
    console.error('Erro /erp/movimentacao:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar movimentação: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// ── GET /api/erp/materiais-por-os — cruza materiais usados x tipo de OS ──
router.get('/materiais-por-os', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(hoje);

    // Movimentos (saídas p/ cliente) e OSs do período, em paralelo
    const [movimentos, ordens] = await Promise.all([
      hubsoft.listarMovimentosEstoque({ dataInicio, dataFim, tipoVinculoDestino: 'servico_cliente' }),
      hubsoft.listarOrdensServico({ dataInicio, dataFim }),
    ]);

    // mapa id_ordem_servico -> tipo
    const tipoPorOS = {};
    for (const o of ordens) tipoPorOS[o.id_ordem_servico] = o.tipo || 'Sem tipo';

    const parseProduto = (str) => {
      const s = String(str || '');
      const nome = s.replace(/:\s*[\d.,]+\s+.*$/, '').trim() || s.trim();
      const un = (s.match(/\(([^)]+)\)\s*$/) || [])[1] || 'UN';
      return { nome, unidade: un.toUpperCase() };
    };

    // agrupa por tipo de OS -> produtos
    const porTipo = {};      // tipoOS -> { chave: {nome, unidade, total} }
    const osPorTipo = {};    // tipoOS -> Set de id_ordem_servico
    let semOS = 0, comOS = 0;

    for (const m of movimentos) {
      if (!m.id_ordem_servico) { semOS++; continue; }
      comOS++;
      const tipo = tipoPorOS[m.id_ordem_servico] || 'OS não encontrada no período';
      if (!porTipo[tipo]) { porTipo[tipo] = {}; osPorTipo[tipo] = new Set(); }
      osPorTipo[tipo].add(m.id_ordem_servico);
      for (const p of (m.produtos || [])) {
        const { nome, unidade } = parseProduto(p.produto);
        const chave = String(p.id_produto);
        const qtd = Number(p.quantidade || 0);
        if (qtd <= 0) continue;
        if (!porTipo[tipo][chave]) porTipo[tipo][chave] = { nome, unidade, total: 0 };
        porTipo[tipo][chave].total += qtd;
      }
    }

    const tipos = Object.entries(porTipo).map(([tipo, prods]) => ({
      tipo,
      qtd_os: osPorTipo[tipo].size,
      itens: Object.values(prods).sort((a, b) => b.total - a.total),
    })).sort((a, b) => b.qtd_os - a.qtd_os);

    res.json({
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
      total_movimentos: movimentos.length,
      movimentos_com_os: comOS,
      movimentos_sem_os: semOS,
      tipos,
    });
  } catch (e) {
    console.error('Erro /erp/materiais-por-os:', e.message);
    res.status(500).json({ erro: 'Erro ao cruzar materiais x OS: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// Lógica pesada da análise de produto (saídas para o cliente por técnico e tipo de OS).
async function calcularAnaliseProduto(dataInicio, dataFim, deveCancelar) {
  const movTodos = await hubsoft.listarMovimentosEstoque({ dataInicio, dataFim, deveCancelar });

  // PADRÃO ÚNICO: "saída para o cliente".
  const movimentos = movTodos.filter(m =>
    m.tipo === 'saida' && m.vinculo_destino?.tipo_vinculo === 'servico_cliente'
  );

  const idsOS = [...new Set(movimentos.map(m => m.id_ordem_servico).filter(Boolean))];
  const tipoPorOS = idsOS.length ? await hubsoft.buscarTiposOSPorId(idsOS, deveCancelar) : {};

  const parseProduto = (str) => {
    const s = String(str || '');
    const nome = s.replace(/:\s*[\d.,]+\s+.*$/, '').trim() || s.trim();
    const un = (s.match(/\(([^)]+)\)\s*$/) || [])[1] || 'UN';
    return { nome, unidade: un.toUpperCase() };
  };

  const prod = {};
  for (const m of movimentos) {
    const tecnico = m.vinculo_origem?.tipo_vinculo === 'usuario'
      ? (m.vinculo_origem.display || 'Sem técnico')
      : 'Direto do estoque';
    const tipoOS = m.id_ordem_servico
      ? (tipoPorOS[m.id_ordem_servico] || 'OS fora do período')
      : 'Sem O.S.';
    for (const p of (m.produtos || [])) {
      const { nome, unidade } = parseProduto(p.produto);
      const chave = String(p.id_produto);
      const qtd = Number(p.quantidade || 0);
      if (qtd <= 0) continue;
      if (!prod[chave]) prod[chave] = { chave, nome, unidade, combos: new Map() };
      const k = `${tecnico}||${tipoOS}`;
      let c = prod[chave].combos.get(k);
      if (!c) { c = { tecnico, tipo: tipoOS, qtd: 0, os: new Set() }; prod[chave].combos.set(k, c); }
      c.qtd += qtd;
      if (m.id_ordem_servico) c.os.add(m.id_ordem_servico);
    }
  }

  const produtos = Object.values(prod).map(P => {
    const combos = [...P.combos.values()].map(c => ({
      tecnico: c.tecnico, tipo: c.tipo, qtd: c.qtd, os: [...c.os],
    }));
    const total = combos.reduce((s, c) => s + c.qtd, 0);
    return { chave: P.chave, nome: P.nome, unidade: P.unidade, total, combos };
  }).sort((a, b) => b.total - a.total);

  return {
    periodo: { data_inicio: dataInicio, data_fim: dataFim },
    produtos,
    _diag: { movimentos_lidos: movTodos.length, saidas_cliente: movimentos.length, os_consultadas: idsOS.length },
  };
}

// Processa em segundo plano e grava no cache (não bloqueia a resposta HTTP).
async function processarCacheAnalise(id, empresaId, dataInicio, dataFim) {
  // Verifica, entre os lotes, se o usuário pediu para parar (status='cancelado').
  const deveCancelar = async () => {
    try { const r = await db.get('SELECT status FROM erp_analise_cache WHERE id=?', [id]); return r?.status === 'cancelado'; }
    catch { return false; }
  };
  try {
    const resultado = await calcularAnaliseProduto(dataInicio, dataFim, deveCancelar);
    await db.run(
      `UPDATE erp_analise_cache SET status='pronto', dados=?, erro=NULL,
         updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=? AND status<>'cancelado'`,
      [JSON.stringify(resultado), id]
    );
  } catch (e) {
    if (e && e.cancelado) return; // parada solicitada — deixa como 'cancelado'
    console.error('Erro ao processar análise em background:', e.message);
    await db.run(
      `UPDATE erp_analise_cache SET status='erro', erro=?,
         updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`,
      [e.message.replace('HUBSOFT', 'HubSoft'), id]
    ).catch(() => {});
  }
}

// Gera e grava no cache a análise de um período (usado pela rotina diária das 4h).
async function sincronizarAnalise(empresaId, dataInicio, dataFim) {
  const cache = await db.get('SELECT id FROM erp_analise_cache WHERE empresa_id=? AND data_inicio=? AND data_fim=?', [empresaId, dataInicio, dataFim]);
  const id = cache?.id || uuidv4();
  if (cache) await db.run("UPDATE erp_analise_cache SET status='processando', erro=NULL WHERE id=?", [id]);
  else await db.run("INSERT INTO erp_analise_cache (id, empresa_id, data_inicio, data_fim, status) VALUES (?,?,?,?,'processando')", [id, empresaId, dataInicio, dataFim]);
  await processarCacheAnalise(id, empresaId, dataInicio, dataFim);
}

// Sincroniza mês atual + mês anterior de todas as empresas (chamada pelo cron).
async function sincronizarTodas() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const periodos = [
    [new Date(hoje.getFullYear(), hoje.getMonth(), 1), new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0)],
    [new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1), new Date(hoje.getFullYear(), hoje.getMonth(), 0)],
  ];
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    for (const [di, df] of periodos) {
      const p = `${iso(di)}..${iso(df)}`;
      try { console.log(`[sync-analise] ${emp.nome || emp.id} ${p}`); await sincronizarAnalise(emp.id, iso(di), iso(df)); }
      catch (e) { console.error(`[sync-analise] falha ${emp.id} ${p}:`, e.message); }
    }
  }
}

// ── GET /api/erp/analise-produto/salvos — lista os períodos já salvos (cache) ──
router.get('/analise-produto/salvos', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT data_inicio, data_fim, updated_at FROM erp_analise_cache
       WHERE empresa_id=? AND status='pronto' ORDER BY data_inicio DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── POST /api/erp/analise-produto/cancelar — para a busca em andamento ──
router.post('/analise-produto/cancelar', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.body.data_inicio || req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.body.data_fim || req.query.data_fim || iso(hoje);
    await db.run(
      `UPDATE erp_analise_cache SET status='cancelado',
         updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
       WHERE empresa_id=? AND data_inicio=? AND data_fim=? AND status='processando'`,
      [req.usuario.empresa_id, dataInicio, dataFim]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── GET /api/erp/analise-produto — com cache + processamento em segundo plano ──
// Respostas: { status:'pronto', ...dados } | { status:'processando' } | { status:'erro', erro }
router.get('/analise-produto', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(hoje);
    const forcar = req.query.forcar === '1';
    const empresaId = req.usuario.empresa_id;

    const cache = await db.get(
      `SELECT * FROM erp_analise_cache WHERE empresa_id=? AND data_inicio=? AND data_fim=?`,
      [empresaId, dataInicio, dataFim]
    );

    // Período já salvo → devolve do BANCO LOCAL (cache), na hora, sem tocar no ERP.
    if (cache && cache.status === 'pronto' && !forcar) {
      return res.json({ status: 'pronto', gerado_em: cache.updated_at, ...(JSON.parse(cache.dados || '{}')) });
    }

    // Já em processamento → avisa; só reprocessa se travou há mais de 10 min.
    if (cache && cache.status === 'processando' && !forcar) {
      const velho = cache.updated_at && (Date.now() - new Date(cache.updated_at.replace(' ', 'T')).getTime()) > 10 * 60 * 1000;
      if (!velho) return res.json({ status: 'processando' });
    }

    // Período NÃO salvo (ou forçar/erro/travado) → consulta o ERP uma vez e salva no cache.
    const id = cache?.id || uuidv4();
    if (cache) {
      await db.run(`UPDATE erp_analise_cache SET status='processando', erro=NULL,
         updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=?`, [id]);
    } else {
      await db.run(`INSERT INTO erp_analise_cache (id, empresa_id, data_inicio, data_fim, status)
         VALUES (?, ?, ?, ?, 'processando')`, [id, empresaId, dataInicio, dataFim]);
    }
    processarCacheAnalise(id, empresaId, dataInicio, dataFim); // sem await (background)
    res.json({ status: 'processando' });
  } catch (e) {
    console.error('Erro /erp/analise-produto:', e.message);
    res.status(500).json({ erro: 'Erro ao analisar produto: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// ── GET /api/erp/financeiro — faturas por vencimento + totais ──
router.get('/financeiro', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0));

    const faturas = await hubsoft.listarFaturas({ dataInicio, dataFim });
    const hojeStr = iso(hoje);

    let totalOriginal = 0, totalPago = 0, qtdPagas = 0, qtdAbertas = 0, qtdVencidas = 0, totalAberto = 0, totalVencido = 0;
    const lista = faturas.map((f) => {
      const pago = !!f.data_pagamento;
      const vencida = !pago && f.data_vencimento && f.data_vencimento < hojeStr;
      totalOriginal += Number(f.valor_original || f.valor || 0);
      if (pago) { totalPago += Number(f.valor_pago || 0); qtdPagas++; }
      else { qtdAbertas++; totalAberto += Number(f.valor || f.valor_original || 0); if (vencida) { qtdVencidas++; totalVencido += Number(f.valor || f.valor_original || 0); } }
      return {
        id: f.id_fatura,
        cliente: f.cliente?.nome_razaosocial || null,
        codigo_cliente: f.cliente?.codigo_cliente,
        vencimento: f.data_vencimento,
        pagamento: f.data_pagamento,
        valor: Number(f.valor || f.valor_original || 0),
        valor_pago: Number(f.valor_pago || 0),
        tipo_cobranca: f.tipo_cobranca,
        situacao: pago ? 'Paga' : (vencida ? 'Vencida' : 'Em aberto'),
        link: f.link,
      };
    });

    res.json({
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
      totais: {
        qtd: lista.length, valor_total: totalOriginal, valor_pago: totalPago,
        qtd_pagas: qtdPagas, qtd_abertas: qtdAbertas, qtd_vencidas: qtdVencidas,
        valor_aberto: totalAberto, valor_vencido: totalVencido,
      },
      faturas: lista.sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento))),
    });
  } catch (e) {
    console.error('Erro /erp/financeiro:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar faturas: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// ── GET /api/erp/atendimentos — chamados por período, agrupados por status/tipo ──
router.get('/atendimentos', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(hoje);

    const ats = await hubsoft.listarAtendimentos({ dataInicio, dataFim });
    const porStatus = {}, porTipo = {};
    const lista = ats.map((a) => {
      const status = a.status?.descricao || a.status_fechamento || 'Sem status';
      const tipo = a.tipo_atendimento?.descricao || 'Sem tipo';
      porStatus[status] = (porStatus[status] || 0) + 1;
      porTipo[tipo] = (porTipo[tipo] || 0) + 1;
      return {
        id: a.id_atendimento,
        protocolo: a.protocolo,
        tipo, status,
        abertura: a.data_cadastro,
        fechamento: a.data_fechamento,
        aberto_por: a.usuario_abertura?.name || a.usuario_abertura?.display,
        responsavel: a.usuario_responsavel?.name || a.usuario_responsavel?.display,
        cliente: a.cliente_servico?.nome_razaosocial,
        descricao: a.descricao_abertura,
      };
    });

    res.json({
      periodo: { data_inicio: dataInicio, data_fim: dataFim },
      total: lista.length, por_status: porStatus, por_tipo: porTipo,
      atendimentos: lista.sort((a, b) => String(b.abertura).localeCompare(String(a.abertura))),
    });
  } catch (e) {
    console.error('Erro /erp/atendimentos:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar atendimentos: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// ── GET /api/erp/clientes — busca de clientes ──
router.get('/clientes', async (req, res) => {
  try {
    const busca = (req.query.busca || '').trim();
    const clientes = await hubsoft.listarClientes(busca ? { busca } : {});
    const lista = clientes.map((c) => ({
      id: c.id_cliente,
      codigo: c.codigo_cliente,
      nome: c.nome_razaosocial,
      fantasia: c.nome_fantasia,
      tipo_pessoa: c.tipo_pessoa,
      cpf_cnpj: c.cpf_cnpj,
      telefone: c.telefone_primario,
      telefone2: c.telefone_secundario,
      email: c.email_principal,
      cidade: c.cidade,
      ativo: c.ativo,
      origem: c.origem_cliente,
      data_cadastro: c.data_cadastro,
    }));
    res.json({ total: lista.length, clientes: lista });
  } catch (e) {
    console.error('Erro /erp/clientes:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar clientes: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

router.delete('/relatorios/:id', async (req, res) => {
  try {
    await db.run(`DELETE FROM erp_relatorios WHERE id = ? AND empresa_id = ?`,
      [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro delete /erp/relatorios:', e.message);
    res.status(500).json({ erro: 'Erro ao excluir relatório.' });
  }
});

router.post('/importar', (req, res) => {
  uploadTemp.array('arquivos', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ erro: 'Erro no upload: ' + err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const arquivosParaLimpar = req.files.map(f => f.path);
    const tipo = String(req.body.tipo || 'estoque').toLowerCase().trim();
    const mes  = String(req.body.mes || '').trim();
    try {
      const resultado = [];

      for (const arquivo of req.files) {
        const wb = XLSX.readFile(arquivo.path);

        for (const nomePlanilha of wb.SheetNames) {
          const ws = wb.Sheets[nomePlanilha];
          const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
          if (!linhas.length) continue;

          const colunas = Object.keys(linhas[0]);

          // ── Tipos diferentes de estoque: mostra a tabela do arquivo (genérico) ──
          if (tipo !== 'estoque') {
            resultado.push({
              tipo,
              mes,
              arquivo: arquivo.originalname,
              planilha: nomePlanilha,
              total_linhas: linhas.length,
              colunas_disponiveis: colunas,
              linhas: linhas.slice(0, 2000).map(l => colunas.map(c => l[c])),
              linhas_truncadas: linhas.length > 2000,
              generico: true,
            });
            continue;
          }

          // Regex que casa APENAS o marcador de quantidade "(QTD: X UN)".
          // O nome do produto é o texto ENTRE marcadores (pode conter vírgulas,
          // parênteses e números, ex: "PORTA(1OPT/1LAN)" ou "CABO ... (1.000 METROS)").
          const REGEX_QTD = /\(\s*Q[TD]+\s*:?\s*([\d.,]+)\s*([^)]*)\)/gi;

          // Detecta a coluna dos produtos: a que tem mais células contendo "QTD:"
          // Usa regex SEM flag /g para .test() (evita bug do lastIndex)
          const TESTE_QTD = /Q[TD]+\s*:/i;
          let colMovimento = colunas.find(c => /produto|item|material/i.test(c));
          if (!colMovimento) {
            let max = 0;
            for (const c of colunas) {
              const count = linhas.slice(0, 100).filter(l => TESTE_QTD.test(String(l[c]))).length;
              if (count > max) { max = count; colMovimento = c; }
            }
          }

          // Detecta coluna de tipo de destino
          const colTipo = colunas.find(c =>
            /tipo.*(dest|sai)|dest.*tipo|tipo_mov|tipo_saida|destino/i.test(c)
          ) || colunas.find(c => /tipo/i.test(c));

          // Detecta coluna de ID único da ordem/saída (só nomes claros de ID)
          const colId = colunas.find(c =>
            /^id$|^id_|_id$|n[ºo]?_?ordem|ordem|protocolo|^os$|_os$|atendimento/i.test(c)
          );

          // Detecta coluna do técnico/responsável pela saída.
          // 1) por nome; 2) se não achar, usa a coluna que parece nome de pessoa
          //    (texto curto, sem números, sem "(QTD", valores repetidos) — normalmente a última.
          let colTecnico = colunas.find(c =>
            /t[ée]cnico|respons[áa]vel|colaborador|funcion[áa]rio|executor|instalador|usuario_saida|usu[áa]rio.*sa[íi]da|atendente/i.test(c)
          ) || colunas.find(c => /usuario|usu[áa]rio/i.test(c));

          if (!colTecnico) {
            const amostra = linhas.slice(0, 200);
            let melhor = null, melhorScore = -1;
            // percorre de trás pra frente (técnico costuma ser a última coluna)
            for (let idx = colunas.length - 1; idx >= 0; idx--) {
              const c = colunas[idx];
              if (c === colMovimento) continue;
              let ok = 0, total = 0;
              const distintos = new Set();
              for (const l of amostra) {
                const v = String(l[c] || '').trim();
                if (!v) continue;
                total++;
                distintos.add(v);
                const pareceNome = !/\d/.test(v) && !/\(Q/i.test(v) && v.length <= 40 && /[a-zà-ú]/i.test(v);
                if (pareceNome) ok++;
              }
              if (total < 5) continue;
              const fracNome = ok / total;
              const fracRepete = 1 - (distintos.size / total); // nomes se repetem
              const score = fracNome + fracRepete;
              // exige que a maioria pareça nome; dá leve preferência às últimas colunas
              if (fracNome >= 0.7 && score > melhorScore) { melhorScore = score; melhor = c; }
            }
            colTecnico = melhor;
          }

          // Detecta a coluna de DESTINO (para onde foi a saída).
          // 1) pelo nome "destino"; 2) pela coluna cujos valores citam CLIENTE.
          const colDestino = colunas.find(c => /destino/i.test(c))
            || colunas.find(c =>
                 linhas.slice(0, 100).filter(l => /cliente/i.test(String(l[c] || ''))).length > 3
               );

          // Filtra apenas SAÍDAS PARA CLIENTE:
          //   mantém linhas cujo destino cita "CLIENTE"/"INSUMO";
          //   se o destino não citar cliente mas também não for transferência
          //   entre estoques (não começa com "ESTOQUE"), mantém.
          //   Exclui transferências estoque→estoque.
          let linhasFiltradas = linhas;
          let filtroAplicado = false;
          if (colDestino) {
            const ehCliente = (v) => {
              const s = String(v || '').trim();
              if (!s) return false;
              if (/cliente|insumo/i.test(s)) return true;
              if (/^estoque\b/i.test(s)) return false; // transferência interna
              return true; // qualquer outro destino não-estoque conta como saída externa
            };
            const filtradas = linhas.filter(l => ehCliente(l[colDestino]));
            if (filtradas.length > 0) {
              linhasFiltradas = filtradas;
              filtroAplicado = true;
            }
          }

          // Conta as saídas individuais: cada linha filtrada = 1 saída para cliente
          // (se houver coluna de ID de saída, conta IDs únicos)
          let totalSaidas;
          if (colId) {
            const idsUnicos = new Set();
            for (const l of linhasFiltradas) {
              const id = String(l[colId] || '').trim();
              if (id) idsUnicos.add(id);
            }
            totalSaidas = idsUnicos.size || linhasFiltradas.length;
          } else {
            totalSaidas = linhasFiltradas.length;
          }

          const totais = {};
          const porTecnico = {}; // { tecnico: { chave: qtd } }

          for (const linha of linhasFiltradas) {
            const tecnico = colTecnico
              ? (String(linha[colTecnico] || '').trim() || '(sem técnico)')
              : '(sem técnico)';

            const celulas = colMovimento
              ? [String(linha[colMovimento] || '')]
              : colunas.map(c => String(linha[c] || ''));

            for (const celula of celulas) {
              if (!/Q[TD]+\s*:/i.test(celula)) continue;
              let match;
              let ultimoFim = 0;
              REGEX_QTD.lastIndex = 0;
              while ((match = REGEX_QTD.exec(celula)) !== null) {
                // nome = texto entre o fim do marcador anterior e o início deste
                let nome = celula.substring(ultimoFim, match.index);
                // remove vírgula/espaços iniciais deixados pelo separador entre produtos
                nome = nome.replace(/^[\s,;]+/, '').trim();
                ultimoFim = match.index + match[0].length;

                const qtd  = parseFloat(String(match[1]).replace(',', '.')) || 0;
                const unid = (match[2] || '').trim().toUpperCase() || 'UN';
                if (!nome || qtd <= 0) continue;
                const chave = `${nome}||${unid}`;
                totais[chave] = (totais[chave] || 0) + qtd;

                if (!porTecnico[tecnico]) porTecnico[tecnico] = {};
                porTecnico[tecnico][chave] = (porTecnico[tecnico][chave] || 0) + qtd;
              }
            }
          }

          // Fallback genérico se não achou padrão QTD
          if (Object.keys(totais).length === 0) {
            const colItem = colunas.find(c =>
              /produto|item|descri|nome|material|equipamento/i.test(c)
            ) || colunas[0];
            const colQtd = colunas.find(c =>
              /qtd|quantidade|quant|total|saida|saída|uso|utiliz/i.test(c)
            );
            for (const linha of linhasFiltradas) {
              const nome = String(linha[colItem] || '').trim();
              if (!nome) continue;
              const qtd = colQtd
                ? (parseFloat(String(linha[colQtd]).replace(',', '.')) || 0)
                : 1;
              totais[`${nome}||UN`] = (totais[`${nome}||UN`] || 0) + qtd;
            }
          }

          const itens = Object.entries(totais)
            .map(([chave, total]) => {
              const [nome, unidade] = chave.split('||');
              const media = totalSaidas > 0
                ? Math.round((total / totalSaidas) * 1000) / 1000
                : 0;
              return { chave, nome, total, unidade, media };
            })
            .sort((a, b) => b.total - a.total);

          // Lista de técnicos com o mapa de quantidades por produto (chave).
          // Não traz técnico sem registro (sem nome / "(sem técnico)" / total zero).
          const tecnicos = Object.entries(porTecnico)
            .map(([nome, mapa]) => ({
              nome,
              produtos: mapa, // { chave: qtd }
              total: Object.values(mapa).reduce((s, v) => s + v, 0),
            }))
            .filter(t => t.total > 0 && t.nome && t.nome !== '(sem técnico)')
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

          resultado.push({
            tipo,
            mes,
            arquivo: arquivo.originalname,
            planilha: nomePlanilha,
            total_linhas: linhas.length,
            linhas_filtradas: linhasFiltradas.length,
            total_saidas: totalSaidas,
            coluna_item: colMovimento || '(auto)',
            coluna_tecnico: colTecnico || '(não encontrada)',
            coluna_destino: colDestino || '(não encontrada)',
            filtro_cliente: filtroAplicado,
            itens,
            tecnicos,
          });
        }
      } // fim loop arquivos

      res.json({ planilhas: resultado });
    } catch (e) {
      res.status(422).json({ erro: 'Não foi possível ler o arquivo: ' + e.message });
    } finally {
      for (const p of arquivosParaLimpar) { try { fs.unlinkSync(p); } catch {} }
    }
  });
});

router.post('/consultar', async (req, res) => {
  try {
    const { pergunta } = req.body;
    if (!pergunta || !pergunta.trim())
      return res.status(400).json({ erro: 'pergunta é obrigatória' });

    const client = getClient();
    const messages = [{ role: 'user', content: pergunta.trim() }];

    // Loop de tool use: repete enquanto o modelo pedir ferramentas (limite de segurança)
    for (let passo = 0; passo < 6; passo++) {
      const resposta = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: SYSTEM_CONSULTA,
        tools: FERRAMENTAS,
        messages,
      });

      messages.push({ role: 'assistant', content: resposta.content });

      if (resposta.stop_reason !== 'tool_use') {
        const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return res.json({ resposta: texto });
      }

      const usos = resposta.content.filter((b) => b.type === 'tool_use');
      const resultados = [];
      for (const uso of usos) {
        let conteudo;
        try {
          conteudo = JSON.stringify(await executarFerramenta(uso.name, uso.input));
        } catch (e) {
          conteudo = JSON.stringify({ erro: e.message });
        }
        resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: conteudo });
      }
      messages.push({ role: 'user', content: resultados });
    }

    res.status(504).json({ erro: 'A consulta ficou complexa demais. Tente reformular a pergunta.' });
  } catch (e) {
    console.error('Erro /erp/consultar:', e.message);
    const msg = e.message.includes('ANTHROPIC')
      ? 'IA não configurada no servidor.'
      : e.message.includes('HUBSOFT')
      ? 'Não foi possível consultar o ERP: ' + e.message.replace('HUBSOFT', 'HubSoft')
      : 'Erro ao processar a consulta.';
    res.status(500).json({ erro: msg });
  }
});

module.exports = router;
module.exports.sincronizarTodas = sincronizarTodas;
module.exports.sincronizarAnalise = sincronizarAnalise;
