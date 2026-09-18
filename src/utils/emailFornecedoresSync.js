// Sincronização da caixa de e-mail de fornecedores (IMAP) — lê boletos e notas
// fiscais recebidos por e-mail, extrai valor/vencimento do PDF anexado e
// registra em contas_pagar_fornecedores. Só LEITURA: nunca apaga, move ou marca
// mensagem como lida na caixa de entrada.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { run, get, all } = require('../config/database');

const PASTA_ANEXOS = path.join(__dirname, '../../uploads-privados/fornecedores-emails');
try { fs.mkdirSync(PASTA_ANEXOS, { recursive: true }); } catch (_) {}

// Limite de mensagens processadas por execução (somado entre todas as pastas)
// — evita sobrecarregar numa primeira sincronização com histórico grande; o
// restante fica pro próximo run (ultimo_uid_processado avança por pasta).
const MAX_MENSAGENS_POR_EXECUCAO = 200;

// Pastas que nunca interessam pra boleto/NF de fornecedor — identificadas
// pelo SPECIAL-USE do IMAP (RFC 6154) e, como reforço quando o servidor não
// informa isso, pelo nome (cobre variações em PT-BR e EN).
const SPECIAL_USE_EXCLUIDOS = ['\\Trash', '\\Junk', '\\Sent', '\\Drafts'];
const NOME_EXCLUIDO = /^(lixeira|trash|spam|junk|quarentena|enviados|itens enviados|sent|itens? enviados?|rascunhos|drafts|itens exclu[ií]dos|deleted ?items)$/i;

function pastaElegivel(mailbox) {
  if (mailbox.specialUse && SPECIAL_USE_EXCLUIDOS.includes(mailbox.specialUse)) return false;
  const nome = (mailbox.name || mailbox.path || '').trim();
  if (NOME_EXCLUIDO.test(nome)) return false;
  return true;
}

async function carregarConfig(empresaId) {
  return await get('SELECT * FROM integracao_email_fornecedores WHERE empresa_id = $1', [empresaId]);
}

async function carregarEstadoPasta(empresaId, pasta) {
  return await get('SELECT * FROM email_fornecedores_pastas WHERE empresa_id = $1 AND pasta = $2', [empresaId, pasta]);
}

async function salvarEstadoPasta(empresaId, pasta, uidvalidity, ultimoUid) {
  await run(`
    INSERT INTO email_fornecedores_pastas (empresa_id, pasta, uidvalidity, ultimo_uid_processado, atualizado_em)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (empresa_id, pasta) DO UPDATE SET
      uidvalidity = EXCLUDED.uidvalidity, ultimo_uid_processado = EXCLUDED.ultimo_uid_processado, atualizado_em = NOW()
  `, [empresaId, pasta, String(uidvalidity), ultimoUid]);
}

function extrairValor(texto) {
  const candidatos = [...texto.matchAll(/R\$\s*([\d.]{1,12},\d{2})/g)].map(m => m[1]);
  if (!candidatos.length) return null;
  // Heurística simples: valor de boleto costuma ser o maior valor citado no documento
  const paraNumero = v => parseFloat(v.replace(/\./g, '').replace(',', '.'));
  const valores = candidatos.map(paraNumero).filter(v => !isNaN(v) && v > 0);
  if (!valores.length) return null;
  return Math.max(...valores);
}

