/**
 * ComfyMemory Client Extension
 *
 * Intercepts ComfyUI image generation requests and routes them through
 * the ComfyMemory server plugin, which manages VRAM by unloading/reloading
 * the LLM to prevent OOM errors on dual-GPU setups.
 *
 * VRAM Management Sequence:
 * 1. Save llama.cpp KV cache to /dev/shm
 * 2. Unload LLM from VRAM
 * 3. Forward generation request to ComfyUI (blocks until complete)
 * 4. Free ComfyUI VRAM
 * 5. Reload LLM into VRAM
 * 6. Restore KV cache
 * 7. Clean up temp file
 */

import { renderSettings } from './settings.js';

/** @type {SillyTavernContext|null} */
let context = null;
/** @type {Object|null} */
let extensionSettings = null;

// Original fetch reference for restoration
let originalFetch = null;
let interceptorActive = false;

// ============================================================================
// Activation
// ============================================================================

/**
 * Called when the extension is activated by SillyTavern.
 */
export async function onActivate() {
    console.log('[ComfyMemory] Extension activating...');

    try {
        context = SillyTavern.getContext();
        extensionSettings = context.extensionSettings;

        // Initialize default settings
        if (!extensionSettings['comfymemory']) {
            extensionSettings['comfymemory'] = {
                enabled: false,
                debug: false,
            };
        }

        // Render settings panel
        try {
            const settingsHtml = await context.renderExtensionTemplateAsync(
                'third-party/comfymemory',
                'settings',
            );
            $('#extensions_settings').append(settingsHtml);
            renderSettings(context, extensionSettings['comfymemory']);
        } catch (e) {
            console.error('[ComfyMemory] Failed to render settings:', e);
        }

        // Activate/deactivate interceptor based on current setting
        updateInterceptor();

        console.log('[ComfyMemory] Activated.');

        // Export functions for cross-module communication
        window.__comfymemory_exports = {
            updateInterceptor,
            disableInterceptor,
        };
    } catch (error) {
        console.error('[ComfyMemory] Activation failed:', error);
    }
}

// ============================================================================
// Deactivation & Cleanup
// ============================================================================

/**
 * Called when the extension is disabled.
 */
export function onDisable() {
    disableInterceptor();
    console.log('[ComfyMemory] Disabled.');
}

/**
 * Called when the user clicks "Clean extension data".
 */
export async function onClean() {
    if (extensionSettings && extensionSettings['comfymemory']) {
        delete extensionSettings['comfymemory'];
        if (context) {
            context.saveSettingsDebounced();
        }
    }
    disableInterceptor();
    console.log('[ComfyMemory] Data cleaned.');
}

// ============================================================================
// Fetch Interceptor
// ============================================================================

/**
 * Enable the fetch interceptor that routes ComfyUI generation through our server plugin.
 */
function enableInterceptor() {
    if (interceptorActive) return;

    originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);

        if (url === '/api/sd/comfy/generate') {
            return interceptComfyGenerate(args);
        }

        return originalFetch(...args);
    };

    interceptorActive = true;
    log('Fetch interceptor enabled');
}

/**
 * Disable the fetch interceptor and restore original fetch.
 */
export function disableInterceptor() {
    if (!interceptorActive) return;

    if (originalFetch) {
        window.fetch = originalFetch;
        originalFetch = null;
    }

    interceptorActive = false;
    log('Fetch interceptor disabled');
}

/**
 * Update the interceptor state based on current settings.
 */
export function updateInterceptor() {
    const settings = extensionSettings?.['comfymemory'] || {};
    const comfyEnabled = isComfySource();

    if (settings.enabled && comfyEnabled) {
        enableInterceptor();
    } else {
        disableInterceptor();
    }
}

/**
 * Check if the current SD source is ComfyUI standard.
 * @returns {boolean} True if source is comfy with standard type
 */
function isComfySource() {
    const sdSettings = extensionSettings?.['sd'] || {};
    return sdSettings.source === 'comfy' && sdSettings.comfy_type === 'standard';
}

/**
 * Intercept a ComfyUI generation request and route it through our server plugin.
 * @param {Array} args - Original fetch arguments [url, options]
 * @returns {Promise<Response>} Response mimicking the original fetch response
 */
async function interceptComfyGenerate(args) {
    const options = args[1] || {};
    const settings = extensionSettings?.['comfymemory'] || {};

    // Parse the request body
    let body;
    try {
        body = JSON.parse(options.body || '{}');
    } catch {
        log('Error: Could not parse request body, passing through');
        return originalFetch.apply(window, args);
    }

    const comfyUrl = body.url;
    const prompt = body.prompt; // This is the workflow JSON string

    if (!comfyUrl || !prompt) {
        log('Error: Missing comfyUrl or prompt in request body, passing through');
        return originalFetch.apply(window, args);
    }

    log(`Intercepting ComfyUI generation request`);
    debug(`ComfyUI URL: ${comfyUrl}`);
    debug(`Signal attached: ${!!options.signal}`);

    try {
        // Send to our server plugin for VRAM-managed generation
        const serverResponse = await originalFetch('/api/plugins/comfymemory/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...context.getRequestHeaders(),
            },
            signal: options.signal,
            body: JSON.stringify({
                comfyUrl: comfyUrl,
                prompt: prompt,
            }),
        });

        if (!serverResponse.ok) {
            const errorText = await serverResponse.text();
            throw new Error(`ComfyMemory server error (${serverResponse.status}): ${errorText}`);
        }

        const result = await serverResponse.json();
        log(`Generation complete: ${result.format}, ${result.data?.length || 0} chars`);

        // Return a Response object mimicking the original fetch response
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });

    } catch (error) {
        if (error.name === 'AbortError') {
            // Re-throw abort errors so the SD extension handles them properly
            throw error;
        }

        console.error('[ComfyMemory] Generation failed:', error);
        toastr.error(`ComfyMemory generation failed: ${error.message}`, 'ComfyMemory');

        // Return error response
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
}

// ============================================================================
// Logging
// ============================================================================

function log(message) {
    console.log(`[ComfyMemory] ${message}`);
}

function debug(message) {
    const settings = extensionSettings?.['comfymemory'] || {};
    if (settings.debug) {
        console.log(`[ComfyMemory DEBUG] ${message}`);
    }
}
