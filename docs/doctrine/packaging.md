# Doutrina de Packaging e Distribuição

> Lei de arquitetura para tudo que roda no disco de quem instalou o DeskcommCRM: imagens,
> composes, tags e o kit de instalação. Complementa [`sistema-vivo.md`](./sistema-vivo.md) —
> não é aspiração, é critério de aceite. Amarrada ao item 15 do Definition of Done
> (`CLAUDE.md`).

Esta é a **lei**. O procedimento operacional de deploy vive em
[`../runbooks/deploy.md`](../runbooks/deploy.md); as decisões estruturais e o que foi
recusado, em [`../adr/0001-packaging-e-distribuicao.md`](../adr/0001-packaging-e-distribuicao.md),
com a distribuição deste fork superada pelo [`ADR-0002`](../adr/0002-distribuicao-promidia.md).
Ao mudar um invariante aqui, atualize os dois na mesma sessão.

### Estado vigente da distribuição Promidia (Sprint 0, Etapa 4)

O fluxo ativo deste fork é `push` na `main` → validação/reuso individual das imagens já
existentes → build somente das ausentes → publicação no GHCR privado com a tag imutável
`sha-<SHA completo>` → smoke do app → validação remota do trio. Os packages são:

- `ghcr.io/soupromidia/bb-gestao-app`;
- `ghcr.io/soupromidia/bb-gestao-worker`;
- `ghcr.io/soupromidia/bb-gestao-scheduler`.

O push de uma tag Git `vX.Y.Z` dispara `release.yml`: o workflow autentica no GHCR privado,
valida o trio `sha-<SHA completo>` e promove os mesmos manifests para `vX.Y.Z`, sem rebuild.
Somente depois de verificar as três tags SemVer ele captura o estado anterior e move o trio
`stable`. `latest` não é publicado. O pull autenticado de produção nos packages privados
pertence a etapa posterior; nenhuma VPS deve tratar esta etapa como deploy já habilitado.

As referências abaixo a releases e instalações legadas registram a doutrina herdada e o
alvo das etapas seguintes. Em caso de conflito operacional durante a Sprint 0, este bloco e
o [`ADR-0002`](../adr/0002-distribuicao-promidia.md) prevalecem.

| Se você quer… | Vá para |
|---|---|
| saber se sua mudança precisa virar imagem publicada | §Os 8 invariantes, nº 1 |
| escolher a tag que uma instalação de cliente consome | §Política de canais |
| lançar uma versão | §Checklist de release |
| entender por que o namespace é `soupromidia` | ADR-0002 |

---

## O princípio-raiz

**O artefato que a pessoa instala é o produto. O repositório é a receita.**

A distinção não é filosófica — ela decide onde o custo cai. Toda peça do sistema ou é
**construída uma vez, por nós, no CI**, ou é **construída toda vez, por cada cliente, na VPS
dele**. A segunda opção transfere para o comprador um custo que é nosso: tempo de instalação,
RAM, risco de OOM no meio do primeiro contato com o produto — e, pior que tudo, a
possibilidade de que duas instalações "da mesma versão" estejam rodando código diferente.

Disso decorre a pergunta que classifica qualquer peça nova:

> *"Quando isto muda, quem paga o build?"*

Se a resposta for "o cliente", a peça está errada e vira imagem publicada.

### As duas famílias de artefato

| | **Nosso** | **Upstream** |
|---|---|---|
| Exemplos | `bb-gestao-app`, `bb-gestao-worker` | WAHA, Redis, Caddy, `serverless-redis-http`, `postgres` |
| Quem constrói | nosso CI, uma vez por versão | terceiro, fora do nosso controle |
| O que fazemos | publicamos com procedência e versão | **referenciamos com tag pinada** (ver ressalva) |
| O que **nunca** fazemos | publicar da máquina de um dev | republicar, embalar ou copiar |
| Se quebrar | é bug nosso, com forward-fix | é incidente de fornecedor, com pin de escape |

