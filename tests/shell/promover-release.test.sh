#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROMOTE="${ROOT}/.github/scripts/promover-release.sh"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

FAKE_BIN="${TMP}/bin"
FAKE_STATE="${TMP}/state"
FAKE_LOG="${TMP}/create.log"
mkdir -p "${FAKE_BIN}" "${FAKE_STATE}"

cat > "${FAKE_BIN}/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

state_file() {
  local tail image tag
  tail=${1##*/}
  image=${tail%%[:@]*}
  tag=${tail##*:}
  printf '%s/%s--%s\n' "${FAKE_STATE}" "${image}" "${tag}"
}

if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  ref=$4
  if [[ "${ref}" == *@sha256:* ]]; then
    printf '%s\n' "${ref##*@}"
    exit 0
  fi
  file=$(state_file "${ref}")
  if [[ ! -f "${file}" ]]; then
    echo "manifest unknown" >&2
    exit 1
  fi
  cat "${file}"
  exit 0
fi

if [[ "$1 $2 $3" == "buildx imagetools create" ]]; then
  shift 3
  target=""
  source=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefer-index=false) shift ;;
      --tag) target=$2; shift 2 ;;
      *) source=$1; shift ;;
    esac
  done
  image=${target##*/}
  image=${image%%:*}
  tag=${target##*:}
  digest=${source##*@}
  if [[ "${tag}" == stable && "${image}" == "${FAIL_STABLE_IMAGE:-}" && ! -f "${FAKE_STATE}/failed-once" ]]; then
    touch "${FAKE_STATE}/failed-once"
    echo "falha simulada em ${image}:stable" >&2
    exit 1
  fi
  printf '%s\n' "${digest}" > "$(state_file "${target}")"
  printf '%s %s\n' "${target}" "${digest}" >> "${FAKE_LOG}"
  exit 0
fi

if [[ "$1 $2" == "pull --platform" ]]; then
  exit 0
fi

if [[ "$1 $2" == "image inspect" ]]; then
  ref=$3
  format=$5
  tail=${ref##*/}
  image=${tail%%[:@]*}
  case "${format}" in
    *image.title*)
      case "${image}" in
        bb-gestao-app) echo "BB Gestão app" ;;
        bb-gestao-worker) echo "BB Gestão worker" ;;
        bb-gestao-scheduler) echo "BB Gestão scheduler" ;;
      esac
      ;;
    *image.source*) echo "${IMAGE_SOURCE}" ;;
    *image.revision*) echo "${RELEASE_SHA}" ;;
    *image.version*) echo "sha-${RELEASE_SHA}" ;;
    *image.vendor*) echo "Promidia" ;;
    *image.licenses*) echo "MIT" ;;
    *'.Os'*) echo "linux" ;;
    *'.Architecture'*) echo "amd64" ;;
    *) echo "formato inesperado: ${format}" >&2; exit 1 ;;
  esac
  exit 0
fi

echo "docker simulado não reconheceu: $*" >&2
exit 1
FAKE_DOCKER
chmod +x "${FAKE_BIN}/docker"

readonly SHA="0123456789abcdef0123456789abcdef01234567"
readonly VERSION="v0.1.0"
NS=$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "${ROOT}/hostgator-setup-kit/_common.sh" | head -1)
readonly NS
[[ -n "${NS}" ]] || { echo "não consegui ler IMG_NS de _common.sh" >&2; exit 1; }
readonly SOURCE="https://github.com/soupromidia/BB-Gestao"
readonly APP_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
readonly WORKER_DIGEST="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
readonly SCHEDULER_DIGEST="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

file_for() {
  printf '%s/%s--%s\n' "${FAKE_STATE}" "$1" "$2"
}

write_ref() {
  printf '%s\n' "$3" > "$(file_for "$1" "$2")"
}

assert_ref() {
  local actual
  actual=$(cat "$(file_for "$1" "$2")" 2>/dev/null || true)
  [[ "${actual}" == "$3" ]] || {
    echo "esperado $1:$2=$3; obtido ${actual:-ausente}" >&2
    exit 1
  }
}

assert_absent() {
  [[ ! -e "$(file_for "$1" "$2")" ]] || {
    echo "esperado $1:$2 ausente" >&2
    exit 1
  }
}

