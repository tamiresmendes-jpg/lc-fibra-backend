// Sincroniza faturas (contas a receber) e contas a pagar do HubSoft para as
// tabelas fin_fatura / fin_conta_pagar (Análise Financeira). Roda SÓ no job da
// madrugada (jobs/syncFinanceiroMensal.js) — nunca por clique na tela.
//
// PRIVACIDADE: não guarda dado pessoal de cliente (nome, CPF/CNPJ, código, link
// da fatura) nem descrição/fornecedor das contas a pagar. Do cliente fica só o
// id interno (número sem identificação), usado para contar clientes distintos.
//
// Cuidado com o ERP: UMA requisição por vez, com pausa entre elas (limite do
// HubSoft: 30 req/60s) e espera + nova tentativa se vier 429.
const hubsoft = require('./hubsoft');
const { run, all, get } = require('../config/database');

const PAUSA_MS = 3000;
const ESPERA_429_MS = 65000;
const POR_PAGINA = 500;
const MAX_DIAS_JANELA = 400;
const TIMEOUT_TRAVADO_MIN = 30;
// Janela padrão atualizada toda madrugada: o recente (títulos mudam de status)
// e o futuro próximo (previsão de caixa).
const DIAS_PASSADO_PADRAO = 30;
const DIAS_FUTURO_PADRAO = 45;
// Quantos meses do ano ainda não buscados são carregados por noite.
const MESES_CARGA_POR_NOITE = 3;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const agoraSP = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
const dia = (v) => (v ? String(v).slice(0, 10) : null);
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const somarDias = (isoData, dias) => { const d = new Date(isoData + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);

async function chamar(caminho, params) {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await hubsoft.apiGet(caminho, params);
    } catch (e) {
      if (/\b429\b/.test(e.message) && tentativa < 3) { await dormir(ESPERA_429_MS); continue; }
      throw e;
    }
  }
}

// Varre todas as páginas (uma por vez) e entrega cada lote.
async function varrer(caminho, paramsBase, chaveLista, aoLote) {
  let pagina = 0, ultima = 0;
  do {
    const d = await chamar(caminho, { ...paramsBase, pagina, itens_por_pagina: POR_PAGINA });
    ultima = d.paginacao?.ultima_pagina || 0;
    await aoLote(d[chaveLista] || []);
    pagina++;
    if (pagina <= ultima) await dormir(PAUSA_MS);
  } while (pagina <= ultima);
}

// Só os campos financeiros — o cliente entra apenas como id interno.
function normalizarFatura(f) {
  const c = f.cliente || {}, b = f.forma_cobranca || {}, e = f.empresa || {};
  return {
    id_fatura: f.id_fatura,
    cliente_id: c.id_cliente ?? null, cliente_ativo: c.ativo == null ? null : (c.ativo ? 1 : 0), tipo_pessoa: c.tipo_pessoa ?? null,
    emissao: dia(f.data_cadastro), vencimento: dia(f.data_vencimento),
    pagamento: dia(f.data_pagamento), credito: dia(f.data_credito),
    valor: num(f.valor) ?? 0, valor_pago: num(f.valor_pago), juros_pago: num(f.valor_juros_pago),
    desconto: num(f.valor_desconto) ?? 0, tipo_cobranca: f.tipo_cobranca ?? null,
    banco_id: b.id_forma_cobranca ?? null, banco_nome: b.descricao ?? null, banco_numero: b.numero_banco ?? null,
    conta: b.conta ? `${b.agencia || ''}/${b.conta}${b.conta_digito ? '-' + b.conta_digito : ''}` : null,
    empresa_doc: e.documento ?? null, empresa_nome: e.nome_fantasia || e.nome_razaosocial || null,
  };
}

// Categoria de despesa (plano de contas) é guardada; descrição e fornecedor, não.
function normalizarContaPagar(c) {
  const e = c.empresa || {};
  return {
    id_conta_pagar: c.id_conta_pagar, status: c.status ?? null,
    vencimento: dia(c.data_vencimento), pagamento: dia(c.data_pagamento), emissao: dia(c.data_emissao),
    valor: num(c.valor) ?? 0, valor_pago: num(c.valor_pago), acrescimo: num(c.valor_acrescimo) ?? 0, desconto: num(c.valor_desconto) ?? 0,
    empresa_doc: e.documento ?? null, empresa_nome: e.nome_fantasia || e.nome_razaosocial || null,
    plano_conta: JSON.stringify((c.plano_conta || []).map((p) => ({ descricao: p.descricao, valor: num(p.valor), percentual: num(p.percentual) }))),
  };
}

