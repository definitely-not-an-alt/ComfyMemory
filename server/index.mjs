/**
 * ComfyMemory Server Plugin
 *
 * Intercepts ComfyUI image generation requests and manages VRAM by:
 * 1. Saving the llama.cpp KV cache to a RAM disk
 * 2. Unloading the LLM from VRAM
 * 3. Forwarding the generation request to ComfyUI
 * 4. Freeing ComfyUI's VRAM after generation
 * 5. Reloading the LLM into VRAM
 * 6. Restoring the KV cache
 * 7. Cleaning up the temporary cache file
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Plugin Info
// ============================================================================

export const info = {
    id: 'comfymemory',
    name: 'ComfyMemory',
    description: 'Manages VRAM during ComfyUI image generation by unloading/reloading the LLM to prevent OOM errors on dual-GPU setups.',
};

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_FILE = path.join(__dirname, 'config.json');

const defaultConfig = {
    // llama.cpp server URL (e.g., http://127.0.0.1:8080)
    llamacppUrl: 'http://127.0.0.1:8080',
    // Model identifier to unload/reload (leave empty to auto-detect via /v1/models)
    modelIdentifier: '',
    // Save/restore KV cache around generation (disable for SWA models or if reprocessing is fast enough)
    saveKvCache: true,
    // KV cache filename (saved to llama.cpp's --slot-save-path directory)
    kvCacheFilename: 'st_active_chat.bin',
    // Directory where llama.cpp saves slot cache files (--slot-save-path)
    // Set this so the plugin can clean up the temp file after restore
    slotSavePath: '/dev/shm',
    // Slot number for KV cache save/restore (0 = active slot)
    slotNumber: 0,
    // Enable debug logging
    debug: false,
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return { ...defaultConfig, ...data };
        }
    } catch (error) {
        log(`Failed to load config: ${error.message}`);
    }
    return { ...defaultConfig };
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf8');
    } catch (error) {
        log(`Failed to save config: ${error.message}`);
    }
}

// ============================================================================
// Logging
// ============================================================================

function log(message) {
    console.log(`[ComfyMemory] ${message}`);
}

function debugLog(message) {
    const config = loadConfig();
    if (config.debug) {
        console.log(`[ComfyMemory DEBUG] ${message}`);
    }
}

// ============================================================================
// HTTP Helpers
// ============================================================================

/**
 * Make an HTTP request and return the parsed JSON response.
 * @param {string} url - The URL to request
 * @param {object} options - Fetch options
 * @returns {Promise<any>} Parsed JSON response
 */
async function apiRequest(url, options = {}) {
    const defaults = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const merged = {
        ...defaults,
        ...options,
        headers: {
            ...defaults.headers,
            ...(options.headers || {}),
        },
    };

    const response = await fetch(url, merged);
    debugLog(`API request to ${url}: status ${response.status}`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    // Some responses might be empty or non-JSON
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return await response.json();
    }
    return await response.text();
}

/**
 * Make a POST request with JSON body.
 * @param {string} url - The URL to request
 * @param {object} body - JSON body to send
 * @returns {Promise<any>} Parsed JSON response
 */
