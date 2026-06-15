const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_PORT === '465',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  });

  return transporter;
}

/**
 * Envia o PDF de um POP por e-mail.
 * @param {Object} pop   - Dados do POP (titulo, codigo, etc.)
 * @param {Buffer} pdf   - Buffer do PDF gerado
 */
async function enviarEmailPOP(pop, pdf) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || process.env.EMAIL_PASS === 'SUA_SENHA_DE_APP_AQUI') {
    console.warn('⚠️  E-mail não configurado — defina EMAIL_USER e EMAIL_PASS no .env');
    return;
  }

  const destino   = process.env.EMAIL_DESTINO || process.env.EMAIL_USER;
  const nomeArq   = `${pop.codigo || 'POP'}-${pop.titulo?.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
  const dataHora  = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #7B55F1; padding: 28px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px;">LC FIBRA — Novo POP Cadastrado</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0; font-size: 13px;">Sistema de Gestão Interna</p>
      </div>
      <div style="background: #fff; padding: 28px 32px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="color: #374151; font-size: 14px; margin: 0 0 20px;">
          Um novo Procedimento Operacional Padrão foi criado no sistema e está anexado a este e-mail em formato PDF.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          ${pop.codigo ? `<tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase; width: 140px;">Código</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #7B55F1; font-weight: 700; font-family: monospace;">${pop.codigo}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Título</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #0f172a; font-weight: 600;">${pop.titulo}</td>
          </tr>
          ${pop.departamento_nome ? `<tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Departamento</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #374151;">${pop.departamento_nome}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Versão</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #374151;">v${pop.versao || '1.0'}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Criado por</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #374151;">${pop.criado_por_nome || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Data/Hora</td>
            <td style="padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; font-size: 13px; color: #374151;">${dataHora}</td>
          </tr>
        </table>
        <p style="color: #94a3b8; font-size: 12px; margin: 0;">
          O documento completo está em anexo.<br>
          Este é um e-mail automático gerado pelo Sistema de Gestão LC FIBRA.
        </p>
      </div>
      <div style="background: #f8fafc; padding: 14px 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="color: #94a3b8; font-size: 11px; margin: 0;">LC FIBRA — Sistema de Gestão Interna</p>
      </div>
    </div>
  `;

  await getTransporter().sendMail({
    from:    process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to:      destino,
    subject: `📄 Novo POP: ${pop.codigo ? `[${pop.codigo}] ` : ''}${pop.titulo}`,
    html,
    attachments: [
      {
        filename:    nomeArq,
        content:     pdf,
        contentType: 'application/pdf',
      },
    ],
  });

  console.log(`📧 E-mail enviado: ${nomeArq} → ${destino}`);
}

module.exports = { enviarEmailPOP };
