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
// Product discovery decides which SmartFlex entities are announced (1.7.0), so it is mocked
// with a discovered account per capture. The scheduler is captured, not started.
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({
    ...jest.requireActual('../lib/scheduler'),
    createScheduler: jest.fn(() => ({ start: () => {}, stop: () => {} })),
}));
const { discoverProducts } = require('../lib/discovery');

const BASE_DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null, vehicleDeviceId: null, inverterDeviceId: null,
};
// The default capture is an EV account with a SmartFlex vehicle and an inverter.
const WITH_DEVICES = { vehicleDeviceId: 'dev-1', inverterDeviceId: 'inv-1' };
const PENDING = Symbol('discovery never answers');

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
const BOOST_TOPIC = `homeassistant/switch/${PREFIX}_boost/config`;
// v1.7: the Boost Charge switch and its command topic (the SmartFlex additions are below).
function addBoostSwitch(expected) {
    expected.configs[BOOST_TOPIC] = {
        unique_id: `${PREFIX}_boost`,
        name: 'Boost Charge',
        state_topic: `${STATE}/boost`,
        command_topic: CMD('set_boost'),
        device_identifiers: DEVICE_IDS,
    };
    const sorted = {};
    Object.keys(expected.configs).sort().forEach((k) => { sorted[k] = expected.configs[k]; });
    expected.configs = sorted;
    expected.command_subscriptions = [...expected.command_subscriptions, CMD('set_boost')].sort();
    return expected;
}
const JOINED_SENSOR_TOPIC = `homeassistant/sensor/${PREFIX}_saving_session_joined/config`;
// v1.7.0 SmartFlex additions, announced after product discovery. Vehicle entities only when
// discovery found a vehicle or charge point; the experimental inverter entities only when
// enableSmartflexInverter is ticked AND discovery found an inverter. Otherwise their discovery
// topics are cleared (removed). Listed explicitly so any later rename fails here.
const sensorTopic = (id) => `homeassistant/sensor/${PREFIX}_${id}/config`;
const binaryTopic = (id) => `homeassistant/binary_sensor/${PREFIX}_${id}/config`;
const V170_VEHICLE_TOPICS = [
    ...['last_session_kwh', 'last_session_soc_final', 'vehicle_make', 'vehicle_model', 'vehicle_battery_kwh',
        'charger_power_kw', 'vehicle_device_state', 'smartflex_vehicle_error'].map(sensorTopic),
    ...['last_session_problem', 'smartflex_vehicle_error_state'].map(binaryTopic),
];
const V170_INVERTER_TOPICS = [
    ...['solar_power_kw', 'home_battery_power_kw', 'home_battery_soc', 'grid_power_kw', 'site_consumption_kw',
        'site_export_kw', 'inverter_power_kw', 'inverter_make', 'inverter_model', 'solar_peak_kw',
        'inverter_connection_status', 'smartflex_inverter_error'].map(sensorTopic),
    ...['inverter_online', 'smartflex_inverter_error_state'].map(binaryTopic),
];
const withoutV170 = (snap) => {
    const out = clone(snap);
    for (const t of [...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]) delete out.configs[t];
    return out;
};
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

async function captureDiscovery(extraConfig = {}, discovered = WITH_DEVICES) {
    jest.useFakeTimers();
    discoverProducts.mockReset();
    if (discovered === PENDING) discoverProducts.mockReturnValue(new Promise(() => {}));
    else discoverProducts.mockResolvedValue({ ...BASE_DISCOVERED, ...discovered });
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
        node = new NodeCtor({ id: 'oi-1', accountNumber: ACCOUNT, enableMqtt: true, broker: 'broker-1', refreshInterval: 5, ...extraConfig });
        // announceControls fires at 2000 ms; product discovery starts then and announces
        // the SmartFlex entities once it resolves.
        await jest.advanceTimersByTimeAsync(2100);
    } finally {
        if (node && node._handlers.close) node._handlers.close();
        jest.clearAllTimers();
        jest.useRealTimers();
    }
    for (const [topic, payload] of published) if (payload && topic.endsWith('/config')) rawConfigs[topic] = JSON.parse(payload);
    return JSON.parse(JSON.stringify(normalise(published, subscribed)));
}
const rawConfigs = {}; // full discovery payloads, for checks on fields the snapshot leaves out

const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

