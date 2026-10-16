// __tests__/smartflex-categories.test.js
'use strict';
/**
 * v1.7.0: the smartflex_vehicle and smartflex_inverter categories are registered from
 * discovery. Vehicle runs whenever a vehicle or charge point is discovered (every 30 min).
 * Inverter is experimental: it runs only when an inverter is discovered AND the editor
 * option is ticked (every 5 min). Mocks only, no network.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const BASE_DISCOVERED = {
    hasIntelligent: false, hasElectricity: false, hasGas: false, deviceId: null, deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null, vehicleDeviceId: null, inverterDeviceId: null,
};

const VEHICLE = {
    __typename: 'SmartFlexVehicle', id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
    alerts: [], make: 'Tesla', model: 'Model X', vehicleBatterySize: '72.50', chargePointPowerOutput: '7.400',
    chargingSessions: { edges: [{ node: {
        start: '2026-10-05T23:30:00+01:00', end: '2026-10-06T04:00:00+01:00',
        stateOfChargeChange: '21.8', stateOfChargeFinal: '90.1',
        energyAdded: { value: '13.50', unit: 'KILOWATT_HOUR' }, cost: null, type: 'SMART', problems: [],
    } }] },
};
// NOT LIVE-VERIFIED: schema-shaped inverter fixture.
const INVERTER = {
    __typename: 'SmartFlexInverter', id: 'inv-1', make: 'GivEnergy', model: 'Gen 3',
    details: { solar: { peakSolarPowerInKw: '4.20' } },
    telemetry: {
        inverter: { connectionStatus: 'CONNECTED', powerInKw: '2.50' },
        battery: { connectionStatus: 'CONNECTED', powerInKw: '-1.20', stateOfCharge: '64.0' },
        solar: { powerInKw: '3.10' }, grid: { powerInKw: '0.40' },
        site: { consumptionInKw: '1.80', exportInKw: '0.00' },
    },
};

let sends;
let onTick;
let node;
let vehicleErrors;
let vehicleReply; // full GraphQL body override for the vehicle query
let warns;

function buildNode(extraConfig = {}) {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n) {
                const handlers = {};
                const store = {};
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_smartflex' };
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
    return new NodeCtor({ id: 'oi-sf', accountNumber: 'A-FAKE0001', enableMqtt: false, refreshInterval: 5, ...extraConfig });
}

const queriesNamed = (name) => graphqlPost.mock.calls.filter(([body]) => new RegExp(`query ${name}\\b`).test(body.query)).length;
const lastPayload = () => sends.filter((m) => m.payload && 'smartflex_vehicle_error' in m.payload).pop().payload;

async function start(discovered, extraConfig) {
    discoverProducts.mockResolvedValue({ ...BASE_DISCOVERED, ...discovered });
    node = buildNode(extraConfig);
    await jest.advanceTimersByTimeAsync(2100); // discovery + scheduler created
    await onTick();                              // first poll: every enabled category is due
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-06T09:00:00Z'));
    sends = [];
    vehicleErrors = undefined;
    vehicleReply = undefined;
    warns = [];
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/query smartflexVehicle\b/.test(body.query)) {
            if (vehicleReply) return { data: vehicleReply, status: 200 };
            return { data: { data: { devices: [VEHICLE, INVERTER] }, errors: vehicleErrors } };
        }
        if (/query smartflexInverter\b/.test(body.query)) return { data: { data: { devices: [VEHICLE, INVERTER] } } };
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });
});

afterEach(() => {
    if (node) node._handlers.close();
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('smartflex_vehicle registration', () => {
    test('polls vehicle data when a vehicle is discovered and puts it in msg.payload', async () => {
        await start({ vehicleDeviceId: 'dev-1' });
        expect(queriesNamed('smartflexVehicle')).toBe(1);
        const p = lastPayload();
        expect(p.vehicle_make).toBe('Tesla');
        expect(p.vehicle_model).toBe('Model X');
        expect(p.vehicle_battery_kwh).toBe(72.5);
        expect(p.charger_power_kw).toBe(7.4);
        expect(p.device_state).toBeNull(); // from the charging poll (none on this account)
        expect(p.last_session_kwh).toBe(13.5);
        expect(p.last_session_soc_final).toBe(90.1);
        expect(p.smartflex_vehicle_error).toBeNull();
    });

    test('does not poll vehicle data when no vehicle or charge point is discovered', async () => {
        await start({});
        expect(queriesNamed('smartflexVehicle')).toBe(0);
        expect(lastPayload().vehicle_make).toBeNull();
    });

    test('polls every 30 minutes', async () => {
        await start({ vehicleDeviceId: 'dev-1' });
        jest.setSystemTime(new Date('2026-10-06T09:25:00Z'));
        await onTick();
        expect(queriesNamed('smartflexVehicle')).toBe(1);
        jest.setSystemTime(new Date('2026-10-06T09:30:01Z'));
        await onTick();
        expect(queriesNamed('smartflexVehicle')).toBe(2);
    });

    test('a GraphQL error sets smartflex_vehicle_error', async () => {
        vehicleErrors = [{ message: 'boom', path: ['devices'] }];
        await start({ vehicleDeviceId: 'dev-1' });
        expect(lastPayload().smartflex_vehicle_error).toMatch(/boom/);
    });
});

// Kraken partial errors: HTTP 200 with { data: {...with nulls}, errors: [{ message, path, extensions }] }.
describe('smartflex_vehicle partial errors (1.7.0)', () => {
    const krakenError = (code, message, path) => ({ message, path, extensions: { errorType: 'APPLICATION', errorCode: code } });

    async function pollAgain() {
        jest.setSystemTime(new Date('2026-10-06T09:30:01Z'));
        await onTick();
    }

    test('a chargingSessions error keeps the last session values, updates the rest and sets a short error', async () => {
        await start({ vehicleDeviceId: 'dev-1' });
        expect(lastPayload().last_session_kwh).toBe(13.5);
        vehicleReply = {
            data: { devices: [{ ...VEHICLE, model: 'Model Y', chargingSessions: null }, INVERTER] },
            errors: [krakenError('KT-CT-4301', 'Unable to fetch charging sessions.', ['devices', 0, 'chargingSessions'])],
        };
        await pollAgain();
        const p = lastPayload();
        expect(p.vehicle_model).toBe('Model Y');
        expect(p.last_session_kwh).toBe(13.5);
        expect(p.last_session_soc_final).toBe(90.1);
        expect(p.charging_sessions).toHaveLength(1);
        expect(p.smartflex_vehicle_error).toBe('KT-CT-4301: Unable to fetch charging sessions');
        expect(warns.some((w) => w.includes('KT-CT-4301: Unable to fetch charging sessions'))).toBe(true);
    });

    test('an alerts error keeps the last device_alerts', async () => {
        const alerts = [{ message: 'Car lost connection', publishedAt: '2026-10-06T08:00:00+01:00' }];
        vehicleReply = { data: { devices: [{ ...VEHICLE, alerts }, INVERTER] } };
        await start({ vehicleDeviceId: 'dev-1' });
        vehicleReply = {
            data: { devices: [{ ...VEHICLE, alerts: null }, INVERTER] },
            errors: [krakenError('KT-CT-4399', 'Unable to get alerts.', ['devices', 0, 'alerts'])],
        };
        await pollAgain();
        const p = lastPayload();
        expect(p.device_alerts).toEqual([{ message: 'Car lost connection', published_at: '2026-10-06T08:00:00+01:00' }]);
        expect(p.smartflex_vehicle_error).toBe('KT-CT-4399: Unable to get alerts');
    });

    test('the next clean poll clears the error', async () => {
        await start({ vehicleDeviceId: 'dev-1' });
        vehicleReply = {
            data: { devices: [{ ...VEHICLE, alerts: null }, INVERTER] },
            errors: [krakenError('KT-CT-4399', 'Unable to get alerts.', ['devices', 0, 'alerts'])],
        };
        await pollAgain();
        vehicleReply = undefined;
        jest.setSystemTime(new Date('2026-10-06T10:00:02Z'));
        await onTick();
        expect(lastPayload().smartflex_vehicle_error).toBeNull();
    });

    test('a full failure (no data) still errors with a short message and keeps every last value', async () => {
        await start({ vehicleDeviceId: 'dev-1' });
        vehicleReply = { data: null, errors: [krakenError('KT-CT-1111', 'Unauthorized.', ['devices'])] };
        await pollAgain();
        const p = lastPayload();
        expect(p.smartflex_vehicle_error).toBe('KT-CT-1111: Unauthorized');
        expect(p.vehicle_make).toBe('Tesla');
        expect(p.last_session_kwh).toBe(13.5);
    });
});

describe('smartflex_inverter registration (experimental, off by default)', () => {
    test('does not poll the inverter when the editor option is not ticked', async () => {
        await start({ vehicleDeviceId: 'dev-1', inverterDeviceId: 'inv-1' });
        expect(queriesNamed('smartflexInverter')).toBe(0);
        expect(lastPayload().inverter_make).toBeNull();
    });

    test('polls the inverter when discovered and the option is ticked', async () => {
        await start({ inverterDeviceId: 'inv-1' }, { enableSmartflexInverter: true });
        expect(queriesNamed('smartflexInverter')).toBe(1);
        const p = lastPayload();
        expect(p.inverter_make).toBe('GivEnergy');
        expect(p.home_battery_soc).toBe(64);
        expect(p.solar_power_kw).toBe(3.1);
        expect(p.smartflex_inverter_error).toBeNull();
    });

    test('does not poll the inverter when the option is ticked but no inverter is discovered', async () => {
        await start({ vehicleDeviceId: 'dev-1' }, { enableSmartflexInverter: true });
        expect(queriesNamed('smartflexInverter')).toBe(0);
    });

    test('polls every 5 minutes', async () => {
        await start({ inverterDeviceId: 'inv-1' }, { enableSmartflexInverter: true });
        jest.setSystemTime(new Date('2026-10-06T09:04:00Z'));
        await onTick();
        expect(queriesNamed('smartflexInverter')).toBe(1);
        jest.setSystemTime(new Date('2026-10-06T09:05:01Z'));
        await onTick();
        expect(queriesNamed('smartflexInverter')).toBe(2);
    });
});
