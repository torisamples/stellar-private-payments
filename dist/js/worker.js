// app/js/bridge.js
import initProverModule, {
  Prover,
  MerkleTree,
  MerkleProof,
  WasmSparseMerkleTree,
  derive_public_key,
  derive_public_key_hex,
  compute_commitment,
  compute_signature,
  compute_nullifier,
  poseidon2_hash2,
  poseidon2_compression_wasm,
  u64_to_field_bytes,
  hex_to_field_bytes,
  field_bytes_to_hex,
  derive_keypair_from_signature,
  derive_note_private_key,
  generate_random_blinding,
  encrypt_note_data,
  decrypt_note_data,
  convert_proof_to_soroban,
  version as proverVersion,
  bn256_modulus,
  zero_leaf
} from "./prover.js";
import initWitnessWasm, {
  WitnessCalculator,
  version as witnessVersion
} from "./witness/witness.js";
var DEFAULT_CONFIG = {
  circuitName: "policy_tx_2_2",
  circuitWasmUrl: "/circuits/policy_tx_2_2.wasm",
  provingKeyUrl: "/keys/policy_tx_2_2_proving_key.bin",
  r1csUrl: "/circuits/policy_tx_2_2.r1cs",
  cacheName: "zk-proving-artifacts"
};
var config = { ...DEFAULT_CONFIG };
function validateArtifactUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Artifact URL must be a non-empty string");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(url)) {
    throw new Error(`Artifact URL must be a relative path, got absolute URL: ${url}`);
  }
  if (url.startsWith("//")) {
    throw new Error(`Artifact URL must not be protocol-relative: ${url}`);
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(url)) {
    throw new Error(`Artifact URL contains path traversal: ${url}`);
  }
  return url;
}
var prover = null;
var witnessCalc = null;
var proverModuleInitialized = false;
var witnessModuleInitialized = false;
var proverInitialized = false;
var witnessInitialized = false;
var cachedProvingKey = null;
var cachedR1cs = null;
var cachedCircuitWasm = null;
var downloadPromise = null;
async function getCached(url) {
  try {
    const cache = await caches.open(config.cacheName);
    const response = await cache.match(url);
    if (response) {
      return new Uint8Array(await response.arrayBuffer());
    }
  } catch (e) {
    console.warn("[ZK] Cache read failed:", e.message);
  }
  return null;
}
async function setCache(url, bytes) {
  try {
    const cache = await caches.open(config.cacheName);
    const response = new Response(bytes, {
      headers: { "Content-Type": "application/octet-stream" }
    });
    await cache.put(url, response);
  } catch (e) {
    console.warn("[ZK] Cache write failed:", e.message);
  }
}
async function clearCache() {
  try {
    await caches.delete(config.cacheName);
    cachedProvingKey = null;
    cachedR1cs = null;
    cachedCircuitWasm = null;
    downloadPromise = null;
    console.log("[ZK] Cache cleared");
  } catch (e) {
    console.warn("[ZK] Cache clear failed:", e.message);
  }
}
async function downloadWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const contentLength = response.headers.get("Content-Length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  if (!total || !response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (onProgress) onProgress(bytes.length, bytes.length, url);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total, url);
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
async function ensureProvingArtifacts(onProgress) {
  if (cachedProvingKey && cachedR1cs) {
    return { provingKey: cachedProvingKey, r1cs: cachedR1cs };
  }
  if (downloadPromise) {
    return downloadPromise;
  }
  downloadPromise = (async () => {
    try {
      let pk = cachedProvingKey || await getCached(config.provingKeyUrl);
      let r1cs = cachedR1cs || await getCached(config.r1csUrl);
      const needsPk = !pk;
      const needsR1cs = !r1cs;
      if (needsPk || needsR1cs) {
        const pkSize = needsPk ? 5e6 : 0;
        const r1csSize = needsR1cs ? 35e5 : 0;
        const totalSize = pkSize + r1csSize;
        let pkLoaded = 0, r1csLoaded = 0;
        const reportProgress = () => {
          if (onProgress) {
            const loaded = pkLoaded + r1csLoaded;
            const message = needsPk && pkLoaded < pkSize ? "Downloading proving key..." : "Downloading circuit constraints...";
            onProgress(loaded, totalSize, message);
          }
        };
        const downloads = [];
        if (needsPk) {
          downloads.push(
            downloadWithProgress(config.provingKeyUrl, (loaded) => {
              pkLoaded = loaded;
              reportProgress();
            }).then(async (bytes) => {
              pk = bytes;
              await setCache(config.provingKeyUrl, bytes);
              console.log(`[ZK] Proving key downloaded: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
            })
          );
        }
        if (needsR1cs) {
          downloads.push(
            downloadWithProgress(config.r1csUrl, (loaded) => {
              r1csLoaded = loaded;
              reportProgress();
            }).then(async (bytes) => {
              r1cs = bytes;
              await setCache(config.r1csUrl, bytes);
              console.log(`[ZK] R1CS downloaded: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
            })
          );
        }
        await Promise.all(downloads);
        if (onProgress) {
          onProgress(totalSize, totalSize, "Download complete");
        }
      } else {
        console.log("[ZK] Proving artifacts loaded from cache");
      }
      cachedProvingKey = pk;
      cachedR1cs = r1cs;
      return { provingKey: pk, r1cs };
    } finally {
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}
async function isProvingCached() {
  if (cachedProvingKey && cachedR1cs) return true;
  const pk = await getCached(config.provingKeyUrl);
  const r1cs = await getCached(config.r1csUrl);
  return pk !== null && r1cs !== null;
}
function configure(options) {
  const urlFields = ["circuitWasmUrl", "provingKeyUrl", "r1csUrl"];
  for (const field of urlFields) {
    if (options[field] !== void 0) {
      validateArtifactUrl(options[field]);
    }
  }
  config = { ...config, ...options };
}
async function initProverWasm() {
  if (!proverModuleInitialized) {
    await initProverModule();
    proverModuleInitialized = true;
    console.log("[ZK] Prover WASM module initialized");
  }
}
async function initWitnessModuleWasm() {
  if (!witnessModuleInitialized) {
    await initWitnessWasm();
    witnessModuleInitialized = true;
    console.log(`[ZK] Witness WASM module initialized (v${witnessVersion()})`);
  }
}
async function initWitnessModule(circuitWasmUrl, r1csUrl) {
  await initWitnessModuleWasm();
  if (witnessInitialized && witnessCalc) {
    return getCircuitInfo();
  }
  const wasmUrl = validateArtifactUrl(circuitWasmUrl || config.circuitWasmUrl);
  const r1cs = validateArtifactUrl(r1csUrl || config.r1csUrl);
  let circuitWasm = cachedCircuitWasm || await getCached(wasmUrl);
  if (!circuitWasm) {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Failed to fetch circuit WASM: ${response.status}`);
    circuitWasm = new Uint8Array(await response.arrayBuffer());
    await setCache(wasmUrl, circuitWasm);
    cachedCircuitWasm = circuitWasm;
    console.log(`[ZK] Circuit WASM downloaded: ${(circuitWasm.length / 1024).toFixed(2)} KB`);
  }
  let r1csBytes = cachedR1cs || await getCached(r1cs);
  if (!r1csBytes) {
    const response = await fetch(r1cs);
    if (!response.ok) throw new Error(`Failed to fetch R1CS: ${response.status}`);
    r1csBytes = new Uint8Array(await response.arrayBuffer());
    await setCache(r1cs, r1csBytes);
    cachedR1cs = r1csBytes;
    console.log(`[ZK] R1CS downloaded: ${(r1csBytes.length / 1024 / 1024).toFixed(2)} MB`);
  }
  witnessCalc = new WitnessCalculator(circuitWasm, r1csBytes);
  witnessInitialized = true;
  console.log("[ZK] Witness calculator initialized (ark-circom)");
  console.log(`[ZK]   - Witness size: ${witnessCalc.witness_size} elements`);
  console.log(`[ZK]   - Public inputs: ${witnessCalc.num_public_inputs}`);
  return getCircuitInfo();
}
async function initProver(onProgress) {
  if (proverInitialized && prover) {
    return {
      version: proverVersion(),
      numPublicInputs: prover.num_public_inputs,
      numConstraints: prover.num_constraints,
      numWires: prover.num_wires
    };
  }
  const [, { provingKey, r1cs }] = await Promise.all([
    initWitnessModule(),
    ensureProvingArtifacts(onProgress)
  ]);
  await initProverWasm();
  prover = new Prover(provingKey, r1cs);
  proverInitialized = true;
  console.log("[ZK] Prover initialized");
  console.log(`[ZK]   - ${prover.num_constraints} constraints`);
  console.log(`[ZK]   - ${prover.num_wires} wires`);
  console.log(`[ZK]   - ${prover.num_public_inputs} public inputs`);
  return {
    version: proverVersion(),
    circuitInfo: getCircuitInfo(),
    numPublicInputs: prover.num_public_inputs,
    numConstraints: prover.num_constraints,
    numWires: prover.num_wires
  };
}
async function init(circuitWasmUrl, provingKeyBytes, r1csBytes) {
  await initWitnessModuleWasm();
  await initProverWasm();
  const response = await fetch(validateArtifactUrl(circuitWasmUrl));
  if (!response.ok) {
    throw new Error(`Failed to fetch circuit WASM: ${response.status}`);
  }
  const circuitWasm = new Uint8Array(await response.arrayBuffer());
  witnessCalc = new WitnessCalculator(circuitWasm, r1csBytes);
  witnessInitialized = true;
  prover = new Prover(provingKeyBytes, r1csBytes);
  proverInitialized = true;
  return {
    version: proverVersion(),
    circuitInfo: getCircuitInfo(),
    numPublicInputs: prover.num_public_inputs,
    numConstraints: prover.num_constraints,
    numWires: prover.num_wires
  };
}
function getCircuitInfo() {
  if (!witnessCalc) {
    throw new Error("Witness calculator not initialized.");
  }
  return {
    witnessSize: witnessCalc.witness_size,
    numPublicInputs: witnessCalc.num_public_inputs
  };
}
function derivePublicKey(privateKey) {
  return derive_public_key(privateKey);
}
function derivePublicKeyHex(privateKey) {
  return derive_public_key_hex(privateKey);
}
async function generateWitness(inputs) {
  if (!witnessInitialized || !witnessCalc) {
    throw new Error("Witness module not initialized. Call initWitnessModule() first.");
  }
  const inputsJson = JSON.stringify(inputs);
  const witnessBytes = witnessCalc.compute_witness(inputsJson);
  return new Uint8Array(witnessBytes);
}
function generateProofBytes(witnessBytes) {
  if (!proverInitialized || !prover) {
    throw new Error("Prover not initialized. Call initProver() first.");
  }
  return prover.prove_bytes(witnessBytes);
}
function extractPublicInputs(witnessBytes) {
  if (!proverInitialized || !prover) {
    throw new Error("Prover not initialized. Call initProver() first.");
  }
  return prover.extract_public_inputs(witnessBytes);
}
function verifyProofLocal(proofBytes, publicInputsBytes) {
  if (!proverInitialized || !prover) {
    throw new Error("Prover not initialized. Call initProver() first.");
  }
  return prover.verify(proofBytes, publicInputsBytes);
}
function getVerifyingKey() {
  if (!proverInitialized || !prover) {
    throw new Error("Prover not initialized. Call initProver() first.");
  }
  return prover.get_verifying_key();
}
function proofBytesToSoroban(proofBytes) {
  return convert_proof_to_soroban(proofBytes);
}
function generateProofBytesSoroban(witnessBytes) {
  if (!proverInitialized || !prover) {
    throw new Error("Prover not initialized. Call initProver() first.");
  }
  return prover.prove_bytes_uncompressed(witnessBytes);
}

// app/js/worker.js
var modulesReady = false;
var witnessReady = false;
var proverReady = false;
function sendProgress(messageId, loaded, total, message) {
  self.postMessage({
    type: "PROGRESS",
    messageId,
    loaded,
    total,
    message,
    percent: total > 0 ? Math.round(loaded / total * 100) : 0
  });
}
async function handleInitModules() {
  try {
    await initProverWasm();
    modulesReady = true;
    return { success: true, modulesReady: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleInitWitness(data) {
  const { circuitWasmUrl } = data || {};
  try {
    const circuitInfo = await initWitnessModule(circuitWasmUrl);
    witnessReady = true;
    return { success: true, circuitInfo, witnessReady: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleInitProver(data, messageId) {
  try {
    const onProgress = (loaded, total, message) => {
      sendProgress(messageId, loaded, total, message);
    };
    const info = await initProver(onProgress);
    proverReady = true;
    return {
      success: true,
      info,
      proverReady: true
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleInit(data) {
  try {
    const { circuitWasmUrl, provingKeyBytes, r1csBytes } = data;
    const info = await init(
      circuitWasmUrl,
      new Uint8Array(provingKeyBytes),
      new Uint8Array(r1csBytes)
    );
    modulesReady = true;
    witnessReady = true;
    proverReady = true;
    return { success: true, info };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
function handleConfigure(data) {
  try {
    configure(data);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleCheckCache() {
  try {
    const cached = await isProvingCached();
    return { success: true, cached };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleClearCache() {
  try {
    await clearCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
async function handleProve(data, messageId) {
  try {
    const { inputs, sorobanFormat } = data;
    if (!proverReady) {
      const onProgress = (loaded, total, message) => {
        sendProgress(messageId, loaded, total, message);
      };
      await initProver(onProgress);
      proverReady = true;
    }
    const witnessTime = performance.now();
    const witnessBytes = await generateWitness(inputs);
    const witnessOnlyTime = performance.now() - witnessTime;
    console.log(`[Worker] Witness generation: ${witnessOnlyTime.toFixed(0)}ms`);
    const proveTime = performance.now();
    let proofBytes;
    if (sorobanFormat) {
      proofBytes = generateProofBytesSoroban(witnessBytes);
      console.log(`[Worker] Proof generation (Soroban): ${(performance.now() - proveTime).toFixed(0)}ms`);
    } else {
      proofBytes = generateProofBytes(witnessBytes);
      console.log(`[Worker] Proof generation: ${(performance.now() - proveTime).toFixed(0)}ms`);
    }
    console.log("[Worker] Extracting public inputs...");
    const publicInputsBytes = extractPublicInputs(witnessBytes);
    console.log(`[Worker] Public inputs extracted: ${publicInputsBytes?.length || 0} bytes`);
    const proofArray = Array.from(proofBytes);
    const publicInputsArray = Array.from(publicInputsBytes);
    console.log(`[Worker] Proof: ${proofArray.length} bytes, Public inputs: ${publicInputsArray.length} bytes`);
    return {
      success: true,
      proof: proofArray,
      publicInputs: publicInputsArray,
      sorobanFormat: !!sorobanFormat,
      timings: {
        witness: witnessOnlyTime,
        prove: performance.now() - proveTime,
        total: performance.now() - witnessTime
      }
    };
  } catch (error) {
    console.error("[Worker] handleProve error:", error);
    return { success: false, error: error?.message || String(error) || "Proof generation failed" };
  }
}
function handleConvertProofToSoroban(data) {
  try {
    const { proofBytes } = data;
    const sorobanProof = proofBytesToSoroban(new Uint8Array(proofBytes));
    return { success: true, proof: Array.from(sorobanProof) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
function handleVerify(data) {
  if (!proverReady) {
    return { success: false, error: "Prover not initialized" };
  }
  try {
    const { proofBytes, publicInputsBytes } = data;
    const proofArr = new Uint8Array(proofBytes);
    const pubInputsArr = new Uint8Array(publicInputsBytes);
    console.log(`[Worker] Verifying proof: ${proofArr.length} bytes, public inputs: ${pubInputsArr.length} bytes`);
    const numPublicInputs = pubInputsArr.length / 32;
    console.log(`[Worker] Number of public inputs: ${numPublicInputs}`);
    const verified = verifyProofLocal(proofArr, pubInputsArr);
    console.log(`[Worker] Verification result: ${verified}`);
    return { success: true, verified };
  } catch (error) {
    const errorMsg = error?.message || error?.toString() || String(error) || "Unknown verification error";
    console.error("[Worker] Verification error:", error);
    console.error("[Worker] Error message:", errorMsg);
    console.error("[Worker] Error stack:", error?.stack);
    return { success: false, error: errorMsg };
  }
}
function handleDerivePublicKey(data) {
  try {
    const { privateKey, asHex } = data;
    const skBytes = new Uint8Array(privateKey);
    if (asHex) {
      return { success: true, publicKey: derivePublicKeyHex(skBytes) };
    } else {
      return { success: true, publicKey: Array.from(derivePublicKey(skBytes)) };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}
function handleComputeCommitment(data) {
  try {
    const { amount, publicKey, blinding } = data;
    const commitment = compute_commitment(
      new Uint8Array(amount),
      new Uint8Array(publicKey),
      new Uint8Array(blinding)
    );
    return { success: true, commitment: Array.from(commitment) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
function handleGetVerifyingKey(data = {}) {
  if (!proverReady) {
    return { success: false, error: "Prover not initialized" };
  }
  try {
    const { sorobanFormat } = data;
    const vkBytes = getVerifyingKey();
    return { success: true, verifyingKey: Array.from(vkBytes), sorobanFormat: !!sorobanFormat };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
function handleGetCircuitInfo() {
  if (!witnessReady) {
    return { success: false, error: "Witness not initialized" };
  }
  return { success: true, info: getCircuitInfo() };
}
function handleGetState() {
  return {
    success: true,
    state: {
      modulesReady,
      witnessReady,
      proverReady
    }
  };
}
self.onmessage = async function(event) {
  const { type, messageId, data } = event.data;
  let result;
  switch (type) {
    // Initialization
    case "INIT_MODULES":
      result = await handleInitModules();
      break;
    case "INIT_WITNESS":
      result = await handleInitWitness(data);
      break;
    case "INIT_PROVER":
      result = await handleInitProver(data, messageId);
      break;
    case "INIT":
      result = await handleInit(data);
      break;
    case "CONFIGURE":
      result = handleConfigure(data);
      break;
    // Caching
    case "CHECK_CACHE":
      result = await handleCheckCache();
      break;
    case "CLEAR_CACHE":
      result = await handleClearCache();
      break;
    // Proving
    case "PROVE":
      result = await handleProve(data, messageId);
      break;
    case "CONVERT_PROOF_TO_SOROBAN":
      result = handleConvertProofToSoroban(data);
      break;
    case "VERIFY":
      result = handleVerify(data);
      break;
    // Crypto utilities
    case "DERIVE_PUBLIC_KEY":
      result = handleDerivePublicKey(data);
      break;
    case "COMPUTE_COMMITMENT":
      result = handleComputeCommitment(data);
      break;
    // Info
    case "GET_VERIFYING_KEY":
      result = handleGetVerifyingKey(data);
      break;
    case "GET_CIRCUIT_INFO":
      result = handleGetCircuitInfo();
      break;
    case "GET_STATE":
      result = handleGetState();
      break;
    case "PING":
      result = {
        success: true,
        ready: proverReady,
        state: { modulesReady, witnessReady, proverReady }
      };
      break;
    default:
      result = { success: false, error: `Unknown message type: ${type}` };
  }
  self.postMessage({ type, messageId, ...result });
};
self.postMessage({ type: "READY" });
