#!/usr/bin/env bash
# Copies the specific frontend files this service depends on into vendor/src/,
# preserving their exact relative path structure so their own internal
# `@/...` imports resolve unmodified against this repo's tsconfig `@/*` ->
# `./vendor/src/*` alias (same alias shape the frontend itself uses).
#
# Run manually and commit the result — see decisions.md for why (accepts
# manual resync as a fine cost at this project's scale, over submodule
# ergonomics). Re-run this after any change to the frontend's simulation
# engine, scenario scoring, or cost/architecture-validation logic.
set -euo pipefail

FRONTEND_REPO="${1:-../../engineering_studio}"
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vendor/src"

if [ ! -d "$FRONTEND_REPO/src" ]; then
  echo "Frontend repo not found at $FRONTEND_REPO (pass its path as \$1)" >&2
  exit 1
fi

FILES=(
  "src/simulation"                       # whole engine dir — self-contained, zero React imports
  "src/scenarios/types.ts"
  "src/scenarios/validator.ts"
  "src/lib/scenarioScoring.ts"
  "src/lib/costEngine.ts"
  "src/lib/architectureValidation.ts"
  "src/lib/entityConfigSchema.ts"
)

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

cd "$FRONTEND_REPO"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
SYNCED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

for f in "${FILES[@]}"; do
  dest="$VENDOR_DIR/${f#src/}"
  if [ -d "$f" ]; then
    mkdir -p "$dest"
    # Exclude test/example files — not needed at runtime, and __tests__ dirs
    # commonly import test-only frameworks this service doesn't have.
    rsync -a --exclude='__tests__' --exclude='examples' "$f/" "$dest/"
  else
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  fi
done

cat > "$VENDOR_DIR/VENDORED.md" <<EOF
# Vendored from engineering_studio

Synced from commit \`$COMMIT\` at $SYNCED_AT by \`sync-vendor.sh\`.
Do not edit these files directly — re-run \`npm run sync-vendor\` after the
source changes in the frontend repo instead.

Files: ${FILES[*]}
EOF

echo "Vendored ${#FILES[@]} paths from $FRONTEND_REPO@$COMMIT into $VENDOR_DIR"
