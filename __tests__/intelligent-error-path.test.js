// __tests__/intelligent-error-path.test.js
'use strict';
/**
 * The REAL node's intelligent poll when Kraken answers HTTP 200 with GraphQL errors
 * (KT-CT-4340 on flexPlannedDispatches, KT-CT-4339 on devices.preferences).
 * A failed poll must surface intelligent_error and a red status but keep the last known
 * plan, the charging timers and charging_now; the next good poll must clear it.
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
const PLAN = [slot('2026-09-30T01:10:00Z', '2026-09-30T01:15:00Z')];
const NEW_PLAN = [slot('2026-09-30T01:20:00Z', '2026-09-30T01:25:00Z')];

let plan;
let dispatchErrors;   // when set, getDispatches answers HTTP 200 with these errors and null data
let devicesReply;     // when set, getDevices answers with this { data, errors }
let sends;
let statuses;
let warns;
let onTick;
let node;

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n) {
                const handlers = {};
                const store = {};
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_errpath' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = () => {};
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
    return new NodeCtor({ id: 'oi-err', accountNumber: 'A-ERRPATH1', enableMqtt: false, refreshInterval: 60 });
}

const dispatchCalls = () => graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query)).length;
const pollSends = () => sends.filter((m) => m.payload && !m.debug && 'intelligent_error' in m.payload);
const lastPoll = () => pollSends().pop().payload;
const stateChanges = (value) => sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change' && m.payload.charging_now === value);

beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; statuses = []; warns = [];
    plan = PLAN; dispatchErrors = undefined; devicesReply = undefined;
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) return { data: devicesReply || { data: { devices: DEVICES } } };
        if (/getDispatches/.test(body.query)) {
            if (dispatchErrors) return { data: { errors: dispatchErrors, data: { flexPlannedDispatches: null } }, status: 200 };
            return { data: { data: { flexPlannedDispatches: plan } } };
        }
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });

    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100); // discovery + scheduler created
    await onTick();                              // first (good) poll at ~01:00:02
});

afterEach(() => {
    if (node) node._handlers.close();
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

async function refreshPoll() {
    node._handlers.input({ payload: {} }); // manual refresh: forces the intelligent category due
    await onTick();
}

test('baseline: the first good poll has no error, a green status and the planned slot', () => {
    expect(lastPoll().intelligent_error).toBeNull();
    expect(lastPoll().slot1_start_raw).toBe('2026-09-30T01:10:00Z');
    expect(lastPoll().charging_now).toBe(false);
    expect(statuses[statuses.length - 1].fill).toBe('green');
});

describe('KT-CT-4340 on flexPlannedDispatches (HTTP 200 with errors)', () => {
    const ERR = [{ message: 'Unable to fetch planned dispatches.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];

    test('sets intelligent_error, turns the status red and keeps the last known plan and charging_now', async () => {
        dispatchErrors = ERR;
        await refreshPoll();

        const p = lastPoll();
        // 1.6.2: short form, no 'Dispatches query failed' wrapper
        expect(p.intelligent_error).toBe('KT-CT-4340: Unable to fetch planned dispatches');
        expect(p.charging_now).toBe(false);
        // previously known plan is still in the published state
        expect(p.slot1_start_raw).toBe('2026-09-30T01:10:00Z');
        expect(p.slot1_end_raw).toBe('2026-09-30T01:15:00Z');
        const status = statuses[statuses.length - 1];
        expect(status.fill).toBe('red');
        // 1.6.2: the short error after the 'Error: ' prefix 1.6.1 had (flows match /^Error/)
        expect(status.text).toBe('Error: KT-CT-4340: Unable to fetch planned dispatches');
        expect(status.text).toMatch(/^Error: KT-CT-4340/);
    });

    test('does not clear the existing slot timers: the slot still starts and ends on time', async () => {
        const timersBefore = jest.getTimerCount();
        dispatchErrors = ERR;
        await refreshPoll();
        // 1.6.2 retries are tick-driven (scheduler mocked here), so a failure adds no timer
        expect(jest.getTimerCount()).toBe(timersBefore);

        dispatchErrors = undefined; // Octopus recovers before pre-validation (01:09:30) runs
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000); // to 01:10:02
        expect(stateChanges(true)).toHaveLength(1);
        expect(stateChanges(false)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);   // past 01:15:00
        expect(stateChanges(false)).toHaveLength(1);
    });

    test('the next successful poll clears intelligent_error, updates the plan and goes green', async () => {
        dispatchErrors = ERR;
        await refreshPoll();
        expect(lastPoll().intelligent_error).toBeTruthy();

        dispatchErrors = undefined;
        plan = NEW_PLAN;
        await refreshPoll();

        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start_raw).toBe('2026-09-30T01:20:00Z');
        expect(p.slot1_end_raw).toBe('2026-09-30T01:25:00Z');
        expect(statuses[statuses.length - 1].fill).toBe('green');

        // and the new plan drives charging_now, not the old one
        await jest.advanceTimersByTimeAsync(12 * 60 * 1000); // 01:12: old slot start passed
        expect(stateChanges(true)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(9 * 60 * 1000);  // 01:21: new slot active
        expect(stateChanges(true)).toHaveLength(1);
    });
});


describe('1.6.2 quick retry after a KT-CT-4340 failure (driven by ticks, as the scheduler does)', () => {
    const ERR = [{ message: 'Unable to fetch planned dispatches.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];

    test('the failure logs the code, the detail and the first retry delay', async () => {
        dispatchErrors = ERR;
        await refreshPoll();
        expect(warns).toContain('Charging poll failed: KT-CT-4340 Unable to fetch planned dispatches (retry 1 in 30s)');
    });

    test('a tick before 30 s does not retry; a tick after 30 s forces one dispatch query that recovers the poll', async () => {
        dispatchErrors = ERR;
        await refreshPoll();
        const afterFail = dispatchCalls();

        await jest.advanceTimersByTimeAsync(20000);
        await onTick();
        expect(dispatchCalls()).toBe(afterFail); // too early

        dispatchErrors = undefined;
        plan = NEW_PLAN;
        await jest.advanceTimersByTimeAsync(10100); // 30.1 s after the failure
        await onTick();
        expect(dispatchCalls()).toBe(afterFail + 1);
        expect(lastPoll().intelligent_error).toBeNull();
        expect(lastPoll().slot1_start_raw).toBe('2026-09-30T01:20:00Z');
        expect(statuses[statuses.length - 1].fill).toBe('green');
    });

    test('retries back off 30 s, 60 s, 120 s while the error persists, then hold at 120 s', async () => {
        dispatchErrors = ERR;
        await refreshPoll();
        let calls = dispatchCalls();
        const expectRetryAfter = async (ms, label) => {
            await jest.advanceTimersByTimeAsync(ms - 1000);
            await onTick();
            expect(dispatchCalls()).toBe(calls);      // not yet
            await jest.advanceTimersByTimeAsync(1200);
            await onTick();
            expect(dispatchCalls()).toBe(calls + 1);  // retry ran
            calls += 1;
            expect(warns.some((w) => w.includes(label))).toBe(true);
        };
        await expectRetryAfter(30000, '(retry 2 in 60s)');
        await expectRetryAfter(60000, '(retry 3 in 120s)');
        await expectRetryAfter(120000, '(retry 4 in 120s)');
    });
});

describe('KT-CT-4339 on devices.preferences (1.6.2: the poll keeps the last confirmed values)', () => {
    const PREF_ERR = [{ message: 'Unable to fetch preferences.', path: ['devices', 0, 'preferences'], extensions: { errorCode: 'KT-CT-4339' } }];

    test('a KT-CT-4339 on preferences does not fail the poll: dispatches are read, confirmed limit/time are kept, status green', async () => {
        devicesReply = { data: { devices: [{ ...DEVICES[0], preferences: null }] }, errors: PREF_ERR };
        plan = NEW_PLAN;
        const dispatchesBefore = dispatchCalls();
        await refreshPoll();

        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(dispatchCalls()).toBe(dispatchesBefore + 1); // dispatches were still queried
        expect(p.slot1_start_raw).toBe('2026-09-30T01:20:00Z'); // the new plan was applied
        expect(p.confirmed_limit).toBe(90);                    // kept from the last good poll
        expect(p.confirmed_time).toBe('04:00');
        expect(statuses[statuses.length - 1]).toMatchObject({ fill: 'green', text: 'Confirmed: 90% @ 04:00' });
        expect(warns).toContain('Charging preferences unavailable this poll (KT-CT-4339) - keeping 90% @ 04:00');
    });

    test('a KT-CT-4339 that nulls the whole device list is tolerated once the device id is cached', async () => {
        devicesReply = { data: { devices: null }, errors: [{ message: 'Unable to fetch preferences.', path: ['devices', 0, 'preferences'], extensions: { errorCode: 'KT-CT-4339' } }] };
        plan = NEW_PLAN;
        await refreshPoll();
        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start_raw).toBe('2026-09-30T01:20:00Z');
        expect(p.confirmed_limit).toBe(90);
        expect(p.confirmed_time).toBe('04:00');
    });

    test('a KT-CT-4339 is not a retry trigger because the poll did not fail', async () => {
        devicesReply = { data: { devices: [{ ...DEVICES[0], preferences: null }] }, errors: PREF_ERR };
        await refreshPoll();
        const calls = dispatchCalls();
        await jest.advanceTimersByTimeAsync(31000);
        await onTick();
        expect(dispatchCalls()).toBe(calls); // no forced retry poll
    });

    test('an error code other than 4339 on the device list still fails the poll with the short error', async () => {
        devicesReply = { data: null, errors: [{ message: 'Something else broke.', extensions: { errorCode: 'KT-CT-9999' } }] };
        const dispatchesBefore = dispatchCalls();
        await refreshPoll();
        const p = lastPoll();
        expect(p.intelligent_error).toBe('KT-CT-9999: Something else broke');
        expect(dispatchCalls()).toBe(dispatchesBefore);
        expect(statuses[statuses.length - 1]).toMatchObject({ fill: 'red', text: 'Error: KT-CT-9999: Something else broke' });
        expect(p.slot1_start_raw).toBe('2026-09-30T01:10:00Z'); // last known plan kept
    });

    test('the poll after a KT-CT-4339 poll updates normally', async () => {
        devicesReply = { data: { devices: [{ ...DEVICES[0], preferences: null }] }, errors: PREF_ERR };
        await refreshPoll();
        devicesReply = undefined;
        plan = NEW_PLAN;
        await refreshPoll();
        expect(lastPoll().intelligent_error).toBeNull();
        expect(lastPoll().slot1_start_raw).toBe('2026-09-30T01:20:00Z');
    });
});
