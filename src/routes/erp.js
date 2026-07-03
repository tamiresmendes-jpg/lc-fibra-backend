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

          // Detecta coluna que contém o padrão "NOME (QTD: X UN)"
          // Prioriza colunas com "produto", "item", "material", "moviment", "descri"
          // Fallback: primeira coluna cujo conteúdo contenha "(QTD:"
          let colMovimento = colunas.find(c =>
            /produto|item|material|moviment|descri|equip/i.test(c)
          );
          if (!colMovimento) {
            colMovimento = colunas.find(c =>
              linhas.slice(0, 20).some(l => String(l[c]).includes('(QTD:'))
            );
          }

          // Padrão: "NOME DO PRODUTO (QTD: 3 UN)" ou "NOME (QTD: 1,5 m)"
          // Múltiplos itens por célula separados por vírgula
          const REGEX_ITEM = /([^,]+?)\s*\(QTD:\s*([\d.,]+)\s*([^)]*)\)/gi;

          const totais = {}; // chave = "NOME||unidade"
          let totalLinhas = 0;

          for (const linha of linhas) {
            // Varre todas as colunas procurando o padrão (ou só a coluna detectada)
            const celulas = colMovimento
              ? [String(linha[colMovimento] || '')]
              : colunas.map(c => String(linha[c] || ''));

            for (const celula of celulas) {
              if (!celula.includes('(QTD:')) continue;
              let match;
              REGEX_ITEM.lastIndex = 0;
              while ((match = REGEX_ITEM.exec(celula)) !== null) {
                const nome = match[1].trim();
                const qtd  = parseFloat(match[2].replace(',', '.')) || 0;
                const unid = (match[3] || '').trim().toUpperCase() || 'UN';
                if (!nome || qtd <= 0) continue;
                const chave = `${nome}||${unid}`;
                totais[chave] = (totais[chave] || 0) + qtd;
                totalLinhas++;
              }
            }
          }

          // Se não encontrou nenhum padrão (QTD:), faz parsing genérico por colunas
          if (Object.keys(totais).length === 0) {
            const colItem = colunas.find(c =>
              /produto|item|descri|nome|material|equipamento/i.test(c)
            ) || colunas[0];
            const colQtd = colunas.find(c =>
              /qtd|quantidade|quant|total|saida|saída|uso|utiliz/i.test(c)
            );

            for (const linha of linhas) {
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
              return { nome, total, unidade };
            })
            .sort((a, b) => b.total - a.total);

          resultado.push({
            arquivo: arquivo.originalname,
            planilha: nomePlanilha,
            total_linhas: linhas.length,
            coluna_item: colMovimento || '(auto)',
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
