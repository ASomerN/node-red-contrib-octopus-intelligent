// __tests__/prevalidation-repoll.test.js
'use strict';
/**
 * When the pre-validation check (30s before a slot) finds Octopus has re-planned, the node
 * must poll straight away so the slot/window sensors match what charging_now is doing
 * (live 2026-09-30: sensors showed the old plan for hours while charging_now followed the new one).
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
const PLAN = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:00:00Z'), slot('2026-09-30T02:30:00Z', '2026-09-30T03:00:00Z')];

let dispatchReplies;
let devicesErrors;
let devicesData;
let dispatchCalls;
let holdDispatchCall; // { n, promise }: dispatch call number n waits for promise
let sends;
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
                n.credentials = { apiKey: 'sk_test_prevalidate' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = () => {};
                n.warn = (m) => { warns.push(String(m)); };
                n.error = () => {};
                n.status = () => {};
                n.send = (msg) => { sends.push(msg); };
                n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: () => null,
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED);
    // 60-min interval: without a forced poll the next scheduled one is not until 02:00.
    return new NodeCtor({ id: 'oi-pv', accountNumber: 'A-PREVAL01', enableMqtt: false, refreshInterval: 60 });
}

// Only the intelligent poll's devices query asks for preferences (smart-charging status has its own getDevices).
const devicesQueries = () => graphqlPost.mock.calls.filter(([body]) => /SmartFlexDevicePreferences/.test(body.query)).length;
const turnedOn = () => sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change' && m.payload.charging_now === true);

beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = [];
    warns = [];
    dispatchReplies = [];
    devicesErrors = undefined;
    devicesData = DEVICES;
    dispatchCalls = 0;
    holdDispatchCall = null;
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) return { data: { data: { devices: devicesData }, errors: devicesErrors } };
        if (/getDispatches/.test(body.query)) {
            dispatchCalls += 1;
            if (holdDispatchCall && holdDispatchCall.n === dispatchCalls) await holdDispatchCall.promise;
            const plan = dispatchReplies.length > 1 ? dispatchReplies.shift() : dispatchReplies[0];
            return { data: { data: { flexPlannedDispatches: plan } } };
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

async function startAndFirstPoll() {
    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100); // discovery + scheduler created
    await onTick();                              // first poll at ~01:00:02
    expect(devicesQueries()).toBe(1);
}

// Run the scheduler once per second up to `iso`, as the real scheduler does.
async function runUntil(iso) {
    while (Date.now() < Date.parse(iso)) {
        await jest.advanceTimersByTimeAsync(1000);
        await onTick();
    }
}

test('a re-planned slot found by pre-validation triggers an immediate poll', async () => {
    dispatchReplies = [PLAN, [slot('2026-09-30T02:00:00Z', '2026-09-30T02:30:00Z')]];
    await startAndFirstPoll();

    await runUntil('2026-09-30T01:29:35Z');

    expect(devicesQueries()).toBe(2);
});

test('an unchanged plan does not trigger an extra poll and the slot still starts on time', async () => {
    dispatchReplies = [PLAN];
    await startAndFirstPoll();

    await runUntil('2026-09-30T01:30:00Z');

    expect(devicesQueries()).toBe(1);
    expect(turnedOn()).toHaveLength(1);
});

test('the forced poll does not lose the start of a slot that is about to begin', async () => {
    // First slot unchanged, second one moved: the forced poll lands ~30s before the first slot
    // starts and resets the charging timers. The poll must set its own slot-start timer rather
    // than leave the start to the 10s reconciliation loop.
    dispatchReplies = [PLAN, [PLAN[0], slot('2026-09-30T03:00:00Z', '2026-09-30T03:30:00Z')]];
    await startAndFirstPoll();

    await runUntil('2026-09-30T01:29:35Z');
    expect(devicesQueries()).toBe(2);
    expect(turnedOn()).toHaveLength(0);

    await runUntil('2026-09-30T01:30:05Z');

    expect(turnedOn()).toHaveLength(1);
    expect(warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);
    expect(warns.some((w) => /Charging slot started/.test(w))).toBe(true);
});

test('an error on the Charge Cap field alone keeps polling, updates the settings and keeps the last Charge Cap', async () => {
    // isChargingDurationCapped is non-null, so its resolver error (same pattern as the KT-CT-4360
    // status error tolerated in discovery) nulls the chargeCap alias only, not the schedules.
    dispatchReplies = [PLAN];
    await startAndFirstPoll();
    const first = sends.filter((m) => m.payload && 'intelligent_error' in m.payload).pop();
    expect(first.payload.charge_cap).toBe(true);

    devicesData = [{ ...DEVICES[0], preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '06:30:00', max: 30 }] }, chargeCap: null }];
    devicesErrors = [{ message: 'An internal error occurred.', path: ['devices', 0, 'chargeCap', 'isChargingDurationCapped'],
        extensions: { errorCode: 'KT-CT-4360' } }];
    await runUntil('2026-09-30T02:00:02Z'); // next scheduled poll (60-min interval)

    expect(devicesQueries()).toBe(2);
    const last = sends.filter((m) => m.payload && 'intelligent_error' in m.payload).pop();
    expect(last.payload.intelligent_error).toBeNull();
    expect(last.payload.slot1_start_raw).toBe('2026-09-30T02:30:00Z');
    expect(last.payload.confirmed_limit).toBe(30);
    expect(last.payload.confirmed_time).toBe('06:30');
    expect(last.payload.charge_cap).toBe(true);
    expect(warns.filter((w) => /not applicable/i.test(w))).toEqual([]);
});

test('a slot start is set once when a poll lands while pre-validation is still waiting on Octopus', async () => {
    // Pre-validation (dispatch call 2) is slow; a manual refresh poll finishes first and sets the
    // start timer, then pre-validation sets it again. Only one start may fire.
    let release;
    holdDispatchCall = { n: 2, promise: new Promise((r) => { release = r; }) };
    dispatchReplies = [PLAN];
    await startAndFirstPoll();

    await runUntil('2026-09-30T01:29:31Z');        // pre-validation has fired and is waiting
    node._handlers.input({ payload: {} });           // manual refresh
    await runUntil('2026-09-30T01:29:34Z');          // refresh poll ran inside the last 30s
    expect(devicesQueries()).toBe(2);
    release();
    await runUntil('2026-09-30T01:30:02Z');

    expect(warns.filter((w) => /Charging slot started/.test(w))).toHaveLength(1);
    expect(turnedOn()).toHaveLength(1);
});

test('any other devices-query error still fails the charging poll', async () => {
    devicesErrors = [{ message: 'boom', path: ['devices'] }];
    dispatchReplies = [PLAN];
    await startAndFirstPoll();

    const last = sends.filter((m) => m.payload && 'intelligent_error' in m.payload).pop();
    expect(last.payload.intelligent_error).toMatch(/Devices query failed/);
});
