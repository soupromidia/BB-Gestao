# ADR-0002 — Distribuição do BB Gestão pela Promidia

- **Status:** aceito
- **Data:** 2026-09-23
- **Contexto medido em:** `9a292a26` (`main`)
- **Decisão de:** Promidia
- **Supera parcialmente:** [`ADR-0001`](0001-packaging-e-distribuicao.md), decisões D1 e D4,
  somente para a linha de distribuição deste fork

---

## Contexto

O BB Gestão é um fork white-label do DeskcommCRM mantido pela Promidia. O BB Cursos será a
primeira organização real, mas continua sendo um tenant: código, imagens, releases e
infraestrutura de distribuição não podem carregar configuração específica desse cliente.

O repositório já pertence à Promidia (`soupromidia/BB-Gestao`), porém a cadeia herdada ainda
contém referências operacionais ao repositório e às imagens do projeto original. Isso permite
que código da Promidia e artefatos do upstream sejam combinados numa instalação sem intenção
explícita do operador.

Este ADR congela a arquitetura-alvo da Sprint 0. Ele não implementa a migração: Dockerfiles,
Compose, workflows, instalador, atualizador e processo de release permanecem inalterados nesta
etapa.

## Decisões

### D1 — A Promidia é dona da cadeia de distribuição

A cadeia será:

```text
github.com/soupromidia/BB-Gestao
  → GitHub Actions
  → GitHub Container Registry
  → Docker Compose
  → VPS
```

Código-fonte, builds, imagens e releases serão publicados e mantidos pela Promidia. Nenhuma
instalação de produção do BB Gestão dependerá da infraestrutura de distribuição do
DeskcommCRM original.

### D2 — O GHCR usa três packages privados

As imagens serão:

```text
ghcr.io/soupromidia/bb-gestao-app
ghcr.io/soupromidia/bb-gestao-worker
ghcr.io/soupromidia/bb-gestao-scheduler
```

Os packages serão privados. O CI publicará com a identidade do repositório; a VPS deverá se
autenticar para leitura com credencial de menor privilégio. Credenciais do registry não serão
embutidas nas imagens nem repassadas aos containers da aplicação.

### D3 — App, worker e scheduler continuam separados

Os três processos têm runtimes e responsabilidades diferentes:

| Imagem | Responsabilidade |
|---|---|
| `bb-gestao-app` | servidor Next.js e atendimento HTTP |
| `bb-gestao-worker` | processamento assíncrono e runtime dos agentes |
| `bb-gestao-scheduler` | disparo dos crons pela rede interna |

Eles compartilham repositório e versão, mas não o artefato final. A Sprint 0 não fundirá os
processos numa imagem única.

### D4 — A primeira linha de versão da Promidia começa em `v0.1.0`

Tags Git usam o prefixo `v`; tags das imagens usam o número sem o prefixo. A primeira release
será, portanto, `v0.1.0` no Git e `0.1.0` no GHCR.

O histórico do upstream será preservado como proveniência, mas não determinará a numeração da
linha Promidia.

### D5 — Cada commit publicado da `main` tem artefato identificável por SHA

Builds aprovados da `main` serão publicados com a tag imutável:

```text
sha-<commit completo>
```

Uma release SemVer promove exatamente os manifests desse SHA já validado. O push da tag de
release não reconstrói as imagens.

### D6 — Tags SemVer e SHA são imutáveis; `stable` é coordenada

- `sha-<commit>` e `X.Y.Z` nunca são movidas nem republicadas;
- `stable` é móvel e representa a última release homologada;
- `stable` só avança depois que app, worker e scheduler da mesma versão foram validados;
- uma falha em qualquer integrante impede a promoção do trio;
- `latest` não é publicada nem consumida.

A imutabilidade será protegida pelo processo de release e por gates, já que o GHCR não a
garante automaticamente para essas tags.

### D7 — O alvo inicial é somente `linux/amd64`

A Sprint 0 publicará apenas para `linux/amd64`, arquitetura do ambiente de produção adotado.
Suporte a `arm64` exige decisão futura e validação de toda a cadeia, inclusive dependências
externas.

### D8 — Produção falha fechada quando o artefato Promidia não está disponível

Uma instalação de produção não pode, silenciosamente:

- baixar imagens do namespace do DeskcommCRM original;
- trocar uma versão Promidia por `stable`, `main` ou outro canal;
- construir app, worker ou scheduler localmente na VPS;
- subir versões diferentes dos três serviços.

Build local poderá existir apenas como procedimento avançado, explícito e separado do caminho
de produção. Ausência, falta de autenticação ou erro de pull do trio Promidia interrompem a
operação antes de qualquer atualização destrutiva.

### D9 — Produto e tenant permanecem separados

`BB Gestão` identifica o produto e sua distribuição. `BB Cursos` é a primeira organização do
sistema e não aparece hardcoded em Dockerfiles, imagens, workflows, Compose, instalador,
atualizador ou release. Configurações de cada empresa permanecem no nível do tenant, usando a
arquitetura multi-tenant existente.

## Alternativas recusadas

| Alternativa | Motivo da recusa |
|---|---|
| Packages públicos | a decisão comercial desta etapa é manter os artefatos privados |
| Continuar consumindo imagens do upstream | tira da Promidia o controle do código efetivamente executado |
| Usar `latest` | não identifica release nem garante reprodutibilidade |
| Reconstruir no push da tag SemVer | a release poderia diferir do artefato validado na `main` |
| Promover cada imagem separadamente | permite parque misto entre app, worker e scheduler |
| Build automático na VPS como fallback | cria artefato fora do CI e rompe a rastreabilidade |
| Imagem única com comandos diferentes | amplia imagem e superfície de ataque sem necessidade demonstrada |
| Publicar `arm64` agora | não há ambiente de produção nem cadeia completa validados nessa arquitetura |
| Hardcode do BB Cursos | transformaria um tenant em característica estrutural do produto |

## Consequências

**Ganhamos:** procedência controlada pela Promidia, releases reproduzíveis, rollback para trio
conhecido e eliminação de dependência silenciosa da distribuição upstream.

**Pagamos:** autenticação do GHCR em cada VPS, operação de três packages privados e necessidade
de bootstrap explícito da linha `v0.1.0`.

**Exigimos da implementação futura:** migração coordenada de namespace; autenticação de pull;
promoção sem rebuild; validação do trio; falha fechada; rollback conjunto; e gates que impeçam
referências operacionais ao upstream.

**Não muda:** multi-tenancy, branding por instalação/organização, schema, comportamento da
aplicação ou configuração do BB Cursos.
