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
  // A atribuição é pela DATA DE FECHAMENTO da O.S. (data_termino_executado).
  // Como o movimento costuma ser no dia do fechamento, buscamos com uma folga de
  // alguns dias antes para não perder O.S. fechadas no início do período cujo
  // movimento tenha ficado no fim do período anterior.
  const isoD = (d) => d.toISOString().slice(0, 10);
  const ini = new Date(dataInicio + 'T00:00:00');
  const bufferInicio = isoD(new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() - 10));
  const movTodos = await hubsoft.listarMovimentosEstoque({ dataInicio: bufferInicio, dataFim, deveCancelar });

  // PADRÃO ÚNICO: "saída para o cliente".
  const movimentos = movTodos.filter(m =>
    m.tipo === 'saida' && m.vinculo_destino?.tipo_vinculo === 'servico_cliente'
  );

  const idsOS = [...new Set(movimentos.map(m => m.id_ordem_servico).filter(Boolean))];
  const infoOS = idsOS.length ? await hubsoft.buscarTiposOSPorId(idsOS, deveCancelar) : {};

  const parseProduto = (str) => {
    const s = String(str || '');
    const nome = s.replace(/:\s*[\d.,]+\s+.*$/, '').trim() || s.trim();
    const un = (s.match(/\(([^)]+)\)\s*$/) || [])[1] || 'UN';
    return { nome, unidade: un.toUpperCase() };
  };

  // dentro do período pela DATA DE FECHAMENTO da O.S. (fallback: data do movimento)
  const noPeriodo = (d) => d && String(d).slice(0, 10) >= dataInicio && String(d).slice(0, 10) <= dataFim;

  const prod = {};
  let porFechamento = 0, porMovimento = 0;
  for (const m of movimentos) {
    const info = m.id_ordem_servico ? infoOS[m.id_ordem_servico] : null;
    const fechamento = info?.fechamento || null;
    // Critério do período: data de fechamento da O.S.; sem O.S./sem fechamento → data do movimento.
    const dataRef = fechamento || m.data_movimento;
    if (!noPeriodo(dataRef)) continue;
    if (fechamento) porFechamento++; else porMovimento++;
    const tecnico = m.vinculo_origem?.tipo_vinculo === 'usuario'
      ? (m.vinculo_origem.display || 'Sem técnico')
      : 'Direto do estoque';
    const tipoOS = info?.tipo
      ? info.tipo
      : (m.id_ordem_servico ? 'OS fora do período' : 'Sem O.S.');
    for (const p of (m.produtos || [])) {
      const { nome, unidade } = parseProduto(p.produto);
      const chave = String(p.id_produto);
      const qtd = Number(p.quantidade || 0);
      const valor = Number(p.valor || 0); // valor total da linha (R$)
      if (qtd <= 0) continue;
      if (!prod[chave]) prod[chave] = { chave, nome, unidade, combos: new Map() };
      const k = `${tecnico}||${tipoOS}`;
      let c = prod[chave].combos.get(k);
      if (!c) { c = { tecnico, tipo: tipoOS, qtd: 0, valor: 0, os: new Set() }; prod[chave].combos.set(k, c); }
      c.qtd += qtd;
      c.valor += valor;
      if (m.id_ordem_servico) c.os.add(m.id_ordem_servico);
    }
  }

  const produtos = Object.values(prod).map(P => {
    const combos = [...P.combos.values()].map(c => ({
      tecnico: c.tecnico, tipo: c.tipo, qtd: c.qtd, valor: c.valor, os: [...c.os],
    }));
    const total = combos.reduce((s, c) => s + c.qtd, 0);
    const totalValor = combos.reduce((s, c) => s + c.valor, 0);
    return { chave: P.chave, nome: P.nome, unidade: P.unidade, total, totalValor, combos };
  }).sort((a, b) => b.total - a.total);

  return {
    periodo: { data_inicio: dataInicio, data_fim: dataFim },
    produtos,
    _diag: { movimentos_lidos: movTodos.length, saidas_cliente: movimentos.length, os_consultadas: idsOS.length, por_fechamento: porFechamento, por_movimento: porMovimento, criterio: 'data_fechamento_os' },
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

// Sincroniza de Janeiro até o mês atual, de todas as empresas (chamada pelo cron das 4h).
// Mês atual e anterior sempre atualizam; meses fechados já salvos não repetem a
// consulta ao ERP (não mudam) — puxa uma vez e mantém no cache.
async function sincronizarTodas() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mesAtual = hoje.getMonth(); // 0-based
  const periodos = [];
  for (let m = 0; m <= mesAtual; m++) {
    periodos.push([new Date(ano, m, 1), new Date(ano, m + 1, 0)]);
  }
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    for (let i = 0; i < periodos.length; i++) {
      const [di, df] = periodos[i];
      const p = `${iso(di)}..${iso(df)}`;
      const ehRecente = i >= periodos.length - 2; // mês atual e anterior
      try {
        if (!ehRecente) {
          const jaPronto = await db.get("SELECT id FROM erp_analise_cache WHERE empresa_id=? AND data_inicio=? AND data_fim=? AND status='pronto'", [emp.id, iso(di), iso(df)]);
          if (jaPronto) { console.log(`[sync-analise] ${emp.nome || emp.id} ${p} — já salvo, pula`); continue; }
        }
        console.log(`[sync-analise] ${emp.nome || emp.id} ${p}`);
        await sincronizarAnalise(emp.id, iso(di), iso(df));
      } catch (e) { console.error(`[sync-analise] falha ${emp.id} ${p}:`, e.message); }
    }
  }
}

