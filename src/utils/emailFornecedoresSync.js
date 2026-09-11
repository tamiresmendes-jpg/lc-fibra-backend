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

// Limite de mensagens processadas por execução — evita sobrecarregar numa
// primeira sincronização com histórico grande; o restante fica pro próximo run
// (ultimo_uid_processado avança incrementalmente).
const MAX_MENSAGENS_POR_EXECUCAO = 200;

async function carregarConfig(empresaId) {
  return await get('SELECT * FROM integracao_email_fornecedores WHERE empresa_id = $1', [empresaId]);
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

async function identificarFornecedor(empresaId, remetente, cnpjExtraido) {
  const fornecedores = await all('SELECT * FROM fornecedores WHERE empresa_id = $1 AND ativo = 1', [empresaId]);
  const cnpjAlvo = normalizarCnpj(cnpjExtraido);
  for (const f of fornecedores) {
    if (cnpjAlvo && normalizarCnpj(f.cnpj) === cnpjAlvo) return f.id;
    let emails = [];
    try { emails = JSON.parse(f.emails_remetentes || '[]'); } catch { /* ignora */ }
    if (remetente && emails.some(e => (e || '').toLowerCase().trim() === remetente.toLowerCase().trim())) return f.id;
  }
  return null;
}

async function processarAnexoPdf({ empresaId, mensagem, anexo }) {
  const pdfParse = require('pdf-parse');
  let texto = '';
  try {
    const dados = await pdfParse(anexo.content);
    texto = dados.text || '';
  } catch (e) {
    console.warn('[email-fornecedores] falha ao ler PDF:', e.message);
  }

  const valor = extrairValor(texto);
  const vencimento = extrairVencimento(texto);
  const cnpj = extrairCnpj(texto);
  const numeroDocumento = extrairLinhaDigitavel(texto);
  const remetente = mensagem.from?.value?.[0]?.address || '';
  const fornecedorId = await identificarFornecedor(empresaId, remetente, cnpj);

  const nomeArquivo = `${randomUUID()}.pdf`;
  fs.writeFileSync(path.join(PASTA_ANEXOS, nomeArquivo), anexo.content);

  const status = (valor && vencimento) ? 'aberto' : 'pendente_revisao';

  await run(`
    INSERT INTO contas_pagar_fornecedores (
      id, empresa_id, fornecedor_id, tipo, numero_documento, descricao, valor, vencimento,
      status, arquivo_path, email_remetente, email_assunto, email_message_id,
      email_recebido_em, extraido_automaticamente
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (empresa_id, email_message_id) DO NOTHING
  `, [
    randomUUID(), empresaId, fornecedorId, numeroDocumento && numeroDocumento.length > 20 ? 'boleto' : 'nota_fiscal',
    numeroDocumento, mensagem.subject || anexo.filename || null, valor, vencimento,
    status, nomeArquivo, remetente, mensagem.subject || null, mensagem.messageId || null,
    mensagem.date || null, 1,
  ]);
}

async function sincronizarEmpresa(empresaId) {
  const cfg = await carregarConfig(empresaId);
  if (!cfg || !cfg.ativo || !cfg.email_usuario || !cfg.email_senha) {
    return { ok: false, motivo: 'Integração não configurada ou inativa' };
  }

  const client = new ImapFlow({
    host: cfg.imap_host || 'imap.uhserver.com',
    port: cfg.imap_port || 993,
    secure: true,
    auth: { user: cfg.email_usuario, pass: cfg.email_senha },
    logger: false,
  });

  let processadas = 0;
  let ultimoUid = cfg.ultimo_uid_processado || 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.pasta || 'INBOX');
    try {
      const inicio = ultimoUid + 1;
      for await (const msg of client.fetch(`${inicio}:*`, { envelope: true, source: true }, { uid: true })) {
        if (msg.uid <= ultimoUid) continue; // '*' sempre inclui a última mensagem, mesmo já processada
        if (processadas >= MAX_MENSAGENS_POR_EXECUCAO) break;
        const parsed = await simpleParser(msg.source);
        const anexosPdf = (parsed.attachments || []).filter(a => a.contentType === 'application/pdf');
        for (const anexo of anexosPdf) {
          await processarAnexoPdf({ empresaId, mensagem: parsed, anexo });
        }
        ultimoUid = msg.uid;
        processadas++;
        await run(
          `UPDATE integracao_email_fornecedores SET ultimo_uid_processado = $1 WHERE empresa_id = $2`,
          [ultimoUid, empresaId]
        );
      }
    } finally {
      lock.release();
    }
    await client.logout();
    await run(
      `UPDATE integracao_email_fornecedores SET ultima_sync = NOW(), ultimo_status = 'ok', ultimo_erro = NULL WHERE empresa_id = $1`,
      [empresaId]
    );
    return { ok: true, mensagens_processadas: processadas };
  } catch (e) {
    try { client.logout(); } catch { /* ignora */ }
    await run(
      `UPDATE integracao_email_fornecedores SET ultima_sync = NOW(), ultimo_status = 'erro', ultimo_erro = $1 WHERE empresa_id = $2`,
      [e.message, empresaId]
    );
    return { ok: false, erro: e.message };
  }
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
    const lock = await client.getMailboxLock(cfg.pasta || 'INBOX');
    const status = client.mailbox;
    lock.release();
    await client.logout();
    return { ok: true, total_mensagens: status?.exists ?? null };
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
