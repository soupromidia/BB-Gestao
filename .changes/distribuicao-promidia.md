---
impacto: exige_acao
secao: alterado
titulo: A distribuição passa a usar os artefatos mantidos pela Promidia
---

Dockerfiles, Compose, instalador e automações de release agora apontam para o repositório e
para as três imagens próprias do BB Gestão no namespace `ghcr.io/soupromidia`.

## Requer atenção

Os packages do BB Gestão são privados. Não use estas referências em produção antes de a VPS
estar autenticada no GHCR e de a cadeia de publicação Promidia estar concluída.
