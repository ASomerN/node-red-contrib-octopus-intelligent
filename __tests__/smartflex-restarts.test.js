// __tests__/smartflex-restarts.test.js
'use strict';
/**
 * announceSmartflexEntities across restarts (review A10 / F3): the Boost Charge switch, the
 * vehicle entities and the experimental inverter entities as the devices Octopus lists change
 * between deploys (EV appears, disappears, the list comes back empty). A retained empty config
 * deletes the entity in Home Assistant, so it may only be sent when Octopus listed devices and
 * none was of that kind.
 *
 * The charge-point-only device_state query was removed (review M1: Kraken lists charge points
 * as ELECTRIC_VEHICLES), so its tests were dropped.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, DISCOVERED, ACCOUNT } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

const PREFIX = `nodered_${ACCOUNT}`;
const BOOST = `homeassistant/switch/${PREFIX}_boost/config`;
const VEHICLE_MAKE = `homeassistant/sensor/${PREFIX}_vehicle_make/config`;
const VEHICLE_ERROR = `homeassistant/binary_sensor/${PREFIX}_smartflex_vehicle_error_state/config`;
const LAST_SESSION = `homeassistant/binary_sensor/${PREFIX}_last_session_problem/config`;
const INVERTER_ONLINE = `homeassistant/binary_sensor/${PREFIX}_inverter_online/config`;
const BATTERY_SOC = `homeassistant/sensor/${PREFIX}_home_battery_soc/config`;

// What discovery reports for each account shape (lib/discovery.js parseDiscovery fields).
const EV = { ...DISCOVERED, deviceCount: 1, deviceId: 'dev-1', vehicleDeviceId: 'dev-1', inverterDeviceId: null };
const EMPTY = { ...DISCOVERED, hasIntelligent: false, deviceSuspended: null, deviceCount: 0, deviceId: null, vehicleDeviceId: null, inverterDeviceId: null };
const CHARGE_POINT = { ...EMPTY, deviceCount: 1, vehicleDeviceId: 'cp-9' };
const INVERTER_ONLY = { ...EMPTY, deviceCount: 1, inverterDeviceId: 'inv-1' };
const EV_AND_INVERTER = { ...EV, deviceCount: 2, inverterDeviceId: 'inv-1' };

let h;
let mark = 0;

// Publishes to `topic` since the last restart (mark), as payload strings.
const since = (topic) => h.broker.client.publish.mock.calls.slice(mark).filter((c) => c[0] === topic).map((c) => c[1]);
const isConfig = (payload) => payload !== '' && typeof JSON.parse(payload).unique_id === 'string';

async function deploy(discovered, cfg) {
    if (h.node) h.close();
    mark = h.broker.client.publish.mock.calls.length;
    discoverProducts.mockResolvedValue(discovered);
    await h.start(cfg);
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T09:00:00Z'));
    h = createHarness();
    mark = 0;
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('SmartFlex entities across restarts', () => {
    test('EV, then an empty list, then a charge point only, then an inverter only, then the EV again', async () => {
        await deploy(EV);
        expect(since(BOOST)).toHaveLength(1);
        expect(isConfig(since(BOOST)[0])).toBe(true);
        expect(isConfig(since(VEHICLE_MAKE)[0])).toBe(true);
        expect(isConfig(since(LAST_SESSION)[0])).toBe(true);

        // Octopus lists no devices (a transient empty list): nothing is cleared.
        await deploy(EMPTY);
        expect(since(BOOST)).toEqual([]);
        expect(since(VEHICLE_MAKE)).toEqual([]);
        expect(since(VEHICLE_ERROR)).toEqual([]);
        expect(since(LAST_SESSION)).toEqual([]);
        expect(h.logs.filter((l) => /Octopus listed no devices/.test(l))).toHaveLength(1);

        // A charge point but no EV: Boost cleared, vehicle entities announced.
        await deploy(CHARGE_POINT);
        expect(since(BOOST)).toEqual(['']);
        expect(isConfig(since(VEHICLE_MAKE)[0])).toBe(true);
        expect(isConfig(since(LAST_SESSION)[0])).toBe(true);

        // Only an inverter (option off): Boost, vehicle and inverter entities all cleared.
        await deploy(INVERTER_ONLY);
        expect(since(BOOST)).toEqual(['']);
        expect(since(VEHICLE_MAKE)).toEqual(['']);
        expect(since(VEHICLE_ERROR)).toEqual(['']);
        expect(since(LAST_SESSION)).toEqual(['']);
        expect(since(INVERTER_ONLINE)).toEqual(['']);

        // The EV is back: announced again with the same unique_id.
        await deploy(EV);
        expect(since(BOOST)).toHaveLength(1);
        expect(JSON.parse(since(BOOST)[0]).unique_id).toBe(`${PREFIX}_boost`);
        expect(isConfig(since(VEHICLE_MAKE)[0])).toBe(true);
    });

    test('every clear is retained, so Home Assistant removes the entity after its own restart too', async () => {
        await deploy(INVERTER_ONLY);
        const clears = h.broker.client.publish.mock.calls.slice(mark).filter((c) => c[1] === '' && /homeassistant\//.test(c[0]));
        expect(clears.length).toBeGreaterThan(3);
        for (const c of clears) expect(c[2]).toEqual({ retain: true });
    });

    test('the Boost switch config: command and state topics, no entity_category, on the single device', async () => {
        await deploy(EV);
        const cfg = JSON.parse(since(BOOST)[0]);
        expect(cfg).toEqual(expect.objectContaining({
            name: 'Boost Charge',
            command_topic: `nodered_octopus/${ACCOUNT}/set_boost`,
            state_topic: `nodered_octopus/${ACCOUNT}/status/boost`,
            payload_on: 'ON',
            payload_off: 'OFF',
        }));
        expect(cfg.entity_category).toBeUndefined();
        expect(cfg.device.identifiers).toEqual([`nodered_octopus_${ACCOUNT}`]);
    });

    test('an EV id with no deviceCount (an older discovery result) still counts as a listed device', async () => {
        const { deviceCount, ...noCount } = EV;
        await deploy({ ...noCount, vehicleDeviceId: null });
        expect(isConfig(since(BOOST)[0])).toBe(true);
        expect(since(VEHICLE_MAKE)).toEqual(['']);   // listed, but no vehicle entry
        expect(h.logs.some((l) => /Octopus listed no devices/.test(l))).toBe(false);
    });

    test('an empty list after a charge-point deploy leaves the charge point entities alone', async () => {
        await deploy(CHARGE_POINT);
        await deploy(EMPTY);
        expect(since(VEHICLE_MAKE)).toEqual([]);
        expect(since(LAST_SESSION)).toEqual([]);
        expect(since(BOOST)).toEqual([]);
    });

    describe('inverter option ticked', () => {
        const ON = { enableSmartflexInverter: true };

        test('the inverter disappears from a non-empty list: its entities are cleared', async () => {
            await deploy(EV_AND_INVERTER, ON);
            expect(isConfig(since(INVERTER_ONLINE)[0])).toBe(true);
            expect(isConfig(since(BATTERY_SOC)[0])).toBe(true);

            await deploy(EV, ON);
            expect(since(INVERTER_ONLINE)).toEqual(['']);
            expect(since(BATTERY_SOC)).toEqual(['']);
            expect(isConfig(since(BOOST)[0])).toBe(true);
        });

        test('the list comes back empty: the inverter entities are left alone', async () => {
            await deploy(EV_AND_INVERTER, ON);
            await deploy(EMPTY, ON);
            expect(since(INVERTER_ONLINE)).toEqual([]);
            expect(since(BATTERY_SOC)).toEqual([]);
        });

        test('unticking the option on redeploy clears the inverter entities even though Octopus still lists it', async () => {
            await deploy(EV_AND_INVERTER, ON);
            await deploy(EV_AND_INVERTER);
            expect(since(INVERTER_ONLINE)).toEqual(['']);
            expect(since(BATTERY_SOC)).toEqual(['']);
        });
    });

    test('MQTT off: no SmartFlex discovery is published at all', async () => {
        await deploy(EV_AND_INVERTER, { enableMqtt: false, enableSmartflexInverter: true });
        const ha = h.broker.client.publish.mock.calls.slice(mark).filter((c) => /^homeassistant\//.test(c[0]));
        expect(ha).toEqual([]);
    });
});
