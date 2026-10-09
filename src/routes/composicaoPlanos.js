// ─────────────────────────────────────────────────────────────────────────────
// Análise de Composição de Planos — cadastro de TIPOS de item (cadastrável,
// não fixo — cada tipo diz se conta ou não na regra dos 50%), itens (nome,
// tipo, valor de venda e custo de fornecedor SEPARADOS) com impostos
// genéricos por item (nome + alíquota + base de cálculo, já que o MESMO
// imposto tem alíquota diferente conforme o item), e montagem de planos
// (item + quantidade) com cálculo automático de: valor/percentual por item,
// totais por tipo (dinâmico), regra dos 50% (soma dos tipos com
// conta_no_limite_50=1), custo total de fornecedores, total de impostos,
// resultado e margem (sobre o PREÇO DE VENDA do plano) e os totais agregados
// pela quantidade de clientes informada manualmente no plano.
//
// Histórico: os planos salvos são SNAPSHOT (cp_plano_itens/cp_plano_itens_
// impostos gravam os valores — incluindo o nome do tipo e se ele contava na
// regra dos 50% — da hora de salvar). cp_historico guarda um log de
// alteração de valor/custo/imposto só pra consulta do cadastro.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');
const hubsoft = require('../services/hubsoft');
const { quantidadeLivros: contarLivrosComposicaoErp } = require('../utils/relatorioLivrosSva');

router.use(autenticar);

// Mesmo padrão de permissão granular do módulo ERP (routes/erp.js): admin
// sempre passa; sem restrição configurada (perms null) libera; senão exige
// 'visualizar' pra leitura e 'editar' pra escrita na chave 'erp.composicao-planos'.
router.use(async (req, res, next) => {
  try {
    if (req.usuario.perfil === 'admin') return next();
    let ownPerms = null;
    try {
      const u = await get('SELECT permissoes_modulos FROM usuarios WHERE id = ?', [req.usuario.id]);
      if (u?.permissoes_modulos) ownPerms = JSON.parse(u.permissoes_modulos);
    } catch { ownPerms = null; }
    const perms = await buscarPermsEfetivas(req.usuario.id, req.usuario.empresa_id, ownPerms);
    if (!perms) return next();
    const nivel = req.method === 'GET' ? 'visualizar' : 'editar';
    if (temPermissaoServer(perms, 'erp.composicao-planos', nivel)) return next();
    return res.status(403).json({ erro: 'Você não tem permissão para acessar Composição de Planos.' });
  } catch { return res.status(500).json({ erro: 'Erro ao verificar permissão.' }); }
});

function numOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const LIMITE_SVA_LIVRO = 50;

// IBS/CBS (reforma tributária) ainda não são cobrados de verdade — entram em
// vigor de valer só num futuro próximo, quando o governo passar a cobrar.
// Por enquanto precisam aparecer informados (com a alíquota) porque a
// legislação exige, mas sem gerar valor de imposto real. Pedido da usuária
// 30/09/2026.
const IMPOSTOS_SEM_COBRANCA_AINDA = ['IBS Estadual', 'IBS Municipal', 'CBS'];
// Compara nome de item do catálogo com descrição de pacote do ERP sem se
// importar com acento/caixa (ex.: "HBO Max" bate com "hbo max").
function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// Tira o preço embutido no próprio nome do plano (ex.: "INTERNET 600MBPS
// 129,00 + LC LIVROS" -> "internet 600mbps + lc livros") pra achar quando
// dois planos são a mesma oferta cadastrada com centavo diferente.
function nomeBaseSemPreco(s) {
  return normalizarNome(String(s || '').replace(/\d+[.,]\d{2}\b/g, ''));
}

async function registrarHistorico(empresaId, entidade, entidadeId, descricao, usuarioId) {
  await run(
    `INSERT INTO cp_historico (id, empresa_id, entidade, entidade_id, descricao, alterado_por) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), empresaId, entidade, entidadeId, descricao, usuarioId]
  );
}

// ── Modelos personalizados (além de "novo" e "atual") ───────────────────────
// Pedido da usuária 25/09/2026: além dos dois modelos fixos, ela quer criar
// quantos modelos quiser, onde cada item do plano usa o valor que ela
// digitar na hora (sem fórmula — nem trava de 50%, nem SVA fora da
// composição). "novo" e "atual" nunca viram linha aqui, continuam sendo os
// valores fixos de cp_planos.modelo; um modelo personalizado é referenciado
// pelo próprio id.

router.get('/modelos', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM cp_modelos WHERE empresa_id = ? AND ativo = 1 ORDER BY criado_em', [req.usuario.empresa_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar modelos' }); }
});

router.post('/modelos', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do modelo é obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO cp_modelos (id, empresa_id, nome) VALUES (?, ?, ?)', [id, req.usuario.empresa_id, nome]);
    res.status(201).json(await get('SELECT * FROM cp_modelos WHERE id = ?', [id]));
  } catch (e) { res.status(500).json({ erro: 'Erro ao criar modelo' }); }
});

router.put('/modelos/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_modelos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Modelo não encontrado' });
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do modelo é obrigatório' });
    await run('UPDATE cp_modelos SET nome = ? WHERE id = ?', [nome, req.params.id]);
    res.json(await get('SELECT * FROM cp_modelos WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar modelo' }); }
});

router.delete('/modelos/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_modelos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Modelo não encontrado' });
    const { count } = await get('SELECT COUNT(*)::int AS count FROM cp_planos WHERE modelo = ? AND ativo = 1', [req.params.id]);
    if (count > 0) return res.status(400).json({ erro: `Esse modelo tem ${count} plano(s) — mova ou exclua os planos antes de remover o modelo.` });
    await run('UPDATE cp_modelos SET ativo = 0 WHERE id = ?', [req.params.id]);
    res.json({ mensagem: 'Modelo removido com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao remover modelo' }); }
});

// ── Catálogo de tipos de item (cadastrável) ─────────────────────────────────

router.get('/tipos', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM cp_tipos_item WHERE empresa_id = ? AND ativo = 1 ORDER BY ordem, nome', [req.usuario.empresa_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar tipos' }); }
});

router.post('/tipos', async (req, res) => {
  try {
    const { nome, conta_no_limite_50, percentual_fixo, absorve_restante } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do tipo é obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO cp_tipos_item (id, empresa_id, nome, conta_no_limite_50, percentual_fixo, absorve_restante) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.usuario.empresa_id, nome, conta_no_limite_50 ? 1 : 0, percentual_fixo != null && percentual_fixo !== '' ? numOrZero(percentual_fixo) : null, absorve_restante ? 1 : 0]);
    const novo = await get('SELECT * FROM cp_tipos_item WHERE id = ?', [id]);
    res.status(201).json(novo);
  } catch (e) { res.status(500).json({ erro: 'Erro ao criar tipo' }); }
});

router.put('/tipos/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_tipos_item WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Tipo não encontrado' });
    const { nome, conta_no_limite_50, percentual_fixo, absorve_restante } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do tipo é obrigatório' });
    await run('UPDATE cp_tipos_item SET nome = ?, conta_no_limite_50 = ?, percentual_fixo = ?, absorve_restante = ? WHERE id = ?',
      [nome, conta_no_limite_50 ? 1 : 0, percentual_fixo != null && percentual_fixo !== '' ? numOrZero(percentual_fixo) : null, absorve_restante ? 1 : 0, req.params.id]);
    res.json(await get('SELECT * FROM cp_tipos_item WHERE id = ?', [req.params.id]));
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar tipo' }); }
});

router.delete('/tipos/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_tipos_item WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Tipo não encontrado' });
    await run('UPDATE cp_tipos_item SET ativo = 0 WHERE id = ?', [req.params.id]);
    res.json({ mensagem: 'Tipo removido com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao remover tipo' }); }
});

// ── Catálogo de impostos (só nomes, reutilizáveis) ──────────────────────────

router.get('/impostos', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM cp_impostos WHERE empresa_id = ? AND ativo = 1 ORDER BY nome', [req.usuario.empresa_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar impostos' }); }
});

router.post('/impostos', async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do imposto é obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO cp_impostos (id, empresa_id, nome) VALUES (?, ?, ?)', [id, req.usuario.empresa_id, nome]);
    const novo = await get('SELECT * FROM cp_impostos WHERE id = ?', [id]);
    res.status(201).json(novo);
  } catch (e) { res.status(500).json({ erro: 'Erro ao criar imposto' }); }
});

// ── Catálogo de itens (com impostos aninhados) ──────────────────────────────

async function carregarImpostosDoItem(itemId) {
  return all(
    `SELECT ci.id, ci.aliquota, ci.base_calculo, ci.vigente_desde, imp.id AS imposto_id, imp.nome
     FROM cp_item_impostos ci JOIN cp_impostos imp ON imp.id = ci.imposto_id
     WHERE ci.item_id = ? AND ci.ativo = 1 ORDER BY imp.nome`,
    [itemId]
  );
}

// Resolve um imposto por id existente OU cria um novo pelo nome — usado tanto
// na criação de item com impostos quanto na vinculação avulsa, pra permitir
// cadastrar o imposto na hora sem precisar ir noutra tela antes.
async function resolverOuCriarImposto(empresaId, { imposto_id, nome_novo }) {
  if (imposto_id) {
    const existente = await get('SELECT id FROM cp_impostos WHERE id = ? AND empresa_id = ?', [imposto_id, empresaId]);
    if (!existente) throw new Error('Imposto inválido');
    return imposto_id;
  }
  if (!nome_novo) throw new Error('Informe um imposto do catálogo ou o nome de um novo');
  const id = uuidv4();
  await run('INSERT INTO cp_impostos (id, empresa_id, nome) VALUES (?, ?, ?)', [id, empresaId, nome_novo]);
  return id;
}

router.get('/itens', async (req, res) => {
  try {
    const itens = await all(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante
       FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id
       WHERE i.empresa_id = ? AND i.ativo = 1 ORDER BY t.ordem, t.nome, i.nome`,
      [req.usuario.empresa_id]
    );
    for (const item of itens) item.impostos = await carregarImpostosDoItem(item.id);
    res.json(itens);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar itens' }); }
});

// Cria o item já com os impostos junto (numa chamada só), pra não precisar
// criar o item, esperar, expandir e só então vincular imposto por imposto.
router.post('/itens', async (req, res) => {
  try {
    const { nome, tipo_id, valor_venda, custo_fornecedor, impostos } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const tipo = await get('SELECT id FROM cp_tipos_item WHERE id = ? AND empresa_id = ?', [tipo_id, req.usuario.empresa_id]);
    if (!tipo) return res.status(400).json({ erro: 'Tipo inválido' });
    const id = uuidv4();
    await run(
      `INSERT INTO cp_itens (id, empresa_id, nome, tipo_id, valor_venda, custo_fornecedor, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, nome, tipo_id, numOrZero(valor_venda), numOrZero(custo_fornecedor), req.usuario.id]
    );
    for (const imp of impostos || []) {
      const impostoId = await resolverOuCriarImposto(req.usuario.empresa_id, { imposto_id: imp.imposto_id, nome_novo: imp.nome_novo });
      await run(
        `INSERT INTO cp_item_impostos (id, item_id, imposto_id, aliquota, base_calculo) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), id, impostoId, numOrZero(imp.aliquota), imp.base_calculo != null ? numOrZero(imp.base_calculo) : 100]
      );
    }
    const novo = await get(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.id = ?`,
      [id]
    );
    novo.impostos = await carregarImpostosDoItem(id);
    res.status(201).json(novo);
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao criar item' }); }
});

router.put('/itens/:id', async (req, res) => {
  try {
    const existente = await get('SELECT * FROM cp_itens WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Item não encontrado' });
    const { nome, tipo_id, valor_venda, custo_fornecedor } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const tipo = await get('SELECT id FROM cp_tipos_item WHERE id = ? AND empresa_id = ?', [tipo_id, req.usuario.empresa_id]);
    if (!tipo) return res.status(400).json({ erro: 'Tipo inválido' });
    const novoValor = numOrZero(valor_venda), novoCusto = numOrZero(custo_fornecedor);

    if (numOrZero(existente.valor_venda) !== novoValor) {
      await registrarHistorico(req.usuario.empresa_id, 'item', req.params.id,
        `Valor de venda de "${existente.nome}" alterado de ${existente.valor_venda} para ${novoValor}`, req.usuario.id);
    }
    if (numOrZero(existente.custo_fornecedor) !== novoCusto) {
      await registrarHistorico(req.usuario.empresa_id, 'item', req.params.id,
        `Custo de fornecedor de "${existente.nome}" alterado de ${existente.custo_fornecedor} para ${novoCusto}`, req.usuario.id);
    }

    await run(
      `UPDATE cp_itens SET nome = ?, tipo_id = ?, valor_venda = ?, custo_fornecedor = ?, atualizado_em = TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [nome, tipo_id, novoValor, novoCusto, req.params.id]
    );
    const atualizado = await get(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.id = ?`,
      [req.params.id]
    );
    atualizado.impostos = await carregarImpostosDoItem(atualizado.id);
    res.json(atualizado);
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar item' }); }
});

router.delete('/itens/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_itens WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Item não encontrado' });
    await run('UPDATE cp_itens SET ativo = 0 WHERE id = ?', [req.params.id]);
    res.json({ mensagem: 'Item removido com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao remover item' }); }
});

// ── Impostos vinculados a um item ────────────────────────────────────────────

router.post('/itens/:id/impostos', async (req, res) => {
  try {
    const item = await get('SELECT id FROM cp_itens WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'Item não encontrado' });
    const { imposto_id, nome_novo, aliquota, base_calculo, vigente_desde } = req.body;
    const impostoIdFinal = await resolverOuCriarImposto(req.usuario.empresa_id, { imposto_id, nome_novo });
    const id = uuidv4();
    await run(
      `INSERT INTO cp_item_impostos (id, item_id, imposto_id, aliquota, base_calculo, vigente_desde) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, impostoIdFinal, numOrZero(aliquota), base_calculo != null ? numOrZero(base_calculo) : 100, vigente_desde || null]
    );
    res.status(201).json({ id });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao vincular imposto' }); }
});

