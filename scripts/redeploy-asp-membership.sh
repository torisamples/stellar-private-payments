#!/usr/bin/env bash
# Redeploy only the ASP Membership contract with on-chain leaf storage.
#
# This rebuilds and redeploys the asp-membership contract, then updates
# deployments.json with the new contract address. The pool contract is
# NOT redeployed — it must be updated separately to point to the new
# ASP membership address (or the pool can be redeployed too).
#
# Usage:
#   scripts/redeploy-asp-membership.sh --deployer <identity> [--network testnet]
#
# Prerequisites:
#   - stellar CLI installed (v25+)
#   - Rust toolchain with wasm32v1-none target
#   - Deployer identity configured in stellar CLI

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — install it first"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/target/stellar"

NETWORK="testnet"
DEPLOYER=""
ASP_LEVELS="10"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployer) DEPLOYER="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --asp-levels) ASP_LEVELS="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$DEPLOYER" ]] || die "--deployer is required"
need stellar
need cargo

# Resolve deployer address
DEPLOYER_ADDR="$(stellar keys address "$DEPLOYER" 2>/dev/null || echo "$DEPLOYER")"

step "Building asp-membership contract..."
mkdir -p "$WASM_DIR"
stellar contract build --manifest-path "$ROOT_DIR/Cargo.toml" --out-dir "$WASM_DIR" --optimize \
  --package asp-membership

ASP_WASM="$WASM_DIR/asp_membership.wasm"
[[ -f "$ASP_WASM" ]] || die "WASM not found: $ASP_WASM"

step "Deploying new ASP Membership contract (levels=$ASP_LEVELS)..."
OUTPUT="$(stellar contract deploy \
  --wasm "$ASP_WASM" \
  --source-account "$DEPLOYER" \
  --network "$NETWORK" \
  -- --admin "$DEPLOYER_ADDR" --levels "$ASP_LEVELS" 2>&1)"

NEW_ASP_ID="$(grep -Eo 'C[A-Z0-9]{55}' <<<"$OUTPUT" | head -1 || true)"
[[ -n "$NEW_ASP_ID" ]] || { echo "$OUTPUT" >&2; die "failed to parse new contract ID"; }

step "Setting AdminInsertOnly=false (open registration)..."
stellar contract invoke \
  --id "$NEW_ASP_ID" \
  --source-account "$DEPLOYER" \
  --network "$NETWORK" \
  -- set_admin_insert_only --admin_only false

step "Updating deployments.json..."
DEPLOY_FILE="$SCRIPT_DIR/deployments.json"
if [[ -f "$DEPLOY_FILE" ]]; then
  # Update just the asp_membership field
  python3 -c "
import json, sys
with open('$DEPLOY_FILE') as f:
    data = json.load(f)
data['asp_membership'] = '$NEW_ASP_ID'
with open('$DEPLOY_FILE', 'w') as f:
    json.dump(data, f)
    f.write('\n')
print('Updated asp_membership in deployments.json')
"
else
  die "deployments.json not found at $DEPLOY_FILE"
fi

cat >&2 <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │            ASP MEMBERSHIP CONTRACT REDEPLOYED                        │
  └──────────────────────────────────────────────────────────────────────┘

  New contract:    $NEW_ASP_ID
  Network:         $NETWORK
  Deployer:        $DEPLOYER_ADDR
  Levels:          $ASP_LEVELS
  AdminInsertOnly: false (open registration)

  The old ASP membership tree has been reset to 0 members.
  All users will need to click "Join Privacy Pool" again.

  IMPORTANT: The pool contract still references the OLD ASP membership
  address.  Run the update script to fix this:

    scripts/update-pool-asp-membership.sh --deployer $DEPLOYER

  Next steps:
    1. Run scripts/update-pool-asp-membership.sh --deployer $DEPLOYER
    2. Commit the updated deployments.json
    3. Push to main to trigger CI/CD deploy
    4. Existing users re-join the privacy pool via the UI

EOF
