import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O CANAL `stable` MOVE EM BLOCO, NUNCA POR IMAGEM.
 *
 * ## O que aconteceu
 *
 * Medido no registro público durante o corte da v1.12.0 (issue #488), com sonda
 * de DIGEST — a ingênua ("a tag `stable` existe?") devolve `200` nas três e não
 * prova nada, porque `stable` existe desde a 1.11.0:
 *
 *     deskcommcrm          1.12.0   404
 *     deskcommcrm          stable   sha256:0235d02b…   ← 1.11.0
 *     deskcomm-worker      stable   sha256:66c7bde4…   ← 1.12.0
 *     deskcomm-scheduler   stable   sha256:ac6b87cc…   ← 1.12.0
 *
 * Quem instalasse por `stable` naquela janela recebia **app 1.11.0 com worker e
 * scheduler 1.12.0**. Os três serviços saem do mesmo repositório e compartilham
 * código; rodar dois numa versão e o terceiro noutra é um estado que nenhum
 * teste cobre e que ninguém escolheu.
 *
 * A causa foi de FORMA, não de conteúdo: `type=raw,value=stable` vivia dentro do
 * job da matriz, então cada imagem movia o canal sozinha, sem saber se as irmãs
 * conseguiram. O job do app morreu em `Set up Buildx` — antes de compilar
 * qualquer coisa — enquanto worker e scheduler seguiram até o fim e moveram o
 * ponteiro.
 *
 * ## Por que `fail-fast: true` não seria o conserto
 *
 * É o conserto óbvio e ele chega tarde: quando o job do app falhou, as irmãs já
 * tinham publicado e já tinham movido `stable`. Abortá-las não desfaz o que já
 * foi publicado. O que separa os dois atos é publicar por NÚMERO sempre (cada
 * imagem, independente — ninguém instala por um número que o instalador não
 * escreveu) e mover o CANAL num job final, quando o conjunto está completo.
 *
 * ## Estado do fork na Etapa 3
 *
 * O histórico acima continua sendo a razão para nunca mover `stable` por imagem.
 * Nesta etapa o canal não existe no fluxo ativo: este arquivo prova que
 * `publish-image.yml` não o publica nem o promove. A conferência histórica de
 * digest em `release.yml` fica preservada para a implementação da Etapa 4.
 */
const RAIZ = process.cwd();
const publish = readFileSync(join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const release = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");

/**
 * O corpo de um job, do cabeçalho até o próximo job.
 *
 * Começa no bloco `jobs:` de propósito: `on:` tem `  push:` na mesma indentação
 * de um job, e um helper que varra o arquivo inteiro devolveria aquilo como se
 * fosse job.
 */
function job(yml: string, nome: string): string {
  const linhas = yml.split("\n");
  const iJobs = linhas.findIndex((l) => /^jobs:\s*$/.test(l));
  if (iJobs === -1) return "";
  const i = linhas.findIndex((l, n) => n > iJobs && l === `  ${nome}:`);
  if (i === -1) return "";
  const fim = linhas.findIndex((l, n) => n > i && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return linhas.slice(i, fim === -1 ? undefined : fim).join("\n");
}

/** O mesmo corpo, sem os comentários. */
function corpo(yml: string, nome: string): string {
  const t = job(yml, nome);
  expect(t, `o job \`${nome}\` sumiu de publish-image.yml/release.yml`).not.toBe("");
  return t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

const IMAGENS = ["bb-gestao-app", "bb-gestao-worker", "bb-gestao-scheduler"];

describe("o canal `stable` permanece fora da Etapa 3", () => {
  it("o instrumento está vivo: enxerga os jobs de publish-image.yml", () => {
    // Controle positivo. Sem ele, um helper que parou de casar devolve "" e as
    // asserções de ausência abaixo passam por vacuidade — vigiando nada.
    expect(job(publish, "build-and-push")).not.toBe("");
    expect(job(publish, "imagens-ok")).not.toBe("");
    expect(job(publish, "build-and-push")).toContain("matrix:");
  });

  it("nenhum trecho executável publica ou promove `stable`", () => {
    const executavel = publish
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(executavel).not.toMatch(/\bstable\b/);
    expect(job(publish, "promover-stable")).toBe("");
  });

  it("o gate do trio espera as três imagens E o boot do app", () => {
    const needs = /needs:\s*\[([^\]]*)\]/.exec(corpo(publish, "validar-trio-sha"))?.[1];
    expect(needs, "o gate do trio não declara `needs`").toBeDefined();
    expect(needs?.split(",").map((s) => s.trim())).toEqual(["build-and-push"]);
    expect(corpo(publish, "build-and-push")).toContain(
      "if: matrix.name == 'bb-gestao-app'",
    );
    expect(corpo(publish, "build-and-push")).toContain(
      "O container do app chega a servir?",
    );
  });

  it("as três imagens são validadas com a tag do mesmo commit", () => {
    const t = corpo(publish, "validar-trio-sha");
    for (const img of IMAGENS) expect(t, `a validação não cita ${img}`).toContain(img);
    expect(t).toContain('revisao=$(docker image inspect');
    expect(t).toContain('[ "${revisao}" = "${GITHUB_SHA}" ]');
  });
});

describe("o corte da release confere o CANAL, não só a existência da versão", () => {
  it("compara DIGEST — `stable` e a versão têm de ser o mesmo manifesto", () => {
    const t = corpo(release, "cortar-tag");
    expect(t, "a conferência não lê digest: `200` na tag `stable` é satisfeito desde a 1.11.0").toContain(
      "docker-content-digest",
    );
    expect(t, "a conferência não olha o canal `stable`").toContain("stable");
    for (const img of IMAGENS) expect(t, `a conferência não cobre ${img}`).toContain(img);
    expect(t).toMatch(/::error::/);
  });
});
