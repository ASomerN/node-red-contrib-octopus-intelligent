// __tests__/discovery-device-id.test.js
'use strict';
/**
 * Review 2026-10-09 #6: discovery found the device id but never stored it for the writes. When
 * the startup device fetch failed (for example a KT-CT-4360 on the device status) and no
 * charging poll had worked yet, Smart Charging, Charge Cap and preference changes all failed
 * with "Device ID not available". Discovery now seeds the id.
 * On 1.7 discovery picks the LIVE EV while the startup fetch (which runs first, before
 * preferredEvId is known) takes the first one listed, possibly a RETIRED one: discovery's id
 * replaces it (review 2026-10-09 round 5, A6).
 * Kraken answers HTTP 200 with GraphQL errors.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createHarness, DISCOVERED } = require('./helpers/real-node');

// The startup getDevices selects status { isSuspended }: an error there nulls the device list.
const STATUS_FAILED = {
    data: { devices: null },
    errors: [{
        message: 'Device status could not be fetched.',
        path: ['devices', 0, 'status'],
        extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' },
    }],
};

let h;

async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

const chargeCapWrites = () => graphqlPost.mock.calls
    .filter(([b]) => /updateIsChargingDurationCapped/.test(b.query))
    .map(([b]) => b.variables.input.deviceId);

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('a failed startup device fetch: the device id from discovery is used for a write', async () => {
    h.replies.status = () => STATUS_FAILED;
    h.build();
    await h.advance(2100); // device fetch fails at 1.5 s, discovery answers at 2 s; no poll yet
    expect(h.warns.some((w) => /Failed to fetch device ID at startup/.test(w))).toBe(true);

    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await flush();

    expect(h.warns.filter((w) => /Device ID not available/.test(w))).toEqual([]);
    expect(chargeCapWrites()).toEqual([DISCOVERED.deviceId]);
});

test('the device discovery picked replaces the one the startup fetch found first', async () => {
    discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: 'dev-other' });
    h.build();
    await h.advance(2100); // the startup device fetch found dev-1 first, then discovery chose dev-other

    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await flush();

    expect(chargeCapWrites()).toEqual(['dev-other']);
});

// Second-eyes review D: discovery asked again without the status; the node warns once, and the
// charging poll's own status warning does not repeat it.
test('discovery that could not read the status warns once, shared with the charging poll', async () => {
    discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceSuspended: null, statusErrorCode: 'KT-CT-4360' });
    h.replies.devices = (query) => (/isSuspended/.test(query) ? STATUS_FAILED : { data: { devices: [{ ...require('./helpers/real-node').pollDevice(), smartStatus: undefined }] } });
    h.build();
    await h.advance(2100);
    await h.onTick();
    const warned = h.warns.filter((w) => /Smart charging state unavailable/.test(w));
    expect(warned).toEqual(['Smart charging state unavailable (KT-CT-4360) - keeping the last value until Octopus returns it']);
});