// Sincroniza a Análise Fiscal de Janeiro até o mês atual, de todas as
// empresas (chamada pelo cron das 4h, junto com a Análise de Produto).
// Mesmo critério: mês atual e anterior sempre atualizam; meses fechados já
// salvos não repetem a consulta ao ERP.
async function sincronizarTodasFiscal() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mesAtual = hoje.getMonth();
  const periodos = [];
  for (let m = 0; m <= mesAtual; m++) periodos.push([new Date(ano, m, 1), new Date(ano, m + 1, 0)]);
  periodos.reverse(); // mês atual primeiro, depois vai voltando (histórico mais antigo por último)
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    for (let i = 0; i < periodos.length; i++) {
      const [di, df] = periodos[i];
      const p = `${iso(di)}..${iso(df)}`;
      const ehRecente = i < 2; // os dois primeiros da lista invertida = mês atual e anterior
      try {
        if (!ehRecente) {
          const jaPronto = await db.get("SELECT id FROM erp_fiscal_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3 AND status='pronto'", [emp.id, iso(di), iso(df)]);
          if (jaPronto) { console.log(`[sync-fiscal] ${emp.nome || emp.id} ${p} — já salvo, pula`); continue; }
        }
        console.log(`[sync-fiscal] ${emp.nome || emp.id} ${p}`);
        await sincronizarFiscal(emp.id, iso(di), iso(df));
      } catch (e) { console.error(`[sync-fiscal] falha ${emp.id} ${p}:`, e.message); }
    }
  }
}

// Idem para o Financeiro mensal (Contas a Receber).
async function sincronizarTodasFinanceiro() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mesAtual = hoje.getMonth();
  const periodos = [];
  for (let m = 0; m <= mesAtual; m++) periodos.push([new Date(ano, m, 1), new Date(ano, m + 1, 0)]);
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    for (let i = 0; i < periodos.length; i++) {
      const [di, df] = periodos[i];
      const p = `${iso(di)}..${iso(df)}`;
      const ehRecente = i >= periodos.length - 2;
      try {
        if (!ehRecente) {
          const jaPronto = await db.get("SELECT id FROM erp_financeiro_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3 AND status='pronto'", [emp.id, iso(di), iso(df)]);
          if (jaPronto) { console.log(`[sync-financeiro] ${emp.nome || emp.id} ${p} — já salvo, pula`); continue; }
        }
        console.log(`[sync-financeiro] ${emp.nome || emp.id} ${p}`);
        const cache = await db.get('SELECT id FROM erp_financeiro_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3', [emp.id, iso(di), iso(df)]);
        const id = cache?.id || uuidv4();
        if (cache) await db.run("UPDATE erp_financeiro_cache SET status='processando', erro=NULL WHERE id=$1", [id]);
        else await db.run("INSERT INTO erp_financeiro_cache (id, empresa_id, data_inicio, data_fim, status) VALUES ($1,$2,$3,$4,'processando')", [id, emp.id, iso(di), iso(df)]);
        await processarCacheFinanceiroMensal(id, emp.id, iso(di), iso(df));
      } catch (e) { console.error(`[sync-financeiro] falha ${emp.id} ${p}:`, e.message); }
    }
  }
}

