#!/bin/bash
# Deploy seguro do backend Kronos para o servidor de produção.
#
# Por que existe: um deploy manual com scp arquivo-a-arquivo deixou o
# hubsoft.js desatualizado no servidor enquanto o erp.js (que depende de uma
# função nova dele) já tinha ido — o processo caiu em loop de crash (502) até
# alguém notar. Este script elimina a possibilidade de "só metade foi": empacota
# a pasta src/ inteira num único .tar.gz, envia esse UM arquivo (scp de um
# arquivo só não tem como copiar "pela metade" o conjunto), extrai no servidor
# por cima da pasta atual, confere a sintaxe de cada .js DEPOIS de extraído —
# no código que vai rodar de fato — e só reinicia o PM2 se a validação passar.
# Se qualquer etapa falhar, o processo antigo continua no ar e o script para.
set -euo pipefail

SERVIDOR="root@172.16.255.55"
CHAVE="$HOME/.ssh/id_kronos"
DESTINO="/opt/kronos/backend"
LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACOTE="/tmp/kronos-backend-src-$$.tar.gz"

echo "==> Verificando sintaxe local antes de enviar..."
find "$LOCAL/src" -name "*.js" -print0 | while IFS= read -r -d '' f; do
  node -c "$f" || { echo "Sintaxe invalida em $f — abortando."; exit 1; }
done

echo "==> Empacotando src/ num unico arquivo..."
tar -czf "$PACOTE" -C "$LOCAL" src

echo "==> Enviando o pacote (um scp so, tudo-ou-nada)..."
scp -i "$CHAVE" -o StrictHostKeyChecking=no "$PACOTE" "$SERVIDOR:/tmp/kronos-backend-src.tar.gz"
rm -f "$PACOTE"

echo "==> Extraindo no servidor por cima da pasta atual..."
ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "tar -xzf /tmp/kronos-backend-src.tar.gz -C $DESTINO && rm -f /tmp/kronos-backend-src.tar.gz"

echo "==> Validando sintaxe de TODOS os arquivos js no servidor (pos-copia)..."
ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "cd $DESTINO && find src -name '*.js' -print0 | xargs -0 -n1 node -c"

echo "==> Sintaxe OK no servidor. Reiniciando kronos-backend..."
ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "pm2 restart kronos-backend --update-env"

echo "==> Aguardando o processo estabilizar..."
sleep 4

STATUS=$(ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "pm2 jlist | node -e \"const p=JSON.parse(require('fs').readFileSync(0)).find(x=>x.name==='kronos-backend'); console.log(p.pm2_env.status)\"")

if [ "$STATUS" != "online" ]; then
  echo "!!! kronos-backend nao ficou online (status: $STATUS). Verifique os logs:"
  echo "    ssh -i $CHAVE $SERVIDOR \"pm2 logs kronos-backend --lines 50 --nostream\""
  exit 1
fi

echo "==> Deploy concluido. kronos-backend esta online."
