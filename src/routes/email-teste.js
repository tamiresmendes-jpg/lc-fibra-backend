const express = require('express');
const nodemailer = require('nodemailer');
const { autenticar } = require('../middleware/auth');
const { gerarPDFPOP } = require('../utils/gerarPDF');
const { enviarEmailPOP } = require('../utils/email');

const router = express.Router();
router.use(autenticar);

// Testa conexão SMTP e envia e-mail de teste
router.post('/testar', async (req, res) => {
  const { host, port, user, pass, destino } = req.body;

  const cfg = {
    host:   host  || process.env.EMAIL_HOST,
    port:   parseInt(port || process.env.EMAIL_PORT || '587'),
    secure: (port || process.env.EMAIL_PORT) === '465',
    auth: {
      user: user || process.env.EMAIL_USER,
      pass: pass || process.env.EMAIL_PASS,
    },
    tls: { rejectUnauthorized: false },
  };

  try {
    const t = nodemailer.createTransport(cfg);
    await t.verify();

    await t.sendMail({
      from:    cfg.auth.user,
      to:      destino || cfg.auth.user,
      subject: '✅ Teste de E-mail — LC FIBRA Sistema',
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;max-width:500px">
          <h2 style="color:#7B55F1">Conexão funcionando!</h2>
          <p>O servidor SMTP está configurado corretamente.</p>
          <p><strong>Host:</strong> ${cfg.host}:${cfg.port}</p>
          <p><strong>Usuário:</strong> ${cfg.auth.user}</p>
          <p style="color:#64748b;font-size:12px">LC FIBRA — Sistema de Gestão</p>
        </div>
      `,
    });

    res.json({ ok: true, mensagem: `E-mail enviado para ${destino || cfg.auth.user}` });
  } catch (err) {
    res.status(400).json({
      ok: false,
      erro: err.message,
      codigo: err.code,
      dica: getDica(err),
    });
  }
});

// Atualiza o .env com as novas configurações de e-mail
router.post('/salvar-config', async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '../../../.env');

  try {
    let conteudo = fs.readFileSync(envPath, 'utf-8');

    const campos = {
      EMAIL_HOST:    req.body.host,
      EMAIL_PORT:    req.body.port,
      EMAIL_USER:    req.body.user,
      EMAIL_PASS:    req.body.pass,
      EMAIL_FROM:    `LC FIBRA Sistema <${req.body.user}>`,
      EMAIL_DESTINO: req.body.destino || req.body.user,
    };

    for (const [chave, valor] of Object.entries(campos)) {
      if (!valor) continue;
      const regex = new RegExp(`^${chave}=.*$`, 'm');
      if (regex.test(conteudo)) {
        conteudo = conteudo.replace(regex, `${chave}=${valor}`);
      } else {
        conteudo += `\n${chave}=${valor}`;
      }
    }

    fs.writeFileSync(envPath, conteudo);

    // Recarrega variáveis de ambiente
    for (const [chave, valor] of Object.entries(campos)) {
      if (valor) process.env[chave] = valor;
    }

    res.json({ ok: true, mensagem: 'Configurações salvas. Reinicie o sistema para aplicar.' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

function getDica(err) {
  if (err.code === 'ECONNREFUSED')  return 'Host ou porta incorretos. Verifique o servidor SMTP e a porta.';
  if (err.code === 'ETIMEDOUT')     return 'Tempo esgotado. O servidor não respondeu. Tente outra porta (587 ou 465).';
  if (err.code === 'EAUTH' || err.message.includes('535') || err.message.includes('authentication failed'))
    return 'Autenticação falhou (erro 535). Verifique se o e-mail e a senha estão corretos. Para UOL/uhserver: use a senha normal do Webmail. Se o erro persistir, acesse o painel UOL Host → Contas de E-mail e confirme se o acesso SMTP está habilitado para esta conta.';
  if (err.message.includes('self signed') || err.message.includes('certificate'))
    return 'Erro de certificado SSL. Tente com porta 587 (TLS) em vez de 465 (SSL).';
  return 'Verifique host, porta, e-mail e senha. Acesse o painel da hospedagem para confirmar as configurações SMTP.';
}

module.exports = router;
