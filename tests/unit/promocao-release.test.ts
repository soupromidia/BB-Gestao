import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const workflow = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
const publish = readFileSync(join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const script = readFileSync(join(RAIZ, ".github/scripts/promover-release.sh"), "utf8");
const docs = [
  "docs/doctrine/packaging.md",
  "docs/doctrine/versionamento.md",
  "docs/runbooks/deploy.md",
  "docs/adr/0002-distribuicao-promidia.md",
]
  .map((f) => readFileSync(join(RAIZ, f), "utf8"))
  .join("\n");

const semComentarios = (texto: string) =>
  texto
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");

describe("release Promidia promove o artefato validado", () => {
  it("não contém qualquer mecanismo de rebuild", () => {
    const executavel = semComentarios(`${workflow}\n${script}`);
    expect(executavel).not.toMatch(/docker\/build-push-action|docker\s+build\b|buildx\s+build\b/);
    expect(executavel).toContain("docker buildx imagetools create --prefer-index=false");
  });

  it("faz preflight do trio inteiro antes da primeira promoção SemVer", () => {
    const preflight = script.indexOf("# FASE 1:");
    const semver = script.indexOf("# FASE 2:");
    const validaSemver = script.indexOf("# FASE 3:");
    const stable = script.indexOf("# FASE 5:");
    expect(preflight).toBeGreaterThan(-1);
    expect(semver).toBeGreaterThan(preflight);
    expect(validaSemver).toBeGreaterThan(semver);
    expect(stable).toBeGreaterThan(validaSemver);
    expect(script).toContain('[[ $(wc -l < "${PREFLIGHT_STATE}") -eq ${#IMAGES[@]} ]]');
  });

  it("não cria a tag Git antes de imagens-ok validar o mesmo commit", () => {
    const espera = workflow.indexOf("Aguardar imagens-ok do commit da release");
    const criaTag = workflow.indexOf("Criar e empurrar a tag");
    expect(espera).toBeGreaterThan(-1);
    expect(criaTag).toBeGreaterThan(espera);
    expect(workflow).toContain('select(.name == "imagens-ok")');
    expect(workflow).toContain("commits/${SHA}/check-runs");
  });

  it("falha fechado para SemVer divergente e reutiliza SemVer correta", () => {
    expect(script).toContain("SemVer imutável divergente");
    expect(script).toContain("semver_state=existing");
    expect(script).toContain("semver_state=missing");
    expect(script).toContain("reutilizada:");
  });

  it("usa vX.Y.Z como única representação SemVer no Git e no GHCR", () => {
    expect(script).toContain('[[ "${RELEASE_VERSION}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(script).toContain('target_ref="${IMAGE_NAMESPACE}/${image}:${RELEASE_VERSION}"');
    expect(script).not.toContain("sem o prefixo v");
    expect(workflow).toContain('release_version="${TAG}"');
    expect(workflow).toContain('echo "version=${release_version}" >> "${GITHUB_OUTPUT}"');
    expect(workflow).not.toContain('versao="${BASH_REMATCH[1]}"');
    expect(docs).not.toMatch(/(?:para|→)\s*`?X\.Y\.Z`?/);
  });

  it("valida SHA completo, metadados OCI e linux/amd64", () => {
    expect(script).toContain('[[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]]');
    for (const label of ["title", "source", "revision", "version", "vendor", "licenses"]) {
      expect(script).toContain(`org.opencontainers.image.${label}`);
    }
    expect(script).toContain("linux/amd64");
    expect(workflow).toContain("git merge-base --is-ancestor");
  });

  it("mantém o build SHA isolado: publish-image não reage a tags nem toca stable", () => {
    const gatilhos = semComentarios(publish.split(/^jobs:/m)[0] ?? "");
    const executavel = semComentarios(publish);
    expect(gatilhos).not.toContain("tags:");
    expect(executavel).not.toMatch(/\bstable\b/);
    expect(executavel).toContain("latest=false");
    expect(executavel).not.toMatch(/value=latest|latest=true|:latest\b/);
  });

  it("não usa latest, registry upstream, fallback local ou tenant hardcoded", () => {
    const executavel = semComentarios(`${workflow}\n${script}`);
    expect(executavel).not.toMatch(/value=latest|latest=true|:latest\b/);
    expect(executavel).not.toMatch(
      /ghcr\.io\/melgarafael|deskcommcrm|deskcomm-worker|deskcomm-scheduler/i,
    );
    expect(executavel).not.toMatch(/docker-compose\.build|docker compose build|BB Cursos/i);
  });

  it("a GitHub Release é o último ato e é idempotente", () => {
    const promove = workflow.indexOf("Promover e validar o trio sem rebuild");
    const githubRelease = workflow.indexOf("Publicar a GitHub Release depois do trio stable");
    expect(promove).toBeGreaterThan(-1);
    expect(githubRelease).toBeGreaterThan(promove);
    expect(workflow).toContain('gh release view "${TAG}"');
  });

  it("a documentação admite que stable não é transacional", () => {
    expect(docs).toMatch(/não (?:é|oferece)[^\n]*(?:atômic|transaç)/i);
  });
});
