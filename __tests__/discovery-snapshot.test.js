// __tests__/discovery-snapshot.test.js
'use strict';
/**
 * Upgrade-safety guard (v1.6.1): the MQTT discovery surface must not change in a way
 * that renames or orphans a Home Assistant entity for anyone upgrading from npm 1.5.0
 * or from the 1.6.0 preview build.
 *
 * Loads octopus-intelligent.js with a stub RED, a fake MQTT broker, a stubbed Kraken
 * transport and Jest fake timers, fires the 2 s discovery timer, and normalises every
 * homeassistant/.../config publish into a snapshot compared against committed baselines.
 *
 * Baseline generation mode: set DISCOVERY_SNAPSHOT_OUT=<absolute path> and the suite
 * writes the snapshot of the code under test to that file and skips the comparisons.
 */
const fs = require('fs');
const path = require('path');

// No network: every Kraken call fails fast with a GraphQL-style error, which the node
// already handles (warns and carries on). Discovery publishing does not depend on it.
jest.mock('../lib/graphql', () => ({
    graphqlPost: jest.fn(async () => ({
        data: { errors: [{ message: 'stubbed by discovery-snapshot test' }] },
        status: 200,
        headers: {},
    })),
}));
jest.mock('../lib/http-get-json', () => jest.fn(async () => {
    throw new Error('stubbed by discovery-snapshot test');
}));

const ACCOUNT = 'A-SNAP0001';
const PREFIX = `nodered_${ACCOUNT}`;
const STATE = `nodered_octopus/${ACCOUNT}/status`;
const CMD = (t) => `nodered_octopus/${ACCOUNT}/${t}`;
const DEVICE_IDS = [`nodered_octopus_${ACCOUNT}`];
const RATE_BAND_TOPICS = [
    'electricity_day_rate',
    'electricity_night_rate',
    'electricity_ev_peak_rate',
    'electricity_ev_off_peak_rate',
].map((id) => `homeassistant/sensor/${PREFIX}_${id}/config`);
const TIME_TOPIC = `homeassistant/select/${PREFIX}_time/config`;
const CAP_TOPIC = `homeassistant/switch/${PREFIX}_charge_cap/config`;
const JOINED_SENSOR_TOPIC = `homeassistant/sensor/${PREFIX}_saving_session_joined/config`;
const FIELDS = ['unique_id', 'name', 'state_topic', 'command_topic', 'entity_category', 'options'];
const FIXTURES = path.join(__dirname, 'fixtures');

function normalise(published, subscribed) {
    const configs = {};
    for (const [topic, payload] of published) {
        if (!topic.startsWith('homeassistant/') || !topic.endsWith('/config')) continue;
        if (payload === '') { configs[topic] = { removed: true }; continue; }
        const c = JSON.parse(payload);
        const entry = {};
        for (const f of FIELDS) if (c[f] !== undefined) entry[f] = c[f];
        if (c.device) entry.device_identifiers = c.device.identifiers;
        configs[topic] = entry;
    }
    const sorted = {};
    Object.keys(configs).sort().forEach((k) => { sorted[k] = configs[k]; });
    return { configs: sorted, command_subscriptions: [...subscribed].sort() };
}