let current;
beforeAll(async () => { current = await captureDiscovery(); });

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

        // Review L5: Saving Session Available and Flex Planned Dispatches use
        // mdi:lightning-bolt-circle, so Boost has its own icon.
        test('Boost Charge switch has an icon no other entity uses', () => {
            expect(rawConfigs[BOOST_TOPIC].icon).toBe('mdi:rocket-launch');
            const same = Object.keys(rawConfigs).filter((t) => t !== BOOST_TOPIC && rawConfigs[t].icon === 'mdi:rocket-launch');
            expect(same).toEqual([]);
        });

        // Review L5: sw_version follows the package version (it was a fixed "2.0.0"). The
        // device identifiers, and so every unique_id, do not change.
        test('the device sw_version is the package version on every config', () => {
            const { version } = require('../package.json');
            for (const [t, cfg] of Object.entries(rawConfigs)) {
                if (!cfg.device) continue;
                expect([t, cfg.device.sw_version]).toEqual([t, version]);
                expect(cfg.device.identifiers).toEqual(DEVICE_IDS);
            }
        });

        test('Boost Charge switch is on the single device with its own command topic, no entity_category', () => {
            expect(rawConfigs[BOOST_TOPIC]).toMatchObject({ payload_on: 'ON', payload_off: 'OFF' });
            expect(current.configs[BOOST_TOPIC]).not.toHaveProperty('entity_category');
            expect(current.command_subscriptions).toContain(CMD('set_boost'));
        });

        test('vs 1.6.0 preview: identical except rate-band entity_category removal, the v1.7 Boost Charge switch and the 1.7.0 SmartFlex additions', () => {
            const base = loadFixture('discovery-1.6.0.json');
            for (const t of RATE_BAND_TOPICS) expect(base.configs[t].entity_category).toBe('config');
            expect(base.configs[BOOST_TOPIC]).toBeUndefined();
            const expected = clone(base);
            for (const t of RATE_BAND_TOPICS) delete expected.configs[t].entity_category;
            addBoostSwitch(expected);
            expect(withoutV170(current)).toEqual(expected);
        });

        test('1.7.0 SmartFlex topics are new: none exists in the 1.5.0 or 1.6.0 baselines', () => {
            for (const name of ['discovery-1.5.0.json', 'discovery-1.6.0.json']) {
                const base = loadFixture(name);
                for (const t of [...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]) expect(base.configs[t]).toBeUndefined();
            }
        });

        test('1.7.0: SmartFlex vehicle entities are announced on the single device', () => {
            for (const t of V170_VEHICLE_TOPICS) {
                expect(current.configs[t]).toBeDefined();
                expect(current.configs[t].removed).toBeUndefined();
                expect(current.configs[t].device_identifiers).toEqual(DEVICE_IDS);
                expect(current.configs[t].state_topic).toBe(STATE);
            }
        });

        test('1.7.0: last charge session energy carries the session list and alerts as attributes', () => {
            const cfg = rawConfigs[sensorTopic('last_session_kwh')];
            expect(cfg.json_attributes_topic).toBe(STATE);
            expect(cfg.json_attributes_template).toContain('value_json.charging_sessions');
            expect(cfg.json_attributes_template).toContain('value_json.device_alerts');
        });

        // Review L2: each finished session is a new cycle. state_class total with last_reset at
        // the session end lets Home Assistant keep statistics and add each session's kWh once.
        // An empty last_reset is ignored by HA (no session yet, or an older state JSON).
        test('1.7.0: last charge session energy is state_class total, reset at each session end', () => {
            const cfg = rawConfigs[sensorTopic('last_session_kwh')];
            expect(cfg).toMatchObject({ device_class: 'energy', unit_of_measurement: 'kWh', state_class: 'total' });
            expect(cfg.last_reset_value_template).toBe(
                "{{ value_json.last_session.end if value_json.last_session is defined and value_json.last_session and value_json.last_session.end else '' }}");
        });

        test('1.7.0: inverter entities are cleared, not announced, while the option is off (default)', () => {
            for (const t of V170_INVERTER_TOPICS) expect(current.configs[t]).toEqual({ removed: true });
        });

        test('vs npm 1.5.0: only the allowed differences (plus the v1.7 Boost Charge switch and the 1.7.0 SmartFlex additions)', () => {
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
            addBoostSwitch(expected);
            expect(withoutV170(current)).toEqual(expected);
        });
    });

    describe('discovery snapshot with the experimental inverter option ticked', () => {
        let withInverter;
        beforeAll(async () => { withInverter = await captureDiscovery({ enableSmartflexInverter: true }); });

        test('1.7.0: inverter entities are announced on the single device', () => {
            for (const t of V170_INVERTER_TOPICS) {
                expect(withInverter.configs[t]).toBeDefined();
                expect(withInverter.configs[t].removed).toBeUndefined();
                expect(withInverter.configs[t].device_identifiers).toEqual(DEVICE_IDS);
                expect(withInverter.configs[t].state_topic).toBe(STATE);
            }
        });

        test('1.7.0: no inverter sensor carries entity_category: config', () => {
            for (const t of V170_INVERTER_TOPICS) expect(withInverter.configs[t].entity_category).not.toBe('config');
        });

        test('1.7.0: everything else matches the default snapshot', () => {
            expect(withoutV170(withInverter)).toEqual(withoutV170(current));
        });

        // Review A3: after a rollback to 1.6.x (which never clears these retained configs), or
        // before the first 1.7 poll, the SmartFlex fields are missing from the state JSON. Every
        // SmartFlex template checks `is defined`, so a missing field reads unknown (sensors) or
        // OFF (error binary sensors), never a false Problem.
        test('1.7.0: every SmartFlex template copes with its field missing from the state JSON', () => {
            for (const t of [...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]) {
                const cfg = rawConfigs[t];
                expect(cfg).toBeDefined();
                const field = cfg.value_template.match(/value_json\.(\w+)/)[1];
                expect(cfg.value_template).toContain(`value_json.${field} is defined`);
                if (t.endsWith('_error_state/config')) {
                    expect(cfg.value_template).toBe(`{{ 'ON' if value_json.${field} is defined and value_json.${field} not in [None, ''] else 'OFF' }}`);
                } else {
                    expect(cfg.value_template).toBe(`{{ value_json.${field} if value_json.${field} is defined else None }}`);
                }
            }
            const attrs = rawConfigs[sensorTopic('last_session_kwh')].json_attributes_template;
            expect(attrs).toContain('value_json.charging_sessions is defined else []');
            expect(attrs).toContain('value_json.device_alerts is defined else []');
        });

        // Review L1: Home Assistant stores a text sensor's "None" as the text "None" (only a
        // numeric sensor maps it to unknown). Each SmartFlex entity therefore has an availability
        // check on the state topic: a missing field (older version after a rollback, or a retained
        // 1.6 state before the first 1.7 poll) reads Unavailable. The plain text sensors also read
        // Unavailable when the field is null; numeric sensors show unknown for null.
        const TEXT_NULL_UNAVAILABLE = ['vehicle_make', 'vehicle_model', 'vehicle_device_state',
            'inverter_make', 'inverter_model', 'inverter_connection_status'];
        test('1.7.0: every SmartFlex entity reads Unavailable when its field is missing from the state JSON', () => {
            for (const t of [...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]) {
                const cfg = rawConfigs[t];
                const field = cfg.value_template.match(/value_json\.(\w+)/)[1];
                const id = t.split(`${PREFIX}_`)[1].replace('/config', '');
                const template = TEXT_NULL_UNAVAILABLE.includes(id)
                    ? `{{ 'online' if value_json.${field} is defined and value_json.${field} is not none else 'offline' }}`
                    : `{{ 'online' if value_json.${field} is defined else 'offline' }}`;
                expect(cfg.availability).toEqual([{ topic: STATE, value_template: template }]);
            }
        });

        test('1.7.0: no availability check is added to an older entity', () => {
            const smartflex = new Set([...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]);
            const withAvailability = Object.keys(rawConfigs)
                .filter((t) => !smartflex.has(t) && rawConfigs[t].availability !== undefined);
            expect(withAvailability).toEqual([]);
        });

        test('1.7.0: SmartFlex templates still read the same payload fields (names and unique_ids unchanged)', () => {
            const vehicle = rawConfigs[sensorTopic('vehicle_device_state')];
            expect(vehicle.name).toBe('Octopus Vehicle Device State');
            expect(vehicle.unique_id).toBe(`${PREFIX}_vehicle_device_state`);
            expect(vehicle.value_template).toContain('value_json.device_state');
        });

        test('the older error binary sensors keep their 1.5 template', () => {
            expect(rawConfigs[binaryTopic('intelligent_error_state')].value_template)
                .toBe("{{ 'OFF' if value_json.intelligent_error in [None, ''] else 'ON' }}");
        });
    });

    describe('SmartFlex entities follow product discovery (1.7.0)', () => {
        test('an account with no vehicle or charge point gets no vehicle entities: their topics are cleared', async () => {
            const snap = await captureDiscovery({}, { vehicleDeviceId: null, inverterDeviceId: null });
            for (const t of V170_VEHICLE_TOPICS) expect(snap.configs[t]).toEqual({ removed: true });
        });

        test('a vehicle account gets the vehicle entities whatever the inverter option', async () => {
            const snap = await captureDiscovery({ enableSmartflexInverter: true }, { vehicleDeviceId: 'dev-1', inverterDeviceId: null });
            for (const t of V170_VEHICLE_TOPICS) expect(snap.configs[t].removed).toBeUndefined();
        });

        test('inverter option ticked but no inverter discovered: inverter topics are cleared', async () => {
            const snap = await captureDiscovery({ enableSmartflexInverter: true }, { vehicleDeviceId: 'dev-1', inverterDeviceId: null });
            for (const t of V170_INVERTER_TOPICS) expect(snap.configs[t]).toEqual({ removed: true });
        });

        test('inverter discovered but option off: inverter topics are cleared', async () => {
            const snap = await captureDiscovery({}, { vehicleDeviceId: null, inverterDeviceId: 'inv-1' });
            for (const t of V170_INVERTER_TOPICS) expect(snap.configs[t]).toEqual({ removed: true });
        });

        test('nothing SmartFlex is announced or cleared while discovery has not answered', async () => {
            const snap = await captureDiscovery({ enableSmartflexInverter: true }, PENDING);
            for (const t of [...V170_VEHICLE_TOPICS, ...V170_INVERTER_TOPICS]) expect(snap.configs[t]).toBeUndefined();
        });

        // Review A10: boost needs an EV. Gated by the same rule as the vehicle entities, so a
        // transient empty device list does not delete it (that would lose user customisations).
        test('Boost Charge switch: not announced while discovery has not answered', async () => {
            const snap = await captureDiscovery({}, PENDING);
            expect(snap.configs[BOOST_TOPIC]).toBeUndefined();
            expect(snap.command_subscriptions).toContain(CMD('set_boost'));
        });

        test('Boost Charge switch: cleared when Octopus lists devices but no EV', async () => {
            const snap = await captureDiscovery({}, { hasIntelligent: false, deviceId: null, deviceCount: 1, vehicleDeviceId: null, inverterDeviceId: 'inv-1' });
            expect(snap.configs[BOOST_TOPIC]).toEqual({ removed: true });
        });

        // A charge point is listed as ELECTRIC_VEHICLES (Kraken has no CHARGE_POINTS type), so
        // discovery gives it a deviceId: it gets the Boost switch and the vehicle entities.
        test('Boost Charge switch: announced on a charge-point account, with the vehicle entities', async () => {
            const snap = await captureDiscovery({}, { hasIntelligent: true, deviceId: 'cp-9', deviceCount: 1, vehicleDeviceId: 'cp-9', inverterDeviceId: null });
            expect(snap.configs[BOOST_TOPIC]).toMatchObject({ unique_id: `${PREFIX}_boost`, name: 'Boost Charge' });
            for (const t of V170_VEHICLE_TOPICS) expect(snap.configs[t].removed).toBeUndefined();
        });

        test('Boost Charge switch: left alone when Octopus lists no devices at all', async () => {
            const snap = await captureDiscovery({}, { hasIntelligent: false, deviceId: null, deviceCount: 0, vehicleDeviceId: null, inverterDeviceId: null });
            expect(snap.configs[BOOST_TOPIC]).toBeUndefined();
        });

        test('Boost Charge switch: announced when Octopus lists an EV', async () => {
            const snap = await captureDiscovery({}, { deviceId: 'dev-1', deviceCount: 1, vehicleDeviceId: 'dev-1', inverterDeviceId: null });
            expect(snap.configs[BOOST_TOPIC]).toMatchObject({ unique_id: `${PREFIX}_boost`, name: 'Boost Charge' });
        });

        test('everything outside the SmartFlex topics is the same with and without devices', async () => {
            const none = await captureDiscovery({}, { vehicleDeviceId: null, inverterDeviceId: null });
            expect(withoutV170(none)).toEqual(withoutV170(current));
        });
    });
}
