#!/usr/bin/env bash
# Full redeploy of all contracts with a fresh admin identity.
#
# This script:
#   1. Generates a new Stellar CLI identity (or reuses an existing one)
#   2. Funds it via Friendbot (testnet only)
#   3. Downloads the verification key from the circuit-artifacts GitHub release
#   4. Builds all four contracts from source
#   5. Deploys them all with the new admin
#   6. Opens ASP Membership for public registration
#   7. Writes the updated deployments.json
#
# Usage:
#   scripts/full-redeploy.sh [--identity NAME] [--network testnet]
#
# If --identity is omitted, a new identity called "deployer" is created.
# If the identity already exists, it is reused (not overwritten).
#
# Prerequisites:
#   - stellar CLI v25+ installed
#   - Rust toolchain with the wasm32v1-none target (for contract builds)
#   - curl, python3 (for vk conversion and friendbot)
#   - gh CLI (GitHub CLI) — for downloading the verification key from releases

set -euo pipefail

die()  { echo "error: $*" >&2; exit 1; }
step() { echo ""; echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' — install it first"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$ROOT_DIR/target/stellar"

# ── Defaults ────────────────────────────────────────────────────────────────
NETWORK="testnet"
IDENTITY="deployer"
ASP_LEVELS="10"
POOL_LEVELS="10"
MAX_DEPOSIT="1000000000000"   # 100,000 XLM in stroops
ARTIFACT_TAG="circuit-artifacts-v1"
VK_FILENAME="policy_tx_2_2_vk.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity)   IDENTITY="$2"; shift 2 ;;
    --network)    NETWORK="$2"; shift 2 ;;
    --asp-levels) ASP_LEVELS="$2"; shift 2 ;;
    --pool-levels) POOL_LEVELS="$2"; shift 2 ;;
    --max-deposit) MAX_DEPOSIT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--identity NAME] [--network testnet] [--asp-levels N] [--pool-levels N]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

need stellar
need cargo
need curl
need python3

# ── Step 1: Identity ───────────────────────────────────────────────────────
step "Setting up identity '$IDENTITY'..."

if stellar keys address "$IDENTITY" &>/dev/null; then
  echo "  Identity '$IDENTITY' already exists, reusing it."
else
  echo "  Generating new identity '$IDENTITY'..."
  stellar keys generate "$IDENTITY" --network "$NETWORK"
  echo "  Identity created."
fi

DEPLOYER_ADDR="$(stellar keys address "$IDENTITY")"
echo "  Address: $DEPLOYER_ADDR"

# ── Step 2: Fund via Friendbot ─────────────────────────────────────────────
step "Funding account via Friendbot..."

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "futurenet" ]]; then
  echo "  Skipping Friendbot (not a test network). Ensure the account is funded."
else
  FRIENDBOT_URL="https://friendbot.stellar.org?addr=$DEPLOYER_ADDR"
  if [[ "$NETWORK" == "futurenet" ]]; then
    FRIENDBOT_URL="https://friendbot-futurenet.stellar.org?addr=$DEPLOYER_ADDR"
  fi

  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$FRIENDBOT_URL")"
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "  Funded successfully."
  elif [[ "$HTTP_CODE" == "400" ]]; then
    echo "  Account already funded (Friendbot returned 400). Continuing."
  else
    echo "  Friendbot returned HTTP $HTTP_CODE. Attempting to continue anyway."
  fi
fi

# ── Step 3: Download verification key ──────────────────────────────────────
step "Downloading verification key from release '$ARTIFACT_TAG'..."

VK_DIR="$ROOT_DIR/target/vk-cache"
VK_PATH="$VK_DIR/$VK_FILENAME"
mkdir -p "$VK_DIR"

if [[ -f "$VK_PATH" ]]; then
  echo "  Cached at $VK_PATH, skipping download."
else
  need gh
  gh release download "$ARTIFACT_TAG" \
    --repo torisamples/stellar-private-payments \
    --pattern "$VK_FILENAME" \
    --dir "$VK_DIR"
  [[ -f "$VK_PATH" ]] || die "Failed to download $VK_FILENAME"
  echo "  Downloaded to $VK_PATH"
fi

# Convert snarkjs-format vk.json to Soroban VerificationKeyBytes JSON
VK_JSON="$(python3 -c '
import json, sys
data = json.load(sys.stdin)
# If it already has "alpha" key, pass through as-is
if "alpha" in data:
    print(json.dumps(data, separators=(",", ":")))
    sys.exit(0)
# snarkjs format conversion
def to_hex32(v):
    n = int(v)
    return n.to_bytes(32, "big").hex()
def g1_bytes(pt):
    return to_hex32(pt[0]) + to_hex32(pt[1])
def g2_bytes(pt):
    x_im, x_re = pt[0]
    y_im, y_re = pt[1]
    return to_hex32(x_im) + to_hex32(x_re) + to_hex32(y_im) + to_hex32(y_re)
out = {
    "alpha": g1_bytes(data["vk_alpha_1"]),
    "beta": g2_bytes(data["vk_beta_2"]),
    "gamma": g2_bytes(data["vk_gamma_2"]),
    "delta": g2_bytes(data["vk_delta_2"]),
    "ic": [g1_bytes(p) for p in data["IC"]],
}
print(json.dumps(out, separators=(",", ":")))
' < "$VK_PATH")"
echo "  Verification key ready (${#VK_JSON} bytes)"

# ── Step 4: Resolve native token ──────────────────────────────────────────
step "Resolving native XLM token address..."
TOKEN="$(stellar contract id asset --asset native --network "$NETWORK")"
echo "  Token: $TOKEN"