reset_state() {
  rm -rf "${FAKE_STATE}"
  mkdir -p "${FAKE_STATE}"
  : > "${FAKE_LOG}"
  write_ref bb-gestao-app "sha-${SHA}" "${APP_DIGEST}"
  write_ref bb-gestao-worker "sha-${SHA}" "${WORKER_DIGEST}"
  write_ref bb-gestao-scheduler "sha-${SHA}" "${SCHEDULER_DIGEST}"
}

run_promotion() {
  local version="${1:-${VERSION}}"
  env \
    PATH="${FAKE_BIN}:${PATH}" \
    FAKE_STATE="${FAKE_STATE}" \
    FAKE_LOG="${FAKE_LOG}" \
    RELEASE_VERSION="${version}" \
    RELEASE_SHA="${SHA}" \
    IMAGE_NAMESPACE="${NS}" \
    IMAGE_SOURCE="${SOURCE}" \
    FAIL_STABLE_IMAGE="${FAIL_STABLE_IMAGE:-}" \
    bash "${PROMOTE}"
}

run_must_fail() {
  if run_promotion "${1:-}" > "${TMP}/failure.log" 2>&1; then
    echo "a promoção deveria ter falhado" >&2
    cat "${TMP}/failure.log" >&2
    exit 1
  fi
}

# A forma sem `v` é inválida e não pode criar alias nem iniciar promoção.
reset_state
run_must_fail "0.1.0"
[[ ! -s "${FAKE_LOG}" ]]

# Primeira promoção e rerun idempotente.
reset_state
run_promotion >/dev/null
for pair in \
  "bb-gestao-app ${APP_DIGEST}" \
  "bb-gestao-worker ${WORKER_DIGEST}" \
  "bb-gestao-scheduler ${SCHEDULER_DIGEST}"; do
  read -r image digest <<<"${pair}"
  assert_ref "${image}" "${VERSION}" "${digest}"
  assert_ref "${image}" stable "${digest}"
done
creates_before=$(wc -l < "${FAKE_LOG}")
run_promotion >/dev/null
creates_after=$(wc -l < "${FAKE_LOG}")
[[ "${creates_before}" -eq 6 && "${creates_after}" -eq "${creates_before}" ]]

# SemVer divergente falha no preflight e não inicia promoção parcial.
reset_state
write_ref bb-gestao-app "${VERSION}" "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
run_must_fail
[[ ! -s "${FAKE_LOG}" ]]
assert_absent bb-gestao-worker "${VERSION}"

# Fonte SHA ausente também falha antes de qualquer promoção.
reset_state
rm "$(file_for bb-gestao-scheduler "sha-${SHA}")"
run_must_fail
[[ ! -s "${FAKE_LOG}" ]]
assert_absent bb-gestao-app "${VERSION}"

# Com stable anterior, falha parcial restaura o trio antigo.
reset_state
old_app="sha256:1111111111111111111111111111111111111111111111111111111111111111"
old_worker="sha256:2222222222222222222222222222222222222222222222222222222222222222"
old_scheduler="sha256:3333333333333333333333333333333333333333333333333333333333333333"
write_ref bb-gestao-app stable "${old_app}"
write_ref bb-gestao-worker stable "${old_worker}"
write_ref bb-gestao-scheduler stable "${old_scheduler}"
FAIL_STABLE_IMAGE=bb-gestao-worker run_must_fail
assert_ref bb-gestao-app stable "${old_app}"
assert_ref bb-gestao-worker stable "${old_worker}"
assert_ref bb-gestao-scheduler stable "${old_scheduler}"

# Na primeira release não se apaga version para restaurar ausência: o run falha,
# preserva o estado parcial e a reexecução idempotente completa o trio.
reset_state
FAIL_STABLE_IMAGE=bb-gestao-worker run_must_fail
assert_ref bb-gestao-app stable "${APP_DIGEST}"
assert_absent bb-gestao-worker stable
assert_absent bb-gestao-scheduler stable
FAIL_STABLE_IMAGE="" run_promotion >/dev/null
assert_ref bb-gestao-app stable "${APP_DIGEST}"
assert_ref bb-gestao-worker stable "${WORKER_DIGEST}"
assert_ref bb-gestao-scheduler stable "${SCHEDULER_DIGEST}"

echo "promover-release: cenários de promoção, idempotência e rollback passaram"
