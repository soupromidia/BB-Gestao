#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION é obrigatório no formato canônico vX.Y.Z}"
: "${RELEASE_SHA:?RELEASE_SHA é obrigatório (SHA completo)}"
: "${IMAGE_NAMESPACE:?IMAGE_NAMESPACE é obrigatório}"
: "${IMAGE_SOURCE:?IMAGE_SOURCE é obrigatório}"

[[ "${RELEASE_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "::error::Versão inválida: ${RELEASE_VERSION}; esperado vX.Y.Z"
  exit 1
}
[[ "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "::error::SHA inválido: esperado o commit completo com 40 caracteres hexadecimais"
  exit 1
}

readonly SHA_TAG="sha-${RELEASE_SHA}"
readonly -a IMAGES=(bb-gestao-app bb-gestao-worker bb-gestao-scheduler)
STATE_DIR=$(mktemp -d)
readonly STATE_DIR
readonly PREFLIGHT_STATE="${STATE_DIR}/preflight.tsv"
readonly STABLE_STATE="${STATE_DIR}/stable.tsv"
trap 'rm -rf "${STATE_DIR}"' EXIT

title_for() {
  case "$1" in
    bb-gestao-app) printf '%s\n' 'BB Gestão app' ;;
    bb-gestao-worker) printf '%s\n' 'BB Gestão worker' ;;
    bb-gestao-scheduler) printf '%s\n' 'BB Gestão scheduler' ;;
    *) echo "::error::Imagem desconhecida: $1" >&2; return 1 ;;
  esac
}

is_absent_error() {
  grep -qiE 'manifest unknown|manifest[^:]*not found|not found: manifest|name unknown' <<<"$1"
}

# Retorna 0 e imprime o digest, 2 para ausência inequívoca e 1 para qualquer
# estado ilegível. Erro de rede/permissão jamais pode ser interpretado como
# autorização para criar ou sobrescrever uma tag.
resolve_digest() {
  local ref="$1" output status digest
  if output=$(docker buildx imagetools inspect "${ref}" --format '{{.Manifest.Digest}}' 2>&1); then
    status=0
  else
    status=$?
  fi

  if [[ ${status} -ne 0 ]]; then
    if is_absent_error "${output}"; then
      return 2
    fi
    echo "${output}" >&2
    echo "::error::Não foi possível ler ${ref}; falha fechada." >&2
    return 1
  fi

  digest=$(printf '%s\n' "${output}" | tr -d '\r' | tail -n 1)
  [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "::error::Digest inválido ao inspecionar ${ref}: ${digest}" >&2
    return 1
  }
  printf '%s\n' "${digest}"
}

validate_source_metadata() {
  local image="$1" digest="$2" expected_title ref
  local title source revision version vendor licenses os architecture
  expected_title=$(title_for "${image}")
  ref="${IMAGE_NAMESPACE}/${image}@${digest}"

  docker pull --platform linux/amd64 "${ref}" >/dev/null
  title=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.title" }}')
  source=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')
  revision=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
  version=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')
  vendor=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.vendor" }}')
  licenses=$(docker image inspect "${ref}" --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}')
  os=$(docker image inspect "${ref}" --format '{{ .Os }}')
  architecture=$(docker image inspect "${ref}" --format '{{ .Architecture }}')

  [[ "${title}" == "${expected_title}" ]] || { echo "::error::${image} tem title=${title}; esperado ${expected_title}"; return 1; }
  [[ "${source}" == "${IMAGE_SOURCE}" ]] || { echo "::error::${image} tem source=${source}; esperado ${IMAGE_SOURCE}"; return 1; }
  [[ "${revision}" == "${RELEASE_SHA}" ]] || { echo "::error::${image} tem revision=${revision}; esperado ${RELEASE_SHA}"; return 1; }
  [[ "${version}" == "${SHA_TAG}" ]] || { echo "::error::${image} tem version=${version}; esperado ${SHA_TAG}"; return 1; }
  [[ "${vendor}" == "Promidia" ]] || { echo "::error::${image} tem vendor=${vendor}; esperado Promidia"; return 1; }
  [[ "${licenses}" == "MIT" ]] || { echo "::error::${image} tem licenses=${licenses}; esperado MIT"; return 1; }
  [[ "${os}" == "linux" && "${architecture}" == "amd64" ]] || {
    echo "::error::${image} tem plataforma ${os}/${architecture}; esperado linux/amd64"
    return 1
  }
}

