// __tests__/charging-poll-retry.test.js
'use strict';
/**
 * 1.6.2: the REAL node retries the charging (intelligent) poll quickly when Octopus answers
 * KT-CT-4340 (flexPlannedDispatches) or KT-CT-4339 (device preferences): after 30 s, 1 min,
 * 2 min, then every 2 min until it works or the next normal poll is due. At most 3
 * flexPlannedDispatches queries in any 60 s, counting pre-validation. One warning per failed
 * poll or retry, one log line on recovery. Kraken answers HTTP 200 with GraphQL errors.
 * The scheduler is driven once per second by hand, as the real scheduler does.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};
const DEVICES = [{
    id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
    preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '04:00:00', max: 90 }] },
    chargeCap: { isChargingDurationCapped: 'ENABLED' },
}];
const slot = (start, end) => ({ start, end, type: 'SMART', energyAddedKwh: '3.0' });
const PLAN = [slot('2026-09-30T03:00:00Z', '2026-09-30T03:30:00Z')];
const NEW_PLAN = [slot('2026-09-30T03:30:00Z', '2026-09-30T04:00:00Z')];
const ERR_4340 = [{ message: 'Unable to fetch planned dispatches.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];
const FAILED_4340 = 'Charging poll failed: KT-CT-4340 Unable to fetch planned dispatches';

let plan;
let dispatchErrors;
let devicesReply;
let dispatchTimes;
let devicesTimes;
let sends;
let statuses;
let warns;
let logs;
let onTick;
let node;

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n, config) {
                const handlers = {};
                const store = {};
                n.id = config.id;
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_retry' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = (m) => { logs.push(String(m)); };
                n.warn = (m) => { warns.push(String(m)); };
                n.error = () => {};
                n.status = (s) => { statuses.push(s); };
                n.send = (msg) => { sends.push(msg); };
                n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: () => null,
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED);
    return new NodeCtor({ id: 'oi-retry', accountNumber: 'A-RETRY162', enableMqtt: false, refreshInterval: 5 });
}

const at = (iso) => Date.parse(iso);
const pollSends = () => sends.filter((m) => m.payload && !m.debug && 'intelligent_error' in m.payload);
const lastPoll = () => pollSends().pop().payload;
const failWarns = () => warns.filter((w) => /^Charging poll failed/.test(w));
const recoveryLogs = () => logs.filter((l) => /^Charging poll recovered/.test(l));
// Seconds after `iso` of every dispatch query made after it.
const dispatchSecondsAfter = (iso) => dispatchTimes.filter((t) => t >= at(iso)).map((t) => Math.round((t - at(iso)) / 1000));

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; statuses = []; warns = []; logs = [];
    dispatchTimes = []; devicesTimes = [];
    plan = PLAN; dispatchErrors = undefined; devicesReply = undefined;
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) {
            // only the charging poll's devices query asks for preferences
            if (/SmartFlexDevicePreferences/.test(body.query)) devicesTimes.push(Date.now());
            return { data: devicesReply || { data: { devices: DEVICES } }, status: 200 };
        }
        if (/getDispatches/.test(body.query)) {
            dispatchTimes.push(Date.now());
            if (dispatchErrors) return { data: { errors: dispatchErrors, data: { flexPlannedDispatches: null } }, status: 200 };
            return { data: { data: { flexPlannedDispatches: plan } }, status: 200 };
        }
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });
});

afterEach(() => {
    if (node) node._handlers.close();
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

// Build the node and run the first poll at 01:00:02.1.
async function start() {
    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100);
    await onTick();
}

// Run the scheduler once per second up to `iso`, as the real scheduler does.
async function runUntil(iso) {
    while (Date.now() < at(iso)) {
        await jest.advanceTimersByTimeAsync(1000);
        await onTick();
    }
}

describe('quick retry on KT-CT-4340', () => {
    test('retries the charging poll after 30s, 1 min and 2 min, then waits for the normal poll', async () => {
        await start();
        expect(lastPoll().intelligent_error).toBeNull();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:11:00Z');

        // 01:05:00 normal poll fails; retries at +30, +90, +210 s; +330 s would pass the
        // 01:10:00 normal poll, which runs instead and starts a new set of retries.
        expect(dispatchSecondsAfter('2026-09-30T01:05:00Z')).toEqual([0, 30, 90, 210, 300, 330]);
        // the retries poll the charging category alone: one devices query per dispatch query
        expect(devicesTimes.filter((t) => t >= at('2026-09-30T01:05:00Z'))).toHaveLength(6);
    });

    test('logs one warning per failed poll and retry, naming the code, retry number and delay', async () => {
        await start();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:10:01Z');

        expect(failWarns()).toEqual([
            `${FAILED_4340} (retry 1 in 30s)`,
            `${FAILED_4340} (retry 2 in 60s)`,
            `${FAILED_4340} (retry 3 in 120s)`,
            `${FAILED_4340} (next poll in 90s)`,
            `${FAILED_4340} (retry 1 in 30s)`,
        ]);
        expect(recoveryLogs()).toEqual([]);
    });

    test('a success during the retries updates the plan, logs the recovery once and stops the retries', async () => {
        await start();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:08:00Z');
        expect(failWarns()).toHaveLength(3);

        dispatchErrors = undefined; // Octopus recovers before retry 3 (01:08:30)
        plan = NEW_PLAN;
        await runUntil('2026-09-30T01:09:59Z');

        expect(recoveryLogs()).toEqual(['Charging poll recovered after 3m 30s']);
        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start_raw).toBe('2026-09-30T03:30:00Z');
        expect(statuses[statuses.length - 1].fill).toBe('green');
        // no more retries after the success
        expect(dispatchSecondsAfter('2026-09-30T01:05:00Z')).toEqual([0, 30, 90, 210]);
        expect(failWarns()).toHaveLength(3);

        await runUntil('2026-09-30T01:10:01Z'); // the normal poll still runs as usual
        expect(dispatchSecondsAfter('2026-09-30T01:05:00Z')).toEqual([0, 30, 90, 210, 300]);
        expect(recoveryLogs()).toHaveLength(1);
    });

    test('keeps the cached plan and charging timers while retrying', async () => {
        await start();
        const timersBefore = jest.getTimerCount();
        const before = lastPoll();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:09:00Z');

        expect(failWarns()).toHaveLength(4);
        expect(jest.getTimerCount()).toBe(timersBefore);
        const p = lastPoll();
        expect(p.intelligent_error).toBe('KT-CT-4340: Unable to fetch planned dispatches');
        expect(p.slot1_start_raw).toBe(before.slot1_start_raw);
        expect(p.slot1_end_raw).toBe(before.slot1_end_raw);
        expect(p.charging_now).toBe(false);
    });

    test('closing the node stops the retries', async () => {
        await start();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:05:01Z');
        expect(failWarns()).toEqual([`${FAILED_4340} (retry 1 in 30s)`]);
        const n = dispatchTimes.length;

        node._handlers.close();
        node = null;
        // even if a late tick still fires, nothing is polled after close
        for (let i = 0; i < 300; i++) {
            await jest.advanceTimersByTimeAsync(1000);
            await onTick();
        }
        expect(dispatchTimes.length).toBe(n);
    });
});

describe('rate limit: at most 3 dispatch queries in any 60 s, counting pre-validation', () => {
    test('a retry waits when a manual refresh and pre-validation have used the minute', async () => {
        // Slot at 01:06:00, so pre-validation queries the dispatches at 01:05:30.
        plan = [slot('2026-09-30T01:06:00Z', '2026-09-30T01:20:00Z')];
        await start();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:05:09Z');  // 01:05:00 poll failed
        node._handlers.input({ payload: {} });     // manual refresh, polls at 01:05:10 and fails
        await runUntil('2026-09-30T01:08:00Z');

        const times = dispatchTimes.filter((t) => t >= at('2026-09-30T01:05:00Z'));
        for (const t of times) {
            expect(times.filter((u) => u >= t && u <= t + 60000).length).toBeLessThanOrEqual(3);
        }
        // the retry due at 01:05:40 was held back, not dropped: it ran just after 01:06:00
        expect(times.some((t) => t > at('2026-09-30T01:05:31Z') && t < at('2026-09-30T01:06:00Z'))).toBe(false);
        expect(times.some((t) => t > at('2026-09-30T01:06:00Z') && t < at('2026-09-30T01:06:03Z'))).toBe(true);
    });

    test('never more than 3 dispatch queries in any 60 s through a long outage', async () => {
        plan = [slot('2026-09-30T01:06:00Z', '2026-09-30T01:07:00Z'), slot('2026-09-30T01:21:00Z', '2026-09-30T01:22:00Z')];
        await start();
        dispatchErrors = ERR_4340;
        await runUntil('2026-09-30T01:30:00Z');
        for (const t of dispatchTimes) {
            expect(dispatchTimes.filter((u) => u >= t && u <= t + 60000).length).toBeLessThanOrEqual(3);
        }
        expect(failWarns().length).toBeGreaterThan(10);
    });
});

describe('which failures are retried', () => {
    test('other errors are logged once per poll but not retried', async () => {
        await start();
        dispatchErrors = [{ message: 'Something else went wrong.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-9999' } }];
        await runUntil('2026-09-30T01:09:59Z');

        expect(dispatchSecondsAfter('2026-09-30T01:05:00Z')).toEqual([0]);
        expect(failWarns()).toEqual(['Charging poll failed: KT-CT-9999 Something else went wrong']);
    });

    // Review 5 R4: a socket error has a code but no detail; the line read "ENOTFOUND undefined".
    test('a socket error is logged with its message, never "undefined"', async () => {
        const base = graphqlPost.getMockImplementation();
        graphqlPost.mockImplementation(async (body) => {
            if (/SmartFlexDevicePreferences/.test(body.query)) {
                throw Object.assign(new Error('getaddrinfo ENOTFOUND api.octopus.energy'), { code: 'ENOTFOUND' });
            }
            return base(body);
        });
        await start();
        expect(failWarns()).toEqual(['Charging poll failed: getaddrinfo ENOTFOUND api.octopus.energy']);
        expect(warns.join(' | ')).not.toMatch(/undefined/);
    });

    test('a KT-CT-4339 that fails the charging poll is retried too', async () => {
        // Since 1.6.2 discovery seeds the device id, so make discovery find none too.
        discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: null });
        // No cached device id yet and no device list: the poll cannot go on to the dispatches.
        devicesReply = {
            data: { devices: null },
            errors: [{ message: 'Your device charging preferences could not be fetched.', path: ['devices', 0, 'preferences'], extensions: { errorCode: 'KT-CT-4339' } }],
        };
        await start();
        expect(lastPoll().intelligent_error).toBe('KT-CT-4339: Your device charging preferences could not be fetched');
        expect(failWarns()).toEqual(['Charging poll failed: KT-CT-4339 Your device charging preferences could not be fetched (retry 1 in 30s)']);

        devicesReply = undefined;
        await runUntil('2026-09-30T01:00:40Z');
        expect(devicesTimes.map((t) => Math.round((t - at('2026-09-30T01:00:02Z')) / 1000))).toEqual([0, 30]);
        expect(lastPoll().intelligent_error).toBeNull();
        expect(recoveryLogs()).toEqual(['Charging poll recovered after 30s']);
    });
});
