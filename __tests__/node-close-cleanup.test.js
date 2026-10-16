// __tests__/node-close-cleanup.test.js
'use strict';
/**
 * Closing (redeploying) the REAL node while a poll is in flight must leave nothing behind:
 * the scheduler is stopped, no timer survives, and the late answer of the hung poll neither
 * publishes nor re-creates charging timers.
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
let hold;        // { n, promise }: dispatch call number n waits for the promise
let dispatchCalls;
let sends;
let statuses;
let warns;
let onTick;
let scheduler;
let node;

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n) {
                const handlers = {};
                const store = {};
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_close' };
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
    return new NodeCtor({ id: 'oi-close', accountNumber: 'A-CLOSE001', enableMqtt: false, refreshInterval: 60 });
}

beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; statuses = []; warns = [];
    plan = PLAN; hold = null; dispatchCalls = 0;
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) return { data: { data: { devices: DEVICES } } };
        if (/getDispatches/.test(body.query)) {
            dispatchCalls += 1;
            if (hold && hold.n === dispatchCalls) await hold.promise;
            return { data: { data: { flexPlannedDispatches: plan } } };
        }
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    scheduler = { start: jest.fn(), stop: jest.fn() };
    createScheduler.mockImplementation((fn) => { onTick = fn; return scheduler; });
    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100); // discovery done, scheduler created and started
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('close stops the scheduler and clears every timer, including charging and reconciliation timers', async () => {
    await onTick(); // good poll: sets pre-validation timer + reconciliation interval
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    expect(scheduler.stop).not.toHaveBeenCalled();

    node._handlers.close();

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test('closing mid-poll: the late answer publishes nothing and starts no timer', async () => {
    plan = PLAN;
    await onTick();                                  // poll 1 (dispatch call 1) done: slot 01:10-01:15 planned
    const sendsBefore = sends.length;

    let release;
    hold = { n: 2, promise: new Promise((r) => { release = r; }) };
    node._handlers.input({ payload: {} });           // manual refresh forces a poll
    const inFlight = onTick();                       // poll 2 hangs on the dispatches query
    await jest.advanceTimersByTimeAsync(0);
    expect(dispatchCalls).toBe(2);

    node._handlers.close();
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    const sendsAtClose = sends.length;
    const statusesAtClose = statuses.length;
    const callsAtClose = graphqlPost.mock.calls.length;

    plan = NEW_PLAN;                                 // the late answer carries a different plan
    release();
    await inFlight;
    await jest.advanceTimersByTimeAsync(0);

    // nothing published, no status change, no new request, no timer re-created by the stale poll
    expect(sends.length).toBe(sendsAtClose);
    expect(statuses.length).toBe(statusesAtClose);
    expect(graphqlPost.mock.calls.length).toBe(callsAtClose);
    expect(jest.getTimerCount()).toBe(0);
    expect(sendsAtClose).toBe(sendsBefore);

    // and nothing fires later: neither the old slot nor the new one
    const warnsAtClose = warns.length;
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(sends.length).toBe(sendsAtClose);
    expect(warns.length).toBe(warnsAtClose);
    expect(graphqlPost.mock.calls.length).toBe(callsAtClose);
});

test('closing mid-poll on the very first poll (no timers yet) still leaves no timer once it resolves', async () => {
    let release;
    hold = { n: 1, promise: new Promise((r) => { release = r; }) };
    const inFlight = onTick();
    await jest.advanceTimersByTimeAsync(0);
    expect(dispatchCalls).toBe(1);

    node._handlers.close();
    release();
    await inFlight;
    await jest.advanceTimersByTimeAsync(0);

    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
});
