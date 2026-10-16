// __tests__/helpers/real-node.js
'use strict';
/**
 * Harness for tests that drive the REAL node: a fake RED, a fake MQTT broker and a mocked
 * Kraken API (HTTP 200 bodies shaped like live replies). The test file must mock these
 * modules before requiring this helper:
 *
 *   jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
 *   jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
 *   jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
 *   jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));
 *
 * The scheduler is captured, not started: tests call h.onTick() by hand, once per second,
 * as the real scheduler does (h.runUntil). h.advance() moves time without polling.
 */
const { graphqlPost } = require('../../lib/graphql');
const { discoverProducts } = require('../../lib/discovery');
const { createScheduler } = require('../../lib/scheduler');

const ACCOUNT = 'A-FIX16300';
const STATUS = `nodered_octopus/${ACCOUNT}/status`;
const DEVICE_ID = 'dev-1';

const slot = (start, end) => ({ start, end, type: 'SMART', energyAddedKwh: '3.0' });

// The charging poll's devices entry (getDevices with preferences, chargeCap and smartStatus aliases).
function pollDevice({ suspended = false, max = 90, time = '04:00:00' } = {}) {
    return {
        id: DEVICE_ID,
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: { schedules: [{ dayOfWeek: 'MONDAY', time, max }] },
        chargeCap: { isChargingDurationCapped: 'ENABLED' },
        smartStatus: { isSuspended: suspended },
    };
}

// The startup / verification getDevices entry (id deviceType status { isSuspended }).
function statusDevice({ suspended = false } = {}) {
    return { id: DEVICE_ID, deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: suspended } };
}

const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: DEVICE_ID, deviceSuspended: false,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};

const OP_NAMES = ['getSavingSessions', 'getFreeElectricity', 'getApplicableRates', 'getSmartMeterTelemetry'];

function createHarness() {
    const h = {
        sends: [], warns: [], logs: [], errors: [], statuses: [],
        node: null, onTick: null,
        plan: [],
        // Reply bodies (the GraphQL JSON: { data, errors }); override per test. devices(query)
        // gets the query text.
        replies: {
            devices: () => ({ data: { devices: [pollDevice()] } }),
            status: () => ({ data: { devices: [statusDevice()] } }),
            dispatches: () => ({ data: { flexPlannedDispatches: h.plan } }),
        },
        holds: [],
        broker: null,
    };

    h.broker = {
        client: { publish: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn() },
        register: jest.fn(),
        deregister: jest.fn((n, done) => done && done()),
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
    };

    // The next request whose query matches `re` waits until released (or rejected).
    h.hold = (re) => {
        const gate = { re };
        gate.promise = new Promise((resolve, reject) => { gate.release = resolve; gate.reject = reject; });
        h.holds.push(gate);
        return gate;
    };

    function bodyFor(query) {
        if (/obtainKrakenToken/.test(query)) return { data: { obtainKrakenToken: { token: 'jwt' } } };
        // The query is passed so a reply can differ for the charging poll's ask without status.
        if (/getDevices/.test(query) && /SmartFlexDevicePreferences/.test(query)) return h.replies.devices(query);
        if (/getDevices/.test(query)) return h.replies.status();
        if (/getDispatches/.test(query)) return h.replies.dispatches();
        if (/setDevicePreferences/.test(query)) return { data: { setDevicePreferences: { __typename: 'SmartFlexDevicePreferences' } } };
        if (/updateDeviceSmartControl/.test(query)) return { data: { updateDeviceSmartControl: { id: DEVICE_ID } } };
        if (/updateIsChargingDurationCapped/.test(query)) return { data: { updateIsChargingDurationCapped: { __typename: 'UpdateIsChargingDurationCappedOutput' } } };
        for (const op of OP_NAMES) {
            if (query.includes(op) && h.replies[op]) return h.replies[op]();
        }
        return { errors: [{ message: 'stubbed' }] };
    }

    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        const i = h.holds.findIndex((g) => g.re.test(body.query));
        if (i !== -1) {
            const gate = h.holds.splice(i, 1)[0];
            await gate.promise;
        }
        return { data: bodyFor(body.query), status: 200 };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { h.onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });

    h.build = (cfg = {}) => {
        let NodeCtor = null;
        const RED = {
            nodes: {
                createNode(n, config) {
                    const handlers = {};
                    const store = {};
                    n.id = config.id;
                    n._handlers = handlers;
                    n.credentials = { apiKey: 'sk_test_fix163' };
                    n.on = (evt, fn) => { handlers[evt] = fn; };
                    n.log = (m) => { h.logs.push(String(m)); };
                    n.warn = (m) => { h.warns.push(String(m)); };
                    n.error = (m) => { h.errors.push(String(m)); };
                    n.status = (s) => { h.statuses.push(s); };
                    n.send = (msg) => { h.sends.push(msg); };
                    n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
                },
                getNode: () => h.broker,
                registerType: (type, ctor) => { NodeCtor = ctor; },
            },
        };
        require('../../octopus-intelligent.js')(RED);
        h.node = new NodeCtor(Object.assign({
            id: 'oi-fix163', accountNumber: ACCOUNT, enableMqtt: true, broker: 'b1', refreshInterval: 5,
        }, cfg));
        return h.node;
    };

    // Build the node, let discovery run and do the first poll (about 2.1 s after start).
    h.start = async (cfg) => {
        h.build(cfg);
        await jest.advanceTimersByTimeAsync(2100);
        await h.onTick();
    };

    h.advance = (ms) => jest.advanceTimersByTimeAsync(ms);

    h.runUntil = async (iso) => {
        while (Date.now() < Date.parse(iso)) {
            await jest.advanceTimersByTimeAsync(1000);
            await h.onTick();
        }
    };

    h.close = () => {
        if (h.node) h.node._handlers.close(false, () => {});
        h.node = null;
    };

    // Values published to `${STATUS}/<suffix>` (retained flag checked separately).
    h.published = (suffix) => h.broker.client.publish.mock.calls
        .filter((c) => c[0] === `${STATUS}/${suffix}`)
        .map((c) => c[1]);
    h.publishCalls = (suffix) => h.broker.client.publish.mock.calls.filter((c) => c[0] === `${STATUS}/${suffix}`);
    // Full JSON state documents published to the main state topic.
    h.statePublishes = () => h.broker.client.publish.mock.calls
        .filter((c) => c[0] === STATUS)
        .map((c) => JSON.parse(c[1]));
    h.pollSends = () => h.sends.filter((m) => m.payload && !m.debug && 'intelligent_error' in m.payload);
    h.lastPayload = () => h.sends[h.sends.length - 1].payload;

    return h;
}

module.exports = { createHarness, slot, pollDevice, statusDevice, DISCOVERED, ACCOUNT, STATUS, DEVICE_ID };