// Duplica os impostos ativos de outro item pro item atual (pula os que já
// existem no destino) — evita recadastrar o mesmo perfil fiscal item a item.
router.post('/itens/:id/impostos/duplicar', async (req, res) => {
  try {
    const destino = await get('SELECT id FROM cp_itens WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!destino) return res.status(404).json({ erro: 'Item não encontrado' });
    const origem = await get('SELECT id FROM cp_itens WHERE id = ? AND empresa_id = ?', [req.body.origem_item_id, req.usuario.empresa_id]);
    if (!origem) return res.status(404).json({ erro: 'Item de origem não encontrado' });

    const impostosOrigem = await carregarImpostosDoItem(origem.id);
    const impostosDestinoIds = new Set((await carregarImpostosDoItem(destino.id)).map(i => i.imposto_id));
    let copiados = 0;
    for (const imp of impostosOrigem) {
      if (impostosDestinoIds.has(imp.imposto_id)) continue;
      await run(
        `INSERT INTO cp_item_impostos (id, item_id, imposto_id, aliquota, base_calculo, vigente_desde) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), destino.id, imp.imposto_id, imp.aliquota, imp.base_calculo, imp.vigente_desde]
      );
      copiados++;
    }
    res.json({ copiados });
  } catch (e) { res.status(500).json({ erro: 'Erro ao duplicar impostos' }); }
});

router.put('/itens/:id/impostos/:vinculoId', async (req, res) => {
  try {
    const vinculo = await get(
      `SELECT ci.* FROM cp_item_impostos ci JOIN cp_itens i ON i.id = ci.item_id WHERE ci.id = ? AND ci.item_id = ? AND i.empresa_id = ?`,
      [req.params.vinculoId, req.params.id, req.usuario.empresa_id]
    );
    if (!vinculo) return res.status(404).json({ erro: 'Vínculo não encontrado' });
    const { aliquota, base_calculo, vigente_desde } = req.body;
    const novaAliquota = numOrZero(aliquota), novaBase = base_calculo != null ? numOrZero(base_calculo) : 100;
    if (numOrZero(vinculo.aliquota) !== novaAliquota || numOrZero(vinculo.base_calculo) !== novaBase) {
      await registrarHistorico(req.usuario.empresa_id, 'imposto_item', req.params.id,
        `Imposto alterado: alíquota ${vinculo.aliquota}% → ${novaAliquota}%, base ${vinculo.base_calculo}% → ${novaBase}%`, req.usuario.id);
    }
    await run('UPDATE cp_item_impostos SET aliquota = ?, base_calculo = ?, vigente_desde = ? WHERE id = ?',
      [novaAliquota, novaBase, vigente_desde || null, req.params.vinculoId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar imposto do item' }); }
});

router.delete('/itens/:id/impostos/:vinculoId', async (req, res) => {
  try {
    const vinculo = await get(
      `SELECT ci.id FROM cp_item_impostos ci JOIN cp_itens i ON i.id = ci.item_id WHERE ci.id = ? AND ci.item_id = ? AND i.empresa_id = ?`,
      [req.params.vinculoId, req.params.id, req.usuario.empresa_id]
    );
    if (!vinculo) return res.status(404).json({ erro: 'Vínculo não encontrado' });
    await run('UPDATE cp_item_impostos SET ativo = 0 WHERE id = ?', [req.params.vinculoId]);
    res.json({ mensagem: 'Imposto removido do item' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao remover imposto do item' }); }
});

// ── Cálculo da composição de um plano ────────────────────────────────────────

// "Composição atual" (modelo de hoje, corrigido 24/09/2026 depois que a
// usuária viu o resultado errado): é o INVERSO da fórmula nova. Na fórmula
// nova, a Internet trava em 50% do preço e o Livro absorve o resto. No
// modelo de hoje é o contrário: SVA e Livro/E-book ficam travados no valor
// de CATÁLOGO (fixo, como sempre foram cobrados) e é a INTERNET que absorve
// o que sobrar. Usa o valor de catálogo ATUAL do item (valor_catalogo_atual,
// vindo do LEFT JOIN em carregarItensDoPlano) pro item que absorve o resto
// na fórmula nova (ex.: Livro), já que o valor snapshotado dele é o
// calculado pela fórmula nova, não o valor de venda real do item.
// Quantidade de Livro/E-book conforme a faixa de preço do plano (pedido da
// usuária 24/09/2026, só pro modelo ATUAL): R$79–100 → 2 livros, R$109,90–
// 148,99 → 3, R$149+ → 4. Faixas intermediárias (ex.: R$144,90) ficam na
// faixa de baixo até a próxima começar.
function calcularQuantidadeLivrosAtual(preco) {
  if (preco <= 100) return 2;
  if (preco <= 148.99) return 3;
  return 4;
}

function calcularComposicaoAntiga(linhas, precoVenda) {
  const preco = numOrZero(precoVenda);
  const comFlags = linhas.map(l => {
    const { percentualFixo, absorveRestante } = resolverFlagsAtual(l);
    return { ...l, percentual_fixo: percentualFixo, absorve_restante: absorveRestante };
  });
  // A faixa de quantidade de livros usa o valor QUE FICA DENTRO DA
  // COMPOSIÇÃO (Internet+Livro) — nunca o preço total do plano, que já vem
  // com as SVAs somadas (essas ficam fora da composição, cobradas à parte).
  const somaSva = comFlags.filter(l => l.percentual_fixo == null && !l.absorve_restante).reduce((s, l) => s + numOrZero(l.quantidade) * numOrZero(l.valor_unitario), 0);
  const valorComposicao = preco - somaSva;
  const fixos = comFlags.map(l => ({
    ...l,
    quantidade: l.absorve_restante ? calcularQuantidadeLivrosAtual(valorComposicao) : l.quantidade,
    valor_fixo: l.absorve_restante ? numOrZero(l.valor_catalogo_atual ?? l.valor_unitario) : numOrZero(l.valor_unitario),
  }));

  const itensInternet = fixos.filter(l => l.percentual_fixo != null);
  const somaDemais = fixos.filter(l => l.percentual_fixo == null).reduce((s, l) => s + numOrZero(l.quantidade) * l.valor_fixo, 0);
  const qtdInternet = itensInternet.reduce((s, l) => s + numOrZero(l.quantidade), 0) || 1;
  const restanteInternet = preco - somaDemais;

  const itensAntigos = fixos.map(l => {
    const valorUnitario = l.percentual_fixo != null ? (restanteInternet / qtdInternet) : l.valor_fixo;
    const valorItem = numOrZero(l.quantidade) * valorUnitario;
    return {
      nome: l.nome, tipo: l.tipo, quantidade: l.quantidade, valor_unitario: valorUnitario, valor_item: valorItem,
      percentual_fixo: l.percentual_fixo, absorve_restante: l.absorve_restante,
    };
  });
  const valorTotal = itensAntigos.reduce((s, i) => s + i.valor_item, 0);
  // "A composição" (pra percentual) é só Internet+Livro — SVA continua no
  // valor total mas não entra nesse percentual (é cobrada à parte).
  const baseComposicao = itensAntigos.filter(i => i.percentual_fixo != null || i.absorve_restante).reduce((s, i) => s + i.valor_item, 0);
  return {
    valor_total: valorTotal,
    itens: itensAntigos.map(i => {
      // null = de fato fora da composição (SVA no modelo atual). Base zerada
      // (plano ainda sem valor nenhum preenchido) é 0%, não "fora" — achado
      // 28/09/2026: mostrava "fora da composição" até pra Internet/Livro só
      // porque nada tinha sido preenchido ainda.
      const dentroDaComposicao = i.percentual_fixo != null || i.absorve_restante;
      const percentual = !dentroDaComposicao ? null : (baseComposicao > 0 ? i.valor_item / baseComposicao * 100 : 0);
      return { ...i, percentual };
    }),
  };
}

// itens: [{ nome, tipo, conta_no_limite_50, quantidade, valor_unitario, custo_fornecedor_unitario, impostos: [{nome, aliquota, base_calculo}] }]
function calcularComposicao(plano, itens) {
  const linhas = itens.map(item => {
    const valorItem = numOrZero(item.quantidade) * numOrZero(item.valor_unitario);
    const custoItem = numOrZero(item.quantidade) * numOrZero(item.custo_fornecedor_unitario);
    // Cada imposto ganha o próprio valor calculado (não só a soma) — pedido
    // da usuária pra ver QUAL imposto compõe o total, não só um número só.
    const impostosDetalhados = (item.impostos || []).map(imp => ({
      ...imp,
      valor: IMPOSTOS_SEM_COBRANCA_AINDA.includes(imp.nome) ? 0 : valorItem * (numOrZero(imp.base_calculo) / 100) * (numOrZero(imp.aliquota) / 100),
    }));
    const impostosItem = impostosDetalhados.reduce((soma, imp) => soma + imp.valor, 0);
    return { ...item, impostos: impostosDetalhados, valor_item: valorItem, custo_item: custoItem, impostos_item: impostosItem };
  });

  const valorTotalComposicao = linhas.reduce((s, l) => s + l.valor_item, 0);

  // Totais por tipo — dinâmico (uma entrada por tipo presente no plano, não
  // mais 3 campos fixos), pra funcionar com qualquer tipo que a usuária criar.
  const totaisPorTipo = {};
  for (const l of linhas) totaisPorTipo[l.tipo] = (totaisPorTipo[l.tipo] || 0) + l.valor_item;

  // Total de impostos por NOME (ex.: "PIS: R$X, COFINS: R$Y") somando todos
  // os itens — mesmo pedido de explicar melhor de onde vem o total.
  const impostosPorNome = {};
  for (const l of linhas) for (const imp of l.impostos) impostosPorNome[imp.nome] = (impostosPorNome[imp.nome] || 0) + imp.valor;

  const valorContaNoLimite = linhas.filter(l => l.conta_no_limite_50).reduce((s, l) => s + l.valor_item, 0);
  const custoTotalFornecedores = linhas.reduce((s, l) => s + l.custo_item, 0);
  const totalImpostos = linhas.reduce((s, l) => s + l.impostos_item, 0);

  const percentualLimite = valorTotalComposicao > 0 ? valorContaNoLimite / valorTotalComposicao * 100 : 0;
  const dentroDoLimite = percentualLimite <= LIMITE_SVA_LIVRO;

  // Modelo ATUAL: "a composição" (pra fins de percentual) é só SCM (Internet)
  // + Livros — SVA fica de fora do percentual (mas continua no valor total e
  // na lista de itens do plano). Pedido da usuária 30/09/2026 (revendo o
  // "todos entram" de 29/09/2026 — aquele valia só pros cards/PDF geral, não
  // pro modelo atual). Outros modelos (novo/personalizado) continuam com o
  // percentual sobre o total, como sempre foi.
  const ehModeloAtual = plano.modelo === 'atual';
  // Sempre prefere o tipo ATUAL do catálogo (resolverFlagsAtual) — o
  // percentual_fixo/absorve_restante gravado no snapshot do item pode estar
  // desatualizado, e o item continua existindo no catálogo pra consultar o
  // valor certo.
  const baseComposicaoPercentual = ehModeloAtual
    ? linhas.filter(l => { const r = resolverFlagsAtual(l); return r.percentualFixo != null || r.absorveRestante; }).reduce((s, l) => s + l.valor_item, 0)
    : valorTotalComposicao;
  // null = de fato fora da composição (SVA no modelo atual). Base zerada
  // (plano ainda sem valor nenhum preenchido) é 0%, não "fora" — um plano
  // ainda vazio não pode parecer que o item foi excluído de propósito.
  const linhasComPercentual = linhas.map(l => {
    const r = resolverFlagsAtual(l);
    const dentroDaComposicao = !ehModeloAtual || r.percentualFixo != null || r.absorveRestante;
    const percentual = !dentroDaComposicao ? null : (baseComposicaoPercentual > 0 ? l.valor_item / baseComposicaoPercentual * 100 : 0);
    return { ...l, percentual };
  });

  // "Composição de hoje" só faz sentido comparando com o modelo novo/atual
  // (assume papéis de Internet/Livro) — modelo personalizado (livre) não tem
  // essa referência, então não calcula.
  const composicaoAntiga = (plano.modelo === 'novo' || plano.modelo === 'atual')
    ? calcularComposicaoAntiga(linhas, plano.preco_venda)
    : null;

  // Preço de venda é o valor BRUTO (de tabela). Todo plano tem desconto de
  // pontualidade (padrão R$10, editável por plano) — o que o cliente
  // efetivamente paga se pagar em dia é preco_venda - desconto. Pedido da
  // usuária: mostrar resultado/margem/faturamento nos DOIS valores (bruto e
  // com desconto), já que a maioria paga com desconto mas o valor de tabela
  // também importa pra análise.
  const preco = numOrZero(plano.preco_venda);
  const descontoPontualidade = numOrZero(plano.desconto_pontualidade);
  const valorComDesconto = Math.max(0, preco - descontoPontualidade);
  const resultadoBruto = preco - custoTotalFornecedores - totalImpostos;
  const resultadoLiquido = valorComDesconto - custoTotalFornecedores - totalImpostos;
  const margemBrutaPercentual = preco > 0 ? resultadoBruto / preco * 100 : 0;
  const margemLiquidaPercentual = valorComDesconto > 0 ? resultadoLiquido / valorComDesconto * 100 : 0;
  const qtdClientes = Math.max(1, numOrZero(plano.quantidade_clientes) || 1);

  // Internet/SCM sempre primeiro na lista de itens (Audio-book, depois
  // Livro/E-book, depois o resto) — pedido da usuária 30/09/2026: o PDF/
  // Excel/CSV não refletiam a mesma ordem já usada nos Cards/Tabela. Faz
  // aqui, uma vez só, pra valer em todo lugar que usa calcularComposicao.
  function ordemItemComposicao(l) {
    const nome = String(l.nome || '').trim();
    if (/^internet/i.test(nome)) return 0;
    if (/audio/i.test(nome)) return 1;
    if (/^livro/i.test(nome)) return 2;
    return 3;
  }
  const itensOrdenados = [...linhasComPercentual].sort((a, b) => ordemItemComposicao(a) - ordemItemComposicao(b));

  return {
    itens: itensOrdenados,
    valor_total_composicao: valorTotalComposicao,
    totais_por_tipo: totaisPorTipo,
    impostos_por_nome: impostosPorNome,
    // margem de 1 centavo pra tolerar arredondamento de ponto flutuante
    // Tolerância de 2 centavos: divisão do restante por quantidade (ex.:
    // Livro em 4x) pode sobrar 1 centavo de arredondamento sem ser erro real.
    total_bate_com_preco: Math.abs(valorTotalComposicao - preco) < 0.02,
    composicao_antiga: composicaoAntiga,
    custo_total_fornecedores: custoTotalFornecedores,
    total_impostos: totalImpostos,
    regra_50: {
      percentual_sva_livro: percentualLimite,
      limite: LIMITE_SVA_LIVRO,
      falta: dentroDoLimite ? LIMITE_SVA_LIVRO - percentualLimite : 0,
      excedente: dentroDoLimite ? 0 : percentualLimite - LIMITE_SVA_LIVRO,
      status: dentroDoLimite ? 'dentro_do_limite' : 'acima_do_limite',
    },
    preco_venda: preco,
    desconto_pontualidade: descontoPontualidade,
    valor_com_desconto: valorComDesconto,
    resultado_bruto: resultadoBruto,
    resultado_liquido: resultadoLiquido,
    margem_bruta_percentual: margemBrutaPercentual,
    margem_liquida_percentual: margemLiquidaPercentual,
    quantidade_clientes: qtdClientes,
    faturamento_total_bruto: preco * qtdClientes,
    faturamento_total_liquido: valorComDesconto * qtdClientes,
    impostos_totais_clientes: totalImpostos * qtdClientes,
    resultado_total_bruto: resultadoBruto * qtdClientes,
    resultado_total_liquido: resultadoLiquido * qtdClientes,
  };
}

async function carregarItensDoPlano(planoId) {
  // valor_catalogo_atual / tipo_*_atual: dados ATUAIS do catálogo (item e seu
  // tipo), que podem já ter mudado desde que o plano foi salvo — usados só
  // pra calcular a composição "modelo de hoje" (calcularComposicaoAntiga) e
  // pra duplicar pro modelo atual, nunca pro plano em si (sempre snapshot).
  // Precisa disso porque planos criados antes de existir percentual_fixo/
  // absorve_restante no snapshot ficaram com essas colunas nulas/zeradas —
  // resolverAtual() abaixo usa o tipo atual como respaldo nesse caso.
  const itens = await all(
    `SELECT pi.*, ci.valor_venda AS valor_catalogo_atual, ti.id AS tipo_atual_id,
            ti.percentual_fixo AS tipo_percentual_fixo_atual, ti.absorve_restante AS tipo_absorve_restante_atual
     FROM cp_plano_itens pi
     LEFT JOIN cp_itens ci ON ci.id = pi.item_id
     LEFT JOIN cp_tipos_item ti ON ti.id = ci.tipo_id
     WHERE pi.plano_id = ? ORDER BY pi.ordem`,
    [planoId]
  );
  for (const item of itens) {
    item.impostos = await all('SELECT nome, aliquota, base_calculo FROM cp_plano_itens_impostos WHERE plano_item_id = ?', [item.id]);
    item.impostos.sort((a, b) => ordemImposto(a.nome) - ordemImposto(b.nome));
  }
  return itens;
}

// Ordem de exibição dos impostos pedida pela usuária 30/09/2026: ICMS, PIS e
// COFINS primeiro (base cheia do item), depois FUST e FUNTTEL (base líquida
// já descontando os três acima) — reflete a ordem real do cálculo em
// cascata. Impostos fora da lista (IBS/CBS, etc.) vão pro final.
const ORDEM_IMPOSTOS = ['ICMS', 'PIS', 'COFINS', 'FUST', 'FUNTTEL'];
function ordemImposto(nome) {
  const i = ORDEM_IMPOSTOS.indexOf(String(nome || '').trim());
  return i === -1 ? ORDEM_IMPOSTOS.length : i;
}

// Resolve percentual_fixo/absorve_restante pro modelo ATUAL: prefere o tipo
// atual do catálogo (join em carregarItensDoPlano) e só cai pro snapshot se
// o item não existe mais no catálogo — planos salvos antes de essas colunas
// existirem no snapshot ficaram com elas nulas/zeradas.
function resolverFlagsAtual(item) {
  const tipoEncontrado = item.tipo_atual_id != null;
  return {
    percentualFixo: tipoEncontrado ? item.tipo_percentual_fixo_atual : item.percentual_fixo,
    absorveRestante: tipoEncontrado ? !!item.tipo_absorve_restante_atual : !!item.absorve_restante,
  };
}

// Traz o cálculo COMPLETO de cada plano (não só o resumo) — usado pela tela
// de lista, que virou uma grade de cartões (mesmo formato do cartão de
// detalhe), então precisa dos itens/impostos de todos de uma vez, sem 1
// requisição por plano.
async function listarPlanosComCalculo(empresaId, modelo) {
  const rows = modelo
    ? await all('SELECT * FROM cp_planos WHERE empresa_id = ? AND ativo = 1 AND modelo = ? ORDER BY preco_venda ASC', [empresaId, modelo])
    : await all('SELECT * FROM cp_planos WHERE empresa_id = ? AND ativo = 1 ORDER BY preco_venda ASC', [empresaId]);
  const planos = [];
  for (const plano of rows) {
    const itens = await carregarItensDoPlano(plano.id);
    planos.push({ ...plano, ...calcularComposicao(plano, itens) });
  }
  return planos;
}

router.get('/', async (req, res) => {
  try {
    res.json(await listarPlanosComCalculo(req.usuario.empresa_id));
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar planos' }); }
});

// Rotas literais (relatorio-geral.*) precisam vir ANTES de /:id, senão o
// Express trata "relatorio-geral.pdf" como se fosse um id de plano.
router.get('/relatorio-geral.pdf', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const planos = await listarPlanosComCalculo(empresaId, req.query.modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado ainda' });
    const nivel = req.query.nivel || 'completo';
    let secaoCombosHtml = '';
    if (nivel === 'completo') {
      for (const r of planos) r.comparacao_modelos = await buscarComparacaoModelos(empresaId, r);
      // Combos LC+ Livros por modelo — pedido da usuária 02/10/2026. Busca
      // TODOS os planos (não só os da aba filtrada) porque o combo compara
      // Modelo atual/Base 50% entre si, não só o modelo aberto.
      const todosPlanos = await listarPlanosComCalculo(empresaId);
      const modelosPersonalizados = await all('SELECT * FROM cp_modelos WHERE empresa_id = ? AND ativo = 1', [empresaId]);
      const { montarHtmlSecaoCombos } = require('../utils/gerarPDFComparacao');
      secaoCombosHtml = montarHtmlSecaoCombos(todosPlanos, modelosPersonalizados);
    }
    const { htmlParaPdf } = require('../utils/gerarPDFHtml');
    const pdf = await htmlParaPdf(htmlRelatorioGeral(planos, nivel, secaoCombosHtml));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="planos-composicao.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar PDF geral' }); }
});

async function labelModelo(empresaId, modelo) {
  if (!modelo || modelo === 'novo') return 'Modelo novo';
  if (modelo === 'atual') return 'Modelo atual (hoje)';
  const m = await get('SELECT nome FROM cp_modelos WHERE id = ? AND empresa_id = ?', [modelo, empresaId]);
  return m?.nome || modelo;
}

// PDF da grade comparativa (planos nas linhas, itens nas colunas) — pedido da
// usuária 29/09/2026: mesma tabela compacta da tela "Tabela", pra baixar.
router.get('/relatorio-tabela.pdf', async (req, res) => {
  try {
    const modelo = req.query.modelo || 'novo';
    const planos = await listarPlanosComCalculo(req.usuario.empresa_id, modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado nessa aba ainda' });
    const itensCatalogo = await all(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante
       FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id
       WHERE i.empresa_id = ? AND i.ativo = 1 ORDER BY t.ordem, t.nome, i.nome`,
      [req.usuario.empresa_id]
    );
    const modeloLabel = await labelModelo(req.usuario.empresa_id, modelo);
    const { gerarPDFTabelaComposicao } = require('../utils/gerarPDFTabelaComposicao');
    const pdf = await gerarPDFTabelaComposicao(planos, itensCatalogo, { modeloLabel, nomeUsuario: req.usuario.nome });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tabela-composicao.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar PDF da tabela' }); }
});

// Mesma grade em Excel — pedido da usuária 01/10/2026 ("tem excel pra
// baixar a tabela?"), só existia em PDF.
router.get('/relatorio-tabela.xlsx', async (req, res) => {
  try {
    const modelo = req.query.modelo || 'novo';
    const planos = await listarPlanosComCalculo(req.usuario.empresa_id, modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado nessa aba ainda' });
    const itensCatalogo = await all(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante
       FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id
       WHERE i.empresa_id = ? AND i.ativo = 1 ORDER BY t.ordem, t.nome, i.nome`,
      [req.usuario.empresa_id]
    );
    const XLSX = require('xlsx');
    const { montarLinhasTabelaXlsx } = require('../utils/gerarPDFTabelaComposicao');
    const linhas = montarLinhasTabelaXlsx(planos, itensCatalogo);
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(linhas);
    sheet['!cols'] = larguraColunas(linhas);
    XLSX.utils.book_append_sheet(wb, sheet, 'Tabela');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tabela-composicao.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar Excel da tabela' }); }
});

// PDF da tela "Cards" (grade de cartões, um por plano) — pedido da usuária
// 02/10/2026 ("trazer em pdf essa tela dos cards").
router.get('/relatorio-cards.pdf', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const modelo = req.query.modelo || 'novo';
    const planos = await listarPlanosComCalculo(empresaId, modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado nessa aba ainda' });
    for (const r of planos) {
      if (r.modelo === 'atual') r.comparacao_modelos = await buscarComparacaoModelos(empresaId, r);
    }
    const modeloLabel = await labelModelo(empresaId, modelo);
    const { gerarPDFCards } = require('../utils/gerarPDFCards');
    const pdf = await gerarPDFCards(planos, { modeloLabel, nomeUsuario: req.usuario.nome });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="planos-cards.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar PDF dos cards' }); }
});

// PDF/Excel da aba "Comparação" (análise fiscal + combos + comparativo entre
// modelos) — pedido da usuária 02/10/2026, essa aba não tinha download nenhum.
router.get('/relatorio-comparacao.pdf', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const planos = await listarPlanosComCalculo(empresaId);
    const modelosPersonalizados = await all('SELECT * FROM cp_modelos WHERE empresa_id = ? AND ativo = 1', [empresaId]);
    const { gerarPDFComparacao } = require('../utils/gerarPDFComparacao');
    const pdf = await gerarPDFComparacao(planos, modelosPersonalizados, { nomeUsuario: req.usuario.nome });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="comparacao-modelos.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar PDF de comparação' }); }
});

router.get('/relatorio-comparacao.xlsx', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const planos = await listarPlanosComCalculo(empresaId);
    const modelosPersonalizados = await all('SELECT * FROM cp_modelos WHERE empresa_id = ? AND ativo = 1', [empresaId]);
    const XLSX = require('xlsx');
    const { montarLinhasAnaliseFiscalXlsx, montarLinhasCombosXlsx, montarLinhasComparativoXlsx } = require('../utils/gerarPDFComparacao');
    const wb = XLSX.utils.book_new();
    const fiscal = montarLinhasAnaliseFiscalXlsx(planos, modelosPersonalizados);
    if (fiscal.length) {
      const s1 = XLSX.utils.json_to_sheet(fiscal);
      s1['!cols'] = larguraColunas(fiscal);
      XLSX.utils.book_append_sheet(wb, s1, 'Analise fiscal');
    }
    const combos = montarLinhasCombosXlsx(planos, modelosPersonalizados);
    if (combos.length) {
      const s2 = XLSX.utils.json_to_sheet(combos);
      s2['!cols'] = larguraColunas(combos);
      XLSX.utils.book_append_sheet(wb, s2, 'Combos');
    }
    const comparativo = montarLinhasComparativoXlsx(planos, modelosPersonalizados);
    if (comparativo.length) {
      const s3 = XLSX.utils.json_to_sheet(comparativo);
      s3['!cols'] = larguraColunas(comparativo);
      XLSX.utils.book_append_sheet(wb, s3, 'Comparativo');
    }
    if (wb.SheetNames.length === 0) return res.status(404).json({ erro: 'Nenhum modelo cadastrado ainda' });
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="comparacao-modelos.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar Excel de comparação' }); }
});

// Largura de coluna por conteúdo (json_to_sheet) — pedido da usuária
// 25/09/2026: a planilha vem "bem ajustada" pra ela poder editar depois sem
// precisar redimensionar coluna por coluna.
function larguraColunas(linhas) {
  if (!linhas.length) return [];
  // União das chaves de TODAS as linhas (não só a primeira) — linhas de
  // resumo/comparação no fim costumam introduzir colunas novas (ex.:
  // "Margem bruta (%)", "Base 50%") que ficavam sem largura ajustada.
  const chaves = [...new Set(linhas.flatMap(l => Object.keys(l)))];
  return chaves.map(chave => {
    const maior = linhas.reduce((max, linha) => {
      const v = linha[chave];
      return Math.max(max, v == null ? 0 : String(v).length);
    }, chave.length);
    return { wch: Math.min(Math.max(maior + 2, 10), 45) };
  });
}
// Nome de aba do Excel válido (limite de 31 caracteres, sem [ ] * ? / \ :).
// Muitos planos dela começam com o mesmo texto (ex.: "INTERNET 1000MBPS +
// WATCH TV + ...") e só se diferenciam depois do limite de 31 caracteres —
// por isso prefixa com um número (garante nome único sem precisar cortar
// meio nome igual de vários planos e desambiguar com sufixo confuso).
function nomeAbaSeguro(nome, indice) {
  const prefixo = `${String(indice).padStart(2, '0')} `;
  const base = String(nome || 'Plano').replace(/[[\]*?/\\:]/g, '').trim();
  return prefixo + (base.slice(0, 31 - prefixo.length) || 'Plano');
}

router.get('/relatorio-geral.xlsx', async (req, res) => {
  try {
    const planos = await listarPlanosComCalculo(req.usuario.empresa_id, req.query.modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado ainda' });
    const nivel = req.query.nivel || 'completo';
    const comImpostos = nivel === 'impostos' || nivel === 'completo';
    const completo = nivel === 'completo';
    const XLSX = require('xlsx');
    const resumo = planos.map(r => {
      const linha = {
        Plano: r.nome, 'Preço bruto': r.preco_venda, 'Preço com desconto': r.valor_com_desconto,
        'Valor total composição': r.valor_total_composicao,
      };
      if (comImpostos) {
        Object.assign(linha, {
          'Desconto pontualidade': r.desconto_pontualidade,
          'Custo fornecedores': r.custo_total_fornecedores, 'Total impostos': r.total_impostos,
          'SVA + Livro/E-book (%)': Number(r.regra_50.percentual_sva_livro.toFixed(2)), 'Status regra 50%': r.regra_50.status,
          'Resultado bruto': r.resultado_bruto, 'Margem bruta (%)': Number(r.margem_bruta_percentual.toFixed(2)),
          'Resultado com desconto': r.resultado_liquido, 'Margem com desconto (%)': Number(r.margem_liquida_percentual.toFixed(2)),
        });
      }
      if (completo) {
        Object.assign(linha, {
          'Quantidade de clientes': r.quantidade_clientes,
          'Faturamento total bruto': r.faturamento_total_bruto, 'Faturamento total com desconto': r.faturamento_total_liquido,
          'Impostos totais (clientes)': r.impostos_totais_clientes,
          'Resultado total bruto': r.resultado_total_bruto, 'Resultado total com desconto': r.resultado_total_liquido,
        });
      }
      return linha;
    });
    const wb = XLSX.utils.book_new();
    const resumoSheet = XLSX.utils.json_to_sheet(resumo);
    resumoSheet['!cols'] = larguraColunas(resumo);
    XLSX.utils.book_append_sheet(wb, resumoSheet, 'Resumo');

    // Cada plano em sua própria aba (pedido da usuária 25/09/2026: numa
    // planilha só, com "Plano" repetido linha a linha, ficava difícil editar
    // a composição de um plano sem se confundir com a de outro). Mesma
    // função do Excel individual (pedido da usuária 01/10/2026: esta aba
    // vinha bem mais pobre que o /relatorio.xlsx de um plano só — faltavam
    // impostos aplicados por item, totais por tipo, resultado/margem e a
    // comparação entre modelos).
    for (const [indice, r] of planos.entries()) {
      if (completo) r.comparacao_modelos = await buscarComparacaoModelos(req.usuario.empresa_id, r);
      // "Plano" por cima (o nome da aba vem truncado em 31 caracteres pelo
      // Excel) — o resto (preço, itens, impostos, resultado...) já vem de
      // montarLinhasPlanoXlsx, sem repetir aqui pra não duplicar informação.
      const linhas = [{ Item: 'Plano', 'Valor total': r.nome }, {}, ...montarLinhasPlanoXlsx(r, nivel)];
      const planoSheet = XLSX.utils.json_to_sheet(linhas);
      planoSheet['!cols'] = larguraColunas(linhas);
      XLSX.utils.book_append_sheet(wb, planoSheet, nomeAbaSeguro(r.nome, indice + 1));
    }
    // Combos LC+ Livros por modelo — pedido da usuária 02/10/2026, mesma aba
    // do /relatorio-comparacao.xlsx. Busca TODOS os planos (não só os da aba
    // filtrada) porque compara Modelo atual/Base 50% entre si.
    if (completo) {
      const todosPlanos = await listarPlanosComCalculo(req.usuario.empresa_id);
      const modelosPersonalizados = await all('SELECT * FROM cp_modelos WHERE empresa_id = ? AND ativo = 1', [req.usuario.empresa_id]);
      const { montarLinhasCombosXlsx } = require('../utils/gerarPDFComparacao');
      const combos = montarLinhasCombosXlsx(todosPlanos, modelosPersonalizados);
      if (combos.length) {
        const combosSheet = XLSX.utils.json_to_sheet(combos);
        combosSheet['!cols'] = larguraColunas(combos);
        XLSX.utils.book_append_sheet(wb, combosSheet, 'Combos');
      }
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planos-composicao.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar Excel geral' }); }
});

router.get('/relatorio-geral.csv', async (req, res) => {
  try {
    const planos = await listarPlanosComCalculo(req.usuario.empresa_id, req.query.modelo);
    if (planos.length === 0) return res.status(404).json({ erro: 'Nenhum plano cadastrado ainda' });
    const nivel = req.query.nivel || 'completo';
    const comImpostos = nivel === 'impostos' || nivel === 'completo';
    const completo = nivel === 'completo';
    const cabecalho = ['Plano', 'Item', 'Tipo', 'Quantidade', 'Valor unitario', 'Valor total', 'Percentual'];
    if (comImpostos) cabecalho.push('Custo fornecedor', 'Impostos');
    const linhas = [];
    for (const r of planos) {
      for (const i of r.itens) {
        const linha = [r.nome, i.nome, i.tipo, i.quantidade, i.valor_unitario, i.valor_item, pctOuFora(i.percentual)];
        if (comImpostos) linha.push(i.custo_item, i.impostos_item.toFixed(2));
        linhas.push(linha);
      }
      linhas.push([r.nome, 'Preço bruto', '', '', '', r.preco_venda]);
      linhas.push([r.nome, 'Preço com desconto', '', '', '', r.valor_com_desconto]);
      if (comImpostos) {
        linhas.push([r.nome, 'Desconto pontualidade', '', '', '', r.desconto_pontualidade]);
        linhas.push([r.nome, 'Total de impostos', '', '', '', r.total_impostos]);
        linhas.push([r.nome, 'Resultado bruto', '', '', '', r.resultado_bruto]);
        linhas.push([r.nome, 'Margem bruta (%)', '', '', '', '', r.margem_bruta_percentual.toFixed(2)]);
        linhas.push([r.nome, 'Resultado com desconto', '', '', '', r.resultado_liquido]);
        linhas.push([r.nome, 'Margem com desconto (%)', '', '', '', '', r.margem_liquida_percentual.toFixed(2)]);
      }
      if (completo) {
        linhas.push([r.nome, 'Quantidade de clientes', '', r.quantidade_clientes]);
        linhas.push([r.nome, 'Faturamento total bruto', '', '', '', r.faturamento_total_bruto]);
        linhas.push([r.nome, 'Faturamento total com desconto', '', '', '', r.faturamento_total_liquido]);
        linhas.push([r.nome, 'Resultado total bruto', '', '', '', r.resultado_total_bruto]);
        linhas.push([r.nome, 'Resultado total com desconto', '', '', '', r.resultado_total_liquido]);
      }
      linhas.push([]);
    }
    const csv = [cabecalho, ...linhas].map(l => l.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planos-composicao.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar CSV geral' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const plano = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado' });
    const itens = await carregarItensDoPlano(plano.id);
    res.json({ ...plano, ...calcularComposicao(plano, itens) });
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar plano' }); }
});

function validarPayload(body) {
  const { nome, itens } = body;
  if (!nome) return 'Nome do plano é obrigatório';
  if (!Array.isArray(itens) || itens.length === 0) return 'O plano precisa de pelo menos 1 item';
  for (const item of itens) {
    if (!item.item_id) return 'Todo item selecionado precisa de item_id';
    if (!Number(item.quantidade) || Number(item.quantidade) < 1) return 'Quantidade inválida';
  }
  return null;
}

// Aplica a fórmula de precificação automática (pedido da usuária 24/09/2026):
// tipos com percentual_fixo têm o valor travado nesse % do preço de venda do
// plano (ex.: Internet/SM = sempre 50%); tipos com absorve_restante dividem
// entre si o que sobrar do preço de venda depois de todos os outros itens já
// calculados (ex.: Livro/E-book). Itens sem nenhuma das duas flags usam o
// valor de venda do catálogo normalmente (ex.: SVA). Sem item "absorvedor"
// no plano, o restante simplesmente não é distribuído — não é erro, só
// significa que o plano não tem um item pra sobrar o valor (ex.: um plano só
// de Internet).
function aplicarFormulaPrecos(itens, precoVenda) {
  const preco = numOrZero(precoVenda);
  for (const item of itens) {
    if (item.percentual_fixo != null) {
      item.valor_unitario = item.quantidade > 0 ? (numOrZero(item.percentual_fixo) / 100 * preco) / item.quantidade : 0;
    }
  }
  const absorventes = itens.filter(i => i.absorve_restante);
  if (absorventes.length > 0) {
    const somaDemais = itens.filter(i => !i.absorve_restante).reduce((s, i) => s + numOrZero(i.quantidade) * numOrZero(i.valor_unitario), 0);
    const restante = preco - somaDemais;
    const qtdTotalAbsorventes = absorventes.reduce((s, i) => s + numOrZero(i.quantidade), 0) || 1;
    for (const item of absorventes) item.valor_unitario = restante / qtdTotalAbsorventes;
  }
  return itens;
}

// Resolve os item_id recebidos contra o catálogo (nunca confia em nome/valor
// vindo do front) e monta o snapshot que será gravado no plano.
async function resolverItensParaSnapshot(empresaId, itensRecebidos, precoVenda) {
  const snapshot = [];
  for (const itemRecebido of itensRecebidos) {
    const item = await get(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.id = ? AND i.empresa_id = ?`,
      [itemRecebido.item_id, empresaId]
    );
    if (!item) throw new Error(`Item ${itemRecebido.item_id} não encontrado`);
    const impostos = await carregarImpostosDoItem(item.id);
    snapshot.push({
      item_id: item.id, nome: item.nome, tipo: item.tipo_nome, conta_no_limite_50: item.conta_no_limite_50,
      percentual_fixo: item.percentual_fixo, absorve_restante: item.absorve_restante,
      quantidade: Number(itemRecebido.quantidade), valor_unitario: numOrZero(item.valor_venda),
      custo_fornecedor_unitario: numOrZero(item.custo_fornecedor),
      impostos: impostos.map(i => ({ nome: i.nome, aliquota: i.aliquota, base_calculo: i.base_calculo })),
    });
  }
  return aplicarFormulaPrecos(snapshot, precoVenda);
}

// Monta o snapshot pra um modelo PERSONALIZADO (pedido da usuária
// 25/09/2026): sem fórmula nenhuma — usa o valor_unitario que ela digitou
// pra cada item, exatamente como recebido (só valida o item_id contra o
// catálogo, pra puxar nome/tipo/custo/impostos corretos).
async function resolverItensLivre(empresaId, itensRecebidos) {
  const snapshot = [];
  for (const itemRecebido of itensRecebidos) {
    const item = await get(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50 FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.id = ? AND i.empresa_id = ?`,
      [itemRecebido.item_id, empresaId]
    );
    if (!item) throw new Error(`Item ${itemRecebido.item_id} não encontrado`);
    const impostos = await carregarImpostosDoItem(item.id);
    snapshot.push({
      item_id: item.id, nome: item.nome, tipo: item.tipo_nome, conta_no_limite_50: item.conta_no_limite_50,
      percentual_fixo: null, absorve_restante: false,
      quantidade: Number(itemRecebido.quantidade) || 1, valor_unitario: numOrZero(itemRecebido.valor_unitario),
      custo_fornecedor_unitario: numOrZero(item.custo_fornecedor),
      impostos: impostos.map(i => ({ nome: i.nome, aliquota: i.aliquota, base_calculo: i.base_calculo })),
    });
  }
  return snapshot;
}

// Recalcula preco_venda como a soma dos itens já salvos do plano — usado
// depois de editar um item avulso (ajustar-composicao-atual, tabela
// comparativa), pra o Total nunca ficar dessincronizado da composição real.
async function sincronizarPrecoVenda(planoId) {
  const itens = await carregarItensDoPlano(planoId);
  const total = itens.reduce((s, i) => s + numOrZero(i.quantidade) * numOrZero(i.valor_unitario), 0);
  await run('UPDATE cp_planos SET preco_venda = ? WHERE id = ?', [total, planoId]);
}

async function gravarItensDoPlano(planoId, snapshot) {
  let ordem = 0;
  for (const item of snapshot) {
    const planoItemId = uuidv4();
    await run(
      `INSERT INTO cp_plano_itens (id, plano_id, item_id, nome, tipo, conta_no_limite_50, percentual_fixo, absorve_restante, quantidade, valor_unitario, custo_fornecedor_unitario, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [planoItemId, planoId, item.item_id, item.nome, item.tipo, item.conta_no_limite_50 ? 1 : 0, item.percentual_fixo, item.absorve_restante ? 1 : 0, item.quantidade, item.valor_unitario, item.custo_fornecedor_unitario, ordem++]
    );
    for (const imp of item.impostos) {
      await run(
        `INSERT INTO cp_plano_itens_impostos (id, plano_item_id, nome, aliquota, base_calculo) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), planoItemId, imp.nome, imp.aliquota, imp.base_calculo]
      );
    }
  }
}

router.post('/', async (req, res) => {
  try {
    const erro = validarPayload(req.body);
    if (erro) return res.status(400).json({ erro });
    const { nome, preco_venda, quantidade_clientes, desconto_pontualidade, itens, modelo } = req.body;
    // Qualquer modelo que não seja "novo" cria livre (sem fórmula, valor de
    // cada item como recebido) — inclusive "atual", pedido da usuária
    // 28/09/2026 pra criar plano atual direto pela tabela comparativa,
    // digitando o valor de cada item na hora (sem passar por /duplicar ou
    // /importar-erp). "novo" nunca aceita valor manual, sempre a fórmula.
    const modeloFinal = (modelo && modelo !== 'novo') ? modelo : 'novo';
    const snapshot = modeloFinal === 'novo'
      ? await resolverItensParaSnapshot(req.usuario.empresa_id, itens, preco_venda)
      : await resolverItensLivre(req.usuario.empresa_id, itens);
    const id = uuidv4();
    await run(
      `INSERT INTO cp_planos (id, empresa_id, nome, preco_venda, quantidade_clientes, desconto_pontualidade, modelo, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, nome, numOrZero(preco_venda), Math.max(1, Math.round(numOrZero(quantidade_clientes)) || 1), desconto_pontualidade != null ? numOrZero(desconto_pontualidade) : 10, modeloFinal, req.usuario.id]
    );
    await gravarItensDoPlano(id, snapshot);
    const criado = await get('SELECT * FROM cp_planos WHERE id = ?', [id]);
    res.status(201).json({ ...criado, ...calcularComposicao(criado, await carregarItensDoPlano(id)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao criar plano' }); }
});

// Duplica um plano já salvo. modelo='atual' recalcula os itens de
// percentual_fixo/absorve_restante com a fórmula ANTIGA (Internet+Livro
// 50/50 só sobre o valor sem as SVAs, ver calcularComposicaoAntiga) em vez de
// copiar os valores da fórmula nova — pedido da usuária 24/09/2026, pra
// registrar de vez a composição de hoje como um plano próprio, numa aba
// separada dos planos "novo".
router.post('/:id/duplicar', async (req, res) => {
  try {
    const original = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!original) return res.status(404).json({ erro: 'Plano não encontrado' });
    // Destino pode ser 'atual' ou qualquer modelo personalizado (pedido da
    // usuária 28/09/2026: trazer planos já existentes pra uma aba nova sem
    // refazer tudo do zero) — só default pra 'novo' se nada for informado.
    const modelo = req.body.modelo || 'novo';
    const itensOriginais = await carregarItensDoPlano(original.id);
    const snapshot = itensOriginais.map(i => ({
      item_id: i.item_id, nome: i.nome, tipo: i.tipo, conta_no_limite_50: i.conta_no_limite_50,
      percentual_fixo: i.percentual_fixo, absorve_restante: i.absorve_restante,
      tipo_atual_id: i.tipo_atual_id, tipo_percentual_fixo_atual: i.tipo_percentual_fixo_atual, tipo_absorve_restante_atual: i.tipo_absorve_restante_atual,
      quantidade: i.quantidade, valor_unitario: i.valor_unitario, custo_fornecedor_unitario: i.custo_fornecedor_unitario,
      impostos: i.impostos,
    }));

    // A fórmula de conversão (SVA/Livro travados no catálogo, Internet
    // absorve o resto) só faz sentido indo de "novo" pra "atual" — pra
    // qualquer outro destino (atual->personalizado, por exemplo) copia os
    // valores tal como estão, sem reaplicar fórmula nenhuma.
    if (modelo === 'atual' && original.modelo === 'novo') {
      // Mesma fórmula de calcularComposicaoAntiga: SVA e Livro/E-book ficam
      // travados no valor de CATÁLOGO (não no valor calculado pela fórmula
      // nova) e a Internet absorve o que sobrar. Resolve percentual_fixo/
      // absorve_restante pelo tipo ATUAL do catálogo (resolverFlagsAtual) —
      // planos salvos antes dessas colunas existirem no snapshot ficaram com
      // elas nulas/zeradas.
      const preco = numOrZero(original.preco_venda);
      for (const l of snapshot) {
        const { percentualFixo, absorveRestante } = resolverFlagsAtual(l);
        l.percentual_fixo = percentualFixo;
        l.absorve_restante = absorveRestante;
      }
      // A faixa de quantidade de livros usa o valor QUE FICA DENTRO DA
      // COMPOSIÇÃO (Internet+Livro) — nunca o preço total do plano, que já
      // vem com as SVAs somadas (essas ficam fora da composição).
      const somaSva = snapshot.filter(l => l.percentual_fixo == null && !l.absorve_restante).reduce((s, l) => s + numOrZero(l.quantidade) * numOrZero(l.valor_unitario), 0);
      const valorComposicao = preco - somaSva;
      for (const l of snapshot) {
        if (l.absorve_restante) {
          // Livro/E-book: quantidade conforme a faixa de valor da composição, e
          // valor travado no de catálogo (não no calculado pela fórmula nova).
          l.quantidade = calcularQuantidadeLivrosAtual(valorComposicao);
          if (l.item_id) {
            const itemCatalogo = await get('SELECT valor_venda FROM cp_itens WHERE id = ?', [l.item_id]);
            if (itemCatalogo) l.valor_unitario = numOrZero(itemCatalogo.valor_venda);
          }
        }
      }
      const itensInternet = snapshot.filter(l => l.percentual_fixo != null);
      const somaDemais = snapshot.filter(l => l.percentual_fixo == null).reduce((s, l) => s + numOrZero(l.quantidade) * numOrZero(l.valor_unitario), 0);
      const qtdInternet = itensInternet.reduce((s, l) => s + numOrZero(l.quantidade), 0) || 1;
      const restanteInternet = preco - somaDemais;
      for (const l of itensInternet) l.valor_unitario = restanteInternet / qtdInternet;
    }

    // Duplicar traz só nome + composição/valores (pedido da usuária
    // 24/09/2026) — nome sem sufixo (as abas já separam novo de atual) e
    // quantidade de clientes/desconto voltam ao padrão, não herdam do
    // original (são específicos daquele plano, não da composição em si).
    const novoId = uuidv4();
    await run(
      `INSERT INTO cp_planos (id, empresa_id, nome, preco_venda, quantidade_clientes, desconto_pontualidade, modelo, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [novoId, req.usuario.empresa_id, original.nome, original.preco_venda, 1, 10, modelo, req.usuario.id]
    );
    await gravarItensDoPlano(novoId, snapshot);
    const criado = await get('SELECT * FROM cp_planos WHERE id = ?', [novoId]);
    res.status(201).json({ ...criado, ...calcularComposicao(criado, await carregarItensDoPlano(novoId)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao duplicar plano' }); }
});

// Importa planos direto do ERP (mesma fonte da tela "Análise de Planos") pro
// modelo ATUAL — pedido da usuária 25/09/2026: só entram os planos que têm
// "LC+ Livros" na composição fiscal (os sem livro ficam de fora). servico.
// valor é exatamente o "Valor" que ela vê na tela do painel (Internet+Livro
// combinados, base da composição) e servico_pacote[] são as SVAs, cobradas
// à parte (fora da composição, mas somam no preço total do plano) — mesma
// distinção já usada em calcularComposicaoAntiga/ajustar-composicao-atual.
// Não importa de novo um plano cujo nome já existe no modelo atual (evita
// duplicar a cada nova importação).
router.post('/importar-erp', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;

    const itensCatalogo = await all(
      `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante
       FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.empresa_id = ? AND i.ativo = 1`,
      [empresaId]
    );
    const itemInternetCatalogo = itensCatalogo.find(i => i.percentual_fixo != null);
    const itemLivroCatalogo = itensCatalogo.find(i => i.absorve_restante);
    if (!itemInternetCatalogo || !itemLivroCatalogo) {
      return res.status(400).json({ erro: 'Cadastre no catálogo um item do tipo Internet/SM e um do tipo Livro/E-book antes de importar.' });
    }
    const itensSvaCatalogo = itensCatalogo.filter(i => i.id !== itemInternetCatalogo.id && i.id !== itemLivroCatalogo.id);
    const impostosPorItem = new Map();
    for (const item of itensCatalogo) impostosPorItem.set(item.id, await carregarImpostosDoItem(item.id));
    const impostosDoItem = (item) => (impostosPorItem.get(item.id) || []).map(i => ({ nome: i.nome, aliquota: i.aliquota, base_calculo: i.base_calculo }));

    const resumo = await hubsoft.listarPlanosResumo(empresaId, {});
    // Só planos com mais de 10 clientes (pedido da usuária 25/09/2026) —
    // ignora planos sem cliente relevante ou residuais com poucos clientes.
    const relevantes = resumo.filter(p => (p.clientes_servicos_count ?? 0) > 10);

    const existentes = await all(`SELECT nome FROM cp_planos WHERE empresa_id = ? AND modelo = 'atual' AND ativo = 1`, [empresaId]);
    const nomesExistentes = new Set(existentes.map(p => normalizarNome(p.nome)));

    const candidatos = []; // { nome, precoVenda, clientes, snapshot }
    const pulados = [];
    const avisos = [];

    for (const p of relevantes) {
      // Já existe um plano com esse nome no modelo atual? Não vale a pena
      // gastar uma chamada de detalhe no ERP só pra descobrir isso de novo —
      // o nome do resumo é o mesmo da descrição do detalhe.
      const nomeResumo = p.descricao || p.nome_exibicao || `Plano ${p.id_servico}`;
      if (nomesExistentes.has(normalizarNome(nomeResumo))) { pulados.push(nomeResumo); continue; }

      // Cada plano processa isolado: um erro (ex.: formato inesperado vindo
      // do ERP num plano específico) vira aviso e passa pro próximo, em vez
      // de derrubar a importação inteira e deixar o resto de fora sem avisar
      // (bug encontrado 25/09/2026: um plano no meio da lista quebrava e
      // cortava todos os que vinham depois dele, sem gerar erro visível).
      try {
        const detalhe = await hubsoft.detalhePlano(empresaId, p.id_servico);
        const qtdLivros = contarLivrosComposicaoErp(detalhe);
        if (!qtdLivros) continue; // sem LC+ Livros na composição — fora do escopo pedido

        const nome = detalhe.descricao || detalhe.nome_exibicao || nomeResumo;
        if (nomesExistentes.has(normalizarNome(nome))) { pulados.push(nome); continue; }

        const valorComposicao = numOrZero(detalhe.valor);
        const valorLivroUnitario = numOrZero(itemLivroCatalogo.valor_venda);
        const valorInternet = valorComposicao - (qtdLivros * valorLivroUnitario);

        const snapshot = [
          {
            item_id: itemInternetCatalogo.id, nome: itemInternetCatalogo.nome, tipo: itemInternetCatalogo.tipo_nome,
            conta_no_limite_50: itemInternetCatalogo.conta_no_limite_50, percentual_fixo: itemInternetCatalogo.percentual_fixo, absorve_restante: false,
            quantidade: 1, valor_unitario: valorInternet, custo_fornecedor_unitario: numOrZero(itemInternetCatalogo.custo_fornecedor),
            impostos: impostosDoItem(itemInternetCatalogo),
          },
          {
            item_id: itemLivroCatalogo.id, nome: itemLivroCatalogo.nome, tipo: itemLivroCatalogo.tipo_nome,
            conta_no_limite_50: itemLivroCatalogo.conta_no_limite_50, percentual_fixo: null, absorve_restante: true,
            quantidade: qtdLivros, valor_unitario: valorLivroUnitario, custo_fornecedor_unitario: numOrZero(itemLivroCatalogo.custo_fornecedor),
            impostos: impostosDoItem(itemLivroCatalogo),
          },
        ];

        let somaSva = 0;
        for (const pacote of (detalhe.servico_pacote || [])) {
          const nomePacote = pacote.descricao || pacote.display || 'SVA';
          const valorPacote = numOrZero(pacote.valor);
          somaSva += valorPacote;
          const catalogoMatch = itensSvaCatalogo.find(i => normalizarNome(i.nome) === normalizarNome(nomePacote));
          if (!catalogoMatch) {
            // Sem item no catálogo com esse nome — pedido da usuária
            // 29/09/2026: não cria mais uma linha "órfã" (nome cru do ERP,
            // sem item_id) que nunca aparece em nenhuma coluna da tabela e
            // fica duplicando quando ela preenche a SVA certa manualmente.
            // O valor ainda soma no preço total do plano, só não vira linha.
            avisos.push(`${nome}: SVA "${nomePacote}" (R$ ${valorPacote.toFixed(2)}) sem correspondência no catálogo — não entrou como item, cadastre e preencha manualmente se quiser rastrear.`);
            continue;
          }
          snapshot.push({
            item_id: catalogoMatch.id, nome: catalogoMatch.nome, tipo: catalogoMatch.tipo_nome,
            conta_no_limite_50: catalogoMatch.conta_no_limite_50, percentual_fixo: null, absorve_restante: false,
            quantidade: 1, valor_unitario: valorPacote, custo_fornecedor_unitario: numOrZero(catalogoMatch.custo_fornecedor),
            impostos: impostosDoItem(catalogoMatch),
          });
        }

        const precoVenda = valorComposicao + somaSva;
        candidatos.push({ nome, precoVenda, clientes: p.clientes_servicos_count, snapshot, idErp: String(p.id_servico) });
      } catch (e) {
        avisos.push(`${nomeResumo}: falha ao importar (${e.message}) — pulado, os demais planos continuaram normalmente.`);
      }
    }

    // Dedup por "mesmo plano, preço com centavo diferente" (pedido da
    // usuária 25/09/2026: ex.: 129,90 e 129,00 contam como UM plano só, fica
    // o de ,90). Só considera duplicata quando o nome-base bate (preço
    // embutido no nome, tipo "129,00", removido antes de comparar) E a
    // diferença de valor é de ~R$0,90 — isso evita juntar planos que
    // simplesmente têm o mesmo nome-base por coincidência mas preços bem
    // diferentes (ex.: "INTERNET 600MBPS + LC LIVROS" a R$109,90 não é o
    // mesmo plano que "INTERNET 600MBPS 129,00 + LC LIVROS").
    const mantidos = [];
    for (const c of candidatos) {
      const centavos = Math.round((c.precoVenda % 1) * 100);
      const baseC = nomeBaseSemPreco(c.nome);
      const idx = mantidos.findIndex(m => {
        const diff = Math.abs(m.precoVenda - c.precoVenda);
        return nomeBaseSemPreco(m.nome) === baseC && diff > 0.85 && diff < 0.95;
      });
      if (idx === -1) { mantidos.push({ ...c, centavos }); continue; }
      const existente = mantidos[idx];
      if (centavos === 90 && existente.centavos !== 90) {
        avisos.push(`"${existente.nome}" (R$ ${existente.precoVenda.toFixed(2)}) e "${c.nome}" (R$ ${c.precoVenda.toFixed(2)}) são o mesmo plano — mantido só o de R$ ,90.`);
        mantidos[idx] = { ...c, centavos };
      } else if (existente.centavos === 90) {
        avisos.push(`"${c.nome}" (R$ ${c.precoVenda.toFixed(2)}) e "${existente.nome}" (R$ ${existente.precoVenda.toFixed(2)}) são o mesmo plano — mantido só o de R$ ,90.`);
      } else {
        avisos.push(`"${c.nome}" (R$ ${c.precoVenda.toFixed(2)}) parece o mesmo plano de "${existente.nome}" (R$ ${existente.precoVenda.toFixed(2)}) — mantido só o primeiro, nenhum dos dois tem ,90 pra desempatar.`);
      }
    }

    const importados = [];
    for (const c of mantidos) {
      const novoId = uuidv4();
      await run(
        `INSERT INTO cp_planos (id, empresa_id, nome, preco_venda, quantidade_clientes, desconto_pontualidade, modelo, criado_por, id_erp) VALUES (?, ?, ?, ?, ?, ?, 'atual', ?, ?)`,
        [novoId, empresaId, c.nome, c.precoVenda, Math.max(1, c.clientes || 1), 10, req.usuario.id, c.idErp]
      );
      await gravarItensDoPlano(novoId, c.snapshot);
      importados.push(c.nome);
    }

    res.json({ importados, pulados, avisos });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao importar planos do ERP' }); }
});

// Ajusta a composição do modelo ATUAL direto (pedido da usuária 24/09/2026):
// o "Valor" (Internet+Livro) de cada plano no ERP é um campo próprio, não dá
// pra calcular por fórmula (varia por plano sem padrão) — ela digita o valor
// real (visto na tela do HubSoft) e a quantidade de livros aqui, e o sistema
// só recalcula o valor da Internet (= Valor − Livro×qtd). NUNCA mexe nas
// SVAs (ficam de fora dessa composição, continuam com seus valores fixos).
router.patch('/:id/ajustar-composicao-atual', async (req, res) => {
  try {
    const plano = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado' });
    if (plano.modelo !== 'atual') return res.status(400).json({ erro: 'Esse ajuste é só pra planos do modelo atual' });

    const itens = await carregarItensDoPlano(plano.id);
    const itemInternet = itens.find(i => resolverFlagsAtual(i).percentualFixo != null);
    const itemLivro = itens.find(i => resolverFlagsAtual(i).absorveRestante);
    if (!itemInternet || !itemLivro) return res.status(400).json({ erro: 'Plano sem Internet/SM ou Livro/E-book identificável' });

    const valorComposicao = numOrZero(req.body.valor_composicao);
    const quantidadeLivros = Math.max(1, numOrZero(req.body.quantidade_livros) || itemLivro.quantidade);
    const valorLivroUnitario = numOrZero(itemLivro.valor_catalogo_atual ?? itemLivro.valor_unitario);
    const valorInternet = valorComposicao - (quantidadeLivros * valorLivroUnitario);

    await run('UPDATE cp_plano_itens SET quantidade = ?, valor_unitario = ? WHERE id = ?', [quantidadeLivros, valorLivroUnitario, itemLivro.id]);
    await run('UPDATE cp_plano_itens SET valor_unitario = ? WHERE id = ?', [valorInternet, itemInternet.id]);
    // Total do plano (preco_venda) precisa refletir a soma dos itens depois
    // do ajuste — sem isso o "bate com o bruto" ficava incorreto (achado
    // 28/09/2026, o total não era resincronizado aqui).
    await sincronizarPrecoVenda(plano.id);

    const atualizado = await get('SELECT * FROM cp_planos WHERE id = ?', [req.params.id]);
    res.json({ ...atualizado, ...calcularComposicao(atualizado, await carregarItensDoPlano(req.params.id)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao ajustar composição atual' }); }
});

// Edita (ou ADICIONA, ou REMOVE) um item de um plano pelo item do CATÁLOGO —
// usado pela tabela comparativa (planos nas linhas, itens nas colunas),
// pedido da usuária 28/09/2026 pra editar E incluir item novo num plano
// existente direto na célula, sem abrir card/formulário. Célula zerada
// remove o item do plano. Só funciona em modelo != 'novo' (a fórmula do novo
// nunca deve ser contornada editando um item avulso na tabela).
router.patch('/:planoId/item-catalogo/:itemId', async (req, res) => {
  try {
    const plano = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.planoId, req.usuario.empresa_id]);
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado' });
    if (plano.modelo === 'novo') return res.status(400).json({ erro: 'Plano do modelo novo segue a fórmula automática — edite pelo formulário do plano.' });

    const existente = await get('SELECT * FROM cp_plano_itens WHERE plano_id = ? AND item_id = ?', [plano.id, req.params.itemId]);
    const quantidade = req.body.quantidade != null ? numOrZero(req.body.quantidade) : null;
    const valorUnitario = req.body.valor_unitario != null ? numOrZero(req.body.valor_unitario) : null;
    const zerado = (quantidade != null && quantidade <= 0) || (valorUnitario != null && valorUnitario <= 0 && quantidade == null);

    if (zerado) {
      if (existente) {
        await run('DELETE FROM cp_plano_itens_impostos WHERE plano_item_id = ?', [existente.id]);
        await run('DELETE FROM cp_plano_itens WHERE id = ?', [existente.id]);
      }
    } else if (existente) {
      const campos = [];
      const valores = [];
      if (quantidade != null) { campos.push('quantidade = ?'); valores.push(Math.max(1, quantidade)); }
      if (valorUnitario != null) { campos.push('valor_unitario = ?'); valores.push(valorUnitario); }
      if (campos.length) {
        valores.push(existente.id);
        await run(`UPDATE cp_plano_itens SET ${campos.join(', ')} WHERE id = ?`, valores);
      }
    } else {
      // Item ainda não fazia parte do plano — adiciona agora.
      const itemCatalogo = await get(
        `SELECT i.*, t.nome AS tipo_nome, t.conta_no_limite_50, t.percentual_fixo, t.absorve_restante FROM cp_itens i JOIN cp_tipos_item t ON t.id = i.tipo_id WHERE i.id = ? AND i.empresa_id = ?`,
        [req.params.itemId, req.usuario.empresa_id]
      );
      if (!itemCatalogo) return res.status(404).json({ erro: 'Item não encontrado no catálogo' });
      const impostos = await carregarImpostosDoItem(itemCatalogo.id);
      const { ordem } = await get('SELECT COALESCE(MAX(ordem), -1) + 1 AS ordem FROM cp_plano_itens WHERE plano_id = ?', [plano.id]);
      const planoItemId = uuidv4();
      await run(
        `INSERT INTO cp_plano_itens (id, plano_id, item_id, nome, tipo, conta_no_limite_50, percentual_fixo, absorve_restante, quantidade, valor_unitario, custo_fornecedor_unitario, ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planoItemId, plano.id, itemCatalogo.id, itemCatalogo.nome, itemCatalogo.tipo_nome, itemCatalogo.conta_no_limite_50 ? 1 : 0,
          itemCatalogo.percentual_fixo, itemCatalogo.absorve_restante ? 1 : 0,
          Math.max(1, quantidade || 1), valorUnitario ?? numOrZero(itemCatalogo.valor_venda), numOrZero(itemCatalogo.custo_fornecedor), ordem,
        ]
      );
      for (const imp of impostos) {
        await run(
          `INSERT INTO cp_plano_itens_impostos (id, plano_item_id, nome, aliquota, base_calculo) VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), planoItemId, imp.nome, imp.aliquota, imp.base_calculo]
        );
      }
    }

    // NÃO resincroniza preco_venda aqui — achado 28/09/2026: ela digita o
    // Total direto (rota /total, abaixo) pra usar como referência ENQUANTO
    // ainda tá preenchendo os itens um por um; se cada item editado
    // recalculasse o Total pela soma na hora, o valor que ela acabou de
    // digitar "sumia" (virava a soma parcial dos itens já preenchidos até
    // ali). O Total agora só muda quando ela mesma editar essa célula.
    const atualizado = await get('SELECT * FROM cp_planos WHERE id = ?', [plano.id]);
    res.json({ ...atualizado, ...calcularComposicao(atualizado, await carregarItensDoPlano(plano.id)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao atualizar item' }); }
});

// Edita o Total (preco_venda) direto na tabela comparativa — pedido da
// usuária 28/09/2026. Só pra modelo != 'novo' (lá o preço bruto é o insumo
// da fórmula automática, editado só pelo formulário do plano).
router.patch('/:id/total', async (req, res) => {
  try {
    const plano = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado' });
    if (plano.modelo === 'novo') return res.status(400).json({ erro: 'Plano do modelo novo segue a fórmula automática — edite o preço pelo formulário do plano.' });
    await run('UPDATE cp_planos SET preco_venda = ? WHERE id = ?', [numOrZero(req.body.preco_venda), plano.id]);
    const atualizado = await get('SELECT * FROM cp_planos WHERE id = ?', [plano.id]);
    res.json({ ...atualizado, ...calcularComposicao(atualizado, await carregarItensDoPlano(plano.id)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao atualizar o total do plano' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const existente = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Plano não encontrado' });
    const erro = validarPayload(req.body);
    if (erro) return res.status(400).json({ erro });
    const { nome, preco_venda, quantidade_clientes, desconto_pontualidade, itens } = req.body;
    // Qualquer modelo que não seja "novo" (atual OU personalizado) edita
    // livre, sem reaplicar a fórmula do modelo novo — só "novo" continua
    // passando por resolverItensParaSnapshot. CORRIGIDO 25/09/2026: antes só
    // excluía "atual" pelo NOME literal, então editar um plano do modelo
    // atual pelo builder genérico reaplicava a trava de 50%/absorção da
    // fórmula nova por cima dos valores ajustados manualmente — corrompendo
    // o plano em silêncio. Editar um plano atual agora carrega o valor atual
    // de cada item pra edição direta (mesmo comportamento de um modelo
    // personalizado), sem fórmula nenhuma.
    const ehLivre = existente.modelo !== 'novo';
    const snapshot = ehLivre
      ? await resolverItensLivre(req.usuario.empresa_id, itens)
      : await resolverItensParaSnapshot(req.usuario.empresa_id, itens, preco_venda);
    await run(
      `UPDATE cp_planos SET nome = ?, preco_venda = ?, quantidade_clientes = ?, desconto_pontualidade = ?, atualizado_em = TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      [nome, numOrZero(preco_venda), Math.max(1, Math.round(numOrZero(quantidade_clientes)) || 1), desconto_pontualidade != null ? numOrZero(desconto_pontualidade) : 10, req.params.id]
    );
    const antigos = await all('SELECT id FROM cp_plano_itens WHERE plano_id = ?', [req.params.id]);
    for (const antigo of antigos) await run('DELETE FROM cp_plano_itens_impostos WHERE plano_item_id = ?', [antigo.id]);
    await run('DELETE FROM cp_plano_itens WHERE plano_id = ?', [req.params.id]);
    await gravarItensDoPlano(req.params.id, snapshot);
    const atualizado = await get('SELECT * FROM cp_planos WHERE id = ?', [req.params.id]);
    res.json({ ...atualizado, ...calcularComposicao(atualizado, await carregarItensDoPlano(req.params.id)) });
  } catch (e) { res.status(400).json({ erro: e.message || 'Erro ao atualizar plano' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existente = await get('SELECT id FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Plano não encontrado' });
    await run('UPDATE cp_planos SET ativo = 0 WHERE id = ?', [req.params.id]);
    res.json({ mensagem: 'Plano removido com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao remover plano' }); }
});

// ── Histórico (consulta) ─────────────────────────────────────────────────────

router.get('/historico/:entidadeId', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM cp_historico WHERE empresa_id = ? AND entidade_id = ? ORDER BY alterado_em DESC',
      [req.usuario.empresa_id, req.params.entidadeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar histórico' }); }
});

// ── Exportação do relatório do plano ────────────────────────────────────────

const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => `${(Number(v) || 0).toFixed(2)}%`;
const fmtPctItem = (v) => v == null ? 'fora da composição' : fmtPct(v);
const pctOuFora = (v) => v == null ? 'fora da composição' : Number(v.toFixed(2));

// Comparação lado a lado do mesmo plano (por nome) entre Modelo atual e
// Base 50% — pedido da usuária 01/10/2026: a tabela "Novo x Atual" do
// relatório só mostrava 2 colunas, mas já existem modelos reais pra
// comparar. Base 55% tirado da comparação a pedido da usuária 02/10/2026.
// Retorna null se não achar o outro modelo com plano do mesmo nome.
async function buscarComparacaoModelos(empresaId, r) {
  const modelosPersonalizados = await all(
    `SELECT id, nome FROM cp_modelos WHERE empresa_id = ? AND ativo = 1 AND nome = 'Base 50%'`,
    [empresaId]
  );
  const idBase50 = modelosPersonalizados.find(m => m.nome === 'Base 50%')?.id;
  const candidatos = [
    { id: 'atual', titulo: 'Modelo atual' },
    idBase50 && { id: idBase50, titulo: 'Base 50%' },
  ].filter(Boolean);
  const colunas = [];
  for (const c of candidatos) {
    if (c.id === r.modelo) {
      colunas.push({ titulo: c.titulo, itens: r.itens, preco_venda: r.preco_venda, total_impostos: r.total_impostos, resultado_bruto: r.resultado_bruto });
      continue;
    }
    const plano = await get('SELECT * FROM cp_planos WHERE empresa_id = ? AND modelo = ? AND nome = ? AND ativo = 1', [empresaId, c.id, r.nome]);
    if (!plano) continue;
    const itensPlano = await carregarItensDoPlano(plano.id);
    const calc = calcularComposicao(plano, itensPlano);
    // preco_venda/total_impostos/resultado_bruto também — pedido da usuária
    // 02/10/2026 (PDF dos Cards precisa da linha Total/Impostos/Resultado do
    // comparativo, igual já mostra na tela).
    colunas.push({ titulo: c.titulo, itens: calc.itens, preco_venda: plano.preco_venda, total_impostos: calc.total_impostos, resultado_bruto: calc.resultado_bruto });
  }
  return colunas.length >= 2 ? colunas : null;
}

async function montarRelatorio(req) {
  const plano = await get('SELECT * FROM cp_planos WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
  if (!plano) return null;
  const itens = await carregarItensDoPlano(plano.id);
  const r = { ...plano, ...calcularComposicao(plano, itens) };
  r.comparacao_modelos = await buscarComparacaoModelos(req.usuario.empresa_id, r);
  return r;
}

// Compacto de propósito (pedido da usuária 24/09/2026 — o PDF geral com
// vários planos estava saindo em muitas páginas): fontes menores, menos
// espaçamento, e SEM quebra de página forçada entre planos — cada um só
// quebra pra próxima página se realmente não couber, não sempre.
// 02/10/2026: ".plano" tinha break-inside:avoid-page, que forçava o BLOCO
// INTEIRO pra próxima página se não coubesse 100% no espaço restante — como
// a seção "Comparação entre modelos" deixou cada plano mais alto, isso
// sobrava bastante espaço em branco no fim de várias páginas. Tirado (só
// "tr" evita quebrar no meio de uma linha de tabela), pra encher a página.
const ESTILO_RELATORIO = `
    body{font-family:Arial,sans-serif;font-size:10px;color:#1e293b;padding:8px}
    h1{font-size:13px;margin:0 0 4px}
    table{width:100%;border-collapse:collapse;margin-top:4px;margin-bottom:4px}
    th,td{border:1px solid #e2e8f0;padding:2px 5px} th{background:#f1f5f9;text-align:left}
    .resumo{margin-top:4px} .resumo div{margin:1px 0} .limite-ok{color:#16a34a} .limite-excedido{color:#dc2626}
    td.esq,th.esq{text-align:left} .sep{border-left:2px solid #94a3b8} .sub{color:#94a3b8;font-size:9px}
    tr{break-inside:avoid}
    .plano{padding-bottom:6px;margin-bottom:6px;border-bottom:2px solid #cbd5e1}`;

// 3 níveis de relatório (pedido da usuária 24/09/2026, pra imprimir/exportar
// só o que faz sentido pra cada público):
//   basico    → só composição e valores (nome, itens, valor, %)
//   impostos  → básico + impostos (por item e total) + resultado/margem/regra 50%
//   completo  → tudo (+ clientes, faturamento total, composição antiga x nova)
function corpoRelatorio(r, nivel = 'completo') {
  const comImpostos = nivel === 'impostos' || nivel === 'completo';
  const completo = nivel === 'completo';

  const linhasItens = r.itens.map(i => `
    <tr>
      <td>${i.nome}</td><td>${i.tipo}</td><td style="text-align:right">${i.quantidade}</td>
      <td style="text-align:right">${fmtBRL(i.valor_unitario)}</td><td style="text-align:right">${fmtBRL(i.valor_item)}</td>
      <td style="text-align:right">${fmtPctItem(i.percentual)}</td>
      ${comImpostos ? `<td style="text-align:right">${fmtBRL(i.custo_item)}</td><td style="text-align:right">${fmtBRL(i.impostos_item)}</td>` : ''}
    </tr>`).join('');
  const linhasTipos = Object.entries(r.totais_por_tipo).map(([tipo, valor]) => `<div>Valor ${tipo}: ${fmtBRL(valor)}</div>`).join('');

  let secaoImpostos = '';
  if (comImpostos) {
    const linhasImpostoDetalhe = r.itens.map(i => `
      <tr>
        <td>${i.nome}</td>
        <td>${(i.impostos || []).length === 0 ? '—' : i.impostos.map(imp => `${imp.nome} ${fmtPct(imp.aliquota)}: ${fmtBRL(imp.valor)}`).join(' · ')}</td>
        <td style="text-align:right">${fmtBRL(i.impostos_item)}</td>
      </tr>`).join('');
    secaoImpostos = `
      <table><thead><tr><th>Item</th><th>Impostos aplicados</th><th>Total do item</th></tr></thead>
      <tbody>${linhasImpostoDetalhe}</tbody></table>
      <div class="resumo">
        <div>Custo total de fornecedores: ${fmtBRL(r.custo_total_fornecedores)}</div>
        <div>Total de impostos: ${fmtBRL(r.total_impostos)}</div>
        <div>SVA + Livro/E-book: ${fmtPct(r.regra_50.percentual_sva_livro)} (limite ${fmtPct(r.regra_50.limite)}) —
          <span class="${r.regra_50.status === 'dentro_do_limite' ? 'limite-ok' : 'limite-excedido'}">
            ${r.regra_50.status === 'dentro_do_limite' ? `dentro do limite (falta ${fmtPct(r.regra_50.falta)})` : `acima do limite (excedeu ${fmtPct(r.regra_50.excedente)})`}
          </span>
        </div>
        <div>Resultado bruto: <strong>${fmtBRL(r.resultado_bruto)}</strong> (${fmtPct(r.margem_bruta_percentual)})</div>
        <div>Resultado com desconto: <strong>${fmtBRL(r.resultado_liquido)}</strong> (${fmtPct(r.margem_liquida_percentual)})</div>
      </div>`;
  }

  let secaoCompleto = '';
  if (completo) {
    // Modelo personalizado (livre), ou plano sem equivalente em outro modelo,
    // não tem com o que comparar.
    const comparacao = (r.comparacao_modelos && r.comparacao_modelos.length >= 2) ? `
      <h1 style="font-size:14px">Comparação entre modelos</h1>
      <table><thead><tr><th>Item</th>${r.comparacao_modelos.map(c => `<th>${c.titulo}</th>`).join('')}</tr></thead><tbody>${r.itens.map((i) => {
        // Casa por NOME em cada modelo (a ordem dos itens pode variar entre eles).
        const celulas = r.comparacao_modelos.map(c => {
          const outro = c.itens.find((a) => a.nome === i.nome);
          return `<td style="text-align:right">${outro ? `${fmtBRL(outro.valor_item)} (${fmtPctItem(outro.percentual)})` : '—'}</td>`;
        }).join('');
        return `<tr><td>${i.nome}</td>${celulas}</tr>`;
      }).join('')}</tbody></table>` : '';
    secaoCompleto = `
      ${comparacao}
      <div class="resumo">
        <div>Quantidade de clientes: <strong>${r.quantidade_clientes}</strong></div>
        <div>Faturamento total bruto: <strong>${fmtBRL(r.faturamento_total_bruto)}</strong></div>
        <div>Faturamento total com desconto: <strong>${fmtBRL(r.faturamento_total_liquido)}</strong></div>
        <div>Impostos totais (clientes): <strong>${fmtBRL(r.impostos_totais_clientes)}</strong></div>
        <div>Resultado total bruto: <strong>${fmtBRL(r.resultado_total_bruto)}</strong></div>
        <div>Resultado total com desconto: <strong>${fmtBRL(r.resultado_total_liquido)}</strong></div>
      </div>`;
  }

  return `
    <h1>${r.nome}</h1>
    <div>Preço bruto (de tabela): <strong>${fmtBRL(r.preco_venda)}</strong></div>
    <div>Desconto pontualidade: <strong>${fmtBRL(r.desconto_pontualidade)}</strong></div>
    <div>Preço com desconto (o cliente paga em dia): <strong>${fmtBRL(r.valor_com_desconto)}</strong></div>
    <table><thead><tr><th>Item</th><th>Tipo</th><th>Qtd</th><th>Valor unit.</th><th>Valor total</th><th>%</th>${comImpostos ? '<th>Custo fornecedor</th><th>Impostos</th>' : ''}</tr></thead>
    <tbody>${linhasItens}</tbody></table>
    <div class="resumo">
      <div>Valor total da composição: <strong>${fmtBRL(r.valor_total_composicao)}</strong>
        <span class="${r.total_bate_com_preco ? 'limite-ok' : 'limite-excedido'}">
          (${r.total_bate_com_preco ? 'bate com o preço de venda' : `NÃO bate com o preço de venda (${fmtBRL(r.preco_venda)})`})
        </span>
      </div>
      ${linhasTipos}
    </div>
    ${secaoImpostos}
    ${secaoCompleto}`;
}

function htmlRelatorio(r, nivel) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ESTILO_RELATORIO}</style></head><body>${corpoRelatorio(r, nivel)}</body></html>`;
}

// Junta o relatório de TODOS os planos num único PDF/Excel/CSV — pedido da
// usuária pra não precisar baixar plano por plano.
function htmlRelatorioGeral(planos, nivel, secaoCombosHtml = '') {
  const corpo = planos.map(r => `<div class="plano">${corpoRelatorio(r, nivel)}</div>`).join('');
  const combos = secaoCombosHtml ? `<div class="plano">${secaoCombosHtml}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${ESTILO_RELATORIO}</style></head><body>${corpo}${combos}</body></html>`;
}

router.get('/:id/relatorio.pdf', async (req, res) => {
  try {
    const r = await montarRelatorio(req);
    if (!r) return res.status(404).json({ erro: 'Plano não encontrado' });
    const { htmlParaPdf } = require('../utils/gerarPDFHtml');
    const pdf = await htmlParaPdf(htmlRelatorio(r, req.query.nivel));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nome}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar PDF' }); }
});

// Linhas da planilha de UM plano — extraído pra ser reaproveitado tanto no
// Excel individual (/:id/relatorio.xlsx) quanto no "Baixar todos (Excel)"
// (/relatorio-geral.xlsx), que até 01/10/2026 tinha uma versão bem mais
// pobre (sem impostos aplicados por item, sem totais por tipo, sem
// resultado/margem, sem comparação entre modelos) — pedido da usuária pra
// incluir TUDO que já sai no Excel de um plano só.
function montarLinhasPlanoXlsx(r, nivel) {
  const comImpostos = nivel === 'impostos' || nivel === 'completo';
  const completo = nivel === 'completo';
  const linhas = r.itens.map(i => {
    const linha = {
      Item: i.nome, Tipo: i.tipo, Quantidade: i.quantidade,
      'Valor unitário': i.valor_unitario, 'Valor total': i.valor_item, 'Percentual (%)': pctOuFora(i.percentual),
    };
    if (comImpostos) {
      linha['Custo fornecedor'] = i.custo_item;
      linha.Impostos = Number(i.impostos_item.toFixed(2));
      linha['Impostos aplicados'] = (i.impostos || []).length === 0 ? '—' : i.impostos.map(imp => `${imp.nome} ${imp.aliquota}%: ${imp.valor.toFixed(2)}`).join(' | ');
    }
    return linha;
  });
  linhas.push({});
  linhas.push({ Item: 'Valor total da composição bate com o preço de venda?', 'Valor total': r.total_bate_com_preco ? 'Sim' : 'Não' });
  for (const [tipo, valor] of Object.entries(r.totais_por_tipo)) linhas.push({ Item: `Valor ${tipo}`, 'Valor total': valor });
  linhas.push({ Item: 'Valor total da composição', 'Valor total': r.valor_total_composicao });
  if (comImpostos) {
    linhas.push(
      { Item: 'Custo total de fornecedores', 'Valor total': r.custo_total_fornecedores },
      { Item: 'Total de impostos', 'Valor total': r.total_impostos },
    );
    linhas.push(
      { Item: 'SVA + Livro/E-book (%)', 'Percentual (%)': Number(r.regra_50.percentual_sva_livro.toFixed(2)) },
      { Item: 'Preço bruto', 'Valor total': r.preco_venda },
      { Item: 'Desconto pontualidade', 'Valor total': r.desconto_pontualidade },
      { Item: 'Preço com desconto', 'Valor total': r.valor_com_desconto },
      { Item: 'Resultado bruto', 'Valor total': r.resultado_bruto },
      { Item: 'Margem bruta (%)', 'Percentual (%)': Number(r.margem_bruta_percentual.toFixed(2)) },
      { Item: 'Resultado com desconto', 'Valor total': r.resultado_liquido },
      { Item: 'Margem com desconto (%)', 'Percentual (%)': Number(r.margem_liquida_percentual.toFixed(2)) },
    );
  }
  if (completo) {
    linhas.push(
      { Item: 'Quantidade de clientes', Quantidade: r.quantidade_clientes },
      { Item: 'Faturamento total bruto', 'Valor total': r.faturamento_total_bruto },
      { Item: 'Faturamento total com desconto', 'Valor total': r.faturamento_total_liquido },
      { Item: 'Impostos totais (clientes)', 'Valor total': r.impostos_totais_clientes },
      { Item: 'Resultado total bruto', 'Valor total': r.resultado_total_bruto },
      { Item: 'Resultado total com desconto', 'Valor total': r.resultado_total_liquido },
    );
    if (r.comparacao_modelos && r.comparacao_modelos.length >= 2) {
      linhas.push({});
      linhas.push({ Item: 'Comparação entre modelos' });
      for (const i of r.itens) {
        const linha = { Item: i.nome };
        for (const c of r.comparacao_modelos) {
          const outro = c.itens.find(a => a.nome === i.nome);
          linha[c.titulo] = outro ? `${fmtBRL(outro.valor_item)} (${fmtPctItem(outro.percentual)})` : '—';
        }
        linhas.push(linha);
      }
    }
  }
  return linhas;
}

router.get('/:id/relatorio.xlsx', async (req, res) => {
  try {
    const r = await montarRelatorio(req);
    if (!r) return res.status(404).json({ erro: 'Plano não encontrado' });
    const nivel = req.query.nivel || 'completo';
    const XLSX = require('xlsx');
    const linhas = montarLinhasPlanoXlsx(r, nivel);
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(linhas);
    sheet['!cols'] = larguraColunas(linhas);
    XLSX.utils.book_append_sheet(wb, sheet, 'Composicao');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nome}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar Excel' }); }
});

router.get('/:id/relatorio.csv', async (req, res) => {
  try {
    const r = await montarRelatorio(req);
    if (!r) return res.status(404).json({ erro: 'Plano não encontrado' });
    const nivel = req.query.nivel || 'completo';
    const comImpostos = nivel === 'impostos' || nivel === 'completo';
    const completo = nivel === 'completo';
    const cabecalho = ['Item', 'Tipo', 'Quantidade', 'Valor unitario', 'Valor total', 'Percentual'];
    if (comImpostos) cabecalho.push('Custo fornecedor', 'Impostos', 'Impostos aplicados');
    const linhas = r.itens.map(i => {
      const linha = [i.nome, i.tipo, i.quantidade, i.valor_unitario, i.valor_item, pctOuFora(i.percentual)];
      if (comImpostos) linha.push(i.custo_item, i.impostos_item.toFixed(2), (i.impostos || []).length === 0 ? '—' : i.impostos.map(imp => `${imp.nome} ${imp.aliquota}%: ${imp.valor.toFixed(2)}`).join(' | '));
      return linha;
    });
    linhas.push([]);
    linhas.push(['Valor total da composicao bate com o preco de venda?', r.total_bate_com_preco ? 'Sim' : 'Nao']);
    for (const [tipo, valor] of Object.entries(r.totais_por_tipo)) linhas.push([`Valor ${tipo}`, '', '', '', valor]);
    linhas.push(['Valor total da composicao', '', '', '', r.valor_total_composicao]);
    if (comImpostos) {
      linhas.push(['Custo total de fornecedores', '', '', '', r.custo_total_fornecedores]);
      linhas.push(['Total de impostos', '', '', '', r.total_impostos]);
      linhas.push(['SVA + Livro/E-book (%)', '', '', '', '', r.regra_50.percentual_sva_livro.toFixed(2)]);
      linhas.push(['Preco bruto', '', '', '', r.preco_venda]);
      linhas.push(['Desconto pontualidade', '', '', '', r.desconto_pontualidade]);
      linhas.push(['Preco com desconto', '', '', '', r.valor_com_desconto]);
      linhas.push(['Resultado bruto', '', '', '', r.resultado_bruto]);
      linhas.push(['Margem bruta (%)', '', '', '', '', r.margem_bruta_percentual.toFixed(2)]);
      linhas.push(['Resultado com desconto', '', '', '', r.resultado_liquido]);
      linhas.push(['Margem com desconto (%)', '', '', '', '', r.margem_liquida_percentual.toFixed(2)]);
    }
    if (completo) {
      linhas.push(['Quantidade de clientes', '', r.quantidade_clientes]);
      linhas.push(['Faturamento total bruto', '', '', '', r.faturamento_total_bruto]);
      linhas.push(['Faturamento total com desconto', '', '', '', r.faturamento_total_liquido]);
      linhas.push(['Impostos totais (clientes)', '', '', '', r.impostos_totais_clientes]);
      linhas.push(['Resultado total bruto', '', '', '', r.resultado_total_bruto]);
      linhas.push(['Resultado total com desconto', '', '', '', r.resultado_total_liquido]);
    }
    const csv = [cabecalho, ...linhas].map(l => l.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nome}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao gerar CSV' }); }
});

module.exports = router;
