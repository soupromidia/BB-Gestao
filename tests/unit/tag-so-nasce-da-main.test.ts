import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Na Etapa 3, somente um push da `main` pode publicar `sha-<commit>`, e a tag
 * imutável não pode ser reapontada. As guardas históricas de criação de tag
 * SemVer em `release.yml` permanecem documentadas aqui para a Etapa 4, mas não
 * disparam o workflow de imagens atual.
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
    expect(release).toContain("actions/create-github-app-token");
    expect(release).toContain("secrets.RELEASE_APP_ID");
    expect(release).toContain("secrets.RELEASE_APP_PRIVATE_KEY");
  });

  it("nenhum job do release pede escopo de escrita ao GITHUB_TOKEN", () => {
    const escritas = release
      .split("\n")
      .filter((l) => /^\s+(contents|pull-requests|packages):\s*write\s*$/.test(l));
    expect(escritas, "escrita pelo GITHUB_TOKEN: quem escreve aqui tem que ser o App").toEqual([]);
  });

  it("o corte da tag prova que as imagens saíram — a falha aqui é silenciosa por natureza", () => {
    const t = job(release, "cortar-tag");
    // A sonda prende o COMPORTAMENTO (consultar o manifesto no registro público),
    // não o nome da função — que já mudou uma vez, quando a conferência passou a
    // comparar digest em vez de código de status (issue #488).
    expect(t, "o corte não consulta mais o registro").toMatch(/ghcr\.io\/v2\//);
    for (const img of ["bb-gestao-app", "bb-gestao-worker", "bb-gestao-scheduler"]) {
      expect(t, `a conferência não cobre ${img}`).toContain(img);
    }
    expect(t).toMatch(/::error::/);
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
    // E a condição que a guarda antiga NÃO tinha: só o App da release corta.
    expect(t).toMatch(/deskcomm-release\[bot\]/);
  });

  it("a tag só é criada em push na main, nunca num dispatch de branch qualquer", () => {
    expect(job(release, "cortar-tag")).toMatch(/if:\s*github\.event_name == 'push'/);
    expect(release).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });
});
