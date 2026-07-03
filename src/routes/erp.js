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

const router = express.Router();
router.use(autenticar);

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
