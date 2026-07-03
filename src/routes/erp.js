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
const uploadTemp = multer({ dest: require('os').tmpdir() });

router.post('/importar', (req, res) => {
  uploadTemp.array('arquivos', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ erro: 'Erro no upload: ' + err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const arquivosParaLimpar = req.files.map(f => f.path);
    try {
      const resultado = [];

      for (const arquivo of req.files) {
        const wb = XLSX.readFile(arquivo.path);

        for (const nomePlanilha of wb.SheetNames) {
          const ws = wb.Sheets[nomePlanilha];
          const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
          if (!linhas.length) continue;

          const colunas = Object.keys(linhas[0]);

          // Regex para extrair "NOME (QTD: X UN)" — NÃO reutilizar com .test() (flag /g)
          const REGEX_ITEM = /([^,(]+?)\s*\(\s*QD?T:?\s*([\d.,]+)\s*([^)]*)\)/gi;

          // Detecta a coluna dos produtos: a que tem mais células contendo "QTD:" / "QDT:"
          // Usa regex SEM flag /g para .test() (evita bug do lastIndex)
          const TESTE_QTD = /QD?T:/i;
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

          // Valores distintos da coluna de tipo (diagnóstico)
          const valoresTipo = colTipo
            ? [...new Set(linhas.map(l => String(l[colTipo] || '').trim()).filter(Boolean))]
            : [];

          // Filtra linhas de insumo de cliente (aceita "INSUMO", "CLIENTE: INSUMO", etc.)
          const FILTRO_INSUMO = /insumo/i;
          const temMatch = colTipo && linhas.some(l => FILTRO_INSUMO.test(String(l[colTipo] || '')));
          const linhasFiltradas = temMatch
            ? linhas.filter(l => FILTRO_INSUMO.test(String(l[colTipo] || '')))
            : linhas; // se nada bate, processa tudo (não zera o relatório)

          const filtroAplicado = temMatch;

          // Conta atendimentos: por ID único se existir coluna de ID; senão cada linha = 1 saída
          let totalAtendimentos;
          if (colId) {
            const idsUnicos = new Set();
            for (const l of linhasFiltradas) {
              const id = String(l[colId] || '').trim();
              if (id) idsUnicos.add(id);
            }
            totalAtendimentos = idsUnicos.size || linhasFiltradas.length;
          } else {
            totalAtendimentos = linhasFiltradas.length;
          }

          const totais = {};

          for (const linha of linhasFiltradas) {
            const celulas = colMovimento
              ? [String(linha[colMovimento] || '')]
              : colunas.map(c => String(linha[c] || ''));

            for (const celula of celulas) {
              if (!/QD?T:/i.test(celula)) continue;
              let match;
              REGEX_ITEM.lastIndex = 0;
              while ((match = REGEX_ITEM.exec(celula)) !== null) {
                const nome = match[1].trim();
                const qtd  = parseFloat(match[2].replace(',', '.')) || 0;
                const unid = (match[3] || '').trim().toUpperCase() || 'UN';
                if (!nome || qtd <= 0) continue;
                const chave = `${nome}||${unid}`;
                totais[chave] = (totais[chave] || 0) + qtd;
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
              const media = totalAtendimentos > 0
                ? Math.round((total / totalAtendimentos) * 1000) / 1000
                : 0;
              return { nome, total, unidade, media };
            })
            .sort((a, b) => b.total - a.total);

          resultado.push({
            arquivo: arquivo.originalname,
            planilha: nomePlanilha,
            total_linhas: linhas.length,
            linhas_filtradas: linhasFiltradas.length,
            total_atendimentos: totalAtendimentos,
            filtro_aplicado: filtroAplicado
              ? `Filtrado por INSUMO (col: ${colTipo})`
              : (colTipo
                  ? `Nenhuma linha "INSUMO" na coluna "${colTipo}" — processando tudo. Valores encontrados: ${valoresTipo.slice(0, 8).join(' | ') || '(vazio)'}`
                  : 'Sem coluna de tipo — processando tudo'),
            coluna_item: colMovimento || '(auto)',
            coluna_tipo: colTipo || '(não encontrada)',
            valores_tipo: valoresTipo.slice(0, 20),
            colunas_disponiveis: colunas,
            itens,
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
