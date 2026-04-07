#!/usr/bin/env bash
# Update the pool contract's ASP Membership reference to match deployments.json.
#
# After redeploying the ASP Membership contract, the pool still points to the
# old address.  This script calls `update_asp_membership` on the pool contract
# so the two stay in sync.
#
# Usage:
#   scripts/update-pool-asp-membership.sh --deployer <identity> [--network testnet]
#
# Prerequisites:
#   - stellar CLI installed (v25+)
#   - Deployer identity configured in stellar CLI (must be pool admin)

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — install it first"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_FILE="$SCRIPT_DIR/deployments.json"

NETWORK="testnet"
DEPLOYER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deployer) DEPLOYER="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$DEPLOYER" ]] || die "--deployer is required"
[[ -f "$DEPLOY_FILE" ]] || die "deployments.json not found at $DEPLOY_FILE"
need stellar
need python3

# Read addresses from deployments.json
POOL_ID="$(python3 -c "import json; print(json.load(open('$DEPLOY_FILE'))['pool'])")"
NEW_ASP_ID="$(python3 -c "import json; print(json.load(open('$DEPLOY_FILE'))['asp_membership'])")"

[[ -n "$POOL_ID" ]] || die "pool address not found in deployments.json"
[[ -n "$NEW_ASP_ID" ]] || die "asp_membership address not found in deployments.json"

step "Pool contract:            $POOL_ID"
step "New ASP Membership:       $NEW_ASP_ID"
step "Network:                  $NETWORK"
echo ""

# Show current membership root via the pool's public getter.
# get_asp_membership_root cross-calls the ASP contract the pool currently
# references, so the root value implicitly tells us which contract is in use.
step "Reading current ASP membership root (via pool)..."
BEFORE_ROOT="$(stellar contract invoke \
  --id "$POOL_ID" \
  --source-account "$DEPLOYER" \
  --network "$NETWORK" \
  --is-view \
  -- get_asp_membership_root 2>&1 || echo '<read failed>')"
echo "  Current root (old contract): $BEFORE_ROOT"

echo ""
step "Updating pool's ASP Membership reference to $NEW_ASP_ID ..."
stellar contract invoke \
  --id "$POOL_ID" \
  --source-account "$DEPLOYER" \
  --network "$NETWORK" \
  -- update_asp_membership --new_asp_membership "$NEW_ASP_ID"

step "Verifying — reading ASP membership root after update..."
AFTER_ROOT="$(stellar contract invoke \
  --id "$POOL_ID" \
  --source-account "$DEPLOYER" \
  --network "$NETWORK" \
  --is-view \
  -- get_asp_membership_root 2>&1 || echo '<read failed>')"
echo "  New root (new contract):     $AFTER_ROOT"

cat >&2 <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │         POOL ASP MEMBERSHIP REFERENCE UPDATED                       │
  └──────────────────────────────────────────────────────────────────────┘

  Pool contract:         $POOL_ID
  New ASP Membership:    $NEW_ASP_ID
  Network:               $NETWORK

  Root before update:    $BEFORE_ROOT
  Root after update:     $AFTER_ROOT

  The pool contract now validates membership proofs against the
  correct ASP Membership tree. Deposits should work after users
  rejoin the privacy pool.

EOF