async function apiPost(url, body = {}) {
    return apiRequest(url, {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/**
 * Make a GET request.
 * @param {string} url - The URL to request
 * @returns {Promise<any>} Parsed JSON response
 */
async function apiGet(url) {
    const response = await fetch(url);
    debugLog(`GET ${url}: status ${response.status}`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return await response.json();
    }
    return await response.text();
}

/**
 * Discover the currently loaded model from llama.cpp router.
 * @param {string} llamacppUrl - Base URL of llama.cpp server
 * @returns {Promise<string|null>} Model ID or null if none found
 */
async function discoverLoadedModel(llamacppUrl) {
    try {
        const data = await apiGet(`${llamacppUrl}/v1/models`);
        const models = data.data || [];
        const loaded = models.find(m => m.status?.value === 'loaded');
        if (loaded) {
            debugLog(`Auto-detected loaded model: ${loaded.id}`);
            return loaded.id;
        }
        // Fallback: return first model if none explicitly "loaded"
        if (models.length > 0) {
            debugLog(`No loaded model found, using first available: ${models[0].id}`);
            return models[0].id;
        }
        debugLog('No models found via /v1/models');
    } catch (error) {
        debugLog(`Failed to discover model: ${error.message}`);
    }
    return null;
}

/**
 * Resolve the model identifier, auto-detecting if not configured.
 * Caches the result on config._resolvedModelId so the same model is used
 * throughout the entire generation sequence (even after unload).
 * @param {object} config - Plugin configuration
 * @returns {Promise<string>} Model identifier
 */
async function resolveModelIdentifier(config) {
    // Use cached resolution if available (prevents picking a different model after unload)
    if (config._resolvedModelId) {
        return config._resolvedModelId;
    }
    if (config.modelIdentifier) {
        config._resolvedModelId = config.modelIdentifier;
        return config._resolvedModelId;
    }
    const discovered = await discoverLoadedModel(config.llamacppUrl);
    if (discovered) {
        config._resolvedModelId = discovered;
        return discovered;
    }
    throw new Error(
        'No model identifier configured and auto-detection failed. '
        + 'Set modelIdentifier in config or use a llama.cpp router with /v1/models support.'
    );
}

// ============================================================================
// VRAM Management Steps
// ============================================================================

/**
 * Step 1: Save the active chat KV cache to RAM disk.
 * @param {object} config - Plugin configuration
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 * @returns {Promise<object>} Response from llama.cpp
 */
async function saveKvCache(config, totalSteps, stepNum) {
    const modelId = await resolveModelIdentifier(config);
    const url = `${config.llamacppUrl}/slots/${config.slotNumber}?action=save`;
    log(`Step ${stepNum}/${totalSteps}: Saving KV cache to ${config.kvCacheFilename} (model: ${modelId})...`);
    const result = await apiPost(url, { model: modelId, filename: config.kvCacheFilename });
    debugLog(`KV cache save response: ${JSON.stringify(result)}`);
    if (result.n_saved !== undefined) {
        log(`KV cache saved: ${result.n_saved} tokens`);
    }
    return result;
}

/**
 * Step 2: Unload the LLM from VRAM.
 * @param {object} config - Plugin configuration
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 * @returns {Promise<object>} Response from llama.cpp
 */
async function unloadLlm(config, totalSteps, stepNum) {
    const modelId = await resolveModelIdentifier(config);
    const url = `${config.llamacppUrl}/models/unload`;
    log(`Step ${stepNum}/${totalSteps}: Unloading LLM (${modelId})...`);
    const result = await apiPost(url, { model: modelId });
    debugLog(`LLM unload response: ${JSON.stringify(result)}`);
    if (result.success) {
        log('Waiting for model to fully unload...');
        await waitForModelStatus(config.llamacppUrl, modelId, 'unloaded', 30);
        log('LLM unloaded successfully');
    }
    return result;
}

/**
 * Wait for a model to reach a specific status.
 * @param {string} llamacppUrl - Base URL of llama.cpp server
 * @param {string} modelId - Model ID to check
 * @param {string} expectedStatus - Expected status (e.g., 'loaded', 'unloaded')
 * @param {number} maxWaitSeconds - Maximum time to wait
 * @returns {Promise<boolean>} True if status was reached
 */
async function waitForModelStatus(llamacppUrl, modelId, expectedStatus, maxWaitSeconds = 30) {
    const maxAttempts = maxWaitSeconds; // 1 second intervals
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const data = await apiGet(`${llamacppUrl}/v1/models`);
            const models = data.data || [];
            const model = models.find(m => m.id === modelId);
            if (model && model.status?.value === expectedStatus) {
                debugLog(`Model ${modelId} is now ${expectedStatus} after ${i}s`);
                return true;
            }
            if (i < 5 || i % 10 === 0) {
                debugLog(`Waiting for model ${modelId} to be ${expectedStatus}... (${i}s, current: ${model?.status?.value})`);
            }
        } catch (error) {
            debugLog(`Status check failed: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    debugLog(`Timed out waiting for model ${modelId} to be ${expectedStatus}`);
    return false;
}

/**
 * Step 3: Forward the generation request to ComfyUI and wait for completion.
 * @param {object} config - Plugin configuration
 * @param {string} workflowJson - The ComfyUI workflow JSON string
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 * @returns {Promise<{format: string, data: string}>} Image data
 */
async function generateWithComfyUI(config, workflowJson, totalSteps, stepNum) {
    log(`Step ${stepNum}/${totalSteps}: Sending generation request to ComfyUI...`);

    const comfyUrl = config.comfyUrl;

    // Parse the workflow JSON string to get the prompt
    let workflow;
    try {
        workflow = JSON.parse(workflowJson);
    } catch (error) {
        throw new Error(`Invalid workflow JSON: ${error.message}`);
    }

    // Send prompt to ComfyUI
    const promptUrl = `${comfyUrl}/prompt`;
    debugLog(`Sending prompt to ${promptUrl}`);
    const promptResponse = await fetch(promptUrl, {
        method: 'POST',
        body: workflowJson,
        headers: { 'Content-Type': 'application/json' },
    });

    if (!promptResponse.ok) {
        const text = await promptResponse.text();
        throw new Error(`ComfyUI prompt failed (${promptResponse.status}): ${text}`);
    }

    const promptData = await promptResponse.json();
    const promptId = promptData.prompt_id;
    debugLog(`ComfyUI prompt ID: ${promptId}`);

    // Poll for completion
    const historyUrl = `${comfyUrl}/history/${promptId}`;
    let item;
    const maxAttempts = 600; // 5 minutes max (1s intervals)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const historyResponse = await fetch(historyUrl);
        if (!historyResponse.ok) {
            throw new Error(`ComfyUI history check failed (${historyResponse.status})`);
        }
        const history = await historyResponse.json();
        item = history[promptId];
        if (item) break;
        if (attempt % 30 === 0) {
            log(`  Waiting for ComfyUI... (${attempt}s)`);
        }
    }

    if (!item) {
        throw new Error('ComfyUI generation timed out');
    }

    if (item.status?.status_str === 'error') {
        const errorMessages = item.status?.messages
            ?.filter(msg => msg[0] === 'execution_error')
            .map(msg => `${msg[1].node_type} [${msg[1].node_id}] ${msg[1].exception_type}: ${msg[1].exception_message}`)
            .join('\n') || '';
        throw new Error(`ComfyUI generation failed:\n${errorMessages}`.trim());
    }

    // Extract image info from outputs
    const outputs = Object.keys(item.outputs).map(key => item.outputs[key]);
    const imgInfo = (outputs.map(o => o.images).flat()[0]) ?? (outputs.map(o => o.gifs).flat()[0]);

    if (!imgInfo) {
        throw new Error('ComfyUI did not return any recognizable outputs');
    }

    // Fetch the actual image
    const imgUrl = `${comfyUrl}/view?filename=${imgInfo.filename}&subfolder=${imgInfo.subfolder}&type=${imgInfo.type}`;
    debugLog(`Fetching image from ${imgUrl}`);
    const imgResponse = await fetch(imgUrl);

    if (!imgResponse.ok) {
        throw new Error(`Failed to fetch generated image (${imgResponse.status})`);
    }

    const format = path.extname(imgInfo.filename).slice(1).toLowerCase() || 'png';
    const imgBuffer = await imgResponse.arrayBuffer();
    const base64Data = Buffer.from(imgBuffer).toString('base64');

    log(`ComfyUI generation complete (${format}, ${base64Data.length} chars base64)`);
    return { format, data: base64Data };
}

/**
 * Step 4: Free ComfyUI VRAM.
 * @param {object} config - Plugin configuration
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 */
async function freeComfyUIVram(config, totalSteps, stepNum) {
    const url = `${config.comfyUrl}/free`;
    log(`Step ${stepNum}/${totalSteps}: Freeing ComfyUI VRAM...`);
    try {
        await apiPost(url, { unload_models: true, free_memory: true });
        log('ComfyUI VRAM freed');
    } catch (error) {
        log(`Warning: Failed to free ComfyUI VRAM: ${error.message}`);
        // Non-critical, continue
    }
}

/**
 * Step 5: Reload the LLM into VRAM.
 * @param {object} config - Plugin configuration
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 * @returns {Promise<object>} Response from llama.cpp
 */
async function reloadLlm(config, totalSteps, stepNum) {
    const modelId = await resolveModelIdentifier(config);
    const url = `${config.llamacppUrl}/models/load`;
    log(`Step ${stepNum}/${totalSteps}: Reloading LLM (${modelId})...`);
    const result = await apiPost(url, { model: modelId });
    debugLog(`LLM reload response: ${JSON.stringify(result)}`);
    if (result.success) {
        log('Waiting for model to fully load...');
        await waitForModelStatus(config.llamacppUrl, modelId, 'loaded', 120);
        log('LLM reloaded successfully');
    }
    return result;
}

/**
 * Step 6: Restore the KV cache from RAM disk.
 * @param {object} config - Plugin configuration
 * @param {number} totalSteps - Total number of steps (for numbering)
 * @param {number} stepNum - Current step number
 * @returns {Promise<object>} Response from llama.cpp
 */
async function restoreKvCache(config, totalSteps, stepNum) {
    const modelId = await resolveModelIdentifier(config);
    const url = `${config.llamacppUrl}/slots/${config.slotNumber}?action=restore`;
    log(`Step ${stepNum}/${totalSteps}: Restoring KV cache from ${config.kvCacheFilename} (model: ${modelId})...`);
    const result = await apiPost(url, { model: modelId, filename: config.kvCacheFilename });
    debugLog(`KV cache restore response: ${JSON.stringify(result)}`);
    if (result.n_restored !== undefined) {
        log(`KV cache restored: ${result.n_restored} tokens`);
    }
    return result;
}

/**
 * Clean up the temporary KV cache file.
 * @param {object} config - Plugin configuration
 */
function cleanupKvCache(config) {
    const savePath = config.slotSavePath || '/dev/shm';
    const cachePath = path.join(savePath, config.kvCacheFilename);
    try {
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
            debugLog(`Cleaned up temp file: ${cachePath}`);
        }
    } catch (error) {
        log(`Warning: Failed to cleanup temp file: ${error.message}`);
    }
}

// ============================================================================
// Main Generation Handler
// ============================================================================

/**
 * Execute the full VRAM management sequence.
 * @param {object} request - Express request object
 * @param {object} response - Express response object
 */
async function handleGenerate(request, response) {
    const startTime = Date.now();
    const config = loadConfig();
    config.comfyUrl = request.body.comfyUrl; // Override from request

    // Determine total steps for consistent numbering
    const kvCacheEnabled = config.saveKvCache !== false;
    const totalSteps = kvCacheEnabled ? 6 : 4;

    log(`=== ComfyMemory generation started (${totalSteps} steps) ===`);
    debugLog(`Request body keys: ${Object.keys(request.body).join(', ')}`);

    let step = 0;

    try {
        // Step: Save KV cache (skip if disabled)
        if (kvCacheEnabled) {
            step++;
            await saveKvCache(config, totalSteps, step);
        } else {
            log(`Step 1/${totalSteps}: Skipping KV cache save (disabled)`);
        }

        // Step: Unload LLM
        step++;
        await unloadLlm(config, totalSteps, step);

        // Step: Generate with ComfyUI (blocks until complete)
        step++;
        const imageData = await generateWithComfyUI(config, request.body.prompt, totalSteps, step);

        // Step: Free ComfyUI VRAM
        step++;
        await freeComfyUIVram(config, totalSteps, step);

        // Step: Reload LLM
        step++;
        await reloadLlm(config, totalSteps, step);

        // Step: Restore KV cache (skip if disabled)
        if (kvCacheEnabled) {
            step++;
            await restoreKvCache(config, totalSteps, step);
        } else {
            log(`Step ${totalSteps}/${totalSteps}: Skipping KV cache restore (disabled)`);
        }

        // Cleanup
        if (kvCacheEnabled) {
            cleanupKvCache(config);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`=== ComfyMemory generation complete (${elapsed}s) ===`);

        return response.send({
            format: imageData.format,
            data: imageData.data,
        });

    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`=== ComfyMemory generation FAILED after ${elapsed}s ===`);
        log(`Error: ${error.message}`);

        // Always try to cleanup on failure
        cleanupKvCache(config);

        // Attempt recovery: reload LLM first, then try to restore KV cache
        // Reuse the original config to preserve the cached _resolvedModelId
        try {
            const recoveryConfig = config; // reuse original config with cached model ID

            // Reload the LLM (needed before KV cache can be restored)
            // reloadLlm waits for the model to be fully loaded internally
            log('Recovery: Attempting to reload LLM...');
            try {
                await reloadLlm(recoveryConfig, 2, 1);
            } catch (loadError) {
                log(`Recovery: Could not reload LLM: ${loadError.message}`);
            }

            // Restore KV cache (skip if disabled)
            if (kvCacheEnabled) {
                log('Recovery: Attempting to restore KV cache...');
                try {
                    await restoreKvCache(recoveryConfig, 2, 2);
                    log('Recovery: KV cache restored successfully');
                } catch (restoreError) {
                    log(`Recovery: Could not restore KV cache: ${restoreError.message}`);
                }
            } else {
                log('Recovery: Skipping KV cache restore (disabled)');
            }

            log('Recovery complete');
        } catch (recoveryError) {
            log(`Recovery failed: ${recoveryError.message}`);
        }

        return response.status(500).send(error.message);
    }
}

/**
 * Handle config GET request.
 * @param {object} _request - Express request object
 * @param {object} response - Express response object
 */
function handleGetConfig(_request, response) {
    const config = loadConfig();
    return response.send(config);
}

/**
 * Handle config POST request.
 * @param {object} request - Express request object
 * @param {object} response - Express response object
 */
function handleSetConfig(request, response) {
    const newConfig = { ...loadConfig(), ...request.body };
    saveConfig(newConfig);
    log('Configuration updated');
    return response.send({ success: true, config: newConfig });
}

// ============================================================================
// Plugin Initialization
// ============================================================================

/**
 * Initialize the plugin and register routes.
 * @param {import('express').Router} router - Express router
 */
export async function init(router) {
    log('ComfyMemory server plugin initializing...');

    // Main generation endpoint
    router.post('/generate', handleGenerate);

    // Configuration endpoints
    router.get('/config', handleGetConfig);
    router.post('/config', handleSetConfig);

    log('ComfyMemory server plugin initialized');
}

/**
 * Cleanup function called on server shutdown.
 */
export async function exit() {
    log('ComfyMemory server plugin shutting down...');
    // Cleanup any lingering temp files
    const config = loadConfig();
    cleanupKvCache(config);
}
