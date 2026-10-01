import { describe, expect, it } from "vitest";

import {
  MARCADOR_HISTORICO_UPSTREAM,
  PRIMEIRA_VERSAO_PROMIDIA,
  proximaVersaoDaLinha,
  versaoAtualDaLinha,
} from "./linha";

const changelog = (promidia = "") =>
  [
    "# Changelog",
    "",
    "## [Não lançado]",
    "",
    promidia,
    MARCADOR_HISTORICO_UPSTREAM,
    "",
    "## [1.20.0] — 2026-09-12",
  ].join("\n");

describe("linha de versões da Promidia", () => {
  it("começa em 0.1.0 sem deixar o histórico upstream determinar o número", () => {
    expect(versaoAtualDaLinha(changelog())).toBeNull();
    expect(proximaVersaoDaLinha(changelog(), "major")).toBe(PRIMEIRA_VERSAO_PROMIDIA);
  });

  it("aplica a régua normal depois da primeira release", () => {
    const comRelease = changelog("## [0.1.0] — 2026-10-01\n");
    expect(versaoAtualDaLinha(comRelease)).toBe("0.1.0");
    expect(proximaVersaoDaLinha(comRelease, "patch")).toBe("0.1.1");
    expect(proximaVersaoDaLinha(comRelease, "minor")).toBe("0.2.0");
    expect(proximaVersaoDaLinha(comRelease, "major")).toBe("1.0.0");
  });

  it("falha fechado se o limite entre as duas linhas desaparecer", () => {
    expect(() => versaoAtualDaLinha("## [1.20.0]")).toThrow(/marcador/);
  });
});
