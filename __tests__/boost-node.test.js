// __tests__/boost-node.test.js
'use strict';
/**
 * set_boost end to end through the real node, with Kraken mocked (no live calls: a live
 * boost really charges the car). Mock shapes follow the live schema (introspection 6 Oct 2026):
 * updateBoostCharge(input: {deviceId, action: BOOST | CANCEL}) returns the device (the node
 * reads back only its id), and status { currentState } is BOOSTING while a boost runs.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const ACCOUNT = 'A-BOOST001';
const STATE = `nodered_octopus/${ACCOUNT}/status`;
const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: false,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};
const slot = (start, end) => ({ start, end, type: 'SMART', energyAddedKwh: '3.0' });
// Next planned slot is tonight; nothing is active at 12:00.
const PLAN = [slot('2026-10-07T23:30:00Z', '2026-10-08T01:00:00Z')];

let currentState;      // what Octopus reports in status.currentState
let boostReply;        // override for the updateBoostCharge reply
let devicesErrors;
let boostCalls;
let sends;
let warns;
let logs;
let errors;
let published;
let subscriptions;
let onTick;
let node;

function device() {
    return {
        id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
        status: { isSuspended: false },
        preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '07:30:00', max: 80 }] },
        chargeCap: { isChargingDurationCapped: 'DISABLED' },
        // The charging poll reads status once, under the smartStatus alias (isSuspended + currentState).
        smartStatus: devicesErrors ? null : { isSuspended: false, currentState },
    };
}

function buildNode({ mqtt = false } = {}) {
    let NodeCtor = null;
    const broker = {
        client: {
            publish: (topic, payload) => { published.push([topic, payload]); },
            subscribe: () => {},
        },
        register: () => {},
        deregister: () => {},
        subscribe: (topic, qos, cb) => { subscriptions[topic] = cb; },
        unsubscribe: () => {},
    };
    const RED = {
        nodes: {
            createNode(n) {
                const handlers = {};
                const store = {};
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_boost' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = (m) => { logs.push(String(m)); };
                n.warn = (m) => { warns.push(String(m)); };
                n.error = (m) => { errors.push(String(m)); };
                n.status = () => {};
                n.send = (msg) => { sends.push(msg); };
                n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: (id) => (id === 'broker-1' ? broker : null),
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED);
    return new NodeCtor({
        id: 'oi-boost', accountNumber: ACCOUNT, refreshInterval: 60,
        enableMqtt: mqtt, broker: mqtt ? 'broker-1' : undefined,
    });
}

const boostMutations = () => graphqlPost.mock.calls.filter(([body]) => /updateBoostCharge/.test(body.query));
const devicesQueries = () => graphqlPost.mock.calls.filter(([body]) => /SmartFlexDevicePreferences/.test(body.query)).length;
const chargingChanges = () => sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change');
const lastPollPayload = () => sends.filter((m) => m.payload && 'intelligent_error' in m.payload && !m.debug).pop().payload;
// Review L6: the message a failed set_boost sends is tagged like the other extra messages.
const boostFailures = () => sends.filter((m) => m.debug && m.debug.trigger === 'boost_failed');
const lastPublished = (topic) => published.filter(([t]) => t === topic).map(([, p]) => p).pop();

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    currentState = 'SMART_CONTROL_CAPABLE';
    boostReply = null;
    devicesErrors = undefined;
    sends = []; warns = []; logs = []; errors = []; published = []; subscriptions = {};
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/updateBoostCharge/.test(body.query)) {
            if (boostReply) return boostReply;
            currentState = body.variables.action === 'BOOST' ? 'BOOSTING' : 'SMART_CONTROL_CAPABLE';
            return { data: { data: { updateBoostCharge: { id: 'dev-1', status: { currentState } } } } };
        }
        if (/getDevices/.test(body.query)) return { data: { data: { devices: [device()] }, errors: devicesErrors } };
        if (/getDispatches/.test(body.query)) return { data: { data: { flexPlannedDispatches: PLAN } } };
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

async function start(opts) {
    node = buildNode(opts);
    await jest.advanceTimersByTimeAsync(2100); // device id fetched, discovery done, scheduler created
    await onTick();                              // first poll
    expect(devicesQueries()).toBe(1);
}

// Run the scheduler once per second for `seconds`, as the real scheduler does.
async function runFor(seconds) {
    for (let i = 0; i < seconds; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        await onTick();
    }
}

describe('set_boost through the node', () => {
    test('true sends BOOST for the EV device, logs it and forces an intelligent poll', async () => {
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(boostMutations()).toHaveLength(1);
        expect(boostMutations()[0][0].variables).toEqual({ deviceId: 'dev-1', action: 'BOOST' });
        expect(boostMutations()[0][1]).toBe('jwt');
        expect(logs).toContain('Boost requested');
        expect(devicesQueries()).toBe(2);
        expect(lastPollPayload().boosting).toBe(true);
        expect(lastPollPayload().boost_error).toBeNull();
    });

    test('a boost turns charging_now on with no slot active, and reconciliation keeps it on', async () => {
        await start();
        expect(lastPollPayload().charging_now).toBe(false);

        node._handlers.input({ payload: { set_boost: true } });
        await runFor(35); // several 10 s reconciliation passes

        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);
        expect(lastPollPayload().charging_now).toBe(true);
    });

    test('false sends CANCEL, logs it, and charging_now falls back to the plan', async () => {
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        node._handlers.input({ payload: { set_boost: false } });
        await runFor(6); // boost mutations are at least 5 s apart

        expect(boostMutations().map(([b]) => b.variables.action)).toEqual(['BOOST', 'CANCEL']);
        expect(logs).toContain('Boost cancelled');
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true, false]);
        expect(lastPollPayload().boosting).toBe(false);
        expect(lastPollPayload().charging_now).toBe(false);
    });

    test('a boost that ends on its own is picked up by the next poll', async () => {
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        currentState = 'SMART_CONTROL_CAPABLE'; // car reached its target
        node._handlers.input({ payload: {} });  // manual refresh
        await runFor(2);

        expect(lastPollPayload().boosting).toBe(false);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true, false]);
    });

    test('a refusal is logged as a warning with the short Octopus error and reported in boost_error', async () => {
        // Refusal shape not yet seen live: the standard Kraken error is assumed, and any code
        // (or none) counts as a refusal. KT-CT-1234 is an arbitrary code.
        boostReply = { data: { data: { updateBoostCharge: null }, errors: [
            { message: 'Unable to boost charge.', path: ['updateBoostCharge'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-1234' } },
        ] } };
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(warns).toContain('Boost request failed: KT-CT-1234: Unable to boost charge');
        expect(logs).not.toContain('Boost requested');
        // Octopus refused, so nothing changed on the device: no forced poll (review F2).
        // boost_error is sent straight away instead.
        expect(devicesQueries()).toBe(1);
        const failures = boostFailures();
        expect(failures).toHaveLength(1);
        expect(failures[0].payload.boost_error).toBe('KT-CT-1234: Unable to boost charge');
        expect(failures[0].payload.boosting).toBe(false);
        expect(failures[0].debug).toEqual({
            timestamp: expect.any(String), trigger: 'boost_failed', request: 'BOOST',
            error: 'KT-CT-1234: Unable to boost charge',
        });
        expect(Number.isNaN(Date.parse(failures[0].debug.timestamp))).toBe(false);
        expect(chargingChanges()).toEqual([]);
    });

    // Review A2: errors next to a device read back are not a clear refusal. The node does not
    // flip the state or set boost_error; a charging poll reads what Octopus really did.
    test('an error with a BOOSTING read-back is unclear: no flip, no boost_error, a poll decides', async () => {
        boostReply = { data: {
            data: { updateBoostCharge: { id: 'dev-1', status: { currentState: 'BOOSTING' } } },
            errors: [{ message: 'Boost not applied.', path: ['updateBoostCharge'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-9876' } }],
        } };
        await start({ mqtt: true });
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(warns).toContain('Boost request: unclear answer from Octopus (KT-CT-9876: Boost not applied). Checking the boost state with a charging poll');
        expect(logs).not.toContain('Boost requested');
        expect(devicesQueries()).toBe(2);
        expect(chargingChanges()).toEqual([]);
        expect(published.filter(([t]) => t === `${STATE}/boost`).map(([, p]) => p)).not.toContain('ON');
        expect(lastPollPayload().boost_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(false); // Octopus still reports no boost
    });

    test('a refusal without an error code is still a refusal', async () => {
        boostReply = { data: { data: { updateBoostCharge: null }, errors: [{ message: 'Something went wrong.', path: ['updateBoostCharge'] }] } };
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(warns).toContain('Boost request failed: Something went wrong');
        const failure = boostFailures().pop();
        expect(failure.payload.boost_error).toBe('Something went wrong');
        expect(failure.payload.boosting).toBe(false);
        expect(failure.debug).toMatchObject({ trigger: 'boost_failed', request: 'BOOST', error: 'Something went wrong' });
    });

    test('a later successful boost clears boost_error', async () => {
        boostReply = { data: { errors: [{ message: 'Unable to boost charge.', extensions: { errorCode: 'KT-CT-1234' } }] } };
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(5); // a repeat of the same value within 5 s is dropped
        boostReply = null;
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(boostMutations()).toHaveLength(2);
        expect(lastPollPayload().boost_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(true);
    });

    test('non-boolean set_boost is reported as an error, sends nothing and does not trigger a refresh', async () => {
        await start();
        node._handlers.input({ payload: { set_boost: 'true' } });
        await runFor(2);

        expect(boostMutations()).toHaveLength(0);
        expect(devicesQueries()).toBe(1);
        expect(errors).toContain("Invalid set_boost 'true' — must be true or false");
    });

    test('set_boost runs alongside another command in the same message', async () => {
        await start();
        node._handlers.input({ payload: { set_charge_cap: true, set_boost: true } });
        await runFor(2);

        expect(boostMutations()).toHaveLength(1);
        expect(graphqlPost.mock.calls.filter(([b]) => /updateIsChargingDurationCapped/.test(b.query))).toHaveLength(1);
    });

    test('an error on the status field (smartStatus) alone keeps polling and keeps the last boosting value', async () => {
        await start();
        node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(true);

        devicesErrors = [{ message: 'An internal error occurred.', path: ['devices', 0, 'smartStatus', 'currentState'],
            extensions: { errorCode: 'KT-CT-4360' } }];
        node._handlers.input({ payload: {} });
        await runFor(2);

        expect(devicesQueries()).toBe(3);
        expect(lastPollPayload().intelligent_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(true);
    });
});

describe('Boost Charge switch over MQTT', () => {
    test('ON / OFF on the set_boost topic boost and cancel, and the state topic follows', async () => {
        await start({ mqtt: true });
        const cmd = subscriptions[`nodered_octopus/${ACCOUNT}/set_boost`];
        expect(typeof cmd).toBe('function');

        cmd(`nodered_octopus/${ACCOUNT}/set_boost`, Buffer.from('ON'));
        await runFor(2);
        expect(boostMutations().map(([b]) => b.variables.action)).toEqual(['BOOST']);
        expect(lastPublished(`${STATE}/boost`)).toBe('ON');
        expect(lastPublished(`${STATE}/charging_now`)).toBe('ON');

        cmd(`nodered_octopus/${ACCOUNT}/set_boost`, Buffer.from('OFF'));
        await runFor(6); // boost mutations are at least 5 s apart
        expect(boostMutations().map(([b]) => b.variables.action)).toEqual(['BOOST', 'CANCEL']);
        expect(lastPublished(`${STATE}/boost`)).toBe('OFF');
        expect(lastPublished(`${STATE}/charging_now`)).toBe('OFF');
    });

    test('a refused boost puts the switch back to its last state', async () => {
        boostReply = { data: { errors: [{ message: 'Unable to boost charge.', extensions: { errorCode: 'KT-CT-1234' } }] } };
        await start({ mqtt: true });
        subscriptions[`nodered_octopus/${ACCOUNT}/set_boost`](`nodered_octopus/${ACCOUNT}/set_boost`, Buffer.from('ON'));
        await runFor(2);

        expect(lastPublished(`${STATE}/boost`)).toBe('OFF');
    });
});