async function upsertFatura(empresaId, f, syncEm) {
  await run(
    `INSERT INTO fin_fatura (empresa_id,id_fatura,cliente_id,cliente_ativo,tipo_pessoa,emissao,vencimento,pagamento,credito,valor,valor_pago,juros_pago,
       desconto,tipo_cobranca,banco_id,banco_nome,banco_numero,conta,empresa_doc,empresa_nome,ativo,sync_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT (empresa_id,id_fatura) DO UPDATE SET
       cliente_id=EXCLUDED.cliente_id, cliente_ativo=EXCLUDED.cliente_ativo, tipo_pessoa=EXCLUDED.tipo_pessoa,
       emissao=EXCLUDED.emissao, vencimento=EXCLUDED.vencimento, pagamento=EXCLUDED.pagamento, credito=EXCLUDED.credito,
       valor=EXCLUDED.valor, valor_pago=EXCLUDED.valor_pago, juros_pago=EXCLUDED.juros_pago, desconto=EXCLUDED.desconto,
       tipo_cobranca=EXCLUDED.tipo_cobranca, banco_id=EXCLUDED.banco_id, banco_nome=EXCLUDED.banco_nome,
       banco_numero=EXCLUDED.banco_numero, conta=EXCLUDED.conta, empresa_doc=EXCLUDED.empresa_doc,
       empresa_nome=EXCLUDED.empresa_nome, ativo=1, sync_em=EXCLUDED.sync_em`,
    [empresaId, f.id_fatura, f.cliente_id, f.cliente_ativo, f.tipo_pessoa, f.emissao, f.vencimento, f.pagamento, f.credito, f.valor, f.valor_pago,
      f.juros_pago, f.desconto, f.tipo_cobranca, f.banco_id, f.banco_nome, f.banco_numero, f.conta, f.empresa_doc, f.empresa_nome, syncEm]
  );
}

async function upsertContaPagar(empresaId, c, syncEm) {
  await run(
    `INSERT INTO fin_conta_pagar (empresa_id,id_conta_pagar,status,vencimento,pagamento,emissao,valor,valor_pago,acrescimo,desconto,
       empresa_doc,empresa_nome,plano_conta,ativo,sync_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT (empresa_id,id_conta_pagar) DO UPDATE SET
       status=EXCLUDED.status, vencimento=EXCLUDED.vencimento, pagamento=EXCLUDED.pagamento, emissao=EXCLUDED.emissao,
       valor=EXCLUDED.valor, valor_pago=EXCLUDED.valor_pago, acrescimo=EXCLUDED.acrescimo, desconto=EXCLUDED.desconto,
       empresa_doc=EXCLUDED.empresa_doc, empresa_nome=EXCLUDED.empresa_nome, plano_conta=EXCLUDED.plano_conta, ativo=1, sync_em=EXCLUDED.sync_em`,
    [empresaId, c.id_conta_pagar, c.status, c.vencimento, c.pagamento, c.emissao, c.valor, c.valor_pago, c.acrescimo, c.desconto,
      c.empresa_doc, c.empresa_nome, c.plano_conta, syncEm]
  );
}

async function marcarStatus(empresaId, tipo, campos) {
  const atual = await get('SELECT 1 AS x FROM fin_sync_status WHERE empresa_id=? AND tipo=?', [empresaId, tipo]);
  if (!atual) {
    await run('INSERT INTO fin_sync_status (empresa_id,tipo,status,janela_inicio,janela_fim,mensagem,iniciado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?)',
      [empresaId, tipo, campos.status, campos.janela_inicio || null, campos.janela_fim || null, campos.mensagem || null, campos.iniciado_em || agoraSP(), agoraSP()]);
  } else {
    await run(`UPDATE fin_sync_status SET status=?, mensagem=?, atualizado_em=?
               ${campos.janela_inicio ? ', janela_inicio=?, janela_fim=?, iniciado_em=?' : ''} WHERE empresa_id=? AND tipo=?`,
      campos.janela_inicio
        ? [campos.status, campos.mensagem || null, agoraSP(), campos.janela_inicio, campos.janela_fim, campos.iniciado_em || agoraSP(), empresaId, tipo]
        : [campos.status, campos.mensagem || null, agoraSP(), empresaId, tipo]);
  }
}