promote_ref() {
  local source_ref="$1" target_ref="$2"
  docker buildx imagetools create --prefer-index=false --tag "${target_ref}" "${source_ref}"
}

wait_for_digest() {
  local ref="$1" expected="$2" attempt actual status
  for attempt in $(seq 1 12); do
    if actual=$(resolve_digest "${ref}"); then
      if [[ "${actual}" == "${expected}" ]]; then
        printf '%s\n' "${actual}"
        return 0
      fi
    else
      status=$?
      [[ ${status} -eq 2 ]] || return 1
    fi
    sleep 5
  done
  echo "::error::${ref} não convergiu para ${expected}" >&2
  return 1
}

# FASE 1: preflight completo do trio. Nada é promovido antes de este arquivo
# conter as três fontes SHA válidas e o estado das três tags SemVer.
: > "${PREFLIGHT_STATE}"
for image in "${IMAGES[@]}"; do
  source_ref="${IMAGE_NAMESPACE}/${image}:${SHA_TAG}"
  target_ref="${IMAGE_NAMESPACE}/${image}:${RELEASE_VERSION}"

  if source_digest=$(resolve_digest "${source_ref}"); then
    :
  else
    status=$?
    if [[ ${status} -eq 2 ]]; then
      echo "::error::Artefato obrigatório ausente: ${source_ref}"
    fi
    exit 1
  fi
  validate_source_metadata "${image}" "${source_digest}"

  if semver_digest=$(resolve_digest "${target_ref}"); then
    [[ "${semver_digest}" == "${source_digest}" ]] || {
      echo "::error::SemVer imutável divergente: ${target_ref}=${semver_digest}, esperado ${source_digest}"
      exit 1
    }
    semver_state=existing
  else
    status=$?
    [[ ${status} -eq 2 ]] || exit 1
    semver_state=missing
  fi

  printf '%s\t%s\t%s\n' "${image}" "${source_digest}" "${semver_state}" >> "${PREFLIGHT_STATE}"
  echo "preflight: ${image} ${SHA_TAG}=${source_digest} SemVer=${semver_state}"