function captureDiscovery() {
    jest.useFakeTimers();
    const published = [];
    const subscribed = new Set();
    const broker = {
        client: {
            publish: (topic, payload, opts) => { published.push([topic, payload, opts]); },
            subscribe: (topic) => { subscribed.add(topic); },
        },
        register: () => {},
        deregister: () => {},
        subscribe: (topic) => { subscribed.add(topic); },
        unsubscribe: () => {},
    };
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(node) {
                const handlers = {};
                const store = {};
                node._handlers = handlers;
                node.credentials = { apiKey: 'sk_test_snapshot' };
                node.on = (evt, fn) => { handlers[evt] = fn; };
                node.log = () => {};
                node.warn = () => {};
                node.error = () => {};
                node.status = () => {};
                node.send = () => {};
                node.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: (id) => (id === 'broker-1' ? broker : null),
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    let node = null;
    try {
        require('../octopus-intelligent.js')(RED);
        node = new NodeCtor({ id: 'oi-1', accountNumber: ACCOUNT, enableMqtt: true, broker: 'broker-1', refreshInterval: 5 });
        jest.advanceTimersByTime(2100); // announceControls fires at 2000 ms
    } finally {
        if (node && node._handlers.close) node._handlers.close();
        jest.clearAllTimers();
        jest.useRealTimers();
    }
    for (const [topic, payload] of published) if (payload) rawConfigs[topic] = JSON.parse(payload);
    return JSON.parse(JSON.stringify(normalise(published, subscribed)));
}
const rawConfigs = {}; // full discovery payloads, for checks on fields the snapshot leaves out

const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

let current;
beforeAll(() => { current = captureDiscovery(); });

if (process.env.DISCOVERY_SNAPSHOT_OUT) {
    test('writes the discovery snapshot baseline', () => {
        fs.writeFileSync(process.env.DISCOVERY_SNAPSHOT_OUT, JSON.stringify(current, null, 2) + '\n');
        expect(Object.keys(current.configs).length).toBeGreaterThan(100);
    });
} else {
    describe('discovery snapshot', () => {
        test('every discovery config is on the single Octopus Intelligent device', () => {
            const offDevice = Object.entries(current.configs)
                .filter(([, c]) => !c.removed && JSON.stringify(c.device_identifiers) !== JSON.stringify(DEVICE_IDS))
                .map(([t]) => t);
            expect(offDevice).toEqual([]);
        });

        test('no rate-band sensor carries entity_category', () => {
            for (const t of RATE_BAND_TOPICS) {
                expect(current.configs[t]).toBeDefined();
                expect(current.configs[t]).not.toHaveProperty('entity_category');
            }
        });

        test('target charge slider allows 5–100% in steps of 5, matching the Octopus app (#3)', () => {
            const limit = rawConfigs[`homeassistant/number/${PREFIX}_limit/config`];
            expect(limit).toMatchObject({ min: 5, max: 100, step: 5 });
        });

        test('still removes the deprecated saving_session_joined sensor for upgraders', () => {
            expect(current.configs[JOINED_SENSOR_TOPIC]).toEqual({ removed: true });
        });

        test('vs 1.6.0 preview: identical except rate-band entity_category removal', () => {
            const base = loadFixture('discovery-1.6.0.json');
            for (const t of RATE_BAND_TOPICS) expect(base.configs[t].entity_category).toBe('config');
            const expected = clone(base);
            for (const t of RATE_BAND_TOPICS) delete expected.configs[t].entity_category;
            expect(current).toEqual(expected);
        });

        test('vs npm 1.5.0: only the allowed differences', () => {
            const { TIME_OPTIONS } = require('../lib/preferences');
            const base = loadFixture('discovery-1.5.0.json');
            // guard the fixture itself: 1.5.0 offered 04:00–11:00 (15 options) and had no Charge Cap
            expect(base.configs[TIME_TOPIC].options).toHaveLength(15);
            expect(base.configs[CAP_TOPIC]).toBeUndefined();
            expect(base.command_subscriptions).not.toContain(CMD('set_charge_cap'));

            const expected = clone(base);
            for (const t of RATE_BAND_TOPICS) delete expected.configs[t].entity_category;
            expected.configs[TIME_TOPIC].options = TIME_OPTIONS;
            expected.configs[CAP_TOPIC] = {
                unique_id: `${PREFIX}_charge_cap`,
                name: 'Charge Cap',
                state_topic: `${STATE}/charge_cap`,
                command_topic: CMD('set_charge_cap'),
                entity_category: 'config',
                device_identifiers: DEVICE_IDS,
            };
            expected.command_subscriptions = [...base.command_subscriptions, CMD('set_charge_cap')].sort();
            expect(current).toEqual(expected);
        });
    });
}