function validarJanela(dataInicio, dataFim) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(dataInicio || '') || !re.test(dataFim || '')) return 'Informe data_inicio e data_fim (AAAA-MM-DD).';
  const dias = (new Date(dataFim) - new Date(dataInicio)) / 86400000;
  if (!(dias >= 0)) return 'A data final precisa ser igual ou posterior à inicial.';
  if (dias > MAX_DIAS_JANELA) return `Janela máxima de ${MAX_DIAS_JANELA} dias por sincronização.`;
  return null;
}

// A tela NUNCA consulta o ERP na hora: só AGENDA a janela pedida para a madrugada.
async function agendarSincronizacao(empresaId, tipo, dataInicio, dataFim) {
  if (!['faturas', 'contas_pagar'].includes(tipo)) return { erro: 'Tipo inválido.' };
  const erroJanela = validarJanela(dataInicio, dataFim);
  if (erroJanela) return { erro: erroJanela };
  const st = await get('SELECT status, atualizado_em FROM fin_sync_status WHERE empresa_id=? AND tipo=?', [empresaId, tipo]);
  if (st?.status === 'processando') {
    const parado = (Date.now() - new Date(String(st.atualizado_em).replace(' ', 'T') + 'Z').getTime()) / 60000;
    if (parado < TIMEOUT_TRAVADO_MIN) return { erro: 'Existe uma sincronização rodando agora. Agende depois que ela terminar.' };
  }
  await marcarStatus(empresaId, tipo, { status: 'agendado', janela_inicio: dataInicio, janela_fim: dataFim, mensagem: `Agendado para a madrugada (${dataInicio} a ${dataFim}).` });
  return { ok: true };
}

// Marca como "buscados" os meses INTEIROS contidos na janela.
async function marcarMesesCobertos(empresaId, tipo, ini, fim) {
  let [a, m] = ini.split('-').map(Number);
  for (;;) {
    const primeiro = `${a}-${String(m).padStart(2, '0')}-01`;
    if (primeiro < ini) { if (m === 12) { a++; m = 1; } else m++; continue; }
    if (ultimoDiaDoMes(a, m) > fim) break;
    const chave = `${a}-${String(m).padStart(2, '0')}`;
    await run(`INSERT INTO fin_sync_mes (empresa_id,tipo,mes,sync_em) VALUES (?,?,?,?)
               ON CONFLICT (empresa_id,tipo,mes) DO UPDATE SET sync_em=EXCLUDED.sync_em`, [empresaId, tipo, chave, agoraSP()]);
    if (m === 12) { a++; m = 1; } else m++;
  }
}

// Chamado SÓ pelo job noturno, por empresa e por tipo (faturas, depois contas a pagar):
//  1) janela agendada pela tela, ou a padrão (últimos 30 / próximos 45 dias);
//  2) carga gradual: até MESES_CARGA_POR_NOITE meses do ano corrente ainda não buscados.
async function sincronizarNoturno(empresaId) {
  const hoje = agoraSP().slice(0, 10);
  const ano = Number(hoje.slice(0, 4));
  for (const tipo of ['faturas', 'contas_pagar']) {
    const st = await get('SELECT status, janela_inicio, janela_fim FROM fin_sync_status WHERE empresa_id=? AND tipo=?', [empresaId, tipo]);
    const agendado = st?.status === 'agendado' && st.janela_inicio && st.janela_fim;
    const ini = agendado ? st.janela_inicio : somarDias(hoje, -DIAS_PASSADO_PADRAO);
    const fim = agendado ? st.janela_fim : somarDias(hoje, DIAS_FUTURO_PADRAO);
    try {
      await marcarStatus(empresaId, tipo, { status: 'processando', janela_inicio: ini, janela_fim: fim, mensagem: 'Iniciando…' });
      const r = await executar(empresaId, tipo, ini, fim);
      await marcarMesesCobertos(empresaId, tipo, ini, fim);

      const feitos = new Set((await all('SELECT mes FROM fin_sync_mes WHERE empresa_id=? AND tipo=?', [empresaId, tipo])).map((x) => x.mes));
      const faltando = [];
      for (let m = 1; m <= 12; m++) { const chave = `${ano}-${String(m).padStart(2, '0')}`; if (!feitos.has(chave)) faltando.push(m); }
      let carregados = 0;
      for (const m of faltando.slice(0, MESES_CARGA_POR_NOITE)) {
        const mi = `${ano}-${String(m).padStart(2, '0')}-01`, mf = ultimoDiaDoMes(ano, m);
        await marcarStatus(empresaId, tipo, { status: 'processando', janela_inicio: mi, janela_fim: mf, mensagem: `Carga de ${mi.slice(0, 7)}…` });
        await executar(empresaId, tipo, mi, mf, { silencioso: true });
        await marcarMesesCobertos(empresaId, tipo, mi, mf);
        carregados++;
      }
      await marcarStatus(empresaId, tipo, { status: 'pronto', mensagem: `${r.mensagem}${carregados ? ` Carga do ano: ${carregados} mês(es) adicionados; faltam ${Math.max(0, faltando.length - carregados)}.` : ''}` });
    } catch (e) {
      console.error(`[fin-sync] ${tipo} falhou:`, e.message);
      await marcarStatus(empresaId, tipo, { status: 'erro', mensagem: e.message.replace('HUBSOFT', 'HubSoft').slice(0, 300) }).catch(() => {});
    }
  }
}

