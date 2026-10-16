// __tests__/boost-queue-lifecycle.test.js
'use strict';
/**
 * The boost queue (review A1 watchdog, A2 unclear answers, A5 back-off, A8/A9 gap timer)
 * against node close and redeploy, and which failures count towards the A5 back-off. Paths
 * boost-node-edges.test.js does not reach. Kraken is mocked with live shapes:
 * updateBoostCharge(input: {deviceId, action: BOOST | CANCEL}) returns the device (only its id
 * is read back); a refusal is HTTP 200 { data: { updateBoostCharge: null }, errors: [{ message,
 * path: ['updateBoostCharge'], extensions: { errorCode } }] }; the charging poll reads
 * status.currentState under the smartStatus alias.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, pollDevice, ACCOUNT, DEVICE_ID } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');

const BOOST_TOPIC = `nodered_octopus/${ACCOUNT}/set_boost`;
const PAUSED = 'Octopus refused 3 boost requests in 10 minutes: ignoring further boost requests for 10 minutes';
const SUPERSEDED = 'Boost request answered, but a newer request follows: ignoring this answer';

let h;
let currentState;  // what Octopus reports in smartStatus.currentState
let boostReply;    // null, or async (body) => full graphqlPost result (may throw)
let boostGate;     // null, or a gate the next boost mutation waits on

function makeGate() {
    const g = {};
    g.promise = new Promise((resolve, reject) => { g.release = resolve; g.reject = reject; });
    return g;
}

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
const actions = () => boostMutations().map(([b]) => b.variables.action);
const devicesQueries = () => graphqlPost.mock.calls.filter(([body]) => /SmartFlexDevicePreferences/.test(body.query)).length;
// The newest node's set_boost handler (a redeploy subscribes again).
const boostCommand = () => h.broker.subscribe.mock.calls.filter((c) => c[0] === BOOST_TOPIC).pop()[2];
const tap = (value) => boostCommand()(BOOST_TOPIC, Buffer.from(value));
const lastPollPayload = () => h.pollSends().pop().payload;

const refusal = async () => ({
    data: { data: { updateBoostCharge: null }, errors: [
        { message: 'Unable to boost charge.', path: ['updateBoostCharge'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-1234' } },
    ] },
    status: 200,
});
// No device and no error: not clear whether it went through (review A2).
const unclear = async () => ({ data: { data: { updateBoostCharge: null } }, status: 200 });

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    h = createHarness();
    currentState = 'SMART_CONTROL_CAPABLE';
    boostReply = null;
    boostGate = null;
    h.replies.devices = () => {
        const d = pollDevice();
        d.smartStatus = { isSuspended: false, currentState };
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
            return { data: { data: { updateBoostCharge: { id: DEVICE_ID } } }, status: 200 };
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('close with the boost queue busy', () => {
    test('a request waiting for the 5 s gap is never sent once the node closes', async () => {
        await h.start();
        tap('ON');
        await runFor(1);
        tap('OFF');                    // waits for the gap after the BOOST
        await flush();
        expect(actions()).toEqual(['BOOST']);

        h.close();
        await jest.advanceTimersByTimeAsync(30000);
        expect(actions()).toEqual(['BOOST']);
    });

    test('a request queued behind one in flight is never sent, even when the answer arrives after close', async () => {
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        tap('ON');
        await flush();
        tap('OFF');                    // queued behind the BOOST in flight
        h.close();
        gate.release();
        await flush();
        await jest.advanceTimersByTimeAsync(30000);
        expect(actions()).toEqual(['BOOST']);
        expect(h.logs).not.toContain('Boost requested');
        expect(h.logs).not.toContain(SUPERSEDED);
    });

    test('closing during an unanswered request stops the 75 s watchdog: nothing is reported and no timer is left', async () => {
        await h.start();
        boostGate = makeGate();        // never answered
        tap('ON');
        await flush();
        const statePublishes = h.statePublishes().length;
        const sends = h.sends.length;

        h.close();
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(120000);
        expect(h.warns.filter((w) => /No answer from Octopus/.test(w))).toEqual([]);
        expect(h.statePublishes()).toHaveLength(statePublishes);
        expect(h.sends).toHaveLength(sends);
    });
});

describe('redeploy with the boost queue busy', () => {
    test('the new node sends at once; the old node\'s late answer moves nothing', async () => {
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        tap('ON');                     // old node: BOOST in flight
        await flush();

        h.close();
        await h.start();               // redeploy: a new node, discovery and a first poll
        tap('OFF');                    // new node: nothing in flight, so CANCEL goes out now
        await flush();
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(h.logs).toContain('Boost cancelled');

        const switchStates = h.published('boost').length;
        const charging = h.published('charging_now').length;
        gate.release();                // the old BOOST is answered at last
        await flush();
        expect(h.logs).not.toContain('Boost requested');
        expect(h.published('boost')).toHaveLength(switchStates);
        expect(h.published('charging_now')).toHaveLength(charging);
        expect(h.published('boost').pop()).toBe('OFF');
    });

    test('a refusal back-off on the old node does not carry over to the new one', async () => {
        boostReply = refusal;
        await h.start();
        for (let i = 0; i < 3; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(6);
        }
        expect(h.warns.filter((w) => w === PAUSED)).toHaveLength(1);
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(1);
        expect(actions()).toHaveLength(3);   // paused

        h.close();
        boostReply = null;
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(1);
        expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'BOOST']);
        expect(h.logs).toContain('Boost requested');
    });
});

describe('only clean refusals count towards the back-off (review A5)', () => {
    test('three watchdog timeouts do not pause the value', async () => {
        await h.start();
        for (let i = 0; i < 3; i++) {
            boostGate = makeGate();    // never answered
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(77);
        }
        expect(h.warns.filter((w) => w === 'Boost request failed: No answer from Octopus after 75s')).toHaveLength(3);
        h.node._handlers.input({ payload: { set_boost: true } });
        await runFor(1);
        expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'BOOST']);
        expect(h.warns).not.toContain(PAUSED);
    });

    test('three transport failures do not pause the value', async () => {
        boostReply = async () => { throw new Error('socket hang up'); };
        await h.start();
        for (let i = 0; i < 4; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(6);
        }
        expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'BOOST']);
        expect(h.warns).not.toContain(PAUSED);
    });

    test('three unclear answers do not pause the value and set no boost_error', async () => {
        boostReply = unclear;
        await h.start();
        for (let i = 0; i < 4; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(6);
        }
        expect(actions()).toEqual(['BOOST', 'BOOST', 'BOOST', 'BOOST']);
        expect(h.warns).not.toContain(PAUSED);
        expect(h.warns.filter((w) => /^Boost request: unclear answer from Octopus/.test(w))).toHaveLength(4);
        expect(lastPollPayload().boost_error).toBeNull();
    });

    test('refusals of ON and of OFF are counted apart: two of each pause neither', async () => {
        boostReply = refusal;
        await h.start();
        for (const v of [true, false, true, false]) {
            h.node._handlers.input({ payload: { set_boost: v } });
            await runFor(6);
        }
        expect(actions()).toEqual(['BOOST', 'CANCEL', 'BOOST', 'CANCEL']);
        expect(h.warns.filter((w) => /^Octopus refused 3/.test(w))).toEqual([]);
    });

    test('a paused value tapped in Home Assistant puts the switch back to the known state', async () => {
        boostReply = refusal;
        await h.start();
        for (let i = 0; i < 3; i++) {
            h.node._handlers.input({ payload: { set_boost: true } });
            await runFor(6);
        }
        expect(h.warns.filter((w) => w === PAUSED)).toHaveLength(1);
        const states = h.published('boost').length;
        tap('ON');
        await flush();
        expect(actions()).toHaveLength(3);
        expect(h.published('boost')).toHaveLength(states + 1);
        expect(h.published('boost').pop()).toBe('OFF');
    });
});

describe('unclear and superseded answers in the queue', () => {
    test('a tap within 5 s of an unclear answer is queued and sent once the gap has passed (review A2 + A9)', async () => {
        boostReply = unclear;
        await h.start();
        tap('ON');
        await flush();
        expect(actions()).toEqual(['BOOST']);
        boostReply = null;
        await runFor(2);
        tap('ON');                     // inside the gap: queued, not dropped
        await flush();
        expect(actions()).toEqual(['BOOST']);
        await runFor(4);
        expect(actions()).toEqual(['BOOST', 'BOOST']);
        expect(h.logs).toContain('Boost requested');
    });

    test('a superseded request that fails in transport is not reported; a poll checks and the newer one is sent', async () => {
        await h.start();
        const polls = devicesQueries();
        boostGate = makeGate();
        const gate = boostGate;
        tap('ON');
        await flush();
        tap('OFF');                    // a newer, different request waits
        gate.reject(new Error('socket hang up'));
        await flush();

        expect(h.logs).toContain(SUPERSEDED);
        expect(h.warns).not.toContain('Boost request failed: socket hang up');
        await runFor(1);
        expect(devicesQueries()).toBe(polls + 1);
        await runFor(6);
        expect(actions()).toEqual(['BOOST', 'CANCEL']);
        expect(h.logs).toContain('Boost cancelled');
    });

    test('asking again for the value in flight cancels the waiting other value', async () => {
        await h.start();
        boostGate = makeGate();
        const gate = boostGate;
        tap('ON');
        await flush();
        tap('OFF');                    // waits behind the BOOST
        tap('ON');                     // the value in flight: the waiting CANCEL is dropped
        gate.release();
        await flush();
        await runFor(10);
        expect(actions()).toEqual(['BOOST']);
        expect(h.logs).toContain('Boost requested');
        expect(h.logs).not.toContain(SUPERSEDED);
    });
});
