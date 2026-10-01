/**
 * Corta a release: lê os fragmentos de `.changes/`, calcula o número, monta a
 * seção do CHANGELOG e apaga os fragmentos consumidos.
 *
 * Ninguém digita o número. Essa é a propriedade que faz duas sessões de
 * trabalho paralelas não colidirem: enquanto a escolha era humana, ela dependia
 * de ler `git tag` e somar um — e duas sessões que leem a mesma lista no mesmo
 * dia chegam ao mesmo número.
 *
 * Casca fina de I/O: a decisão toda mora em `lib/release/`, que é typechecado
 * (`tsconfig.typecheck.json` exclui `scripts/**`, então lógica aqui chegaria
 * verde na `main` sem `tsc` nunca a ter olhado).
 *
 *   pnpm release:conferir     # não escreve; diz que número sairia
 *   pnpm release:cortar       # escreve o CHANGELOG e apaga os fragmentos
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { calcularBump, type Fragmento, parseFragmento } from "../lib/release/fragmento";
import { proximaVersaoDaLinha, versaoAtualDaLinha } from "../lib/release/linha";
import { aplicarNoChangelog, montarSecao } from "../lib/release/montar-secao";

const RAIZ = path.resolve(__dirname, "..");
const DIR_FRAGMENTOS = path.join(RAIZ, ".changes");
const CHANGELOG = path.join(RAIZ, "CHANGELOG.md");
const REPO = "soupromidia/BB-Gestao";

const versaoUrl = (anterior: string | null, atual: string) =>
  anterior
    ? `https://github.com/${REPO}/compare/v${anterior}...${atual === "HEAD" ? atual : `v${atual}`}`
    : `https://github.com/${REPO}/releases/tag/v${atual}`;

/** `.gitkeep` e qualquer não-`.md` ficam de fora; o diretório guarda só fragmento. */
export function arquivosDeFragmento(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function lerFragmentos(dir: string): Fragmento[] {
  const problemas: string[] = [];
  const lidos: Fragmento[] = [];
  for (const arquivo of arquivosDeFragmento(dir)) {
    try {
      lidos.push(parseFragmento(arquivo, fs.readFileSync(path.join(dir, arquivo), "utf8")));
    } catch (erro) {
      problemas.push(`  ${arquivo}: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }
  if (problemas.length > 0) {
    throw new Error(`fragmento(s) inválido(s):\n${problemas.join("\n")}`);
  }
  return lidos;
}

/** A tag exata serve só para distinguir PR cortado de release já publicada. */
function tagLocalExiste(versao: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/tags/v${versao}`], {
      cwd: RAIZ,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function hoje(): string {
  // Data local, não UTC: a seção é lida por quem opera no Brasil, e `toISOString`
  // vira o dia anterior a cada release cortada depois das 21h.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function main(argv: readonly string[]): number {
  const escrever = argv.includes("--escrever");
  const soAVersao = argv.includes("--versao-do-changelog");
  const conhecidos = new Set(["--escrever", "--versao-do-changelog"]);
  const desconhecido = argv.find((a) => !conhecidos.has(a));
  if (desconhecido) {
    process.stderr.write(`argumento desconhecido: ${desconhecido}\n`);
    return 2;
  }

  // O workflow de release usa isto para saber se o merge que acabou de entrar
  // na main trouxe uma versão nova. Imprime só o número, sem mais nada, para
  // caber num `$(...)`.
  if (soAVersao) {
    const atual = versaoAtualDaLinha(fs.readFileSync(CHANGELOG, "utf8"));
    // Antes do primeiro PR de release, ausência é estado esperado: o job que
    // observa pushes comuns da main precisa sair verde sem inventar uma tag.
    if (atual) process.stdout.write(`${atual}\n`);
    return 0;
  }

  const fragmentos = lerFragmentos(DIR_FRAGMENTOS);
  const changelog = fs.readFileSync(CHANGELOG, "utf8");
  const base = versaoAtualDaLinha(changelog);

  if (fragmentos.length === 0) {
    // Terceiro desfecho, e não uma recusa: depois de `--escrever` o estado
    // normal da branch de release é exatamente este — `.changes/` vazio e a
    // seção nova à frente da última tag, porque a tag só nasce no merge.
    if (base && !tagLocalExiste(base)) {
      process.stdout.write(`já cortado: ${base} aguarda a tag\n`);
      return 0;
    }
    process.stderr.write(
      "nenhum fragmento em `.changes/`: não há versão a cortar.\n" +
        "Todo PR que muda comportamento traz o seu — docs/doctrine/versionamento.md.\n",
    );
    return 1;
  }

  const bump = calcularBump(fragmentos.map((f) => f.impacto));
  const versao = proximaVersaoDaLinha(changelog, bump);
  const secao = montarSecao(fragmentos, versao, hoje());

  process.stdout.write(
    base
      ? `${base} + ${bump} = ${versao}  (${fragmentos.length} fragmento(s))\n`
      : `linha Promidia: primeira release = ${versao}  (${fragmentos.length} fragmento(s); impacto agregado: ${bump})\n`,
  );
  for (const f of fragmentos) {
    process.stdout.write(`  ${f.impacto.padEnd(16)} ${f.secao.padEnd(11)} ${f.titulo}\n`);
  }

  if (!escrever) {
    process.stdout.write("\n(conferência: nada foi escrito — use --escrever)\n");
    return 0;
  }

  fs.writeFileSync(CHANGELOG, aplicarNoChangelog(changelog, secao, base, versaoUrl));
  for (const f of fragmentos) fs.rmSync(path.join(DIR_FRAGMENTOS, f.arquivo));
  process.stdout.write(`\nCHANGELOG.md atualizado; ${fragmentos.length} fragmento(s) consumido(s).\n`);
  process.stdout.write("A tag NÃO é criada aqui — ela nasce no CI, do merge do PR de release.\n");
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (erro) {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exit(1);
  }
}