done
[[ $(wc -l < "${PREFLIGHT_STATE}") -eq ${#IMAGES[@]} ]] || {
  echo "::error::Preflight não produziu estado para o trio completo"
  exit 1
}

# FASE 2: promoção SemVer idempotente. Tags já corretas são reutilizadas;
# divergência já falhou no preflight e nunca é sobrescrita.
while IFS=$'\t' read -r image source_digest semver_state; do
  if [[ "${semver_state}" == missing ]]; then
    promote_ref \
      "${IMAGE_NAMESPACE}/${image}@${source_digest}" \
      "${IMAGE_NAMESPACE}/${image}:${RELEASE_VERSION}"
  else
    echo "reutilizada: ${IMAGE_NAMESPACE}/${image}:${RELEASE_VERSION}"
  fi
done < "${PREFLIGHT_STATE}"

# FASE 3: verificação integral do trio SemVer. `stable` ainda não foi tocada.
while IFS=$'\t' read -r image source_digest _; do
  wait_for_digest "${IMAGE_NAMESPACE}/${image}:${RELEASE_VERSION}" "${source_digest}" >/dev/null
  echo "SemVer validada: ${image}:${RELEASE_VERSION}=${source_digest}"
done < "${PREFLIGHT_STATE}"

# FASE 4: captura o estado anterior de stable antes de mover qualquer membro.
: > "${STABLE_STATE}"
stable_already_complete=true
while IFS=$'\t' read -r image source_digest _; do
  stable_ref="${IMAGE_NAMESPACE}/${image}:stable"
  if stable_digest=$(resolve_digest "${stable_ref}"); then
    prior="${stable_digest}"
  else
    status=$?
    [[ ${status} -eq 2 ]] || exit 1
    prior=absent
  fi
  [[ "${prior}" == "${source_digest}" ]] || stable_already_complete=false
  printf '%s\t%s\t%s\n' "${image}" "${source_digest}" "${prior}" >> "${STABLE_STATE}"
  echo "stable anterior: ${image}=${prior}"
done < "${PREFLIGHT_STATE}"

if [[ "${stable_already_complete}" == true ]]; then
  echo "stable já aponta para o trio ${RELEASE_VERSION}; nenhuma movimentação necessária"
  exit 0
fi

rollback_stable() {
  local rollback_failed=false image target_digest prior current status
  echo "::warning::Promoção de stable incompleta; iniciando rollback compensatório."
  while IFS=$'\t' read -r image target_digest prior; do
    if current=$(resolve_digest "${IMAGE_NAMESPACE}/${image}:stable"); then
      :
    else
      status=$?
      if [[ ${status} -eq 2 ]]; then current=absent; else rollback_failed=true; continue; fi
    fi

    if [[ "${prior}" == absent ]]; then
      if [[ "${current}" != absent ]]; then
        echo "::error::${image}:stable não existia antes e agora aponta para ${current}."
        echo "::error::O GHCR não oferece remoção atômica e apagar a version poderia remover também SHA/SemVer."
        echo "::error::Não faça deploy; reexecute esta mesma release para completar o trio."
        rollback_failed=true
      fi
      continue
    fi

    if [[ "${current}" != "${prior}" ]]; then
      if ! promote_ref "${IMAGE_NAMESPACE}/${image}@${prior}" "${IMAGE_NAMESPACE}/${image}:stable"; then
        rollback_failed=true
        continue
      fi
    fi
    wait_for_digest "${IMAGE_NAMESPACE}/${image}:stable" "${prior}" >/dev/null || rollback_failed=true
  done < "${STABLE_STATE}"

  [[ "${rollback_failed}" == false ]]
}

# FASE 5: stable é móvel, mas o GHCR não oferece transação entre packages.
# O processo serializa releases, valida antes/depois e compensa com rollback.
stable_failed=false
while IFS=$'\t' read -r image target_digest prior; do
  if current=$(resolve_digest "${IMAGE_NAMESPACE}/${image}:stable"); then
    :
  else
    status=$?
    if [[ ${status} -eq 2 ]]; then current=absent; else stable_failed=true; break; fi
  fi
  if [[ "${current}" != "${prior}" ]]; then
    echo "::error::${image}:stable mudou durante a promoção (${prior} -> ${current}); abortando."
    stable_failed=true
    break
  fi
  if [[ "${current}" == "${target_digest}" ]]; then
    echo "reutilizada: ${IMAGE_NAMESPACE}/${image}:stable"
    continue
  fi
  if ! promote_ref "${IMAGE_NAMESPACE}/${image}@${target_digest}" "${IMAGE_NAMESPACE}/${image}:stable"; then
    stable_failed=true
    break
  fi
done < "${STABLE_STATE}"

if [[ "${stable_failed}" == false ]]; then
  while IFS=$'\t' read -r image target_digest _; do
    if ! wait_for_digest "${IMAGE_NAMESPACE}/${image}:stable" "${target_digest}" >/dev/null; then
      stable_failed=true
      break
    fi
  done < "${STABLE_STATE}"
fi

if [[ "${stable_failed}" == true ]]; then
  rollback_stable || true
  echo "::error::A promoção de stable falhou. O workflow permanece vermelho mesmo após rollback."
  exit 1
fi

echo "release ${RELEASE_VERSION}: trio SemVer e stable validados sem rebuild"
