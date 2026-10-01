import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Somente um push da `main` publica `sha-<commit>`. A Etapa 4 mantém a criação
 * da tag Git pelo App e reage a essa tag em `release.yml`, sem transformar
 * `publish-image.yml` num segundo caminho de build.
 */
const RAIZ = process.cwd();
const publish = fs.readFileSync(path.join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const release = fs.readFileSync(path.join(RAIZ, ".github/workflows/release.yml"), "utf8");

/** As linhas de um job, até o próximo job na mesma indentação. */
function job(yml: string, nome: string): string {
  const linhas = yml.split("\n");
  const i = linhas.findIndex((l) => l === `  ${nome}:`);
  if (i === -1) return "";
  const fim = linhas.findIndex((l, n) => n > i && /^ {2}[a-z-]+:$/.test(l));
  return linhas.slice(i, fim === -1 ? undefined : fim).join("\n");
}

describe("a imagem sha nasce somente de um commit da main", () => {
  it("cada membro decide pelo próprio estado antes do único build", () => {
    const t = job(publish, "build-and-push");
    expect(t).toContain("id: imagem-sha");
    expect(t).toContain("docker pull --platform linux/amd64");
    expect(t).toContain("if: steps.imagem-sha.outputs.reutilizar != 'true'");
    expect(t).toContain('echo "reutilizar=true" >> "${GITHUB_OUTPUT}"');
    expect(t).toContain('echo "reutilizar=false" >> "${GITHUB_OUTPUT}"');
    expect(publish.match(/uses: docker\/build-push-action@v7/g)).toHaveLength(1);
  });

  it("o workflow publica somente push da main, nunca push de tag", () => {
    const gatilhos = publish.split(/^jobs:/m)[0] ?? "";
    const executavel = gatilhos
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(executavel).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(executavel).not.toContain("tags:");
  });
});

describe("a tag nasce no CI, e nunca do GITHUB_TOKEN", () => {
  it("o release usa o token do GitHub App para escrever", () => {
    // Evento disparado com o GITHUB_TOKEN não cria novo workflow run (doc do
    // GitHub). Se a tag nascesse dele, `publish-image.yml` nunca rodaria: a tag
    // existiria, nenhum erro apareceria, e NENHUMA VPS receberia a atualização.
    expect(release.match(/actions\/create-github-app-token@v3/g)).toHaveLength(2);
    expect(release.match(/client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/g)).toHaveLength(2);
    expect(release.match(/private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/g)).toHaveLength(2);
    expect(release.match(/permission-contents: write/g)).toHaveLength(2);
    expect(release.match(/gh api "\/users\/\$\{APP_SLUG\}\[bot\]" --jq \.id/g)).toHaveLength(2);
    expect(release).not.toContain("RELEASE_APP_ID");
    expect(release).not.toMatch(/\bapp-id:/);
  });

  it("o job que cria a tag não recebe escrita do GITHUB_TOKEN", () => {
    const t = job(release, "cortar-tag");
    const permissoesDoGithubToken = t.split(/^    steps:/m)[0] ?? "";
    expect(permissoesDoGithubToken).not.toContain("contents: write");
    expect(permissoesDoGithubToken).not.toContain("packages: write");
    expect(t).toContain("steps.token.outputs.token");
    expect(t).toContain("persist-credentials: false");
    expect(t).not.toContain("secrets.GITHUB_TOKEN");
  });

  it("push comum é detectado antes de autenticar o App", () => {
    const t = job(release, "cortar-tag");
    const deteccao = t.indexOf("Este push foi um corte de release?");
    const autentica = t.indexOf("Autenticar o App da Promidia para o corte");
    expect(deteccao).toBeGreaterThan(-1);
    expect(autentica).toBeGreaterThan(deteccao);
    expect(t.slice(0, autentica)).not.toMatch(/RELEASE_APP_CLIENT_ID|RELEASE_APP_PRIVATE_KEY/);
    expect(t.slice(autentica)).toMatch(
      /Autenticar o App da Promidia para o corte[\s\S]*?if: steps\.pendente\.outputs\.cortar == 'sim'[\s\S]*?uses: actions\/create-github-app-token@v3/,
    );
  });

  it("a promoção usa o GITHUB_TOKEN apenas nos escopos que realmente escreve", () => {
    const t = job(release, "promover-release");
    expect(t).toContain("contents: write");
    expect(t).toContain("packages: write");
    expect(t).toContain("secrets.GITHUB_TOKEN");
    expect(t).not.toMatch(/PAT|password:\s*\$\{\{\s*secrets\.(?!GITHUB_TOKEN)/);
  });

  it("a tag exige que o push tenha CONSUMIDO fragmentos, não só que haja versão nova no CHANGELOG", () => {
    // Só a condição "o CHANGELOG anuncia versão sem tag" deixaria QUALQUER PR
    // cortar a release: bastaria escrever `## [1.7.0]` à mão e a tag nasceria
    // no merge dele, levando junto as três imagens e o canal `stable`.
    // Medido em 2026-08-27: o PR #354 já trazia uma seção de versão escrita à
    // mão. A segunda condição é a assinatura do corte: o commit REMOVEU
    // fragmento — PR comum ACRESCENTA e nunca apaga.
    const t = job(release, "cortar-tag");
    // ⚠️ A assinatura MUDOU na migration desta guarda (issue #472): era "o
    // diretório ficou vazio" (`antes>0 && depois==0`) e virou "este commit
    // REMOVEU fragmento". A regra antiga recusava todo corte que corresse em
    // paralelo com um merge comum — e merge comum é o estado normal de um repo
    // vivo. Foi assim que a v1.11.1 nunca virou tag.
    expect(t).toMatch(/git diff[^\n]*--diff-filter=D[^\n]*\.changes\//);
    // O ramo que RECUSA precisa existir: zero removidos não é corte.
    expect(t).toMatch(/removidos[^\n]*-eq 0/);
    // E a condição que a guarda antiga NÃO tinha: só a identidade derivada do
    // App autenticado pode concluir o corte.
    expect(t).toContain('bot_name="${APP_SLUG}[bot]"');
    expect(t).toContain('assinante}" != "${BOT_NAME}');
    expect(t).not.toContain("deskcomm-release");
    expect(t).toContain("a linha Promidia não ganhou uma seção de release");
  });

  it("o push da tag usa o checkout autenticado pelo App", () => {
    const t = job(release, "cortar-tag");
    const autentica = t.indexOf("Autenticar o App da Promidia para o corte");
    const identidade = t.indexOf("Resolver identidade Git do App", autentica);
    const checkoutDoApp = t.indexOf("Preparar checkout para escrita pelo App");
    const valida = t.indexOf("Validar identidade do corte");
    const criaTag = t.indexOf("Criar e empurrar a tag");
    expect(identidade).toBeGreaterThan(autentica);
    expect(checkoutDoApp).toBeGreaterThan(identidade);
    expect(valida).toBeGreaterThan(checkoutDoApp);
    expect(criaTag).toBeGreaterThan(valida);
    expect(t.slice(checkoutDoApp, valida)).toContain("token: ${{ steps.token.outputs.token }}");
    expect(t.slice(criaTag)).not.toMatch(/github\.token|GITHUB_TOKEN/);
    expect(t.slice(criaTag)).toContain('git config user.name  "${BOT_NAME}"');
    expect(t.slice(criaTag)).toContain('git config user.email "${BOT_EMAIL}"');
  });

  it("usa o formato canônico de nome e e-mail do bot do App", () => {
    expect(release.match(/bot_name="\$\{APP_SLUG\}\[bot\]"/g)).toHaveLength(2);
    expect(release.match(/email=\$\{bot_user_id\}\+\$\{bot_name\}@users\.noreply\.github\.com/g)).toHaveLength(2);
    expect(release.match(/git config user\.name\s+"\$\{BOT_NAME\}"/g)).toHaveLength(2);
    expect(release.match(/git config user\.email "\$\{BOT_EMAIL\}"/g)).toHaveLength(2);
  });

  it("a tag só é criada em push na main, nunca num dispatch de branch qualquer", () => {
    expect(job(release, "cortar-tag")).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(release).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("a promoção nasce do push de vX.Y.Z, não de dispatch ou release publicada", () => {
    expect(release).toMatch(/tags:\s*\["v\*"\]/);
    expect(job(release, "promover-release")).toContain(
      "if: github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref_name, 'v')",
    );
  });
});
