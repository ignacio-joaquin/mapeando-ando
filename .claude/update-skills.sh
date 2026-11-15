#!/usr/bin/env bash
# Actualiza las skills externas (Gentleman-Skills) copiadas en .claude/skills/.
# Las skills propias del proyecto (mapeando-*, linear-task) no se tocan.
#
# Uso: bash .claude/update-skills.sh   y después revisar el diff y mandarlo por PR.
set -euo pipefail

REPO=https://github.com/Gentleman-Programming/Gentleman-Skills.git
SKILLS=(react-19 typescript tailwind-4 zod-4 zustand-5 pytest playwright github-pr skill-creator)

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Clonando $REPO ..."
git clone --depth 1 -q "$REPO" "$TMP"

for s in "${SKILLS[@]}"; do
  if [ ! -d "$TMP/curated/$s" ]; then
    echo "  ! $s ya no existe en curated/ (¿se renombró upstream?)"
    continue
  fi
  rm -rf "$HERE/skills/$s"
  cp -r "$TMP/curated/$s" "$HERE/skills/"
  echo "  actualizada: $s"
done

echo
echo "Listo. Revisá el diff antes de commitear:  git diff .claude/skills"
