// __tests__/smart-charging-poll.test.js
'use strict';
/**
 * Code review 2026-10-06 F8: the smart-charging (isSuspended) state was read once at startup
 * and never refreshed, and the Home Assistant switch topic was never republished after a
 * poll. A change made in the Octopus app never reached HA, and the 3 s startup republish
 * raced the startup device fetch (1.5 s) and discovery, so a slow start left the switch
 * unknown. The charging poll now reads status { isSuspended } (alias smartStatus) and
 * republishes the switch when the value changes.
 *
 * Schema review 2026-10-09: `status` is non-null inside a non-null device list, so an error
 * on status nulls the whole `devices` list (preferences and Charge Cap included). The poll
 * then asks once more without status and keeps the last switch state.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createHarness, slot, pollDevice, DISCOVERED } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [slot('2026-09-30T03:00:00Z', '2026-09-30T03:30:00Z')];
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('the charging poll asks for status { isSuspended } under its own alias', async () => {
    await h.start();
    const pollQuery = graphqlPost.mock.calls.map(([b]) => b.query).find((q) => /SmartFlexDevicePreferences/.test(q));
    // v1.7: the same selection also reads currentState for boosting.
    expect(pollQuery).toMatch(/smartStatus:\s*status\s*\{\s*isSuspended\s+currentState\s*\}/);
});

test('a change made in the Octopus app reaches the HA switch on the next poll', async () => {
    await h.start();
    expect(h.published('smart_charging')).toEqual(['ON']);
    expect(h.lastPayload().smart_charging).toBe(true);

    h.replies.devices = () => ({ data: { devices: [pollDevice({ suspended: true })] } });
    await h.runUntil('2026-09-30T01:05:02Z');

    expect(h.published('smart_charging')).toEqual(['ON', 'OFF']);
    expect(h.publishCalls('smart_charging').pop()[2]).toEqual({ retain: true });
    expect(h.lastPayload().smart_charging).toBe(false);

    await h.runUntil('2026-09-30T01:10:02Z'); // unchanged: not republished
    expect(h.published('smart_charging')).toEqual(['ON', 'OFF']);
});

test('slow discovery and a failed startup device fetch still publish the switch state', async () => {
    h.replies.status = () => ({ errors: [{ message: 'Device status could not be fetched.', path: ['devices', 0, 'status'], extensions: { errorCode: 'KT-CT-4360' } }], data: null });
    discoverProducts.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(DISCOVERED), 1500)));
    h.build();
    await h.advance(3600); // discovery answers at 3.5 s, after the old 3 s republish

    expect(h.published('smart_charging')).toEqual(['ON']);
});

test('an error on isSuspended alone keeps the poll and the last switch state', async () => {
    await h.start();
    h.plan = [slot('2026-09-30T04:00:00Z', '2026-09-30T04:30:00Z')];
    h.replies.devices = () => ({
        data: { devices: [{ ...pollDevice(), smartStatus: { isSuspended: null } }] },
        errors: [{ message: 'Device status could not be fetched.', path: ['devices', 0, 'smartStatus', 'isSuspended'], extensions: { errorCode: 'KT-CT-4360' } }],
    });
    await h.runUntil('2026-09-30T01:05:02Z');

    const p = h.pollSends().pop().payload;
    expect(p.intelligent_error).toBeNull();
    expect(p.slot1_start_raw).toBe('2026-09-30T04:00:00Z');
    expect(p.smart_charging).toBe(true);
    expect(h.published('smart_charging')).toEqual(['ON']);
});

// Kraken partial error on the device status. status is non-null on the device and the list
// items are non-null, so the error nulls the nearest nullable ancestor: `devices` itself.
const STATUS_4360 = {
    message: 'Device status could not be fetched.',
    locations: [{ line: 23, column: 9 }],
    path: ['devices', 0, 'smartStatus'],
    extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' },
};
const statusNulled = () => ({ data: { devices: null }, errors: [STATUS_4360] });
// The device as the ask without status returns it (no smartStatus key at all).
function noStatusDevice(opts) {
    const d = pollDevice(opts);
    delete d.smartStatus;
    return d;
}
// Octopus fails the status but answers the same query without it.
function statusBroken(opts) {
    return (query) => (/smartStatus/.test(query) ? statusNulled() : { data: { devices: [noStatusDevice(opts)] } });
}
const devicesQueries = () => graphqlPost.mock.calls.map(([b]) => b.query)
    .filter((q) => /getDevices/.test(q) && /SmartFlexDevicePreferences/.test(q));

test('a status error that nulls the device list: the poll asks again without status and keeps the rest', async () => {
    await h.start();
    h.plan = [slot('2026-09-30T04:00:00Z', '2026-09-30T04:30:00Z')];
    // Octopus also has a new target and Charge Cap off: both must come through.
    h.replies.devices = (query) => {
        if (/smartStatus/.test(query)) return statusNulled();
        const d = noStatusDevice({ max: 70, time: '06:30:00' });
        d.chargeCap = { isChargingDurationCapped: 'DISABLED' };
        return { data: { devices: [d] } };
    };
    const before = devicesQueries().length;
    await h.runUntil('2026-09-30T01:05:02Z');

    const asked = devicesQueries().slice(before);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/smartStatus/);
    expect(asked[1]).not.toMatch(/status/);
    const dispatchCalls = graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query));
    expect(dispatchCalls.pop()[0].variables).toEqual({ deviceId: 'dev-1' });

    const p = h.pollSends().pop().payload;
    expect(p.intelligent_error).toBeNull();
    expect(p.slot1_start_raw).toBe('2026-09-30T04:00:00Z');
    expect(p.confirmed_limit).toBe(70);
    expect(p.confirmed_time).toBe('06:30');
    expect(p.charge_cap).toBe(false);
    // The switch keeps its last value: nothing new published, payload unchanged.
    expect(p.smart_charging).toBe(true);
    expect(h.published('smart_charging')).toEqual(['ON']);
    expect(h.warns.filter((w) => /Smart charging state unavailable \(KT-CT-4360\)/.test(w))).toHaveLength(1);
    expect(h.warns.filter((w) => /Charging poll failed/.test(w))).toEqual([]);
});

test('with no cached device id, the ask without status still finds the device', async () => {
    // Startup device fetch fails and discovery has no device id: only the poll can find it.
    h.replies.status = () => ({ data: { devices: null }, errors: [{ ...STATUS_4360, path: ['devices', 0, 'status'] }] });
    discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: null, deviceSuspended: null });
    h.plan = [slot('2026-09-30T04:00:00Z', '2026-09-30T04:30:00Z')];
    h.replies.devices = statusBroken();
    await h.start();

    const dispatchCalls = graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query));
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0][0].variables).toEqual({ deviceId: 'dev-1' });
    const p = h.pollSends().pop().payload;
    expect(p.intelligent_error).toBeNull();
    expect(p.slot1_start_raw).toBe('2026-09-30T04:00:00Z');
    expect(p.confirmed_limit).toBe(90);
});

test('the status warning is logged once per run of failures, and again after a good read', async () => {
    await h.start();
    h.replies.devices = statusBroken();
    await h.runUntil('2026-09-30T01:10:02Z'); // two polls with the status failing
    const warned = () => h.warns.filter((w) => /Smart charging state unavailable/.test(w)).length;
    expect(warned()).toBe(1);

    h.replies.devices = () => ({ data: { devices: [pollDevice({ suspended: true })] } });
    await h.runUntil('2026-09-30T01:15:02Z'); // status read again
    expect(h.lastPayload().smart_charging).toBe(false);
    expect(h.published('smart_charging')).toEqual(['ON', 'OFF']);

    h.replies.devices = statusBroken();
    await h.runUntil('2026-09-30T01:20:02Z');
    expect(warned()).toBe(2);
    expect(h.lastPayload().smart_charging).toBe(false);
});

test('if the ask without status fails too, the poll fails with that short error', async () => {
    await h.start();
    const before = graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query)).length;
    h.replies.devices = (query) => (/smartStatus/.test(query) ? statusNulled() : {
        data: null,
        errors: [{ message: 'Unauthorized.', path: ['devices'], extensions: { errorType: 'AUTHORIZATION', errorCode: 'KT-CT-1111' } }],
    });
    await h.runUntil('2026-09-30T01:05:02Z');

    expect(graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query)).length).toBe(before);
    expect(h.pollSends().pop().payload.intelligent_error).toBe('KT-CT-1111: Unauthorized');
});

test('a poll during the switch verification does not flip the switch back', async () => {
    await h.start();
    h.node._handlers.input({ payload: { set_smart_charging: false } });
    await h.advance(0);
    expect(h.published('smart_charging')).toEqual(['ON', 'OFF']);

    h.node._handlers.input({ payload: {} }); // manual refresh; Octopus still reports the old state
    await h.advance(1000);
    await h.onTick();

    expect(h.published('smart_charging')).toEqual(['ON', 'OFF']);
    expect(h.lastPayload().smart_charging).toBe(false);
});
