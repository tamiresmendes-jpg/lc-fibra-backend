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

# "status: online" sozinho nao basta: um processo em loop de crash tambem
# aparece "online" por uma fracao de segundo entre uma queda e outra (o PM2
# reinicia sozinho). Ja aconteceu de o script dizer "deploy concluido" com o
# processo caindo em loop (ReferenceError num require de topo, por exemplo).
# Por isso: mede o contador de reinicios (restart_time) duas vezes, com uma
# espera de verdade no meio — se ele SUBIU nesse intervalo, e crash loop, nao
# deploy estavel, mesmo que a leitura final diga "online".
echo "==> Aguardando o processo estabilizar..."
sleep 3
INFO_1=$(ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "pm2 jlist | node -e \"const p=JSON.parse(require('fs').readFileSync(0)).find(x=>x.name==='kronos-backend'); console.log(p.pm2_env.status+' '+p.pm2_env.restart_time)\"")
RESTARTS_1=$(echo "$INFO_1" | awk '{print $2}')

sleep 8
INFO_2=$(ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" \
  "pm2 jlist | node -e \"const p=JSON.parse(require('fs').readFileSync(0)).find(x=>x.name==='kronos-backend'); console.log(p.pm2_env.status+' '+p.pm2_env.restart_time)\"")
STATUS_2=$(echo "$INFO_2" | awk '{print $1}')
RESTARTS_2=$(echo "$INFO_2" | awk '{print $2}')

if [ "$STATUS_2" != "online" ] || [ "$RESTARTS_2" -gt "$RESTARTS_1" ]; then
  echo "!!! kronos-backend NAO ficou estavel (status: $STATUS_2, reinicios $RESTARTS_1 -> $RESTARTS_2 em 8s)."
  echo "!!! Isso indica crash loop (provavel erro ao carregar algum arquivo). Ultimas linhas do log de erro:"
  ssh -i "$CHAVE" -o StrictHostKeyChecking=no "$SERVIDOR" "tail -n 25 /root/.pm2/logs/kronos-backend-error.log"
  echo "!!! O processo antigo NAO volta sozinho — ele fica no ar do jeito que ficou. Corrija o codigo e rode o deploy de novo."
  exit 1
fi

echo "==> Deploy concluido. kronos-backend esta online e estavel (sem reinicios em 8s)."