**Ressalva medida:** `redis:7-alpine` e `caddy:2-alpine` flutuam dentro do major — as duas
se moveram no Docker Hub em 2026. São dependências de infraestrutura sem estado de negócio, e
o custo de bumpá-las a cada release não se paga hoje; o item 4 do checklist manda revisitá-las.
`waha` e `srh` — que tocam WhatsApp e rate limit — estão pinadas de verdade (tag exata e
digest). O gate reprova tag ausente ou `:latest`, não o major flutuante.

**Nenhuma peça upstream vira imagem nossa.** Não por preguiça: WAHA Plus é licenciado, e
redistribuir o binário de terceiro dentro de uma imagem nossa é passivo jurídico numa
dependência crítica. Referência, nunca cópia — e a regra vale para todas, não só a licenciada,
porque a exceção é o que apaga a regra.

---

## Os 8 invariantes (verificáveis)

### 1. Nenhum serviço de produção constrói na máquina do cliente

Todo serviço de `docker-compose.prod.yml` declara `image:` apontando para uma imagem
publicada. `build:` pode existir **ao lado** — como caminho de escape para quem quer compilar
—, nunca sozinho.

```yaml
# ERRADO — o cliente paga o build, e o update nunca o alcança
worker:
  build: { context: ., dockerfile: Dockerfile.worker }

# CERTO — imagem publicada; o build fica ao lado, como escape
worker:
  image: ghcr.io/soupromidia/bb-gestao-worker:sha-<SHA completo>
  build: { context: ., dockerfile: Dockerfile.worker }
```

