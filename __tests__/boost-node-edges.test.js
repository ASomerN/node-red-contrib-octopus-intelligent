// __tests__/boost-node-edges.test.js
'use strict';
/**
 * set_boost through the real node: the paths boost-node.test.js does not cover. Kraken is
 * mocked (a live boost really charges the car). Shapes follow the live schema (introspection
 * 6 Oct 2026): updateBoostCharge(input: {deviceId, action: BOOST | CANCEL}) returns the device
 * (the node reads back only its id; some mocks still send a status, which is ignored or used
 * as the old read-back), status { currentState } is BOOSTING while a boost runs; the charging poll reads currentState
 * under the smartStatus alias. Errors are HTTP 200 bodies { data, errors: [{ message, path, extensions }] }.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot, pollDevice, DISCOVERED, ACCOUNT, DEVICE_ID, STATUS } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

const BOOST_TOPIC = `nodered_octopus/${ACCOUNT}/set_boost`;

let h;
let currentState;  // what Octopus reports in smartStatus.currentState (undefined = not sent)
let boostReply;    // null, or async (body) => full graphqlPost result (may throw)
let boostGate;     // null, or a gate the next boost mutation waits on

function makeGate() {
    const g = {};
    g.promise = new Promise((resolve, reject) => { g.release = resolve; g.reject = reject; });
    return g;
}

// Let the mocked (immediately resolving) Kraken calls and their awaits settle.
async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

async function runFor(seconds) {
    for (let i = 0; i < seconds; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        await h.onTick();
    }
}

const boostMutations = () => graphqlPost.mock.calls.filter(([body]) => /updateBoostCharge/.test(body.query));
const devicesQueries = () => graphqlPost.mock.calls.filter(([body]) => /SmartFlexDevicePreferences/.test(body.query)).length;
const chargingChanges = () => h.sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change');
const lastPollPayload = () => h.pollSends().pop().payload;
const boostCommand = () => h.broker.subscribe.mock.calls.find((c) => c[0] === BOOST_TOPIC)[2];
const boostWarns = () => h.warns.filter((w) => /Boost/.test(w));

const refusal = (code, message) => async () => ({
    data: { data: { updateBoostCharge: null }, errors: [
        { message, path: ['updateBoostCharge'], extensions: { errorType: 'APPLICATION', errorCode: code } },
    ] },
    status: 200,
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    h = createHarness();
    currentState = 'SMART_CONTROL_CAPABLE';
    boostReply = null;
    boostGate = null;
    h.replies.devices = () => {
        const d = pollDevice();
        d.smartStatus = currentState === undefined
            ? { isSuspended: false }
            : { isSuspended: false, currentState };
        return { data: { devices: [d] } };
    };
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/updateBoostCharge/.test(body.query)) {
            if (boostGate) {
                const gate = boostGate;
                boostGate = null;
                await gate.promise;
            }
            if (boostReply) return boostReply(body);
            currentState = body.variables.action === 'BOOST' ? 'BOOSTING' : 'SMART_CONTROL_CAPABLE';
            return { data: { data: { updateBoostCharge: { id: DEVICE_ID, status: { currentState } } } }, status: 200 };
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('set_boost failures', () => {
    test('a transport error is a failed request: warning, boost_error, state unchanged, still polls', async () => {
        boostReply = async () => { throw new Error('Octopus API request timed out after 30s'); };
        await h.start();
        const polls = devicesQueries();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(h.warns).toContain('Boost request failed: Octopus API request timed out after 30s');
        expect(h.logs).not.toContain('Boost requested');
        expect(devicesQueries()).toBe(polls + 1);
        expect(lastPollPayload().boost_error).toBe('Octopus API request timed out after 30s');
        expect(lastPollPayload().boosting).toBe(false);
        expect(chargingChanges()).toEqual([]);
    });

    // Review4 nit: boost_error keeps the 254-character contract whatever the caller passes. The key is
    // masked in what is published to Home Assistant, not in the Node-RED msg.
    test('a long error is cut to 254 characters in boost_error, masked only when published', async () => {
        const long = `Octopus said sk_live_abcdef1234567890 ${'x'.repeat(400)}`;
        boostReply = async () => { throw new Error(long); };
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        const stored = h.lastPayload().boost_error;
        expect(stored.length).toBe(254);
        expect(stored.endsWith('...')).toBe(true);
        expect(stored.startsWith('Octopus said sk_live_abcdef1234567890')).toBe(true);
        const published = h.statePublishes().pop().boost_error;
        expect(published).not.toMatch(/sk_live_[A-Za-z0-9]/);
        expect(published.startsWith('Octopus said sk_live_***')).toBe(true);
        const failure = h.sends.filter((m) => m.debug && m.debug.trigger === 'boost_failed').pop();
        expect(failure.debug.error).toBe(stored);
    });

    test('a failed cancel is labelled as a cancel', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        boostReply = refusal('KT-CT-1234', 'Unable to cancel boost charge.');
        h.node._handlers.input({ payload: { set_boost: false } });
        await runFor(6); // boost mutations are at least 5 s apart

        expect(h.warns).toContain('Boost cancel failed: KT-CT-1234: Unable to cancel boost charge');
        expect(h.logs).not.toContain('Boost cancelled');
        expect(lastPollPayload().boosting).toBe(true);
        expect(lastPollPayload().charging_now).toBe(true);
        // Review L6: the failure message says it is a failed cancel.
        const failure = h.sends.filter((m) => m.debug && m.debug.trigger === 'boost_failed').pop();
        expect(failure.debug).toMatchObject({ request: 'CANCEL', error: 'KT-CT-1234: Unable to cancel boost charge' });
    });

    test('no device id yet: refused without calling Octopus', async () => {
        discoverProducts.mockResolvedValue({ ...DISCOVERED, hasIntelligent: false, deviceId: null });
        h.replies.status = () => ({ data: { devices: [] } });
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        expect(boostMutations()).toHaveLength(0);
        expect(h.warns).toContain('Boost request failed: Device ID not available');
        expect(h.statuses[h.statuses.length - 1]).toEqual({ fill: 'red', shape: 'ring', text: 'Boost request failed' });
        // the switch state was never known, so nothing is republished
        expect(h.published('boost')).toEqual([]);
    });

    test('boost state not yet known: a refused MQTT boost does not publish a switch state', async () => {
        currentState = undefined; // Octopus did not send currentState: boosting stays unknown
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(2);

        expect(h.warns).toContain('Boost request failed: KT-CT-1234: Unable to boost charge');
        expect(h.published('boost')).toEqual([]);
        expect(lastPollPayload().boosting).toBeNull();
    });
});

// Sweep #6: boost_error is published when set and does not stay for days.
describe('boost_error lifecycle', () => {
    const REFUSED = 'KT-CT-1234: Unable to boost charge';

    test('a refusal is published to the retained MQTT state and sent straight away', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();
        expect(h.statePublishes().pop().boost_error).toBe(REFUSED);
        expect(h.lastPayload().boost_error).toBe(REFUSED);
    });

    test('a charging poll that starts a minute or more later clears it; an earlier one does not', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        await h.advance(30000);
        h.node._handlers.input({ payload: {} }); // manual refresh
        await runFor(2);
        expect(lastPollPayload().boost_error).toBe(REFUSED);

        await h.advance(30000);
        h.node._handlers.input({ payload: {} });
        await runFor(2);
        expect(lastPollPayload().boost_error).toBeNull();
    });

    test('a poll that cannot read the device state (status error) does not clear it', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        h.replies.devices = () => {
            const d = pollDevice();
            d.smartStatus = null;
            return { data: { devices: [d] }, errors: [
                { message: 'Unable to get device status.', path: ['devices', 0, 'smartStatus'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' } },
            ] };
        };
        await h.advance(90000);
        h.node._handlers.input({ payload: {} });
        await runFor(2);
        expect(lastPollPayload().intelligent_error).toBeNull();
        expect(lastPollPayload().boost_error).toBe(REFUSED);
    });

    test('a later accepted boost clears it at once', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(5);
        boostReply = null;
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(h.logs).toContain('Boost requested');
        await runFor(2);
        expect(lastPollPayload().boost_error).toBeNull();
    });
});

// Review A2: an answer that does not clearly say "refused" must not flip the switch back or
// show a false boost_error. A charging poll (rate-limited) reads what Octopus really did.
describe('set_boost unclear answers', () => {
    const readBackError = async () => {
        currentState = 'BOOSTING'; // the boost went through
        return { data: { data: { updateBoostCharge: null }, errors: [
            { message: 'Unable to get device status.', path: ['updateBoostCharge', 'status', 'currentState'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' } },
        ] }, status: 200 };
    };

    test('a KT-CT-4360 on the read-back is not a refusal: no boost_error, and the poll shows the boost', async () => {
        boostReply = readBackError;
        await h.start();
        const polls = devicesQueries();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();

        expect(h.warns).toContain('Boost request: unclear answer from Octopus (KT-CT-4360: Unable to get device status). Checking the boost state with a charging poll');
        expect(h.warns.some((w) => /^Boost request failed/.test(w))).toBe(false);
        expect(h.published('boost').pop()).toBe('OFF'); // re-synced to the last known state, not flipped

        await runFor(2);
        expect(devicesQueries()).toBe(polls + 1);
        expect(lastPollPayload().boost_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');
    });

    test('no device and no error in the answer: no flip, no boost_error, a charging poll', async () => {
        boostReply = async () => ({ data: { data: { updateBoostCharge: null } }, status: 200 });
        await h.start();
        const polls = devicesQueries();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(h.warns).toContain('Boost request: unclear answer from Octopus (Boost response had no device). Checking the boost state with a charging poll');
        expect(devicesQueries()).toBe(polls + 1);
        expect(lastPollPayload().boost_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(false);
        expect(chargingChanges()).toEqual([]);
    });

    test('the mutation reads back only the device id', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(boostMutations()[0][0].query).not.toMatch(/status/);
    });
});

describe('set_boost read-back', () => {
    test('a read-back without status assumes the request took effect; a poll that still disagrees wins after the 2 min hold', async () => {
        boostReply = async () => ({ data: { data: { updateBoostCharge: { id: DEVICE_ID, status: null } } }, status: 200 });
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        expect(h.logs).toContain('Boost requested');
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(chargingChanges()[0].payload.boosting).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');

        // Octopus still reports no boost (currentState unchanged). Inside the hold the forced
        // poll does not snap the switch back (sweep #4).
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');

        // After the hold, the next poll wins.
        await h.advance(2 * 60 * 1000);
        h.node._handlers.input({ payload: {} }); // manual refresh
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(false);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true, false]);
        expect(h.published('boost').pop()).toBe('OFF');
        expect(h.logs.some((l) => /^Octopus still reports boosting=false 2 min after the boost change/.test(l))).toBe(true);
    });

    test('a read-back that is not BOOSTING yet does not snap the switch back', async () => {
        boostReply = async () => ({
            data: { data: { updateBoostCharge: { id: DEVICE_ID, status: { currentState: 'SMART_CONTROL_CAPABLE' } } } },
            status: 200,
        });
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        expect(h.logs).toContain('Boost requested');
        expect(h.logs).toContain('Boost request accepted. Octopus still reports SMART_CONTROL_CAPABLE, so the switch stays on while it catches up');
        expect(lastPollPayload().boost_error).toBeNull();
        expect(lastPollPayload().boosting).toBe(true);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(h.published('boost').pop()).toBe('ON');
    });

    test('the hold ends as soon as a poll sent after the request agrees', async () => {
        boostReply = async () => ({
            data: { data: { updateBoostCharge: { id: DEVICE_ID, status: { currentState: 'SMART_CONTROL_CAPABLE' } } } },
            status: 200,
        });
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);           // forced poll: still CAPABLE, held
        currentState = 'BOOSTING';
        await h.advance(20000);
        h.node._handlers.input({ payload: {} });
        await runFor(2);           // agrees: the hold ends
        currentState = 'SMART_CONTROL_CAPABLE'; // the boost ends on its own
        await h.advance(20000);
        h.node._handlers.input({ payload: {} });
        await runFor(2);           // well inside 2 min, but no hold any more: the poll wins
        expect(lastPollPayload().boosting).toBe(false);
        expect(h.published('boost').pop()).toBe('OFF');
    });

    test('a charging poll sent before the boost and answered after it does not snap the switch back', async () => {
        await h.start();
        const hold = h.hold(/getDispatches/);
        h.node._handlers.input({ payload: {} }); // make the charging poll due
        const tick = h.onTick();                   // devices (not boosting) sent, dispatches held
        await flush();

        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(h.logs).toContain('Boost requested');

        hold.release();
        await tick;
        expect(lastPollPayload().boosting).toBe(true);
        expect(lastPollPayload().charging_now).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
    });

    test('a boost started outside the node (Octopus app) turns charging_now on at the next poll and stays on', async () => {
        await h.start();
        expect(lastPollPayload().charging_now).toBe(false);

        currentState = 'BOOSTING';
        h.node._handlers.input({ payload: {} }); // manual refresh
        await runFor(35); // several 10 s reconciliation passes

        expect(boostMutations()).toHaveLength(0);
        expect(lastPollPayload().boosting).toBe(true);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(h.published('boost').pop()).toBe('ON');
        expect(h.published('charging_now').pop()).toBe('ON');
        expect(h.warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);
    });
});

describe('boost and planned slots', () => {
    test('a boost during an active slot adds no charging change, and cancelling it keeps charging_now on', async () => {
        h.plan = [slot('2026-10-07T11:30:00Z', '2026-10-07T12:30:00Z')];
        await h.start();
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);

        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(true);
        h.node._handlers.input({ payload: { set_boost: false } });
        await runFor(6); // boost mutations are at least 5 s apart

        expect(boostMutations().map(([b]) => b.variables.action)).toEqual(['BOOST', 'CANCEL']);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(lastPollPayload().boosting).toBe(false);
        expect(lastPollPayload().charging_now).toBe(true);
    });

    test('a slot that ends during a boost keeps charging_now on until the boost is cancelled', async () => {
        h.plan = [slot('2026-10-07T11:30:00Z', '2026-10-07T12:10:00Z')];
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);

        // Past the slot end, with the normal 5-minute polls (which keep confirming the boost).
        await h.runUntil('2026-10-07T12:11:05Z');
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
        expect(h.published('charging_now').pop()).toBe('ON');
        expect(h.warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);

        h.node._handlers.input({ payload: { set_boost: false } });
        await runFor(2);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true, false]);
        expect(h.published('charging_now').pop()).toBe('OFF');
    });
});

describe('Boost Charge switch command parsing', () => {
    test('surrounding whitespace is ignored', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from(' ON \n'));
        await runFor(2);
        expect(boostMutations().map(([b]) => b.variables.action)).toEqual(['BOOST']);
    });

    test.each(['on', 'TOGGLE', '', 'true', '1'])('%p is ignored with a warning: no request, no refresh', async (payload) => {
        await h.start();
        const polls = devicesQueries();
        boostCommand()(BOOST_TOPIC, Buffer.from(payload));
        await runFor(2);
        expect(boostMutations()).toHaveLength(0);
        expect(devicesQueries()).toBe(polls);
        expect(h.warns).toContain(`Ignored set_boost command '${payload}': send ON or OFF`);
    });

    test('a huge payload is ignored and the warning stays short', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('x'.repeat(100000)));
        await runFor(2);
        expect(boostMutations()).toHaveLength(0);
        const w = h.warns.find((m) => m.startsWith('Ignored set_boost command'));
        expect(w.length).toBeLessThan(100);
    });

    test('msg.payload set_boost false with no boost running still sends CANCEL', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: false } });
        await runFor(2);
        expect(boostMutations().map(([b]) => b.variables)).toEqual([{ deviceId: DEVICE_ID, action: 'CANCEL' }]);
        expect(h.logs).toContain('Boost cancelled');
        expect(chargingChanges()).toEqual([]);
    });
});

// Sweep #5: boosting is only kept while the charging poll keeps confirming it.
describe('boosting expires without confirmation', () => {
    const failingDevices = () => ({
        data: null,
        errors: [{ message: 'Something went wrong.', path: ['devices'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-9999' } }],
    });

    test('charging polls failing for over 2 intervals: boosting becomes unknown and charging_now falls back to the plan', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(true);

        h.replies.devices = failingDevices;
        await h.runUntil('2026-10-07T12:09:30Z');      // 12:05 poll failed; still inside 2 x 5 min
        expect(h.published('charging_now').pop()).toBe('ON');

        await h.runUntil('2026-10-07T12:10:30Z');      // 12:10 poll failed too; over 10 min
        expect(h.warns.some((w) => /^Boost state not confirmed by Octopus for 10m \d+s: treating it as unknown$/.test(w))).toBe(true);
        expect(h.published('charging_now').pop()).toBe('OFF');
        const last = chargingChanges().pop();
        expect(last.payload.charging_now).toBe(false);
        expect(last.payload.boosting).toBeNull();
    });

    // Review A7: the HA switch kept its last retained ON while boosting was unknown.
    test('on expiry the Boost switch state is published as None (unknown) and the payload as null', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        expect(h.published('boost').pop()).toBe('ON');

        h.replies.devices = failingDevices;
        await h.runUntil('2026-10-07T12:10:30Z');
        const calls = h.publishCalls('boost');
        expect(calls[calls.length - 1]).toEqual([`${STATUS}/boost`, 'None', { retain: true }]);
        expect(h.lastPayload().boosting).toBeNull();

        // The next good poll publishes ON or OFF again.
        h.replies.devices = () => {
            const d = pollDevice();
            d.smartStatus = { isSuspended: false, currentState: 'SMART_CONTROL_CAPABLE' };
            return { data: { devices: [d] } };
        };
        await h.runUntil('2026-10-07T12:15:05Z');
        expect(h.published('boost').pop()).toBe('OFF');
    });

    test('an expired boost during a planned slot leaves charging_now on (the plan still says charge)', async () => {
        h.plan = [{ start: '2026-10-07T11:30:00Z', end: '2026-10-07T13:30:00Z', type: 'SMART', energyAddedKwh: '3.0' }];
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        h.replies.devices = failingDevices;
        await h.runUntil('2026-10-07T12:10:30Z');
        expect(h.published('charging_now').pop()).toBe('ON');
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true]);
    });

    test('the next good poll brings boosting back', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(2);
        h.replies.devices = failingDevices;
        await h.runUntil('2026-10-07T12:10:30Z');
        h.replies.devices = () => {
            const d = pollDevice();
            d.smartStatus = { isSuspended: false, currentState: 'BOOSTING' };
            return { data: { devices: [d] } };
        };
        await h.runUntil('2026-10-07T12:15:05Z');
        expect(lastPollPayload().boosting).toBe(true);
        expect(h.published('charging_now').pop()).toBe('ON');
    });
});

// Sweep #2/#3, review F2: one updateBoostCharge at a time, latest value wins, repeats dropped,
// mutations at least 5 s apart, superseded answers ignored, forced polls rate-limited.
describe('boost request order, spacing and rate', () => {
    const actions = () => boostMutations().map(([b]) => b.variables.action);

    test('rapid ON then OFF: BOOST, then CANCEL after the gap; the superseded BOOST answer does not move the switch', async () => {
        await h.start();
        const publishedBefore = h.published('boost').length;
        const polls = devicesQueries();
        boostGate = makeGate();
        const gate = boostGate;
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF'));
        gate.release();
        await flush();

        expect(actions()).toEqual(['BOOST']);
        expect(h.published('boost')).toHaveLength(publishedBefore);
        expect(h.logs).toContain('Boost request answered, but a newer request follows: ignoring this answer');

        // Review A2: the superseded BOOST may have started a boost, so a charging poll checks.
        // It sees the boost Octopus started, until the CANCEL ends it.
        await runFor(1);
        expect(devicesQueries()).toBe(polls + 1);
        expect(lastPollPayload().boosting).toBe(true);

        await runFor(5);
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(h.published('boost').pop()).toBe('OFF');
        expect(lastPollPayload().boosting).toBe(false);
        expect(chargingChanges().map((m) => m.payload.charging_now)).toEqual([true, false]);
    });

    // Review A2: before, a superseded answer forced no poll, so a refused follow-up CANCEL left
    // the switch OFF while the car boosted until the next normal poll.
    test('a superseded BOOST then a refused CANCEL: the poll shows the boost Octopus started', async () => {
        await h.start();
        boostReply = async (body) => {
            if (body.variables.action === 'CANCEL') return refusal('KT-CT-1234', 'Unable to cancel boost charge.')();
            currentState = 'BOOSTING';
            return { data: { data: { updateBoostCharge: { id: DEVICE_ID } } }, status: 200 };
        };
        boostGate = makeGate();
        const gate = boostGate;
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF'));
        gate.release();
        await flush();
        await runFor(7);

        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(h.warns).toContain('Boost cancel failed: KT-CT-1234: Unable to cancel boost charge');
        expect(lastPollPayload().boosting).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');
        expect(h.published('charging_now').pop()).toBe('ON');
    });

    test('ON then OFF while nothing is in flight: the CANCEL waits for the 5 s gap', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(1);
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF'));
        await runFor(2);
        expect(actions()).toEqual(['BOOST']);
        await runFor(3);
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
    });

    test('OFF then ON again inside the gap: the waiting CANCEL is dropped (latest wins)', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(1);
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF'));
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(10);
        expect(actions()).toEqual(['BOOST']);
        expect(lastPollPayload().boosting).toBe(true);
    });

    test('a flood of 100 alternating ON/OFF messages makes 2 mutations and the last value wins', async () => {
        await h.start();
        for (let i = 0; i < 100; i++) boostCommand()(BOOST_TOPIC, Buffer.from(i % 2 === 0 ? 'ON' : 'OFF'));
        await runFor(30);
        expect(boostMutations().length).toBeLessThanOrEqual(3);
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(lastPollPayload().boosting).toBe(false);
        expect(graphqlPost.mock.calls.filter(([b]) => /obtainKrakenToken/.test(b.query)).length).toBeLessThan(10);
    });

    test('100 identical ON messages send one BOOST', async () => {
        await h.start();
        for (let i = 0; i < 100; i++) boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(30);
        expect(actions()).toEqual(['BOOST']);
    });

    test('a flow sending set_boost true every 100 ms for 30 s sends one BOOST', async () => {
        await h.start();
        for (let i = 0; i < 300; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await jest.advanceTimersByTimeAsync(100);
            if (i % 10 === 9) await h.onTick();
        }
        expect(actions()).toEqual(['BOOST']);
    });

    test('after a refusal the same request is sent again, but not more than once per 5 s', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        for (let i = 0; i < 20; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await jest.advanceTimersByTimeAsync(1000);
            await h.onTick();
        }
        expect(boostMutations().length).toBeGreaterThanOrEqual(2);
        expect(boostMutations().length).toBeLessThanOrEqual(4);
    });

    // Review A5: a flow that asks again after every refusal used to send the refused request
    // every 5 s for as long as it ran.
    describe('back-off after repeated refusals', () => {
        const PAUSED = 'Octopus refused 3 boost requests in 10 minutes: ignoring further boost requests for 10 minutes';
        async function refuseThreeTimes() {
            boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
            await h.start();
            for (let i = 0; i < 6; i++) {
                h.node._handlers.input({ payload: { set_boost: true } });
                await runFor(6);
            }
        }

        test('3 refusals of the same value in 10 minutes pause it, with one warning', async () => {
            await refuseThreeTimes();
            expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST']);
            expect(h.warns.filter((w) => w === PAUSED)).toHaveLength(1);

            const tokens = graphqlPost.mock.calls.filter(([b]) => /obtainKrakenToken/.test(b.query)).length;
            for (let i = 0; i < 20; i++) {
                boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
                await runFor(6);
            }
            expect(actions()).toHaveLength(3);
            expect(graphqlPost.mock.calls.filter(([b]) => /obtainKrakenToken/.test(b.query)).length).toBe(tokens);
            expect(h.warns.filter((w) => w === PAUSED)).toHaveLength(1);
        });

        test('the other value is still sent, and an accepted request ends the pause', async () => {
            await refuseThreeTimes();
            boostReply = null;
            h.node._handlers.input({ payload: { set_boost: false } });
            await runFor(6);
            expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'CANCEL']);
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(6);
            expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'CANCEL', 'BOOST']);
        });

        test('the pause ends after 10 minutes', async () => {
            await refuseThreeTimes();
            await h.advance(10 * 60 * 1000);
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(1);
            expect(actions()).toHaveLength(4);
        });

        test('refusals spread over more than 10 minutes do not pause', async () => {
            boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
            await h.start();
            for (let i = 0; i < 4; i++) {
                h.node._handlers.input({ payload: { set_boost: true } });
                await runFor(1);
                await h.advance(6 * 60 * 1000);
            }
            expect(actions()).toHaveLength(4);
            expect(h.warns.filter((w) => w === PAUSED)).toHaveLength(0);
        });
    });

    // Review A9: a repeat within the 5 s gap after a refusal used to be dropped with no log.
    test('a tap within 5 s of a refusal is queued and sent once the gap has passed', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));   // refused at once
        await flush();
        expect(actions()).toEqual(['BOOST']);
        boostReply = null;                                // e.g. the car is now plugged in
        await runFor(3);
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));   // inside the gap
        await flush();
        expect(actions()).toEqual(['BOOST']);
        await runFor(3);
        expect(actions()).toEqual(['BOOST', 'BOOST']);
        expect(h.logs).toContain('Boost requested');
        expect(h.published('boost').pop()).toBe('ON');
    });

    test('a repeat within 5 s of an accepted request is still dropped', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(2);
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(10);
        expect(actions()).toEqual(['BOOST']);
    });

    // Review A8: event-loop lag can let the clock pass the 5 s gap before the gap timer runs.
    // jest.setSystemTime moves the clock without running timers, which is that lag.
    test('a late gap timer cannot send an older value after a newer one', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });  // BOOST, refused
        await flush();
        h.node._handlers.input({ payload: { set_boost: false } }); // waits for the 5 s gap
        boostReply = null;
        jest.setSystemTime(Date.now() + 6000);                     // the gap passed, timer not run yet
        h.node._handlers.input({ payload: { set_boost: true } });  // sent at once: the newest choice
        await flush();
        await runFor(10);                                          // the old timer runs now

        expect(actions()).toEqual(['BOOST', 'BOOST']);
        expect(lastPollPayload().boosting).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');
    });

    test('a refusal forces no charging poll', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        const polls = devicesQueries();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(3);
        expect(devicesQueries()).toBe(polls);
    });

    test('forced polls after boosts go through the dispatch rate window: a 4th in a minute waits, then runs', async () => {
        await h.start();                                   // dispatch query 1
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));    // forced poll: query 2
        await runFor(6);
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF'));   // forced poll: query 3
        await runFor(6);
        expect(devicesQueries()).toBe(3);

        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));    // a 4th query would break 3 per minute
        await runFor(10);
        expect(actions()).toEqual(['BOOST', 'CANCEL', 'BOOST']);
        expect(devicesQueries()).toBe(3);
        expect(h.logs.some((l) => /^Charging poll after boost waits \d+s/.test(l))).toBe(true);

        await h.runUntil('2026-10-07T12:01:05Z');          // the window opens about 12:01:02
        expect(devicesQueries()).toBe(4);
    });
});

// Review A1: a connection that drops after the answer headers can leave a request pending for
// ever. The boost queue gives up after 75 s, so later requests still go out.
describe('boost watchdog', () => {
    const actions = () => boostMutations().map(([b]) => b.variables.action);
    const TIMEOUT = 'No answer from Octopus after 75s';

    test('a request that never settles is given up after 75 s: warning, boost_error and a charging poll', async () => {
        await h.start();
        const polls = devicesQueries();
        boostGate = makeGate(); // never released: the answer never comes
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();
        await runFor(74);
        expect(h.warns).not.toContain(`Boost request failed: ${TIMEOUT}`);
        expect(devicesQueries()).toBe(polls);

        await runFor(2);
        expect(h.warns).toContain(`Boost request failed: ${TIMEOUT}`);
        expect(h.statePublishes().pop().boost_error).toBe(TIMEOUT);
        expect(devicesQueries()).toBe(polls + 1);
        expect(h.statuses[h.statuses.length - 1].text).not.toBe('Requesting boost...');
    });

    test('a request that never settles does not block later requests, and its late answer changes nothing', async () => {
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await flush();
        boostCommand()(BOOST_TOPIC, Buffer.from('OFF')); // waits behind the stuck request
        await runFor(30);
        expect(actions()).toEqual(['BOOST']);

        await runFor(50);                                 // past the 75 s watchdog
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(h.logs).toContain('Boost cancelled');

        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));   // later requests still work
        await runFor(6);
        expect(actions()).toEqual(['BOOST', 'CANCEL', 'BOOST']);

        const requested = h.logs.filter((l) => l === 'Boost requested').length;
        gate.release();                                   // the first answer finally arrives
        await flush();
        expect(h.logs.filter((l) => l === 'Boost requested').length).toBe(requested);
        expect(h.logs).not.toContain('Boost request answered, but a newer request follows: ignoring this answer');
    });

    test('an answer in time clears the watchdog: nothing is reported 75 s later', async () => {
        await h.start();
        boostCommand()(BOOST_TOPIC, Buffer.from('ON'));
        await runFor(80);
        expect(boostWarns()).toEqual([]);
        expect(lastPollPayload().boost_error).toBeNull();
    });
});

describe('close during a boost request', () => {
    test('a late success after close changes nothing', async () => {
        await h.start();
        const publishedBefore = h.published('boost').length;
        boostGate = makeGate();
        const gate = boostGate;
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(boostMutations()).toHaveLength(1); // in flight

        h.close();
        gate.release();
        await flush();

        expect(h.logs).not.toContain('Boost requested');
        expect(h.published('boost')).toHaveLength(publishedBefore);
        expect(chargingChanges()).toEqual([]);
        expect(h.statuses.some((s) => s.text === 'Boost requested')).toBe(false);
    });

    test('a late failure after close is not reported', async () => {
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        h.close();
        gate.reject(new Error('socket hang up'));
        await flush();

        expect(boostWarns()).toEqual([]);
        expect(h.statuses.some((s) => s.text === 'Boost request failed')).toBe(false);
    });

    test('a late refusal after close is not reported', async () => {
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();

        h.close();
        gate.release();
        await flush();

        expect(boostWarns()).toEqual([]);
    });
});

describe('boost while a charging poll is in flight', () => {
    // Was a FINDING (coverage draft, review F4): pollDueCategories() replaced lastKnownState with
    // the tick's result, merged into a snapshot taken when the tick STARTED, so a refusal that
    // landed while the charging poll waited on Octopus lost its boost_error. boosting and
    // boost_error are now re-applied after the tick, like charging_now.
    test('a refusal during an in-flight poll still reaches boost_error', async () => {
        await h.start();
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        const hold = h.hold(/getDispatches/);
        h.node._handlers.input({ payload: {} }); // make the charging poll due
        const tick = h.onTick();                   // devices sent, dispatches held
        await flush();

        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(h.warns).toContain('Boost request failed: KT-CT-1234: Unable to boost charge');

        hold.release();
        await tick;
        await runFor(2);
        expect(lastPollPayload().boost_error).toBe('KT-CT-1234: Unable to boost charge');
    });

    test('a refusal during an in-flight poll also reaches the retained MQTT state', async () => {
        await h.start();
        boostReply = refusal('KT-CT-1234', 'Unable to boost charge.');
        const hold = h.hold(/getDispatches/);
        h.node._handlers.input({ payload: {} });
        const tick = h.onTick();
        await flush();
        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        hold.release();
        await tick;
        expect(h.statePublishes().pop().boost_error).toBe('KT-CT-1234: Unable to boost charge');
    });

    // Left skipped on purpose: forceCategoryDue lost during an in-flight poll is fixed in the
    // shared 1.6.x scheduler code, not here. (The 1.7 boost hold already keeps the switch on.)
    // FINDING: setBoost() ends with forceCategoryDue('intelligent') (lastPolled = 0) so the next
    // tick re-reads the device. When a charging poll is already in flight, runTick sets
    // cat.lastPolled = now() when that poll finishes, cancelling the forced poll. That poll's
    // devices query went out BEFORE the boost, so it reports the old currentState, sets
    // boosting = false and turns charging_now off again; the real BOOSTING state is only seen at
    // the next scheduled poll (refreshInterval later). Correct: the forced re-read still happens.
    test('FINDING (fixed): a successful boost during an in-flight poll is confirmed by a fresh poll', async () => {
        await h.start();
        const hold = h.hold(/getDispatches/);
        h.node._handlers.input({ payload: {} }); // make the charging poll due
        const tick = h.onTick();                   // devices (not boosting) sent, dispatches held
        await flush();

        h.node._handlers.input({ payload: { set_boost: true } });
        await flush();
        expect(h.logs).toContain('Boost requested');

        hold.release();
        await tick;
        await runFor(2);
        expect(lastPollPayload().boosting).toBe(true);
        expect(lastPollPayload().charging_now).toBe(true);
        expect(h.published('boost').pop()).toBe('ON');
    });
});

// Review A11: the charging poll reads status for every device on the account. A persistent
// status error on another device (an inverter, a second charger) used to mark smartStatus,
// preferences and Charge Cap as failed for the EV too, freezing them every poll.
describe('errors on another device in the charging poll', () => {
    const otherError = (index, field = 'smartStatus') => ({
        message: 'Unable to get device status.', path: ['devices', index, field],
        extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' },
    });
    const other = { id: 'inv-1', deviceType: 'BATTERIES', preferences: null, chargeCap: null, smartStatus: null };
    const ev = () => {
        const d = pollDevice({ max: 70, time: '06:30:00' });
        d.smartStatus = { isSuspended: true, currentState };
        return d;
    };

    test.each([
        ['present', () => other],
        ['nulled by the error', () => null],
    ])('another device %s with a status error: the EV switch, preferences and boost state still update', async (_, otherEntry) => {
        await h.start();
        h.replies.devices = () => ({ data: { devices: [otherEntry(), ev()] }, errors: [otherError(0)] });
        currentState = 'BOOSTING';
        h.node._handlers.input({ payload: {} }); // manual refresh
        await runFor(2);

        const p = lastPollPayload();
        expect(p.intelligent_error).toBeNull();
        expect(p.boosting).toBe(true);
        expect(p.device_state).toBe('BOOSTING');
        expect(p.smart_charging).toBe(false);
        expect(p.confirmed_limit).toBe(70);
        expect(p.confirmed_time).toBe('06:30');
        expect(h.published('smart_charging').pop()).toBe('OFF');
        expect(h.published('boost').pop()).toBe('ON');
        expect(h.warns.filter((w) => /Charging preferences unavailable|Charge Cap state unavailable/.test(w))).toEqual([]);
    });

    test('it is logged once, not every poll', async () => {
        await h.start();
        h.replies.devices = () => ({ data: { devices: [other, ev()] }, errors: [otherError(0)] });
        for (let i = 0; i < 3; i++) {
            h.node._handlers.input({ payload: {} });
            await runFor(31); // past the 30 s manual refresh window
        }
        expect(h.logs.filter((l) => /could not read another device/.test(l))).toHaveLength(1);
    });

    test('an error on the EV itself is still handled as before (last boost state kept)', async () => {
        await h.start();
        h.replies.devices = () => {
            const d = ev();
            d.smartStatus = null;
            return { data: { devices: [other, d] }, errors: [otherError(1)] };
        };
        currentState = 'BOOSTING';
        h.node._handlers.input({ payload: {} });
        await runFor(2);
        const p = lastPollPayload();
        expect(p.intelligent_error).toBeNull();
        expect(p.boosting).toBe(false); // unknown this poll: the last value is kept
    });
});
