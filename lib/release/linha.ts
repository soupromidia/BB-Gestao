import { type Bump, proximaVersao } from "./fragmento";

/** Separa a linha Promidia do histórico preservado do projeto de origem. */
export const MARCADOR_HISTORICO_UPSTREAM =
  "<!-- LINHA PROMIDIA: o histórico do upstream começa abaixo e não define a próxima versão. -->";

export const PRIMEIRA_VERSAO_PROMIDIA = "0.1.0";

/**
 * A versão mais nova da linha Promidia, ou `null` antes da primeira release.
 * O histórico abaixo do marcador continua legível, mas nunca entra no cálculo.
 */
export function versaoAtualDaLinha(changelog: string): string | null {
  const limite = changelog.indexOf(MARCADOR_HISTORICO_UPSTREAM);
  if (limite === -1) {
    throw new Error(
      "CHANGELOG.md sem o marcador que separa a linha Promidia do histórico upstream",
    );
  }

  for (const linha of changelog.slice(0, limite).split("\n")) {
    const m = /^##\s+\[(\d+\.\d+\.\d+)\]/.exec(linha);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** A primeira release é congelada em 0.1.0; depois dela vale a régua normal. */
export function proximaVersaoDaLinha(changelog: string, bump: Bump): string {
  const atual = versaoAtualDaLinha(changelog);
  return atual ? proximaVersao(atual, bump) : PRIMEIRA_VERSAO_PROMIDIA;
}
