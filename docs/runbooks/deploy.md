# Runbook — Deploy em produção (VPS)

O caminho alvo de deploy **não constrói nada na VPS**: o CI publica a imagem no
GHCR e a VPS só puxa. Construir localmente é exceção de emergência, e tem custo —
está documentado no fim.

> **Estado da Sprint 0:** a Etapa 4 publica o trio privado `sha-<SHA completo>` e o promove
> sem rebuild para SemVer e `stable`. A autenticação read-only da VPS no GHCR ainda pertence
> a etapa posterior. Portanto, a parte de VPS deste runbook continua bloqueada até essa
> credencial e os fallbacks de produção serem fechados.

---

## 1. O comando

```bash
cd /var/www/crm
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

### Os DOIS `-f` são obrigatórios. Sempre.

Esta é a pegadinha que já derrubou o site inteiro em produção (2026-08-05).

A VPS (Hostinger) vem com um **Traefik próprio** ocupando as portas 80/443.
`docker-compose.traefik.yml` é o ÚNICO lugar que:

- coloca no contêiner `app` as labels de roteamento
  (`traefik.http.routers.deskcomm.rule=Host(...)`);
- associa o contêiner à rede que o Traefik enxerga (`TRAEFIK_DOCKER_NETWORK`);
- desliga o `caddy` do compose base por profile (senão dois processos brigam
  pela mesma porta).

Rodar só com `-f docker-compose.prod.yml` recria o contêiner **sem labels
nenhuma**. O Traefik deixa de enxergá-lo e o domínio inteiro passa a responder
`404 page not found` — não é erro do Next, é o 404 genérico do Traefik. A app
está no ar, saudável, e inalcançável.

---

## 2. Verificação pós-deploy (não pule)

`healthy` no `docker ps` **não prova que o site está acessível** — o healthcheck
é um probe TCP interno e passa mesmo com o roteamento quebrado. Verifique as
duas coisas:

```bash
# 1) as labels do Traefik existem?
#    O nome do contêiner é <pasta-do-projeto>-app-1, então pergunte ao compose
#    em vez de chutar. Aqui um -f só basta: o `ps -q` resolve pelo nome do
#    projeto + serviço, não pelo conteúdo do arquivo (medido: com um -f ou com
#    os dois, devolve o MESMO contêiner). Quem precisa dos dois é o `up -d`.
docker inspect "$(docker compose -f docker-compose.prod.yml ps -q app)" \
  --format '{{.Config.Labels}}' | grep -o 'traefik.enable:[^ ]*'
# esperado: traefik.enable:true   (vazio = roteamento quebrado)

# 2) o domínio responde?
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMAIN>/
# esperado: 307 (redireciona pro login)
# 404      = labels perdidas, refaça o deploy com os dois -f
```

---

## 3. Fluxo ativo da Etapa 4 (do código ao GHCR)

```
main → sha-<commit> → vX.Y.Z → validação do trio → stable → GitHub Release
```

1. **Commit + push** numa branch de feature. Trabalho que fica só no disco da
   VPS não existe: o CI não o vê, some se a VPS for reconstruída, e é invisível
   pra qualquer outra pessoa.
2. **PR e merge na `main`.** `publish-image.yml` publica **três** imagens privadas —
   `bb-gestao-app`, `bb-gestao-worker` e `bb-gestao-scheduler` — com a mesma tag
   `sha-<SHA completo>`, em `linux/amd64`. Cada imagem SHA existente e compatível é
   reutilizada; somente as ausentes são construídas. O check `imagens-ok` só aprova depois
   da matriz, do smoke da imagem publicada/reutilizada do app e da validação remota dos
   labels OCI. Ele pode ser configurado como required check, mas esse estado da branch
   protection do fork ainda precisa ser verificado/configurado externamente.
3. **Corte revisável.** O dispatch de `release.yml` calcula a linha Promidia a partir dos
   fragmentos e abre o PR de release. A primeira versão é `v0.1.0`; o histórico upstream
   permanece no CHANGELOG, fora desse cálculo.
4. **Tag Git.** O merge do PR aguarda `imagens-ok` aprovar aquele mesmo commit; só então o App
   cria `vX.Y.Z` na `main`. A tag dispara um novo run de `release.yml`; `publish-image.yml`
   não reage a tags.
5. **Preflight e SemVer.** O job autenticado resolve o commit da tag, exige as três imagens
   `sha-<commit>`, valida `linux/amd64`, revisão e labels OCI, e só então copia os manifests
   por digest para `vX.Y.Z`. Não há build. SemVer existente só é aceita com o mesmo digest.
6. **Canal e release.** Depois de verificar o trio SemVer, o job captura os três `stable`,
   move o canal, verifica o trio e publica a GitHub Release. `latest` não existe neste fluxo.

O GHCR não oferece alteração atômica entre três packages. A garantia é: uma promoção por vez,
preflight integral, verificação antes e depois e rollback compensatório para refs anteriores.
Se a primeira promoção falhar depois de criar apenas parte de `stable`, o run fica vermelho e
o operador deve reexecutar a mesma release para completar o trio; não deve apagar versions do
GHCR, porque uma version pode carregar também as tags SHA e SemVer imutáveis.

---

## 4. Rollback operacional

Se a falha ocorrer durante a promoção `sha-<commit>` → `vX.Y.Z`, `stable` ainda não foi
tocada. As tags SemVer que já ficaram corretas permanecem imutáveis; reexecute o mesmo run.
O preflight reutiliza as corretas, promove as ausentes e falha fechado se encontrar qualquer
digest divergente.

### Tentativa de `stable` que falhou parcialmente

1. Não faça deploy e preserve o run vermelho.
2. Leia no log o estado anterior capturado para app, worker e scheduler.
3. Se os três refs anteriores existiam, o próprio job tenta restaurá-los e verifica os digests.
4. Mesmo com restauração completa, a execução termina em falha e exige revisão humana.
5. Se era a primeira release e algum ref anterior era ausente, reexecute o job da **mesma tag**.
   O fluxo reutiliza as SemVer corretas e completa somente o que falta. Não apague package
   versions para tentar restaurar "ausência".

### Rollback deliberado de produção

Escolha uma tag `vX.Y.Z` que já teve o job `promover-release` verde. Reexecute o run de push
dessa tag no GitHub Actions. O preflight prova novamente o trio SHA/SemVer e move `stable` de
volta para os três digests antigos, sem reconstruir `vX.Y.Z`.

Com acesso autenticado ao GHCR, confirme o resultado:

```bash
for image in bb-gestao-app bb-gestao-worker bb-gestao-scheduler; do
  version_digest=$(docker buildx imagetools inspect \
    "ghcr.io/soupromidia/${image}:vX.Y.Z" --format '{{.Manifest.Digest}}')
  stable_digest=$(docker buildx imagetools inspect \
    "ghcr.io/soupromidia/${image}:stable" --format '{{.Manifest.Digest}}')
  printf '%s vX.Y.Z=%s stable=%s\n' "$image" "$version_digest" "$stable_digest"
  test "$version_digest" = "$stable_digest"