- **Por quê:** um serviço `build:`-only é invisível para `docker compose pull` ("Skipped — No
  image to be pulled") e imune a `up -d` sem `--build`. Ele não é apenas caro de instalar: ele
  **nunca é atualizado**. Congela no código do dia da instalação e atravessa todas as
  atualizações seguintes sem que ninguém perceba.
- **Anti-exemplo real (o defeito que originou esta doutrina):** o serviço `worker` — que é o
  runtime do agente de IA, e o único consumidor de `ai_agent.dispatch_requested`, já que
  `app/api/v1/cron/agent-dispatcher` é no-op permanente — não tinha `image:`. Toda instalação
  rodava `pnpm install --frozen-lockfile` de 82 pacotes na VPS do cliente, e nenhum
  `update.sh` jamais o reconstruiu. A feature-título do produto era a única peça que não
  recebia correção. Enquanto isso, `CLAUDE.md` afirmava *"o caminho normal não constrói nada
  na VPS"* — verdade para o app, falso para o produto.
- **Verificação:** `tests/unit/packaging-artefato-do-cliente.test.ts` reprova serviço de
  `docker-compose.prod.yml` com `build:` e sem `image:`.

### 2. Publicação é ato do CI, e carrega procedência

Imagem nossa só existe se saiu de `.github/workflows/publish-image.yml`. Ela carrega os labels
OCI — no mínimo `source`, `revision`, `version`, `licenses` — e é construída para `linux/amd64`.

- **Por quê:** duas razões distintas. **(a) Arquitetura:** um `docker build` num Mac ARM produz
  imagem que não roda na VPS amd64 do cliente, e a falha aparece só no `up -d` dele. **(b)
  Rastreabilidade:** sem `org.opencontainers.image.revision` não existe resposta para "que
  código está rodando neste cliente?", e o suporte vira adivinhação.
- **Verificação:** o job **`imagens-ok`** de `publish-image.yml` reprova quando qualquer uma
  das três imagens não constrói nem é reconhecida como um SHA existente válido. Ele existe
  porque a matriz gera um nome de check por imagem, e exigir os três pelo nome faria uma
  quarta imagem, um dia, escapar do gate em silêncio.

  > **Evidência histórica do upstream.** Em 2026-08-14, `imagens-ok` era required check da
  > `main` do repositório original:
  >
  > ```console
  > $ gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  >     --jq '.required_status_checks.contexts|join(", ")'
  > verify, build-and-size, invariants, e2e, imagens-ok
  > ```
  >
  > No fork da Promidia, o estado equivalente ainda precisa ser verificado e configurado:
  >
  > ```console
  > $ gh api repos/soupromidia/BB-Gestao/branches/main/protection \
  >     --jq '.required_status_checks.contexts|join(", ")'
  > ```
  >
  > Este parágrafo já disse as duas coisas erradas, em ordem: primeiro afirmou no presente
  > que o check era obrigatório quando não era, depois — corrigido — afirmou que "ainda não
  > está" e **continuou afirmando isso depois da ativação**, que aconteceu no mesmo dia. O
  > segundo erro é o mais instrutivo: o texto foi escrito *sabendo* que a ativação era o
  > passo seguinte, e ninguém volta para trocar um "ainda não" por um "já". **Nota de
  > pendência é dívida com data de vencimento e sem cobrador.** Quem ler qualquer uma das
  > duas versões mede contra a régua errada — reconfira na fonte, com o comando acima.
  >
  > O roteiro da ativação, com as verificações de cada passo, está em
  > [`../runbooks/ativar-packaging.md`](../runbooks/ativar-packaging.md).

  O gate importa porque já falhou: em 2026-08-12 um bump de `next` passou pelos quatro
  obrigatórios e quebrou o build da imagem na `main`, porque o `next build` dentro do
  Dockerfile não enxerga `tests/` (`.dockerignore`) e o next 16.3 passou a typechecar os
  `*.test.ts` colocados. **O artefato que o self-hoster instala era o único sem gate.**

### 3. Instalação de cliente nunca aponta para tag móvel

A Promidia publica `sha-<SHA completo>` na `main` e promove esse mesmo artefato para SemVer e
`stable` no corte da release. A autenticação read-only da VPS ainda será configurada em etapa
posterior. Portanto, nenhuma instalação deve consumir os packages privados até essa etapa.

Os caminhos legados de `install.sh`, `update.sh` e dos templates ainda contêm a política do
upstream para tags numéricas, `stable` e fallback em `latest`. Eles permanecem por decisão de
escopo até a Etapa 5; não descrevem tags produzidas pelo workflow atual.

No fluxo de produção, a instalação gravará no `.env` uma tag SemVer imutável promovida do SHA
já validado, nunca um canal móvel.

<details>
<summary>Histórico do upstream que motivou o invariante</summary>

Duas exceções, ambas deliberadas e ambas com aviso na tela — porque falhar fechado aqui
seria recusar instalar por não conseguir resolver um número:

1. **Sem rede ou sem tag no remoto**, cai em `latest` e avisa. Trocar previsibilidade por
   disponibilidade é o negócio errado numa instalação que já começou.
2. **Quem preenche o `.env` à mão** a partir do template recebe `stable` — o piso seguro
   para quem não vai rodar a entrevista. `--yes` com o template preserva esse valor.

O que **nenhum** caminho faz é pinar numa versão sem antes conferir que as três imagens
existem lá: a tag do git nasce minutos antes das imagens, e `deskcomm-worker:1.2.1` nunca
vai existir porque a v1.2.1 é anterior à criação desse pacote.

- **Por quê:** três consequências de uma só causa. **(a)** A versão do cliente para de mudar
  por acidente — um `up -d` rodado à mão semanas depois não troca o app sob o banco. **(b)**
  Atualizar vira **ato deliberado e reversível**: voltar é reescrever uma linha do `.env`.
  **(c)** O suporte passa a ter resposta exata para "qual versão você está rodando?" — hoje,
  duas instalações "no latest" feitas em meses diferentes rodam código diferente, e a issue
  #184 chegou descrevendo o ambiente como *"latest do dia 06/08/2026"*, que é a admissão de
  que a versão não era nomeável.
- **A armadilha específica deste projeto:** `latest` aqui **não** significa "última release" —
  significa **topo da `main`**. Uma instalação fresca em `:latest` recebe código não-lançado.
  Isso inverte a expectativa que o nome cria, e é a razão de o canal `stable` existir
  (§Política de canais).

  A regra `enable={{is_default_branch}}` do `metadata-action`, sozinha, **não** entregava isso:
  ela era verdadeira também num push de tag, então toda release movia `latest` junto e o canal
  oscilava entre os dois significados. O workflow do upstream prendia `latest` a
  `ref_type == 'branch'`.
- **Verificação:** duas, porque são dois caminhos distintos e o primeiro passou verde por
  meses sem nenhum. `hostgator-setup-kit/test-validators.sh` roda o `install.sh` de verdade
  contra um remoto local com tags conhecidas e cobra o `.env` pinado na maior delas (a ordem
  alfabética escolheria `v1.9.0` sobre `v1.10.0` — erro que só apareceria na décima release).
  `tests/shell/update-guard.test.sh` prova que o `update.sh` grava as **três** imagens na
  mesma versão, no `.env`, sem duplicar chave.

</details>

### 4. Tag de versão é imutável; canal é móvel

`sha-<SHA completo>` identifica o commit e nunca é reapontada. Cada membro da
matriz consulta sua própria referência antes do build. Se ela não existe, publica uma vez; se
existe com os labels OCI e a plataforma esperados, reutiliza sem build nem push. Referência
existente incompatível, ou falha que não prove ausência, encerra aquele membro sem publicar.
Isso permite recuperar publicação parcial em `Re-run failed jobs` e `Re-run all jobs`.

As tags Git e de imagem `vX.Y.Z` apontam para esse mesmo artefato **para sempre**, por promoção
sem rebuild. Se a SemVer já existe com o digest esperado, a execução a reutiliza; se diverge,
falha antes de sobrescrever. `stable` é o único canal móvel previsto e só avança depois que o
trio SemVer foi validado. `latest`, `main`, `vX.Y` e aliases `X.Y.Z` sem `v` não fazem parte da
política do fork.

O GHCR não oferece uma transação atômica entre três packages. A garantia real é processual:
uma promoção por vez, preflight integral antes de qualquer SemVer, verificação integral antes
de `stable`, captura dos três refs anteriores, verificação posterior e rollback compensatório
quando os refs anteriores existiam. Mesmo com rollback bem-sucedido, o run falha.

- **Por quê:** a imutabilidade da tag é o que torna a pinagem do invariante 3 uma garantia em
  vez de uma esperança. Se `1.2.1` puder ser reescrita, todo cliente "pinado" continua exposto
  — só que agora com uma falsa sensação de controle, que é pior que nenhum controle.
- **Verificação atual:** `build-and-push` valida/reutiliza cada imagem antes de decidir
  construir; `validar-trio-sha` confere no GHCR que app, worker e scheduler têm a mesma
  `revision`, `version`, origem, identidade e plataforma; `imagens-ok` só aprova quando
  matriz, smoke e validação remota terminam com sucesso. O workflow disponibiliza esse check;
  torná-lo obrigatório no fork depende da branch protection externa e ainda precisa ser
  verificado/configurado.

### 5. `pull_policy` acompanha a mutabilidade da tag

Tag imutável → `missing`. Tag móvel → `always`.

- **Por quê:** medido, não deduzido. Com `pull_policy: always` e o registry indisponível
  **para aquela referência**, o `docker compose up -d` **falha e o contêiner não sobe** —
  mesmo com a imagem já presente no disco:

  ```console
  $ docker compose up -d      # pull_policy: always, imagem só local
   t Error failed to resolve reference "…:1.0.0": not found
  --> container rodando?           (vazio)

  $ docker compose up -d      # pull_policy: missing, mesma imagem
   Container polmissing-t-1  Started
  --> container rodando? running
  ```

  Com tag móvel, `always` é o que faz o canal significar alguma coisa. Com tag imutável, ele
  não protege de nada — só amarra a disponibilidade do CRM de um cliente pago à
  disponibilidade do GHCR, em todo `up -d`. O `update.sh` não depende disso: ele puxa
  explicitamente com `dc pull` antes de subir.
- **Verificação:** `tests/shell/update-guard.test.sh` prova que instalação pinada grava
  `APP_PULL_POLICY=missing`.

### 6. Bump de versão não exige edição manual de `.env`

Uma versão nova sobe sobre o `.env` que o cliente já tem. Variável nova nasce **opcional, com
default que preserva o comportamento anterior**; se ela precisa existir, quem a acrescenta é o
`update.sh`, não o usuário.

- **Por quê:** o operador da VPS é leigo por premissa do produto. "Edite o `.env` antes de
  atualizar" é uma instrução que metade do parque não executa e a outra metade executa errado
  — e o modo de falha é o app não subir depois de uma atualização que já mexeu no banco.
- **Anti-exemplo estrutural:** o compose de produção tem 7 variáveis sem fallback
  (`WAHA_API_KEY_SHA512`, `WAHA_WEBHOOK_BASE_URL`, `WAHA_HMAC_SECRET`, `SRH_TOKEN`,
  `INTERNAL_SECRET`, `DOMAIN`, `ACME_EMAIL`). Medido: o Compose **não** falha quando elas
  faltam — substitui por string vazia, avisa em `stderr` e sobe. `DOMAIN: ""` e
  `WAHA_API_KEY: "sha512:"` quebram em runtime, depois do `up -d`, silenciosamente. Falhar
  tarde e mudo é pior que falhar cedo.
- **Verificação:** toda variável nova entra em `.env.example` **e** em `lib/env.ts` com
  default seguro (já cobrado no DoD); mudança que exija chave nova no `.env` de instalação
  existente só entra com o `update.sh` sabendo acrescentá-la.

### 7. A versão que roda é observável de fora

`GET /api/v1/health` responde a identidade real do artefato em execução.

Na cadeia Promidia, `APP_VERSION` é gravada no build imutável como `sha-<commit completo>`.
Promover esse manifest para `vX.Y.Z` não altera bytes nem variáveis internas; portanto o health
continua respondendo o SHA de procedência, e não finge que houve um rebuild SemVer. Associar
essa resposta à release é feito pelos digests registrados no run de promoção.

- **Por quê:** é o fecho do laço dos invariantes 2 e 3. Procedência sem observabilidade só
  serve a quem tem acesso ao registry; o suporte precisa da resposta a partir da instalação.
- **Anti-exemplo real:** o campo já existia e **mentia**. `app/api/v1/health/route.ts` lia
  `process.env.npm_package_version ?? "0.1.0"`, e sob `CMD ["node","server.js"]` essa variável
  é `undefined` — ela só existe quando o processo nasce de um `npm`/`pnpm run`. Toda
  instalação do mundo reportava `0.1.0`. Um campo que responde com confiança o valor errado é
  pior que um campo ausente: ele desliga a pergunta.
- **Verificação:** `tests/unit/packaging-artefato-do-cliente.test.ts` prova que a versão vem
  de `APP_VERSION` (injetada no build via `ARG`) e reprova o retorno ao `npm_package_version`.
  Medido no app real: com `APP_VERSION=9.9.9-teste` o endpoint responde `9.9.9-teste`; sem ela,
  `desconhecido` — nunca um número plausível.

### 8. Uma instalação, um dono — o projeto Docker não se compartilha

Só a árvore que criou os contêineres pode atualizá-los. Uma segunda cópia do repo na
mesma VPS **recusa** mexer, e diz por quê.

- **Por quê:** `docker compose` deriva o nome do projeto do *basename* do diretório.
  `/root/DeskcommCRM` e `/root/apagar6/DeskcommCRM` viram ambos `deskcommcrm` — um
  conjunto só de contêineres, dois `.env` diferentes. Cada `up -d` recria o parque com as
  credenciais da sua árvore, e a outra passa a falar com serviços que não a reconhecem.
- **Anti-exemplo real (medido, 2026-08):** o cron rodava o `agent.sh` das duas árvores a
  cada 5 minutos. Em 21/08 13:30 a cópia de teste recriou o contêiner do WAHA com a chave
  dela; às 14:47 o app foi recriado da árvore de produção, com outra. Resultado: **três
  dias** com `waha_create_401` em toda chamada — nenhum número de WhatsApp conectava — e as
  sessões caindo a cada recriação. O mesmo aconteceu com o `srh`, que ficou com o token da
  árvore errada e derrubou o rate limit (`GET /api/v1/health` → `redis: down, http_401`).
- **Por que o `flock` não bastava:** ele tranca por **diretório** (`$PROJECT_DIR/.update.lock`),
  e as duas árvores pegam locks diferentes enquanto disputam os mesmos contêineres. A trava
  tem de ser pelo que elas de fato compartilham — o projeto Docker.
- **Como se detecta:** o label `com.docker.compose.project.working_dir`, que todo contêiner
  do compose carrega, nomeia a árvore que o criou.

  ```bash
  docker ps -a --filter "label=com.docker.compose.project=$(basename "$PWD" | tr 'A-Z' 'a-z')" \
    --format '{{.Names}} => {{.Label "com.docker.compose.project.working_dir"}}'
  ```

- **Escape:** `DESKCOMM_ASSUMIR_PROJETO=1` assume o parque de propósito. Existe para a
  instalação que **mudou de pasta** de verdade; é explícito porque assumir por engano é o
  defeito que o guarda existe para impedir. Uma árvore alheia que já **não está no disco**
  não conta como rival — senão o guarda nasceria vermelho em quem só moveu a instalação.
- **Anti-exemplo real nº 2 — a INSTALAÇÃO, não a atualização (medido, 2026-08-24):** o
  invariante valia para quem *atualiza* e não valia para quem *instala*. `agent.sh` e
  `update.sh` chamavam o guarda; o `install.sh` não — ele é standalone de propósito (roda
  antes do clone) e tinha a própria varredura de portas, que perguntava só pelo **nome do
  projeto**. Como o nome colide justamente entre cópias irmãs, o instalador de uma aula em
  `/root/apagar7/DeskcommCRM` concluiu "é a re-execução" ao ver o Caddy de
  `/root/DeskcommCRM`, subiu por cima e trocou o banco da produção. O sintoma que chegou
  primeiro foi "minha senha parou de funcionar" — no outro banco a conta é outra —, o que
  manda a investigação para o lado errado por horas. **Nome de projeto igual não é
  identidade: só a árvore é.**
- **Verificação:** `tests/shell/dono-do-projeto.test.sh` (no `pnpm test:shell`) — cobre
  parque limpo, parque próprio, parque alheio, parque **misto** (o caso medido), pasta
  movida, o escape, e os **três** call sites — `agent.sh`, `update.sh` e `install.sh`.

  No `install.sh` são DOIS mecanismos, e a distinção importa porque um deles tem alcance
  parcial:

  1. **`recusar_projeto_de_outra_arvore`, logo depois de `PROJECT_DIR`** — vale SEMPRE,
     porque pergunta pelos CONTÊINERES do projeto, não pelo proxy. É o que fecha a classe.
  2. **O painel de cópia irmã em `decide_proxy`** — diagnóstico melhor (nomeia as duas
     pastas e ensina o `update.sh`), mas só é alcançado quando o irmão é o DONO das portas
     80/443 **e** `REVERSE_PROXY` está vazio no `.env`.

  Medido com o harness de VPS falsa, três entradas em que só o mecanismo 1 pega: VPS com
  Traefik de painel (Coolify/Hostinger), onde `decide_proxy` sai por `traefik` antes de
  comparar árvore; pasta que já concluiu uma instalação, porque o próprio `install.sh`
  grava `REVERSE_PROXY` no `.env` (:1413) e na rodada seguinte o `if [ -z … ]` é falso — o
  instalador desligava o próprio guarda; e portas 80/443 livres, em que a decisão é
  `caddy` na primeira linha. Nas três, `docker compose … up -d` subia sobre o parque da
  produção com o `.env` da pasta nova.

  Cobertura: `tests/shell/dono-do-projeto.test.sh` prende os três call sites e a ORDEM no
  `install.sh` (o guarda antes da coleta de config — recusar depois de arrancar sete
  respostas é fazer a pessoa trabalhar para ouvir "não"). Sabotando só a chamada do
  `install.sh`: 2 falhas, ambas previstas. A integração "instalar de uma CÓPIA IRMÃ" em
  `hostgator-setup-kit/test-validators.sh` roda o instalador inteiro contra um `docker`
  dublê — porque um teste só da regra fica verde enquanto o call site deixa de passar a
  árvore (medido: sabotando só a chamada, o caso de `decide_proxy` segue ✓ e apenas a
  integração reprova).

  **O escape é variável de AMBIENTE, não linha no `.env`** — `DESKCOMM_ASSUMIR_PROJETO=1
  bash install.sh`. No `install.sh` o guarda roda antes de o `.env` ser carregado, então
  escrevê-lo no arquivo não desliga nada (medido: bloqueia igual). É a mesma via dos
  outros dois call sites.

---

## Política de canais

| Tag | Estado no fork | Move? | O que significa |
|---|---|---|---|
| `sha-<SHA completo>` | ativa | **não** | artefato validado de um commit da `main`, promovível sem rebuild |
| `vX.Y.Z` | ativa na Etapa 4 | **não** | release SemVer apontando para o mesmo digest do SHA validado |
| `stable` | ativo na Etapa 4 | sim, por processo coordenado | trio da release validada selecionada |
| `latest` | **não publicado** | — | proibido pela decisão do ADR-0002 |
| `main` | **não publicado** | — | não é canal de imagem neste fork |

**A regra de ouro:** *instalação que alguém pagou aponta para número de versão. Ponto.*

Ela existe porque o modelo de receita é a venda da VPS com o sistema instalado — quem instala
para um cliente responde pelo que roda lá. Um canal móvel transfere a decisão de "quando
atualizar" para o acaso: um reboot, um `up -d` de manutenção, uma queda de energia. Nenhum
desses eventos é um momento em que alguém escolheu correr o risco de uma versão nova, e
nenhum deles avisa quando dá errado. Quem descobre é o cliente, por telefone.

O histórico do upstream usava `latest` para o topo da `main`; o fork não preserva esse canal.
Durante a transição, os scripts legados ainda não constituem autorização para uma VPS consumir
esses canais: falta implementar a autenticação read-only e fechar os fallbacks na Etapa 5.

---

## Retrocompatibilidade — o contrato com quem já instalou

Um bump de versão **pode** exigir do operador da VPS:

- rodar `update.sh` (ou clicar "Atualizar agora" na tela);
- que a VPS alcance o GHCR e o Supabase durante a atualização.

Um bump de versão **não pode** exigir:

- editar `.env`, compose ou qualquer arquivo à mão;
- reinstalar, recriar volume, ou recomeçar do zero;
- que o operador saiba o que é uma imagem, uma tag ou um registry;
- migração de namespace de imagem — o namespace está gravado no `.env` de todo cliente
  instalado; trocá-lo é breaking change e só cabe numa major, com o `update.sh` migrando
  sozinho e o namespace antigo publicando em paralelo durante a transição.

**Mudança que não couber nessas regras não entra: vira issue com plano de migração.**

---

## Checklist de release

Verificável e na ordem. Os packages são privados; `401`/`403` nunca provam ausência.

```text
[ ] 1. O commit da main tem `imagens-ok` verde e as três tags sha-<commit completo>.
[ ] 2. "Run workflow" em release.yml abriu o PR calculado; para o bootstrap, v0.1.0.
[ ] 3. O PR contém a seção do CHANGELOG e consome os fragmentos esperados.
[ ] 4. `imagens-ok` aprovou o SHA do merge; só então o App criou a tag Git vX.Y.Z.
[ ] 5. O run de tag de release.yml terminou verde no job promover-release.
[ ] 6. O log registra os três digests SHA, os mesmos três digests SemVer e stable.
[ ] 7. A GitHub Release vX.Y.Z existe; ela é consequência, não fonte das imagens.
[ ] 8. Antes de deploy, a VPS está autenticada read-only no GHCR e usa vX.Y.Z nos três serviços.
[ ] 9. O ensaio de atualização responde o sha-<commit> promovido em /api/v1/health.
```

O job de promoção é idempotente: SemVer correta é reutilizada; SemVer divergente falha sem
sobrescrever; `stable` já correto não é movido. Nenhum item autoriza tag manual, rebuild de
release, package público ou fallback para `latest`, upstream ou build local.

---

## Enforcement

| Camada | Artefato | Garante |
|---|---|---|
| CI (mecânico) | `imagens-ok` em `publish-image.yml` | no upstream, imagem quebrada reprovava o merge; no fork, o estado equivalente ainda precisa ser verificado e configurado: `gh api repos/soupromidia/BB-Gestao/branches/main/protection --jq '.required_status_checks.contexts'` |
| CI (mecânico) | `tests/unit/packaging-artefato-do-cliente.test.ts` | serviço `build:`-only, pin upstream solto, `pull_policy` trocado e versão que mente reprovam |
| CI (mecânico) | `tests/shell/update-guard.test.sh` | atualização que não pina as três imagens reprova |
| CI (mecânico) | `hostgator-setup-kit/test-validators.sh` | instalação que nasce em tag móvel reprova |
| Gate de sessão | item 15 do Definition of Done (`CLAUDE.md`) | nenhuma task de imagem/compose/kit fecha sem responder |
| Revisão | bloco de packaging em `CONTRIBUTING.md` | contribuidor externo sabe a régua antes do PR |
| Operação | `docs/runbooks/deploy.md` | o procedimento reflete a lei |

---

## Decisões registradas

**2026-08-13 — o namespace fica em `melgarafael` (decisão histórica do upstream, superada
para este fork pelo ADR-0002).** Uma consultoria externa recomendou criar
uma org `deskcommcrm` e migrar, sob a premissa de que o compose apontava para uma org
desvinculada do repo. A premissa era falsa: o compose sempre apontou para
`ghcr.io/melgarafael/deskcommcrm`, que é o que o CI publica e o que está gravado no `.env` de
todo cliente instalado. A string `deskcommcrm/deskcommcrm` existia num único lugar — uma URL
de `git clone` em `docs/deploy-selfhost/README.md`, que retornava 404. O conserto proporcional
ao defeito foi essa linha. Racional completo no ADR.

**2026-08-13 — a régua de RAM é de operação, não de build.** A mesma consultoria argumentou
que publicar a imagem derrubaria o requisito de 4 GB para 2 GB. Os 4 GB nunca foram custo de
build do app: a imagem é pré-buildada desde 2026-07-02. Eles saem de **operação** — 7
contêineres, `mem_limit` somando 2560m só entre app+worker+waha, e ~150 MB por número de
WhatsApp conectado.

> **Correção de 2026-08-14, e ela é sobre a nossa própria régua:** das três parcelas acima,
> duas são medidas (contêineres e `mem_limit`) e a terceira — os ~150 MB por número — é
> **herdada** de `docs/research/reference-synthesis.md` (síntese do curso WAHA), nunca medida
> neste projeto. Ela aparece em sete documentos que se citam entre si, o que a fazia parecer
> confirmada por repetição. O que **está** medido, na produção do projeto: o contêiner `waha`
> inteiro em **304,5 MiB com uma sessão pareada**, contra `mem_limit` de 1280 MiB. Isso não
> decompõe baseline e sessão, e não muda nada abaixo — a régua dos 4 GB é a soma da stack em
> operação, não o WAHA isolado. Detalhe em `docs/runbooks/deploy.md`.

Publicar o worker remove um `pnpm install` da VPS; **não muda o consumo de
quem opera**, e portanto não muda o tier recomendado. O ganho a comunicar é confiabilidade e
capacidade — a instalação deixa de poder falhar por memória no meio, e o agente de IA passa a
receber atualização —, nunca economia de plano.

**2026-08-13 — o limiar codificado continua em 3.500.000 KB.** `install.sh` avisa (amarelo,
não fatal) abaixo desse valor, e não em 4.000.000, porque `MemTotal` é o que sobra depois do
que o kernel reserva: uma VPS de 4 GiB reporta ~4.012.000 KB e uma de "4 GB" decimais reporta
~3.735.000 KB. Cortar em 4.000.000 acusaria justamente quem acabou de comprar o plano
recomendado, na pior hora possível. Coberto por `hostgator-setup-kit/test-validators.sh`.