# ── Step 5: Build contracts ────────────────────────────────────────────────
step "Building all contracts (this may take a few minutes)..."
mkdir -p "$WASM_DIR"
for pkg in asp-membership asp-non-membership circom-groth16-verifier pool; do
  echo "  Building $pkg..."
  stellar contract build \
    --manifest-path "$ROOT_DIR/Cargo.toml" \
    --out-dir "$WASM_DIR" \
    --optimize \
    --package "$pkg" >/dev/null
done

ASP_MEMBERSHIP_WASM="$WASM_DIR/asp_membership.wasm"
ASP_NON_MEMBERSHIP_WASM="$WASM_DIR/asp_non_membership.wasm"
VERIFIER_WASM="$WASM_DIR/circom_groth16_verifier.wasm"
POOL_WASM="$WASM_DIR/pool.wasm"

for f in "$ASP_MEMBERSHIP_WASM" "$ASP_NON_MEMBERSHIP_WASM" "$VERIFIER_WASM" "$POOL_WASM"; do
  [[ -f "$f" ]] || die "WASM not found: $f"
done
echo "  All contracts built."

# ── Step 6: Deploy contracts ───────────────────────────────────────────────
deploy_contract() {
  local name="$1"; local wasm="$2"; shift 2
  local output
  output="$(stellar contract deploy \
    --wasm "$wasm" \
    --source-account "$IDENTITY" \
    --network "$NETWORK" \
    -- "$@" 2>&1)"
  local id
  id="$(grep -Eo 'C[A-Z0-9]{55}' <<<"$output" | head -1 || true)"
  [[ -n "$id" ]] || { echo "$output" >&2; die "failed to parse contract id for $name"; }
  echo "$id"
}

step "Deploying ASP Membership (levels=$ASP_LEVELS)..."
ASP_MEMBERSHIP_ID="$(deploy_contract asp-membership "$ASP_MEMBERSHIP_WASM" \
  --admin "$DEPLOYER_ADDR" --levels "$ASP_LEVELS")"
echo "  Contract: $ASP_MEMBERSHIP_ID"

step "Deploying ASP Non-Membership..."
ASP_NON_MEMBERSHIP_ID="$(deploy_contract asp-non-membership "$ASP_NON_MEMBERSHIP_WASM" \
  --admin "$DEPLOYER_ADDR")"
echo "  Contract: $ASP_NON_MEMBERSHIP_ID"

step "Deploying Circom Groth16 Verifier..."
VERIFIER_ID="$(deploy_contract circom-groth16-verifier "$VERIFIER_WASM" \
  --vk "$VK_JSON")"
echo "  Contract: $VERIFIER_ID"

step "Deploying Pool..."
POOL_ID="$(deploy_contract pool "$POOL_WASM" \
  --admin "$DEPLOYER_ADDR" --token "$TOKEN" --verifier "$VERIFIER_ID" \
  --asp-membership "$ASP_MEMBERSHIP_ID" --asp-non-membership "$ASP_NON_MEMBERSHIP_ID" \
  --maximum-deposit-amount "$MAX_DEPOSIT" --levels "$POOL_LEVELS")"
echo "  Contract: $POOL_ID"

# ── Step 7: Open ASP Membership for public registration ──────────────────
step "Opening ASP Membership for public registration..."
stellar contract invoke \
  --id "$ASP_MEMBERSHIP_ID" \
  --source-account "$IDENTITY" \
  --network "$NETWORK" \
  -- set_admin_insert_only --admin_only false
echo "  AdminInsertOnly = false"

# ── Step 8: Write deployments.json ─────────────────────────────────────────
step "Writing deployments.json..."
DEPLOY_FILE="$SCRIPT_DIR/deployments.json"

python3 -c "
import json
data = {
    'network': '$NETWORK',
    'deployer': '$DEPLOYER_ADDR',
    'admin': '$DEPLOYER_ADDR',
    'asp_membership': '$ASP_MEMBERSHIP_ID',
    'asp_non_membership': '$ASP_NON_MEMBERSHIP_ID',
    'verifier': '$VERIFIER_ID',
    'pool': '$POOL_ID',
    'initialized': True
}
with open('$DEPLOY_FILE', 'w') as f:
    json.dump(data, f)
    f.write('\n')
"
echo "  Written to $DEPLOY_FILE"

# ── Done ───────────────────────────────────────────────────────────────────
cat >&2 <<EOF

  ┌──────────────────────────────────────────────────────────────────────┐
  │              FULL REDEPLOY COMPLETE                                  │
  └──────────────────────────────────────────────────────────────────────┘

  Network:               $NETWORK
  Admin/Deployer:        $DEPLOYER_ADDR
  Identity name:         $IDENTITY

  ASP Membership:        $ASP_MEMBERSHIP_ID   (levels=$ASP_LEVELS, open registration)
  ASP Non-Membership:    $ASP_NON_MEMBERSHIP_ID
  Verifier:              $VERIFIER_ID
  Pool:                  $POOL_ID   (levels=$POOL_LEVELS, max deposit=$MAX_DEPOSIT)

  All contracts share the same admin. To update later:
    stellar contract invoke --id <CONTRACT> --source-account $IDENTITY --network $NETWORK \\
      -- update_admin --new_admin <NEW_ADMIN_ADDRESS>

  Next steps:
    1. Commit the updated scripts/deployments.json
    2. Push to main to trigger CI/CD deploy to Vercel
    3. Clear browser IndexedDB (or the app will auto-detect contract changes)
    4. Connect wallet → Join Privacy Pool → Deposit

EOF