function extrairVencimento(texto) {
  const idx = texto.toLowerCase().search(/vencimento/);
  const janela = idx >= 0 ? texto.slice(idx, idx + 60) : texto.slice(0, 300);
  const m = janela.match(/(\d{2})\/(\d{2})\/(\d{4})/) || texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function extrairCnpj(texto) {
  const m = texto.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  return m ? m[0] : null;
}

function extrairLinhaDigitavel(texto) {
  const compacto = texto.replace(/[^\d]/g, ' ');
  const m = compacto.match(/\b\d{47,48}\b/) || texto.match(/(\d{5}\.\d{5}\s*\d{5}\.\d{6}\s*\d{5}\.\d{6}\s*\d\s*\d{14})/);
  return m ? m[0].replace(/\s+/g, '') : null;
}

function normalizarCnpj(v) {
  return v ? v.replace(/\D/g, '') : null;
}

// Nome do fornecedor costuma vir depois do último " - " no nome da pasta
// (ex.: "NF - Faturas - Wurth" → "Wurth", "Impostos - Solintel" → "Solintel").
function dicaFornecedorDaPasta(pasta) {
  if (!pasta) return null;
  const partes = pasta.split(' - ');
  return (partes[partes.length - 1] || '').trim() || null;
}

async function identificarFornecedor(empresaId, remetente, cnpjExtraido, pasta) {
  const fornecedores = await all('SELECT * FROM fornecedores WHERE empresa_id = $1 AND ativo = 1', [empresaId]);
  const cnpjAlvo = normalizarCnpj(cnpjExtraido);
  for (const f of fornecedores) {
    if (cnpjAlvo && normalizarCnpj(f.cnpj) === cnpjAlvo) return f.id;
    let emails = [];
    try { emails = JSON.parse(f.emails_remetentes || '[]'); } catch { /* ignora */ }
    if (remetente && emails.some(e => (e || '').toLowerCase().trim() === remetente.toLowerCase().trim())) return f.id;
  }
  const dica = (dicaFornecedorDaPasta(pasta) || '').toLowerCase();
  if (dica) {
    const porPasta = fornecedores.find(f => {
      const nome = (f.nome || '').toLowerCase();
      return nome.includes(dica) || dica.includes(nome);
    });
    if (porPasta) return porPasta.id;
  }
  return null;
}

// Nome a partir do domínio do e-mail (ex.: "financeiro@wurth.com.br" → "Wurth",
// "financeiro@contareisp.com.br" → "Contare Isp") — só usado quando não há
// pista melhor (nome da pasta). Sufixos comuns que vêm colados no nome da
// empresa são separados com espaço; o resto fica como uma palavra só (sempre
// dá pra ajustar o nome depois na tela de Fornecedores).
const SUFIXOS_DOMINIO = /^(.{3,})(isp|telecom|tecnologia|solucoes|net|corp|group)$/i;
function nomeDoDominio(email) {
  if (!email || !email.includes('@')) return null;
  const base = (email.split('@')[1] || '').split('.')[0] || '';
  if (base.length < 3) return null;
  const m = base.match(SUFIXOS_DOMINIO);
  const partes = m ? [m[1], m[2]] : [base];
  return partes.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Casa com um fornecedor existente; se não achar nenhum e houver uma pista
// razoável (nome da pasta ou domínio do remetente), CRIA o fornecedor na
// hora. Runs seguintes do mesmo fornecedor casam por esse cadastro recém-
// criado (mesma lógica de identificarFornecedor), sem duplicar.
async function identificarOuCriarFornecedor(empresaId, remetente, cnpjExtraido, pasta) {
  const existente = await identificarFornecedor(empresaId, remetente, cnpjExtraido, pasta);
  if (existente) return existente;

  const nome = dicaFornecedorDaPasta(pasta) || nomeDoDominio(remetente);
  if (!nome) return null; // sem pista nenhuma — fica sem fornecedor, pra revisão manual

  const id = randomUUID();
  await run(
    'INSERT INTO fornecedores (id, empresa_id, nome, cnpj, emails_remetentes) VALUES ($1,$2,$3,$4,$5)',
    [id, empresaId, nome, cnpjExtraido || null, JSON.stringify(remetente ? [remetente] : [])]
  );
  return id;
}

async function processarAnexoPdf({ empresaId, mensagem, pasta, anexo }) {
  const { PDFParse } = require('pdf-parse');
  let texto = '';
  try {
    const parser = new PDFParse({ data: anexo.content });
    const resultado = await parser.getText();
    texto = resultado.text || '';
    await parser.destroy();
  } catch (e) {
    console.warn('[email-fornecedores] falha ao ler PDF:', e.message);
  }

  const valor = extrairValor(texto);
  const vencimento = extrairVencimento(texto);
  const cnpj = extrairCnpj(texto);
  const numeroDocumento = extrairLinhaDigitavel(texto);
  const remetente = mensagem.from?.value?.[0]?.address || '';
  const fornecedorId = await identificarOuCriarFornecedor(empresaId, remetente, cnpj, pasta);

  const nomeArquivo = `${randomUUID()}.pdf`;
  fs.writeFileSync(path.join(PASTA_ANEXOS, nomeArquivo), anexo.content);

  const status = (valor && vencimento) ? 'aberto' : 'pendente_revisao';

  await run(`
    INSERT INTO contas_pagar_fornecedores (
      id, empresa_id, fornecedor_id, tipo, numero_documento, descricao, valor, vencimento,
      status, arquivo_path, email_remetente, email_assunto, email_message_id,
      email_recebido_em, email_pasta, extraido_automaticamente
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (empresa_id, email_message_id) DO NOTHING
  `, [
    randomUUID(), empresaId, fornecedorId, numeroDocumento && numeroDocumento.length > 20 ? 'boleto' : 'nota_fiscal',
    numeroDocumento, mensagem.subject || anexo.filename || null, valor, vencimento,
    status, nomeArquivo, remetente, mensagem.subject || null, mensagem.messageId || null,
    mensagem.date || null, pasta || null, 1,
  ]);
}

function criarCliente(cfg) {
  return new ImapFlow({
    host: cfg.imap_host || 'imap.uhserver.com',
    port: cfg.imap_port || 993,
    secure: true,
    auth: { user: cfg.email_usuario, pass: cfg.email_senha },
    logger: false,
  });
}

// Processa UMA pasta com conexão própria (conecta, faz o trabalho, desconecta).
// Isolado por pasta de propósito: numa caixa com muitas pastas (~90+), manter
// uma única conexão aberta o tempo todo se mostrou frágil — o servidor derruba
// a sessão ("Connection not available") no meio do caminho, e antes isso
// abortava a sincronização inteira, perdendo o progresso de todas as pastas
// ainda não visitadas. Reconectar por pasta faz uma pasta com problema falhar
// sozinha, sem impedir as demais de serem processadas nesta mesma execução.
async function sincronizarPasta({ empresaId, cfg, pasta, dataCorte, limiteRestante }) {
  const client = criarCliente(cfg);
  let processadas = 0;
  try {
    await client.connect();
    const estado = await carregarEstadoPasta(empresaId, pasta);
    let ultimoUid = estado?.ultimo_uid_processado || 0;
    const lock = await client.getMailboxLock(pasta);
    try {
      const uidvalidityAtual = String(client.mailbox.uidValidity);
      if (estado?.uidvalidity && estado.uidvalidity !== uidvalidityAtual) ultimoUid = 0;

      // Busca por data primeiro (SEARCH SINCE) pra não varrer anos de
      // histórico em pastas antigas — só depois filtra pelo que falta
      // processar (uid > ultimoUid) e busca só essas mensagens específicas.
      const uidsDesdeData = await client.search({ since: new Date(dataCorte) }, { uid: true });
      const pendentes = (uidsDesdeData || []).filter(uid => uid > ultimoUid).sort((a, b) => a - b);

      if (pendentes.length > 0) {
        const fatia = pendentes.slice(0, limiteRestante);
        for await (const msg of client.fetch(fatia.join(','), { envelope: true, source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source);
          const anexosPdf = (parsed.attachments || []).filter(a => a.contentType === 'application/pdf');
          for (const anexo of anexosPdf) {
            await processarAnexoPdf({ empresaId, mensagem: parsed, pasta, anexo });
          }
          if (msg.uid > ultimoUid) ultimoUid = msg.uid;
          processadas++;
          await salvarEstadoPasta(empresaId, pasta, uidvalidityAtual, ultimoUid);
        }
      } else if (estado?.uidvalidity !== uidvalidityAtual) {
        // Nada pendente, mas grava o uidvalidity mesmo assim (primeira vez na pasta)
        await salvarEstadoPasta(empresaId, pasta, uidvalidityAtual, ultimoUid);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try { client.logout(); } catch { /* ignora */ }
    throw e;
  }
  return processadas;
}

async function sincronizarEmpresa(empresaId) {
  const cfg = await carregarConfig(empresaId);
  if (!cfg || !cfg.ativo || !cfg.email_usuario || !cfg.email_senha) {
    return { ok: false, motivo: 'Integração não configurada ou inativa' };
  }

  const dataCorte = cfg.data_inicio_historico || '2026-01-01';

  let mailboxes;
  try {
    const clientLista = criarCliente(cfg);
    await clientLista.connect();
    mailboxes = (await clientLista.list()).filter(pastaElegivel);
    await clientLista.logout();
  } catch (e) {
    await run(
      `UPDATE integracao_email_fornecedores SET ultima_sync = NOW(), ultimo_status = 'erro', ultimo_erro = $1 WHERE empresa_id = $2`,
      [e.message, empresaId]
    );
    return { ok: false, erro: e.message };
  }

  let processadas = 0;
  const porPasta = [];
  const comErro = [];

  for (const mb of mailboxes) {
    if (processadas >= MAX_MENSAGENS_POR_EXECUCAO) break;
    try {
      const nestapasta = await sincronizarPasta({
        empresaId, cfg, pasta: mb.path, dataCorte,
        limiteRestante: MAX_MENSAGENS_POR_EXECUCAO - processadas,
      });
      processadas += nestapasta;
      if (nestapasta > 0) porPasta.push({ pasta: mb.path, processadas: nestapasta });
    } catch (e) {
      comErro.push({ pasta: mb.path, erro: e.message });
    }
  }

  const status = comErro.length > 0 ? 'erro' : 'ok';
  const erroResumo = comErro.length > 0
    ? comErro.slice(0, 5).map(x => `${x.pasta}: ${x.erro}`).join(' | ') + (comErro.length > 5 ? ` (+${comErro.length - 5} outra(s))` : '')
    : null;
  await run(
    `UPDATE integracao_email_fornecedores SET ultima_sync = NOW(), ultimo_status = $1, ultimo_erro = $2 WHERE empresa_id = $3`,
    [status, erroResumo, empresaId]
  );
  return {
    ok: comErro.length === 0,
    mensagens_processadas: processadas,
    pastas_com_novidade: porPasta,
    pastas_com_erro: comErro.length > 0 ? comErro : undefined,
  };
}

async function sincronizarTodasEmpresas() {
  const empresas = await all('SELECT empresa_id FROM integracao_email_fornecedores WHERE ativo = 1');
  const resultados = [];
  for (const { empresa_id } of empresas) {
    resultados.push({ empresa_id, ...(await sincronizarEmpresa(empresa_id)) });
  }
  return resultados;
}

async function testarConexao(cfg) {
  const client = new ImapFlow({
    host: cfg.imap_host || 'imap.uhserver.com',
    port: cfg.imap_port || 993,
    secure: true,
    auth: { user: cfg.email_usuario, pass: cfg.email_senha },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const status = client.mailbox;
    lock.release();
    const mailboxes = (await client.list()).filter(pastaElegivel);
    await client.logout();
    return {
      ok: true,
      total_mensagens: status?.exists ?? null,
      total_pastas: mailboxes.length,
      pastas: mailboxes.map(m => m.path).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    };
  } catch (e) {
    try { client.logout(); } catch { /* ignora */ }
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  sincronizarEmpresa,
  sincronizarTodasEmpresas,
  testarConexao,
  PASTA_ANEXOS,
};
