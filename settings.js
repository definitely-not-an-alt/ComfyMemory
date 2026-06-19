/**
 * ComfyMemory Settings Module
 *
 * Handles rendering and managing the settings UI.
 */

/** @type {SillyTavernContext|null} */
let context = null;
/** @type {Object|null} */
let settings = null;

/**
 * Initialize the settings module.
 * @param {Object} ctx - SillyTavern context
 * @param {Object} extSettings - Extension settings object
 */
export function renderSettings(ctx, extSettings) {
    context = ctx;
    settings = extSettings;

    // Wire up event handlers
    $('#comfymemory_enabled').on('change', onEnabledChange);
    $('#comfymemory_save_kv_cache').on('change', onSaveKvCacheChange);
    $('#comfymemory_debug').on('change', onDebugChange);
    $('#comfymemory_sync_server').on('click', onSyncServer);
    $('#comfymemory_llamacpp_url').on('input', onLlamacppUrlInput);
    $('#comfymemory_model_id').on('input', onModelIdInput);
    $('#comfymemory_slot_save_path').on('input', onSlotSavePathInput);
    $('#comfymemory_kv_cache_filename').on('input', onKvCacheFilenameInput);
    $('#comfymemory_slot_number').on('input', onSlotNumberInput);

    // Populate values from settings
    populateSettings();

    // Check server plugin status on load
    checkServerStatus();

    // Listen for SD source changes to update interceptor
    if (context?.eventSource) {
        context.eventSource.on(context.event_types.SETTINGS_UPDATED, () => {
            setTimeout(() => {
                const { updateInterceptor } = getModuleExports();
                if (updateInterceptor) updateInterceptor();
            }, 100);
        });
    }
}

/**
 * Populate UI elements with current settings values.
 */
function populateSettings() {
    if (!settings) return;

    $('#comfymemory_enabled').prop('checked', !!settings.enabled);
    $('#comfymemory_save_kv_cache').prop('checked', settings.saveKvCache !== false);
    $('#comfymemory_debug').prop('checked', !!settings.debug);
}

/**
 * Check if the server plugin is accessible and load its config.
 */
async function checkServerStatus() {
    const statusEl = $('#comfymemory_status');
    statusEl.html('<span style="color: #888;">Checking server plugin...</span>');

    try {
        const response = await fetch('/api/plugins/comfymemory/config', {
            headers: context.getRequestHeaders(),
        });

        if (response.ok) {
            const config = await response.json();
            // Populate UI from server config
            $('#comfymemory_llamacpp_url').val(config.llamacppUrl || 'http://127.0.0.1:8080');
            $('#comfymemory_model_id').val(config.modelIdentifier || '');
            $('#comfymemory_save_kv_cache').prop('checked', config.saveKvCache !== false);
            $('#comfymemory_slot_save_path').val(config.slotSavePath || '/dev/shm');
            $('#comfymemory_kv_cache_filename').val(config.kvCacheFilename || 'st_active_chat.bin');
            $('#comfymemory_slot_number').val(config.slotNumber ?? 0);

            statusEl.html('<span style="color: #4caf50;">✓ Server plugin connected</span>');
        } else {
            statusEl.html(`
                <span style="color: #f44336;">✗ Server plugin not responding (${response.status})</span>
                <p class="comfymemory_hint" style="margin-top: 4px;">
                    Make sure <code>enableServerPlugins: true</code> is set in SillyTavern config.yaml,
                    then restart SillyTavern.
                </p>
            `);
        }
    } catch (error) {
        statusEl.html(`
            <span style="color: #f44336;">✗ Server plugin not reachable</span>
            <p class="comfymemory_hint" style="margin-top: 4px;">
                Make sure <code>enableServerPlugins: true</code> is set in SillyTavern config.yaml,
                then restart SillyTavern.
            </p>
        `);
    }
}

/**
 * Handle the enabled toggle change.
 */
function onEnabledChange() {
    if (!settings || !context) return;

    settings.enabled = !!$('#comfymemory_enabled').prop('checked');
    context.saveSettingsDebounced();

    const { updateInterceptor } = getModuleExports();
    if (updateInterceptor) updateInterceptor();

    if (settings.enabled) {
        toastr.info('ComfyMemory enabled', 'ComfyMemory');
    } else {
        toastr.info('ComfyMemory disabled', 'ComfyMemory');
    }
}

/**
 * Handle the KV cache save/restore toggle change.
 */
function onSaveKvCacheChange() {
    if (!settings || !context) return;

    settings.saveKvCache = !!$('#comfymemory_save_kv_cache').prop('checked');
    context.saveSettingsDebounced();
}

/**
 * Handle the debug toggle change.
 */
function onDebugChange() {
    if (!settings || !context) return;

    settings.debug = !!$('#comfymemory_debug').prop('checked');
    context.saveSettingsDebounced();
}

/**
 * Sync local settings with the server plugin configuration.
 */
async function onSyncServer() {
    if (!context) return;

    const statusEl = $('#comfymemory_status');
    statusEl.html('<span style="color: #888;">Syncing...</span>');

    try {
        const llamacppUrl = $('#comfymemory_llamacpp_url').val().trim();
        const modelId = $('#comfymemory_model_id').val().trim();
        const slotSavePath = $('#comfymemory_slot_save_path').val().trim();
        const kvCacheFilename = $('#comfymemory_kv_cache_filename').val().trim();
        const slotNumber = parseInt($('#comfymemory_slot_number').val(), 10) || 0;

        const response = await fetch('/api/plugins/comfymemory/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...context.getRequestHeaders(),
            },
            body: JSON.stringify({
                llamacppUrl: llamacppUrl,
                modelIdentifier: modelId,
                saveKvCache: $('#comfymemory_save_kv_cache').prop('checked'),
                slotSavePath: slotSavePath,
                kvCacheFilename: kvCacheFilename,
                slotNumber: slotNumber,
                debug: settings?.debug || false,
            }),
        });

        if (response.ok) {
            statusEl.html('<span style="color: #4caf50;">✓ Synced to server</span>');
            toastr.success('Server configuration synced', 'ComfyMemory');
        } else {
            const text = await response.text();
            statusEl.html(`<span style="color: #f44336;">✗ Sync failed (${response.status})</span>`);
            toastr.error(`Failed to sync: ${text}`, 'ComfyMemory');
        }
    } catch (error) {
        statusEl.html('<span style="color: #f44336;">✗ Sync failed</span>');
        toastr.error(`Sync failed: ${error.message}`, 'ComfyMemory');
    }
}

/**
 * Handle llama.cpp URL input.
 */
function onLlamacppUrlInput() {
    // Value is saved on sync, not on input
}

/**
 * Handle model ID input.
 */
function onModelIdInput() {
    // Value is saved on sync, not on input
}

/**
 * Handle slot save path input.
 */
function onSlotSavePathInput() {
    // Value is saved on sync, not on input
}

/**
 * Handle KV cache filename input.
 */
function onKvCacheFilenameInput() {
    // Value is saved on sync, not on input
}

/**
 * Handle slot number input.
 */
function onSlotNumberInput() {
    // Value is saved on sync, not on input
}

/**
 * Get exports from the main module for cross-module communication.
 * @returns {Object} Module exports
 */
function getModuleExports() {
    return window.__comfymemory_exports || {};
}