// ── GET /api/erp/produtos-precos — preço (valor_compra) de cada produto do catálogo ──
// Cache em memória de 12h para não consultar o ERP a cada acesso.
let _precosCache = { mapa: null, ts: 0 };
router.get('/produtos-precos', async (req, res) => {
  try {
    const forcar = req.query.forcar === '1';
    if (!forcar && _precosCache.mapa && (Date.now() - _precosCache.ts) < 12 * 3600 * 1000) {
      return res.json({ precos: _precosCache.mapa, do_cache: true });
    }
    const produtos = await hubsoft.listarProdutos();
    const mapa = {};
    for (const p of produtos) {
      mapa[String(p.id_produto)] = { compra: Number(p.valor_compra || 0), venda: Number(p.valor_venda || 0) };
    }
    _precosCache = { mapa, ts: Date.now() };
    res.json({ precos: mapa, do_cache: false });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

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

// ── DELETE /api/erp/analise-produto/salvos — exclui um relatório salvo (cache) ──
router.delete('/analise-produto/salvos', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    if (!data_inicio || !data_fim) return res.status(400).json({ erro: 'Período obrigatório' });
    await db.run(
      'DELETE FROM erp_analise_cache WHERE empresa_id=? AND data_inicio=? AND data_fim=?',
      [req.usuario.empresa_id, data_inicio, data_fim]
    );
    res.json({ ok: true });
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

// ── ANÁLISE FISCAL — notas emitidas (NFSe, NFCOM, Telecom 21/22, NFe55) ─────
// Consulta TODAS as empresas cadastradas (que tenham CNPJ válido) por período,
// soma os principais impostos de cada tipo de nota e devolve o total geral +
// a quebra por empresa. Roda em segundo plano com cache (mesmo padrão da
// análise de produto), porque o volume de notas pode ser grande.
const num = (v) => Number(v) || 0;

function somaImpostos(acc, n, mapa) {
  for (const [chaveAcc, chaveNota] of Object.entries(mapa)) {
    acc[chaveAcc] = (acc[chaveAcc] || 0) + num(n[chaveNota]);
  }
}

function notaVazia() {
  return {
    total: 0, cancelada: 0,
    valor_total: 0,
    icms: 0, iss: 0, pis: 0, cofins: 0, csll: 0, irrf: 0, inss: 0, fust: 0, funttel: 0,
  };
}

async function calcularFiscal(dataInicio, dataFim) {
  const empresas = await db.all('SELECT id, nome, cnpj FROM empresas');
  const porEmpresa = [];
  const geral = { nfse: notaVazia(), nfcom: notaVazia(), telecom0: notaVazia(), telecom21: notaVazia(), telecom22: notaVazia(), nfe55: notaVazia(), nfe55_comodato: notaVazia() };

  for (const emp of empresas) {
    const documento = (emp.cnpj || '').replace(/\D/g, '');
    if (documento.length !== 14) {
      porEmpresa.push({ empresa: emp.nome, cnpj: emp.cnpj, indisponivel: true, motivo: 'CNPJ não cadastrado ou inválido' });
      continue;
    }

    const tipos = { nfse: notaVazia(), nfcom: notaVazia(), telecom0: notaVazia(), telecom21: notaVazia(), telecom22: notaVazia(), nfe55: notaVazia(), nfe55_comodato: notaVazia() };
    let erroEmpresa = null;

    // Processa cada página assim que chega e descarta — nunca guarda a lista
    // inteira de notas na memória (com NFCOM/telecom o volume é grande demais
    // e já derrubou o processo por falta de memória).
    try {
      await hubsoft.varrerNfse({ documento, dataInicio, dataFim }, async (lote) => {
        for (const n of lote) {
          tipos.nfse.total++;
          if (n.status === 'cancelado') tipos.nfse.cancelada++;
          tipos.nfse.valor_total += num(n.valor);
          somaImpostos(tipos.nfse, n, { iss: 'valor_iss', pis: 'valor_pis', cofins: 'valor_cofins', csll: 'valor_csll', inss: 'valor_inss', irrf: 'valor_irrf' });
        }
      });
    } catch (e) { erroEmpresa = e.message; }

    try {
      await hubsoft.varrerNfcom({ documento, dataInicio, dataFim }, async (lote) => {
        for (const n of lote) {
          tipos.nfcom.total++;
          if (n.status === 'cancelada') tipos.nfcom.cancelada++;
          tipos.nfcom.valor_total += num(n.valor_nota);
          somaImpostos(tipos.nfcom, n, { icms: 'valor_icms', pis: 'valor_pis', cofins: 'valor_cofins', fust: 'valor_fust', funttel: 'valor_funttel' });
        }
      });
    } catch (e) { erroEmpresa = erroEmpresa || e.message; }

    // Modelo 0 = Fatura de Serviços (o que a maior parte do volume de telecom
    // usa hoje), 21/22 são os modelos antigos de nota telecom "clássica".
    for (const [chave, modelo] of [['telecom0', '0'], ['telecom21', '21'], ['telecom22', '22']]) {
      try {
        await hubsoft.varrerNotaTelecom({ documento, dataInicio, dataFim, modelo }, async (lote) => {
          for (const n of lote) {
            tipos[chave].total++;
            // "situacao": 'N' = normal, 'C' = cancelada (campo usado neste endpoint,
            // diferente do "status" usado em NFSe/NFCOM).
            if (n.situacao === 'C' || String(n.status || '').includes('cancel')) tipos[chave].cancelada++;
            tipos[chave].valor_total += num(n.valor_nota ?? n.valor);
            somaImpostos(tipos[chave], n, { icms: 'valor_icms', pis: 'valor_pis', cofins: 'valor_cofins', csll: 'valor_csll', irrf: 'valor_irrf', fust: 'valor_fust', funttel: 'valor_funttel' });
          }
        });
      } catch (e) { erroEmpresa = erroEmpresa || e.message; }
    }

    try {
      await hubsoft.varrerNfe55({ documento, dataInicio, dataFim }, async (lote) => {
        for (const n of lote) {
          // Separa por natureza da operação: comodato vs vendas
          const isComodato = String(n.natureza_operacao || n.nat_op || '').toLowerCase().includes('comodato');
          const tipoNota = isComodato ? 'nfe55_comodato' : 'nfe55';

          tipos[tipoNota].total++;
          if (String(n.status || '').includes('cancel')) tipos[tipoNota].cancelada++;
          tipos[tipoNota].valor_total += num(n.valor_nota_fiscal ?? n.valor_nota ?? n.valor);
          somaImpostos(tipos[tipoNota], n, { icms: 'valor_icms', pis: 'valor_pis', cofins: 'valor_cofins' });
        }
      });
    } catch (e) { erroEmpresa = erroEmpresa || e.message; }

    for (const chave of Object.keys(geral)) {
      for (const campo of Object.keys(geral[chave])) geral[chave][campo] += tipos[chave][campo];
    }

    porEmpresa.push({ empresa: emp.nome, cnpj: emp.cnpj, tipos, erro: erroEmpresa });
  }

  const totalGeral = notaVazia();
  for (const chave of Object.keys(geral)) {
    for (const campo of Object.keys(totalGeral)) totalGeral[campo] += geral[chave][campo];
  }

  return { periodo: { data_inicio: dataInicio, data_fim: dataFim }, total_geral: totalGeral, por_tipo: geral, por_empresa: porEmpresa };
}

// Sincroniza UM período específico da Análise Fiscal (usado pela rotina diária
// e por sincronizações pontuais/parciais, ex.: só mês atual + anterior).
async function sincronizarFiscal(empresaId, dataInicio, dataFim) {
  const cache = await db.get('SELECT id FROM erp_fiscal_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3', [empresaId, dataInicio, dataFim]);
  const id = cache?.id || uuidv4();
  if (cache) await db.run("UPDATE erp_fiscal_cache SET status='processando', erro=NULL WHERE id=$1", [id]);
  else await db.run("INSERT INTO erp_fiscal_cache (id, empresa_id, data_inicio, data_fim, status) VALUES ($1,$2,$3,$4,'processando')", [id, empresaId, dataInicio, dataFim]);
  await processarCacheFiscal(id, dataInicio, dataFim);
}

async function processarCacheFiscal(id, dataInicio, dataFim) {
  try {
    const resultado = await calcularFiscal(dataInicio, dataFim);
    await db.run(
      `UPDATE erp_fiscal_cache SET status='pronto', dados=$1, erro=NULL, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$2`,
      [JSON.stringify(resultado), id]
    );
  } catch (e) {
    console.error('Erro ao processar análise fiscal em background:', e.message);
    await db.run(
      `UPDATE erp_fiscal_cache SET status='erro', erro=$1, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$2`,
      [e.message.replace('HUBSOFT', 'HubSoft'), id]
    ).catch(() => {});
  }
}

// GET /api/erp/fiscal — OTIMIZADO: SÓ LEÊ CACHE (nunca consulta ERP por clique do usuário)
// Evita sobrecarga do ERP. Dados são atualizados via cron (8h e 17h).
router.get('/fiscal', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const dataInicio = req.query.data_inicio || iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const dataFim = req.query.data_fim || iso(hoje);
    const empresaId = req.usuario.empresa_id;

    const cache = await db.get(
      `SELECT * FROM erp_fiscal_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3`,
      [empresaId, dataInicio, dataFim]
    );

    // Cache pronto: retorna na hora (não consulta ERP)
    if (cache && cache.status === 'pronto') {
      return res.json({ status: 'pronto', gerado_em: cache.updated_at, ...(JSON.parse(cache.dados || '{}')) });
    }

    // Cache não existe ou está velho: avisa para usar cron (não dispara consulta aqui)
    if (!cache) {
      return res.json({
        status: 'sem_dados',
        mensagem: 'Dados não disponíveis. Serão carregados automaticamente às 8h e 17h.',
        periodo: { data_inicio: dataInicio, data_fim: dataFim }
      });
    }

    // Cache em processamento: retorna status
    return res.json({ status: 'processando' });
  } catch (e) {
    console.error('Erro /erp/fiscal:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar dados fiscais: ' + e.message });
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

// Converte "01/08/2026" (dd/mm/aaaa, como o relatório de Contas a Receber
// devolve) pra "2026-08" (chave do mês) e pra comparação de string YYYY-MM-DD.
function dataBRParaChaveMes(dataBR) {
  const [dia, mes, ano] = String(dataBR || '').split('/');
  if (!dia || !mes || !ano) return null;
  return { chaveMes: `${ano}-${mes}`, iso: `${ano}-${mes}-${dia}` };
}

// Calcula faturado/recebido/a_receber/vencido por mês a partir do relatório
// de Contas a Receber do painel (mesmo critério que a usuária já usa: tudo
// que tem VENCIMENTO naquele mês) — processado página a página, nunca guarda
// a lista inteira (mesmo problema de memória já corrigido na Análise Fiscal).
async function calcularFinanceiroMensal(empresaId, dataInicio, dataFim) {
  const hoje = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const hojeStr = iso(hoje);

  // Monta todos os meses entre data_inicio e data_fim (mesmo os sem cobrança
  // nenhuma aparecem, com zero) — pode ser só 1 mês (o padrão) ou vários.
  const inicioJanela = new Date(dataInicio + 'T00:00:00');
  const fimJanela = new Date(dataFim + 'T00:00:00');
  const porMes = {};
  const cursor = new Date(inicioJanela.getFullYear(), inicioJanela.getMonth(), 1);
  while (cursor <= fimJanela) {
    const chave = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    porMes[chave] = { mes: chave, faturado: 0, recebido: 0, a_receber: 0, vencido: 0, qtd: 0, qtd_pagas: 0, qtd_abertas: 0 };
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // O relatório quer as datas em ISO (não dd/mm/aaaa) — início do dia inicial
  // até o fim do dia final, cobrindo o mês inteiro.
  const dataInicioISO = `${dataInicio}T00:00:00.000Z`;
  const dataFimISO = `${dataFim}T23:59:59.999Z`;

  await hubsoft.varrerContaReceber({ empresaId, dataInicio: dataInicioISO, dataFim: dataFimISO }, async (lote) => {
    for (const f of lote) {
      const venc = dataBRParaChaveMes(f.data_vencimento);
      if (!venc) continue;
      const chave = venc.chaveMes;
      if (!porMes[chave]) continue; // fora da janela pedida (não deveria acontecer)
      const pago = !!f.data_pagamento;
      const valor = hubsoft.parseValorBR(f.valor);
      const valorPago = hubsoft.parseValorBR(f.valor_pago);
      const vencida = !pago && venc.iso < hojeStr;
      const m = porMes[chave];
      m.qtd++;
      m.faturado += valor;
      if (pago) { m.recebido += valorPago; m.qtd_pagas++; }
      else {
        m.qtd_abertas++;
        m.a_receber += valor;
        if (vencida) m.vencido += valor;
      }
    }
  });

  const lista = Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes));
  const totais = lista.reduce((acc, m) => ({
    faturado: acc.faturado + m.faturado, recebido: acc.recebido + m.recebido,
    a_receber: acc.a_receber + m.a_receber, vencido: acc.vencido + m.vencido,
  }), { faturado: 0, recebido: 0, a_receber: 0, vencido: 0 });

  return { janela: { data_inicio: dataInicio, data_fim: dataFim }, totais, meses: lista };
}

async function processarCacheFinanceiroMensal(id, empresaId, dataInicio, dataFim) {
  try {
    const resultado = await calcularFinanceiroMensal(empresaId, dataInicio, dataFim);
    await db.run(
      `UPDATE erp_financeiro_cache SET status='pronto', dados=$1, erro=NULL, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$2`,
      [JSON.stringify(resultado), id]
    );
  } catch (e) {
    console.error('Erro ao processar financeiro mensal em background:', e.message);
    await db.run(
      `UPDATE erp_financeiro_cache SET status='erro', erro=$1, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$2`,
      [e.message.replace('HUBSOFT', 'HubSoft'), id]
    ).catch(() => {});
  }
}

// ── GET /api/erp/financeiro-mensal — recebido x a receber, mês a mês (por vencimento) ──
// Por padrão só o mês atual — mas aceita data_inicio/data_fim explícitos pra
// consultar outro mês, o ano inteiro, ou uma janela de N meses. Roda em
// segundo plano com cache (mesmo padrão da Análise Fiscal), porque janelas de
// vários meses envolvem dezenas de milhares de faturas.
router.get('/financeiro-mensal', async (req, res) => {
  try {
    const hoje = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const inicioMesAtual = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const fimMesAtual = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    const dataInicio = req.query.data_inicio || iso(inicioMesAtual);
    const dataFim = req.query.data_fim || iso(fimMesAtual);
    const forcar = req.query.forcar === '1';
    const empresaId = req.usuario.empresa_id;

    const cache = await db.get(
      `SELECT * FROM erp_financeiro_cache WHERE empresa_id=$1 AND data_inicio=$2 AND data_fim=$3`,
      [empresaId, dataInicio, dataFim]
    );

    if (cache && cache.status === 'pronto' && !forcar) {
      return res.json({ status: 'pronto', gerado_em: cache.updated_at, ...(JSON.parse(cache.dados || '{}')) });
    }
    if (cache && cache.status === 'processando' && !forcar) {
      const velho = cache.updated_at && (Date.now() - new Date(cache.updated_at.replace(' ', 'T')).getTime()) > 15 * 60 * 1000;
      if (!velho) return res.json({ status: 'processando' });
    }

    const id = cache?.id || uuidv4();
    if (cache) {
      await db.run(`UPDATE erp_financeiro_cache SET status='processando', erro=NULL, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$1`, [id]);
    } else {
      await db.run(`INSERT INTO erp_financeiro_cache (id, empresa_id, data_inicio, data_fim, status) VALUES ($1,$2,$3,$4,'processando')`, [id, empresaId, dataInicio, dataFim]);
    }
    processarCacheFinanceiroMensal(id, empresaId, dataInicio, dataFim); // sem await (background)
    res.json({ status: 'processando' });
  } catch (e) {
    console.error('Erro /erp/financeiro-mensal:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar financeiro mensal: ' + e.message.replace('HUBSOFT', 'HubSoft') });
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

// ─── Login do PAINEL HubSoft ─────────────────────────────────────────────────
// A conta de integração não enxerga os relatórios. Este login (de um usuário real)
// libera o Relatório de Serviços, única fonte de cidade, bairro e novo/migrado.
// A senha é guardada cifrada (AES-256-GCM) e nunca volta para a tela.
const { run: prun } = require('../config/database');
const { cifrar } = require('../utils/segredos');

function soAdminGestorErp(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) {
    res.status(403).json({ erro: 'Sem permissão' });
    return false;
  }
  return true;
}

router.get('/painel-config', autenticar, async (req, res) => {
  try {
    if (!soAdminGestorErp(req, res)) return;
    const c = await pget('SELECT usuario, senha, client_id, client_secret, atualizado_em FROM integracao_hubsoft_painel WHERE empresa_id=$1',
      [req.usuario.empresa_id]);
    res.json({
      usuario: c?.usuario || '',
      tem_senha: !!c?.senha,           // a senha em si nunca é devolvida
      client_id: c?.client_id || '',
      tem_client_secret: !!c?.client_secret,
      atualizado_em: c?.atualizado_em || null,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/painel-config', autenticar, async (req, res) => {
  try {
    if (!soAdminGestorErp(req, res)) return;
    const usuario = (req.body.usuario || '').trim();
    const senha = req.body.senha || '';
    if (!usuario) return res.status(400).json({ erro: 'Informe o usuário do painel.' });
    const atual = await pget('SELECT senha, client_secret FROM integracao_hubsoft_painel WHERE empresa_id=$1', [req.usuario.empresa_id]);
    // Campos em branco = manter o que já está guardado
    const senhaFinal = senha ? cifrar(senha) : (atual?.senha || null);
    if (!senhaFinal) return res.status(400).json({ erro: 'Informe a senha do painel.' });
    const clientId = (req.body.client_id || '').trim() || null;
    const segredo = (req.body.client_secret || '').trim();
    const segredoFinal = segredo ? cifrar(segredo) : (atual?.client_secret || null);
    await prun(
      `INSERT INTO integracao_hubsoft_painel (empresa_id, usuario, senha, client_id, client_secret, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET usuario=EXCLUDED.usuario, senha=EXCLUDED.senha,
         client_id=EXCLUDED.client_id, client_secret=EXCLUDED.client_secret, atualizado_em=NOW()`,
      [req.usuario.empresa_id, usuario, senhaFinal, clientId, segredoFinal]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Testa o login e já confirma que o relatório responde
router.post('/painel-testar', autenticar, async (req, res) => {
  try {
    if (!soAdminGestorErp(req, res)) return;
    await hubsoft.autenticarPainel(req.usuario.empresa_id);
    const hoje = new Date();
    // ISO (aaaa-mm-dd) — o HubSoft passou a rejeitar dd/mm/aaaa nesse relatório
    // ("O campo data fim não contém uma data válida"), confirmado testando os
    // dois formatos direto na API.
    const dd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const r = await hubsoft.relatorioServicos(req.usuario.empresa_id, {
      dataInicio: dd(ini), dataFim: dd(hoje), limit: 1, pagina: 1,
    });
    const a = r.registros[0] || {};
    res.json({
      ok: true,
      total: r.total,
      amostra: r.registros.length ? { cidade: a.cidade, bairro: a.bairro, origem: a.origem, status: a.servico_status } : null,
    });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos — lista TODOS os planos (ativos e inativos) com a
// quantidade de clientes de cada um (clientes_servicos_count) — leve, 1
// chamada só. Cacheado no servidor por 15min — ?forcar=1 ignora o cache.
router.get('/planos', async (req, res) => {
  try {
    const planos = await hubsoft.listarPlanosResumo(req.usuario.empresa_id, { forcar: req.query.forcar === '1' });
    res.json({ planos });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// Rotas literais (/planos/pdf, /planos/excel) precisam vir ANTES de
// /planos/:id, senão o Express trata "pdf"/"excel" como se fosse um id.

// Planos com pelo menos 1 cliente ativo, já com o detalhe COMPLETO de cada um
// (composição, contrato, desconto, etc.) — usado pelo "baixar todos". Só
// entra quem tem cliente (ativo ou inativo com base ativa), senão vira 565
// chamadas de detalhe por plano.
async function planosComClienteDetalhados(empresaId) {
  const resumo = await hubsoft.listarPlanosResumo(empresaId, {});
  const comCliente = resumo.filter(p => (p.clientes_servicos_count ?? 0) > 0);
  const detalhados = [];
  for (const p of comCliente) {
    const d = await hubsoft.detalhePlano(empresaId, p.id_servico);
    detalhados.push({ ...d, clientes_servicos_count: p.clientes_servicos_count });
  }
  return detalhados;
}

// Mesmo critério "relevantes" já usado na tela (filtro padrão que esconde só
// os inativos sem nenhum cliente) — usado pelo relatório de itens de
// composição (fiscal), que precisa ver ativo E inativo-com-cliente.
async function planosRelevantesDetalhados(empresaId) {
  const resumo = await hubsoft.listarPlanosResumo(empresaId, {});
  const relevantes = resumo.filter(p => p.ativo || (p.clientes_servicos_count ?? 0) > 0);
  const detalhados = [];
  for (const p of relevantes) {
    const d = await hubsoft.detalhePlano(empresaId, p.id_servico);
    detalhados.push({ ...d, clientes_servicos_count: p.clientes_servicos_count });
  }
  return detalhados;
}

// GET /api/erp/planos/pdf — PDF completo (todas as seções) de cada plano que
// tem pelo menos 1 cliente ativo.
router.get('/planos/pdf', async (req, res) => {
  try {
    const planos = await planosComClienteDetalhados(req.usuario.empresa_id);
    const { gerarPDFListaPlanos } = require('../utils/gerarPDFPlano');
    const pdf = await gerarPDFListaPlanos(planos);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="planos.pdf"');
    res.send(pdf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/excel — mesmo conjunto, em planilha (1 aba por seção).
router.get('/planos/excel', async (req, res) => {
  try {
    const planos = await planosComClienteDetalhados(req.usuario.empresa_id);
    const { gerarExcelListaPlanos } = require('../utils/gerarExcelPlano');
    const buf = gerarExcelListaPlanos(planos);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="planos.xlsx"');
    res.send(buf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/relatorio-ebooks-cst — planos com cliente ativo cujo
// item de composição "LC+ Livros" (E-books SVA) tem CST ICMS, PIS ou COFINS
// diferente de "Nenhum" (pedido pra achar cadastro fiscal fora do padrão
// esperado desse item específico).
router.get('/planos/relatorio-ebooks-cst', async (req, res) => {
  try {
    const planos = await planosComClienteDetalhados(req.usuario.empresa_id);
    const { gerarPDFRelatorioEbooksCst } = require('../utils/gerarPDFEbooksCst');
    const pdf = await gerarPDFRelatorioEbooksCst(planos);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="planos-ebooks-cst.pdf"');
    res.send(pdf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/relatorio-ebooks-cst/json — mesmo filtro acima, mas em
// JSON leve pra tela mostrar direto (sem precisar baixar PDF pra só olhar).
router.get('/planos/relatorio-ebooks-cst/json', async (req, res) => {
  try {
    const planos = await planosComClienteDetalhados(req.usuario.empresa_id);
    const { filtrarPlanosComCstForaDoPadrao, resumirEncontrados } = require('../utils/gerarPDFEbooksCst');
    const encontrados = filtrarPlanosComCstForaDoPadrao(planos);
    res.json({ planos: resumirEncontrados(encontrados) });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/itens-composicao — TODOS os itens de composição fiscal
// (ICMS/PIS/COFINS/IBS/CBS/NFCom etc.) de cada plano ATIVO ou INATIVO COM
// CLIENTE — 1 linha por item (não por plano). Alimenta a aba "Itens da
// Composição (Fiscal)" da tela, com filtros combinados no frontend.
router.get('/planos/itens-composicao', async (req, res) => {
  try {
    const planos = await planosRelevantesDetalhados(req.usuario.empresa_id);
    const { listarItensComposicao } = require('../utils/itensComposicaoFiscal');
    res.json({ itens: listarItensComposicao(planos) });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/:id — detalhe completo de UM plano (composição,
// contrato, desconto, etc) — sob demanda, quando a pessoa expande o plano.
router.get('/planos/:id', async (req, res) => {
  try {
    const plano = await hubsoft.detalhePlano(req.usuario.empresa_id, req.params.id);
    res.json({ plano });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/:id/pdf — PDF completo de UM plano.
router.get('/planos/:id/pdf', async (req, res) => {
  try {
    const plano = await hubsoft.detalhePlano(req.usuario.empresa_id, req.params.id);
    const { gerarPDFPlano } = require('../utils/gerarPDFPlano');
    const pdf = await gerarPDFPlano(plano);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="plano-${(plano.descricao || plano.id_servico).replace(/[^a-zA-Z0-9]/g, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/planos/:id/excel — Excel completo de UM plano (1 aba por seção).
router.get('/planos/:id/excel', async (req, res) => {
  try {
    const plano = await hubsoft.detalhePlano(req.usuario.empresa_id, req.params.id);
    const { gerarExcelPlano } = require('../utils/gerarExcelPlano');
    const buf = gerarExcelPlano(plano);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plano-${(plano.descricao || plano.id_servico).replace(/[^a-zA-Z0-9]/g, '-')}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// Sincroniza o catálogo de Pacotes de TODAS as empresas — chamada pelo cron
// das 4h30 (syncAnalisePacotes.js), NUNCA pelo clique do usuário. Busca no
// HubSoft (sequencial, 10/página) e substitui o cache em erp_pacotes_cache.
async function sincronizarPacotes() {
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    try {
      console.log(`[sync-pacotes] ${emp.nome || emp.id}`);
      const { pacotes } = await hubsoft.listarPacotesResumo(emp.id);
      await db.run(
        `INSERT INTO erp_pacotes_cache (empresa_id, dados, erro, updated_at)
         VALUES (?, ?, NULL, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (empresa_id) DO UPDATE SET dados = EXCLUDED.dados, erro = NULL, updated_at = EXCLUDED.updated_at`,
        [emp.id, JSON.stringify(pacotes)]
      );
    } catch (e) {
      console.error(`[sync-pacotes] falha ${emp.id}:`, e.message);
      await db.run(
        `INSERT INTO erp_pacotes_cache (empresa_id, dados, erro, updated_at)
         VALUES (?, NULL, ?, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (empresa_id) DO UPDATE SET erro = EXCLUDED.erro, updated_at = EXCLUDED.updated_at`,
        [emp.id, e.message]
      ).catch(() => {});
    }
  }
}

// GET /api/erp/pacotes — lê o catálogo de pacotes já sincronizado de
// madrugada (erp_pacotes_cache). NUNCA consulta o HubSoft na hora do clique
// — só a rotina de madrugada (syncAnalisePacotes.js) faz isso.
// GET /api/erp/pacotes/pdf — PDF com todos os pacotes já salvos no cache
// (mesmo dado da tela) — não consulta o HubSoft, só lê o que já está salvo.
router.get('/pacotes/pdf', async (req, res) => {
  try {
    const linha = await db.get('SELECT dados, erro FROM erp_pacotes_cache WHERE empresa_id = ?', [req.usuario.empresa_id]);
    if (linha?.erro) return res.status(400).json({ erro: linha.erro });
    const pacotes = linha?.dados ? JSON.parse(linha.dados) : [];
    if (!pacotes.length) return res.status(400).json({ erro: 'Nenhum pacote sincronizado ainda.' });
    const { gerarPDFListaPacotes } = require('../utils/gerarPDFPacotes');
    const pdf = await gerarPDFListaPacotes(pacotes);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="pacotes.pdf"');
    res.send(pdf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

router.get('/pacotes', async (req, res) => {
  try {
    const linha = await db.get('SELECT dados, erro, updated_at FROM erp_pacotes_cache WHERE empresa_id = ?', [req.usuario.empresa_id]);
    if (!linha) return res.json({ pacotes: [], atualizadoEm: null });
    if (linha.erro) return res.status(400).json({ erro: linha.erro, atualizadoEm: linha.updated_at });
    res.json({ pacotes: linha.dados ? JSON.parse(linha.dados) : [], atualizadoEm: linha.updated_at });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// Sincroniza o catálogo de Serviços NFSe de TODAS as empresas — chamada pelo
// cron das 4h45 (syncAnaliseServicosNfse.js), NUNCA pelo clique do usuário.
async function sincronizarServicosNfse() {
  const empresas = await db.all('SELECT id, nome FROM empresas');
  for (const emp of empresas) {
    try {
      console.log(`[sync-servicos-nfse] ${emp.nome || emp.id}`);
      const { servicos } = await hubsoft.listarServicosNfse(emp.id);
      await db.run(
        `INSERT INTO erp_servicos_nfse_cache (empresa_id, dados, erro, updated_at)
         VALUES (?, ?, NULL, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (empresa_id) DO UPDATE SET dados = EXCLUDED.dados, erro = NULL, updated_at = EXCLUDED.updated_at`,
        [emp.id, JSON.stringify(servicos)]
      );
    } catch (e) {
      console.error(`[sync-servicos-nfse] falha ${emp.id}:`, e.message);
      await db.run(
        `INSERT INTO erp_servicos_nfse_cache (empresa_id, dados, erro, updated_at)
         VALUES (?, NULL, ?, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (empresa_id) DO UPDATE SET erro = EXCLUDED.erro, updated_at = EXCLUDED.updated_at`,
        [emp.id, e.message]
      ).catch(() => {});
    }
  }
}

// GET /api/erp/servicos-nfse/pdf — PDF com todos os serviços já salvos no
// cache (mesmo dado da tela) — não consulta o HubSoft, só lê o que já está salvo.
router.get('/servicos-nfse/pdf', async (req, res) => {
  try {
    const linha = await db.get('SELECT dados, erro FROM erp_servicos_nfse_cache WHERE empresa_id = ?', [req.usuario.empresa_id]);
    if (linha?.erro) return res.status(400).json({ erro: linha.erro });
    const servicos = linha?.dados ? JSON.parse(linha.dados) : [];
    if (!servicos.length) return res.status(400).json({ erro: 'Nenhum serviço NFSe sincronizado ainda.' });
    const { gerarPDFListaServicosNfse } = require('../utils/gerarPDFServicosNfse');
    const pdf = await gerarPDFListaServicosNfse(servicos);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="servicos-nfse.pdf"');
    res.send(pdf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

// GET /api/erp/servicos-nfse — lê o catálogo de Serviços NFSe já sincronizado
// de madrugada (erp_servicos_nfse_cache). NUNCA consulta o HubSoft na hora do
// clique — só a rotina de madrugada (syncAnaliseServicosNfse.js) faz isso.
router.get('/servicos-nfse', async (req, res) => {
  try {
    const linha = await db.get('SELECT dados, erro, updated_at FROM erp_servicos_nfse_cache WHERE empresa_id = ?', [req.usuario.empresa_id]);
    if (!linha) return res.json({ servicos: [], atualizadoEm: null });
    if (linha.erro) return res.status(400).json({ erro: linha.erro, atualizadoEm: linha.updated_at });
    res.json({ servicos: linha.dados ? JSON.parse(linha.dados) : [], atualizadoEm: linha.updated_at });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

module.exports = router;
module.exports.sincronizarTodas = sincronizarTodas;
module.exports.sincronizarAnalise = sincronizarAnalise;
module.exports.sincronizarTodasFiscal = sincronizarTodasFiscal;
module.exports.sincronizarPacotes = sincronizarPacotes;
module.exports.sincronizarTodasFinanceiro = sincronizarTodasFinanceiro;
module.exports.sincronizarServicosNfse = sincronizarServicosNfse;