done
```

Somente depois dos três pares iguais a instalação pode voltar para `vX.Y.Z`. O rollback de
produção promove uma release validada; nunca reconstrói uma versão antiga. O health da app
responde o `sha-<commit>` original, pois a promoção SemVer preserva o artefato byte a byte.

---

## 5. Exceção: imagem construída na VPS

Só quando é preciso validar algo em produção **antes** de a imagem oficial
existir (ex.: CI ainda rodando e um bug bloqueando o usuário).

```bash
APP_IMAGE=bb-gestao-app:local docker compose \
  -f docker-compose.prod.yml -f docker-compose.build.yml --env-file .env build app

APP_IMAGE=bb-gestao-app:local APP_PULL_POLICY=never docker compose \
  -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

O `docker-compose.build.yml` também cobre `worker` e `scheduler` — troque
`app` pelo serviço que você precisa construir. Eles têm `build:` no próprio
compose de produção (é o escape que faz a instalação sobreviver a um registry
fora do ar), mas é o override que traz o `pull_policy: never`; sem ele o
`up -d` volta a buscar a imagem publicada.

**Isto é dívida, não um caminho paralelo.** A imagem existe só no disco daquela
VPS: não está no registry, não está no git, e qualquer `docker compose up -d`
sem `APP_PULL_POLICY=never` a substitui pela do GHCR — silenciosamente, sem erro
nenhum, revertendo o que você acabou de subir.

Requisitos: >= 4 GB de RAM **ou** swap (medido: ~4min num VPS de 3.8 GB com 4 GB
de swap) — e isto é o requisito **deste caminho de exceção**, não da operação
normal. A régua de operação é outra, e não mudou. Ela tem três parcelas, e **duas
são medidas e uma é herdada** — a distinção importa porque a herdada é a que
costuma ser citada como se fosse nossa:

| parcela | estado | como conferir |
|---|---|---|
| 7 contêineres | **medido** | `docker compose -f docker-compose.prod.yml config --services \| wc -l` |
| `mem_limit` somando 2560m (app 768 + worker 512 + waha 1280) | **medido** | `grep -n 'mem_limit' docker-compose.prod.yml` |
| ~150 MB por número de WhatsApp | **herdado do upstream WAHA**, nunca medido neste projeto | `docker stats --no-stream` na sua VPS |

O terceiro número vem de `docs/research/reference-synthesis.md` (síntese do curso
WAHA, 2026-05), não de uma medição nossa — e circula em sete documentos que se
citam entre si. Uma medição pontual na produção do projeto (2026-08-14, **uma**
sessão pareada, VPS compartilhada com outras stacks) deu **304,5 MiB no contêiner
`waha` inteiro**, contra o `mem_limit` de 1280 MiB. Um ponto não decompõe baseline
e sessão: para isso seriam necessários dois números pareados, e não é ensaio que
se faça numa instalação viva.

**Nada disso mexe no tier recomendado.** A régua que sustenta os 4 GB é a soma da
stack em operação, não o WAHA isolado — e a folga existe justamente porque a
parcela por sessão não é conhecida com precisão.

Ao terminar, feche o ciclo — merge na `main` e volte a VPS pra imagem oficial.
