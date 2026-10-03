'use strict';
const { discoveryRetryDelay, DISCOVERY_RETRY_DELAYS_MS, DISCOVERY_RETRY_STEADY_MS } = require('../lib/discovery-retry');

test('backs off 30s, 60s, 120s, then every 5 min', () => {
    expect(DISCOVERY_RETRY_DELAYS_MS).toEqual([30000, 60000, 120000]);
    expect(DISCOVERY_RETRY_STEADY_MS).toBe(300000);
    expect([0, 1, 2, 3, 4, 50].map(discoveryRetryDelay)).toEqual([30000, 60000, 120000, 300000, 300000, 300000]);
});
