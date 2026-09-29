import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/publish-image.yml"),
  "utf8",
);

const executavel = workflow
  .split("\n")
  .filter((linha) => !linha.trimStart().startsWith("#"))
  .join("\n");

function job(nome: string): string {
  const linhas = workflow.split("\n");
  const inicioDosJobs = linhas.findIndex((linha) => /^jobs:\s*$/.test(linha));
  const inicio = linhas.findIndex(
    (linha, indice) => indice > inicioDosJobs && linha === `  ${nome}:`,
  );
  if (inicio === -1) return "";
  const fim = linhas.findIndex(
    (linha, indice) => indice > inicio && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(linha),
  );
  return linhas.slice(inicio, fim === -1 ? undefined : fim).join("\n");
}

function step(corpoDoJob: string, nome: string): string {
  const linhas = corpoDoJob.split("\n");
  const inicio = linhas.findIndex((linha) => linha === `      - name: ${nome}`);
  if (inicio === -1) return "";
  const fim = linhas.findIndex(
    (linha, indice) => indice > inicio && /^ {6}- (?:name:|uses:)/.test(linha),
  );
  return linhas.slice(inicio, fim === -1 ? undefined : fim).join("\n");
}

const IMAGENS = ["bb-gestao-app", "bb-gestao-worker", "bb-gestao-scheduler"] as const;
const MATRIZ = job("build-and-push");
const VERIFICACAO = step(MATRIZ, "Verificar imagem SHA existente");
const BUILD = step(MATRIZ, "Build e push quando a imagem SHA nao existe");

type Estado = "ausente" | "valida" | "conflitante";

function plano(estados: Estado[]) {
  return {
    builds: estados.filter((estado) => estado === "ausente").length,
    reutilizadas: estados.filter((estado) => estado === "valida").length,
    falha: estados.includes("conflitante"),
  };
}

