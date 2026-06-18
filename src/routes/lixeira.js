const express = require('express');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

// Mapa: módulo → tabela, campo título
const MODULOS = {
  departamentos: { tabela: 'departamentos', titulo: 'nome'   },
  cargos:        { tabela: 'cargos',        titulo: 'nome'   },
  processos:     { tabela: 'processos',     titulo: 'titulo' },
  reunioes:      { tabela: 'reunioes',      titulo: 'titulo' },
  acoes:         { tabela: 'acoes',         titulo: 'titulo' },
  treinamentos:  { tabela: 'treinamentos',  titulo: 'titulo' },
  pops:          { tabela: 'pops',          titulo: 'titulo' },
};

// Listar tudo na lixeira
router.get('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });

    const resultados = await Promise.all(
      Object.entries(MODULOS).map(async ([modulo, { tabela, titulo }]) => {
        try {
          const rows = await all(
            `SELECT id, ${titulo} as titulo, excluido_em, excluido_por_nome, '${modulo}' as modulo
             FROM ${tabela}
             WHERE empresa_id = $1 AND excluido_em IS NOT NULL
             ORDER BY excluido_em DESC`,
            [eid(req)]
          );
          return rows;
        } catch { return []; }
      })
    );

    const itens = resultados.flat().sort((a, b) => new Date(b.excluido_em) - new Date(a.excluido_em));
    res.json(itens);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Restaurar item
router.post('/:modulo/:id/restaurar', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const cfg = MODULOS[req.params.modulo];
    if (!cfg) return res.status(400).json({ erro: 'Módulo inválido' });

    await run(
      `UPDATE ${cfg.tabela} SET excluido_em = NULL, excluido_por = NULL, excluido_por_nome = NULL
       WHERE id = $1 AND empresa_id = $2 AND excluido_em IS NOT NULL`,
      [req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir definitivamente (apenas admin)
router.delete('/:modulo/:id', async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas o administrador pode excluir definitivamente' });
    const cfg = MODULOS[req.params.modulo];
    if (!cfg) return res.status(400).json({ erro: 'Módulo inválido' });

    // Para treinamentos, limpa tabelas relacionadas antes
    if (req.params.modulo === 'treinamentos') {
      const tid = req.params.id;
      await run('DELETE FROM treinamento_anotacoes    WHERE treinamento_id = $1', [tid]);
      await run('DELETE FROM treinamento_respostas    WHERE treinamento_id = $1', [tid]);
      await run('DELETE FROM treinamento_avaliacoes   WHERE treinamento_id = $1', [tid]);
      await run('DELETE FROM treinamento_pops         WHERE treinamento_id = $1', [tid]);
      await run('DELETE FROM treinamento_participantes WHERE treinamento_id = $1', [tid]);
    }

    await run(
      `DELETE FROM ${cfg.tabela} WHERE id = $1 AND empresa_id = $2 AND excluido_em IS NOT NULL`,
      [req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
