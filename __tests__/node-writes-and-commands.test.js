// __tests__/node-writes-and-commands.test.js
'use strict';
/**
 * Coverage round 2 (gaps 8, 9, 10 of docs/reviews/2026-10-06-test-coverage.md), against the REAL node:
 *  - write mutations: setPreferences / setSmartCharging / setChargeCap (success, Kraken error, auth
 *    error, no device id, verify retries and their timers)
 *  - MQTT command handlers through a fake broker, and the node-red input path
 *  - Kraken numeric strings through the poll and into the write payloads
 * graphqlPost, discovery, http and the scheduler are mocked; everything else is production code.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const ACCOUNT = 'A-WRITES01';
const STATE = `nodered_octopus/${ACCOUNT}/status`;
const TOPIC = (name) => `nodered_octopus/${ACCOUNT}/${name}`;
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};

const ok = (data) => ({ data: { data } });
const gqlErrors = (errors) => ({ data: { errors } });
const TOKEN_OK = () => ok({ obtainKrakenToken: { token: 'jwt' } });

let world;      // what the fake Kraken currently answers
let broker;
let cmdHandlers;
let sends;
let statuses;
let warns;
let errors;
let onTick;
let node;

function freshWorld() {
    return {
        prefs: { max: 80, time: '04:00:00' },
        chargeCap: 'ENABLED',
        suspended: false,
        ignoreSmart: false,           // when true a SUSPEND/UNSUSPEND is accepted but never takes effect
        plan: [],
        auth: TOKEN_OK,
        prefsMutation: () => ok({ setDevicePreferences: { __typename: 'SetDevicePreferencesPayload' } }),
        smartMutation: null,          // default built below (applies the change)
        capMutation: () => ok({ updateIsChargingDurationCapped: { __typename: 'X' } }),
        simpleDevicesFail: false,     // fetchDeviceId / smart-charging verification device query
        pollDevicesFail: false,       // the intelligent poll's device query
        pollGate: null,               // a promise: the next intelligent poll device query waits for it
    };
}

function installGraphql() {
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        const q = body.query;
        if (/obtainKrakenToken/.test(q)) return world.auth();
        if (/setDevicePreferences/.test(q)) return world.prefsMutation(body);
        if (/updateDeviceSmartControl/.test(q)) {
            if (world.smartMutation) return world.smartMutation(body);
            if (!world.ignoreSmart) world.suspended = body.variables.action === 'SUSPEND';
            return ok({ updateDeviceSmartControl: { id: 'dev-1' } });
        }
        if (/updateIsChargingDurationCapped/.test(q)) return world.capMutation(body);
        // 1.6.3: the poll's getDevices also reads isSuspended (alias smartStatus), so the
        // simple device query is the one without preferences.
        if (/isSuspended/.test(q) && !/preferences/.test(q)) {
            if (world.simpleDevicesFail) return gqlErrors([{ message: 'device query down' }]);
            return ok({ devices: [{ id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: world.suspended } }] });
        }
        if (/getDevices/.test(q)) {
            if (world.pollGate) { const gate = world.pollGate; world.pollGate = null; await gate; }
            if (world.pollDevicesFail) return gqlErrors([{ message: 'nope', extensions: { errorCode: 'KT-CT-9999' } }]);
            return ok({
                devices: [{
                    id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
                    preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: world.prefs.time, max: world.prefs.max }] },
                    chargeCap: { isChargingDurationCapped: world.chargeCap },
                    smartStatus: { isSuspended: world.suspended },
                }],
            });
        }
        if (/getDispatches/.test(q)) return ok({ flexPlannedDispatches: world.plan });
        return gqlErrors([{ message: 'stubbed' }]);
    });
}

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n, config) {
                const handlers = {};
                const store = {};
                n.id = config.id;
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_writes' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = () => {};
                n.warn = (m) => { warns.push(String(m)); };
                n.error = (m, msg) => { errors.push({ text: String(m), msg }); };
                n.status = (s) => { statuses.push(s); };
                n.send = (msg) => { sends.push(msg); };
                n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: () => broker,
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED); // each call builds fresh node state
    return new NodeCtor({ id: 'oi-writes', accountNumber: ACCOUNT, enableMqtt: true, broker: 'b1', refreshInterval: 60 });
}

// opts.tick false: skip the first poll (so a failed startup device fetch leaves no device id).
async function start({ tick = true } = {}) {
    node = buildNode();
    await jest.advanceTimersByTimeAsync(3100); // device fetch 1.5 s, discovery 2 s, MQTT announce/republish 2-3 s
    if (tick) await onTick();
    broker.client.publish.mockClear();
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; statuses = []; warns = []; errors = []; cmdHandlers = {};
    world = freshWorld();
    installGraphql();
    broker = {
        client: { publish: jest.fn(), subscribe: jest.fn() },
        register: jest.fn(),
        deregister: jest.fn((n, done) => done && done()),
        subscribe: jest.fn((topic, qos, cb) => { cmdHandlers[topic] = cb; }),
        unsubscribe: jest.fn(),
    };
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });
    node = null;
});

afterEach(() => {
    if (node) node._handlers.close(false, () => {});
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

// ---- helpers -----------------------------------------------------------------------------
const flush = () => jest.advanceTimersByTimeAsync(1);
const cmd = async (name, payload) => {
    cmdHandlers[TOPIC(name)](TOPIC(name), Buffer.from(String(payload)));
    await flush();
};
const input = async (payload) => { node._handlers.input({ payload }); await flush(); };
const calls = (re) => graphqlPost.mock.calls.filter(([b]) => re.test(b.query));
const prefMutations = () => calls(/setDevicePreferences/);
const prefPolls = () => calls(/getDevices/).filter(([b]) => /preferences/.test(b.query)).length;
const verifyQueries = () => calls(/isSuspended/).filter(([b]) => !/preferences/.test(b.query)).length; // includes the startup device fetch
const dispatchCalls = () => calls(/getDispatches/).length;
const authCalls = () => calls(/obtainKrakenToken/).length;
const lastStatus = () => statuses[statuses.length - 1];
const pollSends = () => sends.filter((m) => m.payload && !m.debug && 'intelligent_error' in m.payload);
const lastPoll = () => pollSends().pop().payload;
const statePubs = () => broker.client.publish.mock.calls.filter((c) => c[0] === STATE);
const lastStatePub = () => JSON.parse(statePubs().pop()[1]);
const pubsTo = (suffix) => broker.client.publish.mock.calls.filter((c) => c[0] === `${STATE}/${suffix}`);
const refreshPoll = async () => { await cmd('refresh', ''); await onTick(); };

// =========================================================================================
describe('setPreferences (submit via MQTT)', () => {
    test('sends the 7-day schedule with the pending limit and time and the JWT, then verifies and confirms', async () => {
        await start();
        await cmd('set_limit', '90');
        await cmd('set_time', '04:30');
        await cmd('submit_changes', '');

        expect(prefMutations()).toHaveLength(1);
        const [body, token] = prefMutations()[0];
        expect(token).toBe('jwt');
        expect(body.variables.input).toMatchObject({ deviceId: 'dev-1', mode: 'CHARGE', unit: 'PERCENTAGE' });
        expect(body.variables.input.schedules.map((s) => s.dayOfWeek)).toEqual(DAYS);
        for (const s of body.variables.input.schedules) expect(s).toEqual(expect.objectContaining({ time: '04:30:00', min: 0, max: 90 }));
        expect(lastStatus()).toMatchObject({ fill: 'blue', shape: 'ring', text: 'Verifying changes...' });

        // The API now reflects the change (string max, as Kraken can send): the first verify poll confirms it.
        world.prefs = { max: '90', time: '04:30:00' };
        const before = prefPolls();
        await jest.advanceTimersByTimeAsync(15000);
        expect(prefPolls()).toBe(before + 1);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Confirmed: 90% @ 04:30' });
        expect(lastPoll().confirmed_limit).toBe(90);

        // validation done: retry timers are gone, no further verification polls
        await jest.advanceTimersByTimeAsync(300000);
        expect(prefPolls()).toBe(before + 1);
    });

    test('retries verification at 15 s, 30 s, 60 s, 120 s when the API never reflects the change, then times out', async () => {
        await start();
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        const base = prefPolls();

        await jest.advanceTimersByTimeAsync(14000);
        expect(prefPolls()).toBe(base);
        await jest.advanceTimersByTimeAsync(1000);
        expect(prefPolls()).toBe(base + 1);
        expect(lastStatus()).toMatchObject({ fill: 'blue', text: 'Retry 1/4...' });

        await jest.advanceTimersByTimeAsync(30000);
        expect(prefPolls()).toBe(base + 2);
        expect(lastStatus().text).toBe('Retry 2/4...');

        await jest.advanceTimersByTimeAsync(60000);
        expect(prefPolls()).toBe(base + 3);
        expect(lastStatus().text).toBe('Retry 3/4...');

        await jest.advanceTimersByTimeAsync(120000);
        expect(prefPolls()).toBe(base + 4);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Validation timed out' });

        await jest.advanceTimersByTimeAsync(600000);
        expect(prefPolls()).toBe(base + 4); // nothing left scheduled
    });

    test('verification polls that throw warn per attempt and end with "Validation failed"', async () => {
        await start();
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        world.pollDevicesFail = true;

        await jest.advanceTimersByTimeAsync(15000);
        expect(warns).toContain('Retry 1 failed: KT-CT-9999: nope');
        await jest.advanceTimersByTimeAsync(30000);
        await jest.advanceTimersByTimeAsync(60000);
        await jest.advanceTimersByTimeAsync(120000);
        expect(warns).toContain('Retry 4 failed: KT-CT-9999: nope');
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Validation failed' });
    });

    test('a Kraken error on the mutation sets "Update Failed" and starts no verification', async () => {
        await start();
        world.prefsMutation = () => gqlErrors([{ message: 'Not allowed' }]);
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');

        expect(errors.some((e) => /Failed to set preferences: Mutation failed: .*Not allowed/.test(e.text))).toBe(true);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Update Failed' });
        const base = prefPolls();
        await jest.advanceTimersByTimeAsync(300000);
        expect(prefPolls()).toBe(base);
    });

    // Sweep 2026-10-08 #6: no answer to the mutation does not mean Octopus refused it.
    test('a mutation with no answer (timeout) is reported unconfirmed and forces a charging poll', async () => {
        await start();
        world.prefsMutation = () => { throw new Error('Octopus API request timed out after 30s'); };
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');

        expect(warns).toContain('Preferences update not confirmed (Octopus API request timed out after 30s) - checking with Octopus');
        expect(errors.some((e) => /Failed to set preferences/.test(e.text))).toBe(false);
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Update unconfirmed - checking' });

        world.prefs = { max: 90, time: '04:00:00' };   // Octopus had applied it
        const d = dispatchCalls();
        await onTick();                                // forced due although the interval is 60 min
        expect(dispatchCalls()).toBe(d + 1);
        expect(lastPoll().confirmed_limit).toBe(90);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Confirmed: 90% @ 04:00' });

        const polls = prefPolls();
        await jest.advanceTimersByTimeAsync(300000);
        expect(prefPolls()).toBe(polls);               // no verification chain was started
    });

    // Review 5 R1: a write that never reached Octopus is a plain failure again, as in 1.6.1.
    test.each([
        ['DNS failure', () => Object.assign(new Error('getaddrinfo ENOTFOUND api.octopus.energy'), { code: 'ENOTFOUND' })],
        ['connection refused', () => Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })],
        ['an HTTP 4xx page', () => new Error('HTTP 403: <html>Forbidden</html>')],
        ['a reply that is not JSON', () => new Error('Failed to parse API response: Unexpected token <')],
    ])('a mutation that fails with %s raises node.error, shows "Update Failed" and forces no poll', async (label, make) => {
        await start();
        world.prefsMutation = () => { throw make(); };
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');

        expect(errors.some((e) => e.text.startsWith('Failed to set preferences: '))).toBe(true);
        expect(warns.some((w) => /not confirmed/.test(w))).toBe(false);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Update Failed' });
        const d = dispatchCalls();
        await onTick();                                // not forced: the interval is 60 min
        expect(dispatchCalls()).toBe(d);
    });

    test('a connection closed after the request was sent is unconfirmed', async () => {
        await start();
        world.prefsMutation = () => { throw new Error('Octopus API connection closed before the response completed'); };
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        expect(warns).toContain('Preferences update not confirmed (Octopus API connection closed before the response completed) - checking with Octopus');
        expect(errors).toHaveLength(0);
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Update unconfirmed - checking' });
    });

    test('an unconfirmed change that the forced poll does not find shows "Update Failed" and warns', async () => {
        await start();
        world.prefsMutation = () => { throw new Error('Octopus API request timed out after 30s'); };
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Update unconfirmed - checking' });

        const d = dispatchCalls();
        await onTick();                                // Octopus still has 80%: the write was lost
        expect(dispatchCalls()).toBe(d + 1);
        expect(warns).toContain('Preferences update not applied: sent 90% @ 04:00, Octopus has 80% @ 04:00');
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Update Failed' });
        expect(lastPoll().confirmed_limit).toBe(80);

        await refreshPoll();                           // checked once: the next poll is a normal one
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Confirmed: 80% @ 04:00' });
        expect(warns.filter((w) => /not applied/.test(w))).toHaveLength(1);
    });

    test('an auth error stops before the mutation', async () => {
        await start();
        world.auth = () => gqlErrors([{ message: 'bad key' }]);
        await cmd('submit_changes', '');
        expect(errors.some((e) => /Failed to set preferences: Auth failed/.test(e.text))).toBe(true);
        expect(prefMutations()).toHaveLength(0);
        expect(lastStatus().text).toBe('Update Failed');
    });

    test('an auth response without a token stops before the mutation', async () => {
        await start();
        world.auth = () => ok({ obtainKrakenToken: null });
        await cmd('submit_changes', '');
        expect(errors.some((e) => /Auth response missing token data/.test(e.text))).toBe(true);
        expect(prefMutations()).toHaveLength(0);
    });

    test('with no cached device id the mutation is not sent', async () => {
        // Since 1.6.2 discovery seeds the device id, so make discovery find none too.
        discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: null });
        world.simpleDevicesFail = true; // startup device fetch fails; no poll yet, so no id from the poll either
        await start({ tick: false });
        expect(warns.some((w) => /Failed to fetch device ID at startup/.test(w))).toBe(true);
        await cmd('submit_changes', '');
        expect(errors.some((e) => /Device ID not available — cannot set preferences/.test(e.text))).toBe(true);
        expect(prefMutations()).toHaveLength(0);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Update Failed' });
    });

    test('a second submit cancels the first submit\'s pending verification timers', async () => {
        await start();
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        await jest.advanceTimersByTimeAsync(5000);
        await cmd('set_limit', '95');
        await cmd('submit_changes', '');
        const base = prefPolls();
        // the first submit's 15 s timer would fire 10 s from now; only the second one's may run
        await jest.advanceTimersByTimeAsync(16000);
        expect(prefPolls()).toBe(base + 1);
        expect(prefMutations()).toHaveLength(2);
        expect(prefMutations()[1][0].variables.input.schedules[0].max).toBe(95);
    });

    // Sweep 2026-10-08 #5: both submits used to start a 15/30/60/120 s chain.
    test('two submits at once start only one verification chain', async () => {
        await start();
        await cmd('set_limit', '90');
        const submit = () => cmdHandlers[TOPIC('submit_changes')](TOPIC('submit_changes'), Buffer.from(''));
        submit();
        submit();
        await flush();
        expect(prefMutations()).toHaveLength(2);
        const base = prefPolls();
        await jest.advanceTimersByTimeAsync(16000);
        expect(prefPolls()).toBe(base + 1);
        await jest.advanceTimersByTimeAsync(30000);   // the one chain's second check (45 s)
        expect(prefPolls()).toBe(base + 2);
    });

    test('a verification poll still waiting when a new submit lands does not carry on its old chain', async () => {
        await start();
        await cmd('set_limit', '90');
        await cmd('submit_changes', '');
        let release;
        world.pollGate = new Promise((r) => { release = r; });
        await jest.advanceTimersByTimeAsync(15000);   // first chain's check is waiting on Octopus
        const base = prefPolls();
        await cmd('set_limit', '95');
        await cmd('submit_changes', '');             // new chain: checks at +15 s, +45 s, ...
        release();
        await flush();
        expect(lastStatus().text).toBe('Verifying changes...'); // the old check changed nothing
        await jest.advanceTimersByTimeAsync(44000);
        expect(prefPolls()).toBe(base + 1);           // only the new chain's 15 s check ran
        expect(lastStatus().text).toBe('Retry 1/4...');
    });

    test('closing the node cancels the verification timers', async () => {
        await start();
        await cmd('submit_changes', '');
        const base = prefPolls();
        node._handlers.close(false, () => {});
        await jest.advanceTimersByTimeAsync(600000);
        expect(prefPolls()).toBe(base);
        node = null;
    });

    test('an unsubmitted pending change is reset to the confirmed value by the next poll', async () => {
        await start();
        await cmd('set_limit', '60');
        expect(lastStatePub().pending_limit).toBe(60);
        await refreshPoll();
        expect(lastPoll().pending_limit).toBe(80);
    });
});

// =========================================================================================
describe('setSmartCharging (switch via MQTT)', () => {
    test('OFF sends SUSPEND with the JWT, publishes OFF, and the 15 s verification confirms it', async () => {
        await start();
        const startupQueries = verifyQueries();
        await cmd('set_smart_charging', 'OFF');

        const [body, token] = calls(/updateDeviceSmartControl/)[0];
        expect(token).toBe('jwt');
        expect(body.variables).toEqual({ deviceId: 'dev-1', action: 'SUSPEND' });
        expect(pubsTo('smart_charging')).toEqual([[`${STATE}/smart_charging`, 'OFF', { retain: true }]]);
        expect(lastStatus()).toMatchObject({ fill: 'blue', text: 'Suspending smart charging...' });

        await jest.advanceTimersByTimeAsync(15000);
        expect(verifyQueries()).toBe(startupQueries + 1);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Smart charging suspended' });

        await jest.advanceTimersByTimeAsync(300000);
        expect(verifyQueries()).toBe(startupQueries + 1); // confirmed: no more retries
    });

    test('ON sends UNSUSPEND, publishes ON and confirms "Smart charging enabled"', async () => {
        world.suspended = true;
        await start();
        await cmd('set_smart_charging', 'ON');
        expect(calls(/updateDeviceSmartControl/)[0][0].variables.action).toBe('UNSUSPEND');
        expect(pubsTo('smart_charging')[0][1]).toBe('ON');
        await jest.advanceTimersByTimeAsync(15000);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Smart charging enabled' });
    });

    test('a Kraken error on the mutation reverts the switch to its previous state', async () => {
        await start(); // suspended=false -> previous state ON
        world.smartMutation = () => gqlErrors([{ message: 'refused' }]);
        await cmd('set_smart_charging', 'OFF');
        expect(errors.some((e) => /Failed to toggle smart charging: Smart charging mutation failed/.test(e.text))).toBe(true);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Smart charging update failed' });
        expect(pubsTo('smart_charging')).toEqual([[`${STATE}/smart_charging`, 'ON', { retain: true }]]);
        const q = verifyQueries();
        await jest.advanceTimersByTimeAsync(300000);
        expect(verifyQueries()).toBe(q); // no verification scheduled
    });

    // Network sweep F6: no answer is not a refusal; the usual checks read what Octopus has.
    test('a mutation with no answer (HTTP 503) keeps the switch, warns and verifies; Octopus had applied it', async () => {
        await start(); // smart charging on
        world.smartMutation = () => { world.suspended = true; throw new Error('HTTP 503'); };
        await cmd('set_smart_charging', 'OFF');
        expect(warns).toContain('Smart charging change not confirmed (HTTP 503) - checking with Octopus');
        expect(errors).toHaveLength(0);
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Smart charging unconfirmed - checking' });
        expect(pubsTo('smart_charging')).toEqual([[`${STATE}/smart_charging`, 'ON', { retain: true }]]);

        await jest.advanceTimersByTimeAsync(15000);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Smart charging suspended' });
        expect(pubsTo('smart_charging').pop()[1]).toBe('OFF');
    });

    test('a mutation that could not reach Octopus (ECONNREFUSED) is a failure, as before', async () => {
        await start();
        world.smartMutation = () => { throw Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }); };
        await cmd('set_smart_charging', 'OFF');
        expect(errors.some((e) => /^Failed to toggle smart charging: connect ECONNREFUSED/.test(e.text))).toBe(true);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Smart charging update failed' });
        const q = verifyQueries();
        await jest.advanceTimersByTimeAsync(300000);
        expect(verifyQueries()).toBe(q);
    });

    test('an auth error reverts the switch and sends no mutation', async () => {
        await start();
        world.auth = () => gqlErrors([{ message: 'bad key' }]);
        await cmd('set_smart_charging', 'OFF');
        expect(errors.some((e) => /Failed to toggle smart charging: Auth failed/.test(e.text))).toBe(true);
        expect(calls(/updateDeviceSmartControl/)).toHaveLength(0);
        expect(pubsTo('smart_charging')[0][1]).toBe('ON');
    });

    test('a change that never takes effect is verified at 15/30/60/120 s, then reported unconfirmed', async () => {
        await start();
        world.ignoreSmart = true;
        const q0 = verifyQueries();
        await cmd('set_smart_charging', 'OFF');

        await jest.advanceTimersByTimeAsync(14000);
        expect(verifyQueries()).toBe(q0);
        await jest.advanceTimersByTimeAsync(1000);
        expect(verifyQueries()).toBe(q0 + 1);
        await jest.advanceTimersByTimeAsync(30000);
        expect(verifyQueries()).toBe(q0 + 2);
        await jest.advanceTimersByTimeAsync(60000);
        expect(verifyQueries()).toBe(q0 + 3);
        await jest.advanceTimersByTimeAsync(120000);
        expect(verifyQueries()).toBe(q0 + 4);
        expect(warns).toContain('Smart charging state could not be confirmed after all retries');
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Smart charging: update unconfirmed' });
        await jest.advanceTimersByTimeAsync(600000);
        expect(verifyQueries()).toBe(q0 + 4);
    });

    test('verification attempts that hit an auth or device-query error keep retrying, then report unconfirmed', async () => {
        await start();
        const q0 = verifyQueries();
        await cmd('set_smart_charging', 'OFF');

        world.auth = () => gqlErrors([{ message: 'bad key' }]); // attempt 1: auth fails, no device query
        await jest.advanceTimersByTimeAsync(15000);
        expect(verifyQueries()).toBe(q0);

        world.auth = TOKEN_OK; world.simpleDevicesFail = true; // attempt 2: device query errors
        await jest.advanceTimersByTimeAsync(30000);
        expect(verifyQueries()).toBe(q0 + 1);

        await jest.advanceTimersByTimeAsync(60000);
        await jest.advanceTimersByTimeAsync(120000);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Smart charging: update unconfirmed' });
    });

    test('a second toggle cancels the first toggle\'s verification timers', async () => {
        await start();
        const q0 = verifyQueries();
        await cmd('set_smart_charging', 'OFF');
        await jest.advanceTimersByTimeAsync(5000);
        await cmd('set_smart_charging', 'ON');
        await jest.advanceTimersByTimeAsync(300000);
        expect(verifyQueries()).toBe(q0 + 1); // only the second toggle's verification ran
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Smart charging enabled' });
    });

    test('with no cached device id it warns and sends nothing', async () => {
        // Since 1.6.2 discovery seeds the device id, so make discovery find none too.
        discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: null });
        world.simpleDevicesFail = true;
        await start({ tick: false });
        const a = authCalls();
        await cmd('set_smart_charging', 'OFF');
        expect(warns).toContain('Device ID not available — cannot toggle smart charging');
        expect(authCalls()).toBe(a);
    });

    test.each(['on', 'off', '', 'TOGGLE', 'true', '1'])('payload %j is ignored (only exact ON / OFF act)', async (payload) => {
        await start();
        const a = authCalls();
        await cmd('set_smart_charging', payload);
        expect(authCalls()).toBe(a);
        expect(calls(/updateDeviceSmartControl/)).toHaveLength(0);
    });

    test('payload is trimmed: " OFF\\n" suspends', async () => {
        await start();
        await cmd('set_smart_charging', ' OFF\n');
        expect(calls(/updateDeviceSmartControl/)[0][0].variables.action).toBe('SUSPEND');
    });
});

// =========================================================================================
describe('setChargeCap (switch via MQTT)', () => {
    test('OFF sends the mutation with the JWT, publishes OFF, goes green and forces the next poll', async () => {
        await start();
        await cmd('set_charge_cap', 'OFF');

        const [body, token] = calls(/updateIsChargingDurationCapped/)[0];
        expect(token).toBe('jwt');
        expect(body.variables).toEqual({ input: { deviceId: 'dev-1', enabled: false } });
        expect(pubsTo('charge_cap')).toEqual([[`${STATE}/charge_cap`, 'OFF', { retain: true }]]);
        expect(lastStatus()).toMatchObject({ fill: 'green', text: 'Charge Cap off' });

        const d = dispatchCalls();
        await onTick(); // forced due: the poll runs although the interval (60 min) has not elapsed
        expect(dispatchCalls()).toBe(d + 1);
    });

    test('ON sends enabled:true', async () => {
        await start();
        world.chargeCap = 'DISABLED';
        await cmd('set_charge_cap', 'ON');
        expect(calls(/updateIsChargingDurationCapped/)[0][0].variables.input.enabled).toBe(true);
        expect(pubsTo('charge_cap')[0][1]).toBe('ON');
        expect(lastStatus().text).toBe('Charge Cap on');
    });

    test('a Kraken error on the mutation republishes the previous state and goes red', async () => {
        await start(); // first poll saw ENABLED -> previous ON
        world.capMutation = () => gqlErrors([{ message: 'not allowed' }]);
        await cmd('set_charge_cap', 'OFF');
        expect(errors.some((e) => /Failed to change Charge Cap: Charge Cap mutation failed/.test(e.text))).toBe(true);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Charge Cap update failed' });
        expect(pubsTo('charge_cap')).toEqual([[`${STATE}/charge_cap`, 'ON', { retain: true }]]);
        const d = dispatchCalls();
        await onTick();
        expect(dispatchCalls()).toBe(d); // a failed change does not force a poll
    });

    test('a mutation with no answer (HTTP 503) is reported unconfirmed and forces a charging poll', async () => {
        await start();
        world.capMutation = () => { throw new Error('HTTP 503'); };
        await cmd('set_charge_cap', 'OFF');
        expect(warns).toContain('Charge Cap change not confirmed (HTTP 503) - checking with Octopus');
        expect(errors.some((e) => /Failed to change Charge Cap/.test(e.text))).toBe(false);
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Charge Cap unconfirmed - checking' });
        expect(pubsTo('charge_cap')).toEqual([[`${STATE}/charge_cap`, 'ON', { retain: true }]]);

        world.chargeCap = 'DISABLED';                  // Octopus had applied it
        const d = dispatchCalls();
        await onTick();
        expect(dispatchCalls()).toBe(d + 1);
        expect(pubsTo('charge_cap').pop()[1]).toBe('OFF');
        expect(lastPoll().charge_cap).toBe(false);
    });

    // Review 5 R1.
    test('a mutation that fails with a DNS error raises node.error, goes red and forces no poll', async () => {
        await start();
        world.capMutation = () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN api.octopus.energy'), { code: 'EAI_AGAIN' }); };
        await cmd('set_charge_cap', 'OFF');
        expect(errors.some((e) => /^Failed to change Charge Cap: getaddrinfo EAI_AGAIN/.test(e.text))).toBe(true);
        expect(warns.some((w) => /not confirmed/.test(w))).toBe(false);
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Charge Cap update failed' });
        expect(pubsTo('charge_cap')).toEqual([[`${STATE}/charge_cap`, 'ON', { retain: true }]]);
        const d = dispatchCalls();
        await onTick();
        expect(dispatchCalls()).toBe(d);
    });

    test('an unconfirmed change that the forced poll does not find goes red and warns', async () => {
        await start();
        world.capMutation = () => { throw new Error('HTTP 503'); };
        await cmd('set_charge_cap', 'OFF');
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Charge Cap unconfirmed - checking' });

        await onTick();                                // Octopus still has it on
        expect(warns).toContain('Charge Cap change not applied: sent off, Octopus has on');
        expect(lastStatus()).toMatchObject({ fill: 'red', text: 'Charge Cap update failed' });
        expect(lastPoll().charge_cap).toBe(true);
    });

    test('an auth response without a token goes red and sends no mutation', async () => {
        await start();
        world.auth = () => gqlErrors([{ message: 'bad key' }]);
        await cmd('set_charge_cap', 'ON');
        expect(errors.some((e) => /Failed to change Charge Cap: Auth response missing token/.test(e.text))).toBe(true);
        expect(calls(/updateIsChargingDurationCapped/)).toHaveLength(0);
        expect(lastStatus().text).toBe('Charge Cap update failed');
    });

    test('with no cached device id it warns and sends nothing', async () => {
        // Since 1.6.2 discovery seeds the device id, so make discovery find none too.
        discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: null });
        world.simpleDevicesFail = true;
        await start({ tick: false });
        const a = authCalls();
        await cmd('set_charge_cap', 'ON');
        expect(warns).toContain('Device ID not available — cannot change Charge Cap');
        expect(authCalls()).toBe(a);
    });

    test.each(['on', 'off', '', 'true', 'TOGGLE'])('payload %j is ignored', async (payload) => {
        await start();
        const a = authCalls();
        await cmd('set_charge_cap', payload);
        expect(authCalls()).toBe(a);
    });
});

// =========================================================================================
describe('MQTT limit / time handlers', () => {
    test.each([['abc'], [''], ['0'], ['-5'], ['1e2'], ['8O'], ['0x5A']])('limit %j is rejected: warn, state republished, pending unchanged', async (payload) => {
        await start();
        await cmd('set_limit', payload);
        expect(warns.some((w) => /Invalid charge limit/.test(w))).toBe(true);
        expect(statePubs()).toHaveLength(1); // snap-back publish
        expect(statePubs()[0][2]).toEqual({ retain: false });
        expect(lastStatePub().pending_limit).toBe(80);
    });

    test.each([['4', 5], ['7', 5], ['8', 10], ['87', 85], ['101', 100], [' 65 ', 65], ['72.5', 75], ['100', 100]])(
        'limit %j snaps to %i%% and is published as pending', async (payload, expected) => {
            await start();
            await cmd('set_limit', payload);
            expect(lastStatePub().pending_limit).toBe(expected);
            expect(lastStatus()).toMatchObject({ fill: 'yellow', shape: 'dot', text: `Pending: ${expected}% @ 04:00` });
            expect(warns.some((w) => /Invalid/.test(w))).toBe(false);
        });

    test.each([['4:30'], ['04:45'], ['25:00'], [''], ['24:00'], ['8am']])('time %j is rejected: warn, state republished, pending unchanged', async (payload) => {
        await start();
        await cmd('set_time', payload);
        expect(warns.some((w) => /Invalid ready-by time/.test(w))).toBe(true);
        expect(lastStatePub().pending_time).toBe('04:00');
    });

    test.each([['00:00'], ['04:30'], ['23:30']])('time %j is accepted as pending', async (payload) => {
        await start();
        await cmd('set_time', payload);
        expect(lastStatePub().pending_time).toBe(payload);
        expect(lastStatus().text).toBe(`Pending: 80% @ ${payload}`);
    });

    test('pending changes do not write anything until submit', async () => {
        await start();
        await cmd('set_limit', '60');
        await cmd('set_time', '05:00');
        expect(prefMutations()).toHaveLength(0);
        await cmd('submit_changes', '');
        expect(prefMutations()[0][0].variables.input.schedules[0]).toMatchObject({ max: 60, time: '05:00:00' });
    });

    test('submit with only a limit change keeps the confirmed time', async () => {
        await start();
        await cmd('set_limit', '60');
        await cmd('submit_changes', '');
        expect(prefMutations()[0][0].variables.input.schedules[0]).toMatchObject({ max: 60, time: '04:00:00' });
    });
});

// =========================================================================================
describe('MQTT refresh handler (30 s cooldown)', () => {
    test('first press forces a poll and publishes the cooldown end; a press within 30 s is blocked', async () => {
        await start();
        const d0 = dispatchCalls();
        const t0 = Date.now();
        await cmd('refresh', '');
        expect(lastStatePub().refresh_available_at).toBe(new Date(t0 + 30000).toISOString());
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Manual refresh...' });
        await onTick();
        expect(dispatchCalls()).toBe(d0 + 1);

        await jest.advanceTimersByTimeAsync(10000);
        const d1 = dispatchCalls();
        await cmd('refresh', '');
        expect(warns).toContain('MQTT refresh blocked. Please wait 20 seconds.');
        expect(lastStatus()).toMatchObject({ fill: 'red', shape: 'dot', text: 'Cooldown: 20s' });
        await onTick();
        expect(dispatchCalls()).toBe(d1); // no forced poll
    });

    test('the cooldown clears itself after 30 s (null published) and the next press is accepted', async () => {
        await start();
        await cmd('refresh', '');
        await onTick();
        await jest.advanceTimersByTimeAsync(30000);
        expect(lastStatePub().refresh_available_at).toBeNull();

        const d = dispatchCalls();
        await cmd('refresh', '');
        await onTick();
        expect(dispatchCalls()).toBe(d + 1);
    });

    test('a Node-RED input refresh is never blocked, but it starts the cooldown the MQTT button sees', async () => {
        await start();
        await input({});
        await input('refresh');
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Manual refresh...' });
        await cmd('refresh', '');
        expect(warns.some((w) => /^MQTT refresh blocked/.test(w))).toBe(true);
    });
});

// =========================================================================================
describe('MQTT timezone handler', () => {
    test('a timezone is trimmed, stored, published retained and applied by the next poll', async () => {
        await start();
        await cmd('set_timezone', ' Europe/Paris ');
        expect(pubsTo('timezone')).toEqual([[`${STATE}/timezone`, 'Europe/Paris', { retain: true }]]);
        await refreshPoll();
        expect(lastPoll().timezone_applied).toBe('Europe/Paris');
    });

    // Fuzz finding: an unknown zone was stored and published as it was.
    test.each(['Not/AZone', 'Europe/Londn', `Europe/${'X'.repeat(300)}`])('an unknown timezone is an error and nothing is stored or published', async (payload) => {
        await start();
        await cmd('set_timezone', payload);
        expect(errors).toHaveLength(1);
        expect(errors[0].text).toMatch(/^Invalid timezone '/);
        expect(errors[0].text.length).toBeLessThan(120);
        expect(pubsTo('timezone')).toHaveLength(0);
        await refreshPoll();
        expect(lastPoll().timezone_applied).not.toBe(payload);
    });

    test('an unknown timezone through input raises node.error and is not stored', async () => {
        await start();
        await input({ set_timezone: 'Mars/Olympus' });
        expect(errors.map((e) => e.text)).toEqual(["Invalid timezone 'Mars/Olympus' — must be an IANA name such as Europe/London"]);
        await refreshPoll();
        expect(lastPoll().timezone_applied).not.toBe('Mars/Olympus');
    });

    test.each(['', '   '])('a blank timezone %j is ignored', async (payload) => {
        await start();
        await cmd('set_timezone', payload);
        expect(pubsTo('timezone')).toHaveLength(0);
    });
});

// =========================================================================================
describe('node-red input commands', () => {
    test('set_limit + set_time write both, and a command never triggers a manual refresh', async () => {
        await start();
        const d = dispatchCalls();
        await input({ set_limit: 90, set_time: '05:00' });
        expect(prefMutations()).toHaveLength(1);
        expect(prefMutations()[0][0].variables.input.schedules[0]).toMatchObject({ max: 90, time: '05:00:00' });
        await onTick();
        expect(dispatchCalls()).toBe(d);
    });

    test('an invalid set_limit raises node.error with the msg, shows a short red status and writes nothing', async () => {
        await start();
        await input({ set_limit: 'abc' });
        expect(errors).toHaveLength(1);
        expect(errors[0].text).toMatch(/Invalid charge limit 'abc'/);
        expect(errors[0].msg.payload).toEqual({ set_limit: 'abc' });
        expect(lastStatus()).toMatchObject({ fill: 'red', text: "Invalid charge limit 'abc'" });
        expect(prefMutations()).toHaveLength(0);
    });

    test('one invalid field cancels the whole preferences write', async () => {
        await start();
        await input({ set_limit: 'abc', set_time: '05:00' });
        expect(prefMutations()).toHaveLength(0);
    });

    test('set_smart_charging and set_charge_cap booleans act; string "true" does neither and does not refresh', async () => {
        await start();
        await input({ set_smart_charging: false, set_charge_cap: false });
        expect(calls(/updateDeviceSmartControl/)[0][0].variables.action).toBe('SUSPEND');
        expect(calls(/updateIsChargingDurationCapped/)[0][0].variables.input.enabled).toBe(false);
        await onTick(); // the charge cap write forced one poll; consume it

        const a = authCalls();
        const d = dispatchCalls();
        await input({ set_smart_charging: 'true', set_charge_cap: 'true' });
        expect(authCalls()).toBe(a);
        await onTick();
        expect(dispatchCalls()).toBe(d);
    });

    test('set_timezone through input is stored and applied by the next poll', async () => {
        await start();
        await input({ set_timezone: 'Asia/Tokyo' });
        await refreshPoll();
        expect(lastPoll().timezone_applied).toBe('Asia/Tokyo');
    });

    test.each([[{}], [{ foo: 1 }], ['refresh'], [undefined], [null]])('payload %j is a manual refresh', async (payload) => {
        await start();
        const d = dispatchCalls();
        node._handlers.input({ payload });
        expect(lastStatus()).toMatchObject({ fill: 'yellow', text: 'Manual refresh...' });
        await onTick();
        expect(dispatchCalls()).toBe(d + 1);
    });
});

// =========================================================================================
describe('Kraken numeric strings at the node boundary', () => {
    test('a string max (e.g. "85") becomes a number everywhere: confirmed, pending, and the value written back', async () => {
        world.prefs = { max: '85', time: '04:00:00' };
        await start();
        const p = lastPoll();
        expect(p.confirmed_limit).toBe(85);
        expect(p.pending_limit).toBe(85);
        await input({ set_time: '05:30' }); // limit not supplied: falls back to the confirmed value
        const sent = prefMutations()[0][0].variables.input.schedules;
        for (const s of sent) { expect(s.max).toBe(85); expect(typeof s.max).toBe('number'); }
    });

    test.each([[''], [' '], ['abc'], ['0'], [null]])('an unusable max %j falls back to 80 and is what a later write sends', async (max) => {
        world.prefs = { max, time: '04:00:00' };
        await start();
        expect(lastPoll().confirmed_limit).toBe(80);
        await input({ set_time: '05:30' });
        expect(prefMutations()[0][0].variables.input.schedules[0].max).toBe(80);
    });

    test('string energyAddedKwh values are summed as numbers; flex dispatches get numeric energy_kwh', async () => {
        world.plan = [
            { start: '2026-09-30T01:10:00Z', end: '2026-09-30T01:15:00Z', type: 'SMART', energyAddedKwh: '3.0' },
            { start: '2026-09-30T01:20:00Z', end: '2026-09-30T01:25:00Z', type: 'SMART', energyAddedKwh: '2.55' },
        ];
        await start();
        const p = lastPoll();
        expect(p.total_energy).toBe(5.55);
        expect(typeof p.total_energy).toBe('number');
        expect(p.next_kwh).toBe('3.00');
        expect(p.flex_planned_dispatches.map((d) => d.energy_kwh)).toEqual([3, 2.55]);
    });

    test('api_complexity_percent is a number (parseFloat of the metric string)', async () => {
        await start();
        const p = lastPoll();
        expect(p.api_requests_hour).toBe(1);
        expect(p.api_complexity_hour).toBe(300);
        expect(typeof p.api_complexity_percent).toBe('number');
        expect(p.api_complexity_percent).toBeCloseTo(0.6, 5);
    });

    // 1.6.3: next_kwh follows total_energy and counts a non-numeric energyAddedKwh as no energy.
    test('next_kwh is "0", not "NaN", when energyAddedKwh is a non-numeric string', async () => {
        world.plan = [{ start: '2026-09-30T01:10:00Z', end: '2026-09-30T01:15:00Z', type: 'SMART', energyAddedKwh: 'abc' }];
        await start();
        expect(lastPoll().next_kwh).toBe('0');
        expect(lastPoll().total_energy).toBe(0);
    });
});