async function executar(empresaId, tipo, dataInicio, dataFim, { silencioso = false } = {}) {
  const inicioRun = agoraSP();
  const hojeStr = inicioRun.slice(0, 10);
  let vistos = 0;
  const tabela = tipo === 'faturas' ? 'fin_fatura' : 'fin_conta_pagar';
  const caminho = tipo === 'faturas' ? '/api/v1/integracao/financeiro/fatura' : '/api/v1/integracao/financeiro/conta_pagar';
  const chave = tipo === 'faturas' ? 'faturas' : 'contas_pagar';

  // Duas passadas: por vencimento (tudo que vence na janela, com o status
  // atual) e por pagamento (o que foi baixado na janela, mesmo vencendo antes).
  for (const tipoData of ['data_vencimento', 'data_pagamento']) {
    // Pagamento não existe no futuro: limita a passada por pagamento até hoje.
    const fimPassada = tipoData === 'data_pagamento' && dataFim > hojeStr ? hojeStr : dataFim;
    if (dataInicio > fimPassada) continue;
    if (!silencioso) await marcarStatus(empresaId, tipo, { status: 'processando', mensagem: `Buscando por ${tipoData === 'data_vencimento' ? 'vencimento' : 'pagamento'}… (${vistos} registros)` });
    const params = { tipo_data: tipoData, data_inicio: dataInicio, data_fim: fimPassada };
    if (tipo === 'faturas') Object.assign(params, { tipo_resultado: 'simplificado', relacoes: 'cliente' });
    else Object.assign(params, { status: 'todos', ativo: 'sim' });

    await varrer(caminho, params, chave, async (lote) => {
      for (const item of lote) {
        if (tipo === 'faturas') await upsertFatura(empresaId, normalizarFatura(item), inicioRun);
        else await upsertContaPagar(empresaId, normalizarContaPagar(item), inicioRun);
        vistos++;
      }
    });
    await dormir(PAUSA_MS);
  }

  // Quem tem vencimento na janela e NÃO apareceu nesta rodada foi cancelado,
  // substituído ou removido no ERP: sai dos totais (ativo=0), sem apagar.
  const r = await run(
    `UPDATE ${tabela} SET ativo=0 WHERE empresa_id=? AND ativo=1 AND vencimento BETWEEN ? AND ? AND (sync_em IS NULL OR sync_em < ?)`,
    [empresaId, dataInicio, dataFim, inicioRun]
  );
  const desativados = r?.changes ?? 0;
  return { vistos, desativados, mensagem: `${vistos} registros sincronizados${desativados ? `; ${desativados} inativados (cancelados/substituídos no ERP)` : ''}.` };
}

async function statusSincronizacao(empresaId) {
  return all('SELECT tipo, status, janela_inicio, janela_fim, mensagem, iniciado_em, atualizado_em FROM fin_sync_status WHERE empresa_id=?', [empresaId]);
}

module.exports = { agendarSincronizacao, sincronizarNoturno, statusSincronizacao };
