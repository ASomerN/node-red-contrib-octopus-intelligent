// __tests__/slot-timers-real-node.test.js
'use strict';
/**
 * Slot start/end timers and the 10 s reconciliation loop, exercised on the REAL node
 * (the older reconciliation/charging tests run copies of this logic).
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
// Poll happens at ~01:00:02; slot is ~10 minutes ahead.
const PLAN = [slot('2026-09-30T01:10:00Z', '2026-09-30T01:15:00Z')];

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
                n.credentials = { apiKey: 'sk_test_slots' };
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
    return new NodeCtor({ id: 'oi-slots', accountNumber: 'A-SLOTS001', enableMqtt: false, refreshInterval: 60 });
}

// charging_now transitions the node reports to the flow
const transitions = () => sends
    .filter((m) => m.debug && m.debug.trigger === 'charging_state_change')
    .map((m) => m.payload.charging_now);
const corrections = () => warns.filter((w) => /State reconciliation: Correcting chargingNow/.test(w));

beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; warns = [];
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) return { data: { data: { devices: DEVICES } } };
        if (/getDispatches/.test(body.query)) return { data: { data: { flexPlannedDispatches: PLAN } } };
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });
    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100);
    await onTick(); // poll at ~01:00:02
});

afterEach(() => {
    if (node) node._handlers.close();
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('charging_now switches on at the slot start and off at the slot end', async () => {
    await jest.advanceTimersByTimeAsync(9 * 60 * 1000 + 50 * 1000); // 01:09:52, just before the slot
    expect(transitions()).toEqual([]);
    expect(warns.some((w) => /Pre-validating slot data/.test(w))).toBe(true);

    await jest.advanceTimersByTimeAsync(10 * 1000);                  // 01:10:02
    expect(transitions()).toEqual([true]);
    expect(warns.some((w) => /Charging slot started at 2026-09-30T01:10:00Z/.test(w))).toBe(true);
    // started by the start timer, not rescued by reconciliation
    expect(corrections()).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(4 * 60 * 1000 + 50 * 1000);  // 01:14:52, still charging
    expect(transitions()).toEqual([true]);

    await jest.advanceTimersByTimeAsync(10 * 1000);                  // 01:15:02
    expect(transitions()).toEqual([true, false]);
    expect(warns.some((w) => /Charging slot ended at 2026-09-30T01:15:00Z/.test(w))).toBe(true);
    expect(corrections()).toHaveLength(0);

    // the flow messages carry the flipped value over the last known full state
    const on = sends.find((m) => m.debug && m.debug.new_state === true);
    expect(on.payload.slot1_start_raw).toBe('2026-09-30T01:10:00Z');
});

test('the 10 s reconciliation switches charging_now on when the node is wrongly off inside a slot', async () => {
    // Simulate drift: the clock jumps into the slot without the start timer firing
    // (fake-timer setSystemTime shifts pending timers with the clock, so only the 10 s interval acts first).
    jest.setSystemTime(new Date('2026-09-30T01:10:05Z'));
    expect(transitions()).toEqual([]);

    await jest.advanceTimersByTimeAsync(10 * 1000);

    expect(transitions()).toEqual([true]);
    expect(corrections()).toHaveLength(1);
    expect(corrections()[0]).toMatch(/from false to true/);
});

test('the 10 s reconciliation switches charging_now off when the node is wrongly on after the slot', async () => {
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 2000); // 01:10:04 charging via the start timer
    expect(transitions()).toEqual([true]);

    jest.setSystemTime(new Date('2026-09-30T01:20:00Z'));        // slot is over, end timer has not fired
    await jest.advanceTimersByTimeAsync(10 * 1000);

    expect(transitions()).toEqual([true, false]);
    expect(corrections()).toHaveLength(1);
    expect(corrections()[0]).toMatch(/from true to false/);
});

test('reconciliation does not correct (or warn) while the state already matches', async () => {
    await jest.advanceTimersByTimeAsync(30 * 1000);
    expect(corrections()).toHaveLength(0);
    expect(transitions()).toEqual([]);
});
