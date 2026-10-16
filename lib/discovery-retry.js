// lib/discovery-retry.js
'use strict';

// Startup discovery retry schedule: quick early retries for transient Kraken errors,
// then a steady 5-minute cadence until it succeeds.
const DISCOVERY_RETRY_DELAYS_MS = [30000, 60000, 120000];
const DISCOVERY_RETRY_STEADY_MS = 300000;
// Discovery that returns no devices at all is checked again this many times, on the same
// delays (about 18 minutes in all), before the node accepts that there is no charger.
const EMPTY_DEVICES_MAX_RETRIES = 6;

function discoveryRetryDelay(attempt) {
    return attempt < DISCOVERY_RETRY_DELAYS_MS.length ? DISCOVERY_RETRY_DELAYS_MS[attempt] : DISCOVERY_RETRY_STEADY_MS;
}

module.exports = { DISCOVERY_RETRY_DELAYS_MS, DISCOVERY_RETRY_STEADY_MS, EMPTY_DEVICES_MAX_RETRIES, discoveryRetryDelay };
