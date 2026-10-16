// __tests__/net-findings-startup.test.js
'use strict';
/**
 * FINDING tests from the network sweep (test/v1.6.2-network, __tests__/net-discovery-startup.test.js),
 * ported un-skipped as they are fixed: startup discovery (REAL lib/discovery.js) and the startup
 * device fetch on the REAL node over the fake https (helpers/fake-https.js).
 */
jest.mock('https', () => require('./helpers/fake-https').createFakeHttps());
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

// Each test runs minutes of fake time through the real once-a-second scheduler.
jest.setTimeout(30000);

const { createNetHarness, trackEscapes } = require('./helpers/network-node');

const T = (hms) => `2026-09-30T${hms}Z`;

let h;
let escapes;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T('01:00:00')));
    h = createNetHarness();
    escapes = trackEscapes();
});

afterEach(() => {
    h.close();
    escapes.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    expect(escapes.seen).toEqual([]);
});

describe('startup discovery', () => {
    beforeEach(() => {
        h.useRealDiscovery();
    });

    // F4: lib/discovery.js did not know the node closed. When its token request answered after
    // close, it still sent the discover query to Octopus.
    test('discovery sends no query after the node is closed', async () => {
        h.build();
        await h.at(T('01:00:01.600'));            // the startup device fetch is done
        const gate = h.net.hold('obtainToken');    // discovery's own token request (2 s)
        await h.at(T('01:00:02.100'));
        expect(gate.call).not.toBeNull();
        const after = await h.closeAndDrain(() => gate.release('ok'));
        expect(after.requests).toEqual([]);
        expect(after.timers).toBe(0);
        expect(after.warns).toEqual([]);
    });
});

describe('startup device fetch', () => {
    // F3: fetchDeviceId had no closed check. When its token request answered after close, the
    // node still sent getDevices, published the retained smart_charging topic and logged.
    test('a startup device fetch that answers after close sends nothing more', async () => {
        const gate = h.net.hold('obtainToken');    // the device fetch's token request (1.5 s)
        h.build();
        await h.at(T('01:00:01.600'));
        expect(gate.call).not.toBeNull();
        const after = await h.closeAndDrain(() => gate.release('ok'));
        expect(after.requests).toEqual([]);
        expect(after.publishes).toEqual([]);
        expect(after.logs).toEqual([]);
        expect(after.warns).toEqual([]);
        expect(after.timers).toBe(0);
    });

    test('a device reply that answers after close publishes and logs nothing', async () => {
        const gate = h.net.hold('getDevicesStatus');
        h.build();
        await h.at(T('01:00:01.600'));
        expect(gate.call).not.toBeNull();
        const after = await h.closeAndDrain(() => gate.release('ok'));
        expect(after.publishes).toEqual([]);
        expect(after.logs).toEqual([]);
        expect(after.warns).toEqual([]);
    });
});

describe('long errors in the log', () => {
    // F9: a very long Kraken error made a ~8 kB warning, cut by the masking at 8192 characters,
    // so ". Retrying in 30s." was lost.
    test('a long discovery error gives a short warning that still says when it retries', async () => {
        h.useRealDiscovery();
        h.net.fail('discover', 'errorsLong', { times: 1 });
        h.build();
        await h.at(T('01:00:03'));
        const [warn] = h.warns.filter((w) => /^V2 discovery failed: /.test(w));
        expect(warn).toMatch(/\. Retrying in 30s\.$/);
        expect(warn.length).toBeLessThan(1000);
        h.expectRedacted();
    });

    test('a long startup device fetch error gives a short warning that keeps its end', async () => {
        h.net.fail('getDevicesStatus', 'errorsLong', { times: 1 });
        h.build();
        await h.at(T('01:00:03'));
        const [warn] = h.warns.filter((w) => /^Failed to fetch device ID at startup: /.test(w));
        expect(warn).toMatch(/\. Smart charging toggle unavailable until the first charging poll\.$/);
        expect(warn.length).toBeLessThanOrEqual(500);
        h.expectRedacted();
    });

    test('every log line is cut to 500 characters, keeping its start and its end, and shows the key as it is', () => {
        h.build();
        h.node.warn(`start ${'x'.repeat(3000)} sk_test_fix163 end. Retrying in 30s.`);
        const line = h.warns[h.warns.length - 1];
        expect(line).toHaveLength(500);
        expect(line.startsWith('start xxx')).toBe(true);
        expect(line.endsWith('sk_test_fix163 end. Retrying in 30s.')).toBe(true);
        h.node.log('short line');
        expect(h.logs[h.logs.length - 1]).toBe('short line');
    });
});