describe("Etapa 3 — publicação imutável e recuperável do trio por SHA", () => {
  it("publica somente no namespace da Promidia e usa o mesmo SHA completo no trio", () => {
    expect(executavel).toContain("IMAGE_NAMESPACE: ghcr.io/${{ github.repository_owner }}");
    expect(executavel).toContain("IMAGE_TAG: sha-${{ github.sha }}");
    expect(MATRIZ).toContain(
      "images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.name }}",
    );
    expect(MATRIZ).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    expect(MATRIZ).toContain("org.opencontainers.image.version=${{ env.IMAGE_TAG }}");
    for (const imagem of IMAGENS) {
      expect(MATRIZ, `a matriz não contém ${imagem}`).toContain(`name: ${imagem}`);
    }
    expect(executavel).not.toContain("ghcr.io/melgarafael");
    expect(executavel).not.toMatch(/\bdeskcomm(?:crm|-worker|-scheduler|-app)\b/i);
  });

  it("tem uma única superfície de build e nunca publica PR ou workflow_dispatch", () => {
    expect(executavel.match(/uses: docker\/build-push-action@v7/g)).toHaveLength(1);
    expect(BUILD).toContain(
      "push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    );
    expect(BUILD).toContain(
      "load: ${{ matrix.name == 'bb-gestao-app' && (github.event_name != 'push' || github.ref != 'refs/heads/main') }}",
    );
    expect(executavel).not.toMatch(/\bdocker push\b|buildx build/);
    expect(executavel).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(executavel.split(/^jobs:/m)[0]).not.toContain("tags:");
  });

  it("não publica latest, stable nem SemVer", () => {
    const linhasLatest = executavel
      .split("\n")
      .filter((linha) => /latest\s*=|value=latest|:latest\b/.test(linha));
    expect(linhasLatest).toEqual(["            latest=false"]);
    expect(executavel).not.toMatch(/\bstable\b/);
    expect(executavel).not.toMatch(/type=semver|pattern=\{\{version\}\}|pattern=\{\{major\}\}/);
    expect(executavel).not.toContain("imagetools create");
  });

  it("valida identidade e plataforma antes de marcar uma imagem existente como reutilizável", () => {
    expect(VERIFICACAO).toContain("docker pull --platform linux/amd64");
    for (const label of ["title", "source", "revision", "version", "vendor", "licenses"]) {
      expect(VERIFICACAO, `label OCI não validado: ${label}`).toContain(
        `org.opencontainers.image.${label}`,
      );
    }
    expect(VERIFICACAO).toContain("{{ .Os }}");
    expect(VERIFICACAO).toContain("{{ .Architecture }}");
    expect(VERIFICACAO).toContain('[ "${revisao}" = "${GITHUB_SHA}" ]');
    expect(VERIFICACAO).toContain('[ "${versao}" = "${IMAGE_TAG}" ]');
    expect(VERIFICACAO).toContain('[ "${sistema}" = "linux" ]');
    expect(VERIFICACAO).toContain('[ "${arquitetura}" = "amd64" ]');

    const ultimaValidacao = VERIFICACAO.lastIndexOf('[ "${arquitetura}" = "amd64" ]');
    const marcaReuso = VERIFICACAO.indexOf('echo "reutilizar=true"');
    expect(ultimaValidacao).toBeGreaterThan(-1);
    expect(marcaReuso).toBeGreaterThan(ultimaValidacao);
  });

  it("só a ausência inequívoca libera build; estado ilegível ou conflitante falha fechado", () => {
    expect(VERIFICACAO).toMatch(
      /manifest unknown\|manifest\[\^:\]\*not found\|not found: manifest\|name unknown/,
    );
    expect(VERIFICACAO).toContain('echo "reutilizar=false" >> "${GITHUB_OUTPUT}"');
    expect(VERIFICACAO).toContain("abortando sem publicar");
    expect(VERIFICACAO.trimEnd()).toMatch(/exit 1$/);
    expect(BUILD).toContain("if: steps.imagem-sha.outputs.reutilizar != 'true'");
  });

  it.each([
    {
      nome: "estado vazio",
      estados: ["ausente", "ausente", "ausente"] as Estado[],
      esperado: { builds: 3, reutilizadas: 0, falha: false },
    },
    {
      nome: "estado parcial",
      estados: ["valida", "valida", "ausente"] as Estado[],
      esperado: { builds: 1, reutilizadas: 2, falha: false },
    },
    {
      nome: "estado completo",
      estados: ["valida", "valida", "valida"] as Estado[],
      esperado: { builds: 0, reutilizadas: 3, falha: false },
    },
    {
      nome: "estado conflitante",
      estados: ["valida", "conflitante", "ausente"] as Estado[],
      esperado: { builds: 1, reutilizadas: 1, falha: true },
    },
    {
      nome: "rerun após push ambíguo",
      estados: ["valida", "valida", "valida"] as Estado[],
      esperado: { builds: 0, reutilizadas: 3, falha: false },
    },
  ])("modela $nome sem reconstruir referência válida", ({ estados, esperado }) => {
    expect(plano(estados)).toEqual(esperado);
  });

  it("reuso válido pula metadata, Buildx e build/push no mesmo membro da matriz", () => {
    for (const nome of [
      "Docker metadata (tag e labels OCI)",
      "Set up Buildx",
      "Build e push quando a imagem SHA nao existe",
    ]) {
      expect(step(MATRIZ, nome), `${nome} pode rodar sobre uma tag existente`).toContain(
        "if: steps.imagem-sha.outputs.reutilizar != 'true'",
      );
    }
  });

  it("o smoke usa exatamente o artefato da app sem segundo build", () => {
    const baixar = step(MATRIZ, "Baixar a imagem SHA do app para smoke");
    const smoke = step(MATRIZ, "O container do app chega a servir?");
    expect(baixar).toContain(
      "if: matrix.name == 'bb-gestao-app' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(baixar).toContain(
      'docker pull --platform linux/amd64 "${IMAGE_NAMESPACE}/bb-gestao-app:${IMAGE_TAG}"',
    );
    expect(smoke).toContain("if: matrix.name == 'bb-gestao-app'");
    expect(smoke).toContain('"${IMAGE_NAMESPACE}/bb-gestao-app:${IMAGE_TAG}"');
    expect(BUILD).toContain("load:");
  });

  it("a validação final e imagens-ok exigem o trio e o smoke da matriz", () => {
    const validacao = job("validar-trio-sha");
    for (const imagem of IMAGENS) expect(validacao).toContain(imagem);
    expect(validacao).toContain('[ "${revisao}" = "${GITHUB_SHA}" ]');
    expect(validacao).toContain('[ "${versao}" = "${IMAGE_TAG}" ]');
    expect(validacao).toContain('[ "${arquitetura}" = "amd64" ]');
    expect(validacao).toMatch(/needs:\s*\[build-and-push\]/);

    const fachada = job("imagens-ok");
    expect(fachada).toContain("needs: [build-and-push, validar-trio-sha]");
    for (const dependencia of ["build-and-push", "validar-trio-sha"]) {
      expect(fachada).toContain(`needs.${dependencia}.result`);
    }
  });
});
