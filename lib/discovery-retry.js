// lib/discovery-retry.js
'use strict';

// Startup discovery retry schedule: quick early retries for transient Kraken errors,
// then a steady 5-minute cadence until it succeeds.
const DISCOVERY_RETRY_DELAYS_MS = [30000, 60000, 120000];
const DISCOVERY_RETRY_STEADY_MS = 300000;

function discoveryRetryDelay(attempt) {
    return attempt < DISCOVERY_RETRY_DELAYS_MS.length ? DISCOVERY_RETRY_DELAYS_MS[attempt] : DISCOVERY_RETRY_STEADY_MS;
}

module.exports = { DISCOVERY_RETRY_DELAYS_MS, DISCOVERY_RETRY_STEADY_MS, discoveryRetryDelay };
