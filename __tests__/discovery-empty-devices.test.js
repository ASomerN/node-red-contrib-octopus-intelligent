// __tests__/discovery-empty-devices.test.js
'use strict';
/**
 * Error-path sweep 2026-10-08 #7: a startup discovery that got an empty device list
 * (devices: []) still "succeeded", so no charging category was set up and discovery never
 * ran again: no charging polls until a redeploy. The node now checks the devices again on
 * the discovery retry delays (30 s, 60 s, 120 s, then 5 min), a limited number of times.
 * When a later check finds the EV, the charging poll starts.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');
const { createHarness, DISCOVERED, ACCOUNT } = require('./helpers/real-node');
const { EMPTY_DEVICES_MAX_RETRIES } = jest.requireActual('../lib/discovery-retry');

// What parseDiscovery returns for `devices: []`, and for a list with the EV in it.
const NO_DEVICES = { ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null, deviceCount: 0 };
const WITH_EV = { ...DISCOVERED, deviceCount: 1 };
// A list with devices but no EV (for example a battery): that answer is accepted.
const NO_EV = { ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null, deviceCount: 1 };

// Review4 #1: the re-check must set up the same SmartFlex entities and polls as a normal start.
const PREFIX = `nodered_${ACCOUNT}`;
const BOOST = `homeassistant/switch/${PREFIX}_boost/config`;
const VEHICLE_MAKE = `homeassistant/sensor/${PREFIX}_vehicle_make/config`;
const INVERTER_ONLINE = `homeassistant/binary_sensor/${PREFIX}_inverter_online/config`;
const WITH_VEHICLE = { ...WITH_EV, vehicleDeviceId: 'dev-1', inverterDeviceId: null };
const WITH_VEHICLE_AND_INVERTER = { ...WITH_VEHICLE, deviceCount: 2, inverterDeviceId: 'inv-1' };
const configsFor = (topic) => h.broker.client.publish.mock.calls.filter((c) => c[0] === topic && c[1] !== '').map((c) => JSON.parse(c[1]));
const queriesNamed = (name) => graphqlPost.mock.calls.filter((c) => c[0].query.includes(`query ${name}(`)).length;

const chargingPolls = () => graphqlPost.mock.calls
    .filter((c) => /getDevices/.test(c[0].query) && /SmartFlexDevicePreferences/.test(c[0].query)).length;

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T12:00:10Z'));
    h = createHarness();
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('an empty device list is checked again, and the charging poll starts once the EV is found', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValueOnce(NO_DEVICES).mockResolvedValue(WITH_EV);
    await h.start();
    expect(discoverProducts).toHaveBeenCalledTimes(1);
    expect(createScheduler).toHaveBeenCalledTimes(1);
    expect(chargingPolls()).toBe(0);
    expect(h.logs.some((m) => /no devices.*30s/i.test(m))).toBe(true);

    await h.runUntil('2026-09-30T12:00:45Z');
    expect(discoverProducts).toHaveBeenCalledTimes(2);
    expect(chargingPolls()).toBe(1);
    // Still one scheduler, and no further checks once the EV is found.
    expect(createScheduler).toHaveBeenCalledTimes(1);
    await h.advance(3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(2);
});

test('when the re-check finds the EV, the Boost switch and vehicle entities are announced and the vehicle is polled', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValueOnce(NO_DEVICES).mockResolvedValue(WITH_VEHICLE);
    await h.start();
    expect(configsFor(BOOST)).toHaveLength(0);
    expect(configsFor(VEHICLE_MAKE)).toHaveLength(0);
    expect(queriesNamed('smartflexVehicle')).toBe(0);

    await h.runUntil('2026-09-30T12:00:45Z');
    expect(configsFor(BOOST).map((c) => c.unique_id)).toEqual([`${PREFIX}_boost`]);
    expect(configsFor(VEHICLE_MAKE)).toHaveLength(1);
    expect(queriesNamed('smartflexVehicle')).toBe(1);
    // The inverter option is off, so no inverter entities or polls.
    expect(configsFor(INVERTER_ONLINE)).toHaveLength(0);
    expect(queriesNamed('smartflexInverter')).toBe(0);
});

test('when the re-check finds an inverter and the option is ticked, the inverter is announced and polled', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValueOnce(NO_DEVICES).mockResolvedValue(WITH_VEHICLE_AND_INVERTER);
    await h.start({ enableSmartflexInverter: true });
    expect(configsFor(INVERTER_ONLINE)).toHaveLength(0);
    expect(queriesNamed('smartflexInverter')).toBe(0);

    await h.runUntil('2026-09-30T12:00:45Z');
    expect(configsFor(INVERTER_ONLINE)).toHaveLength(1);
    expect(queriesNamed('smartflexInverter')).toBe(1);
    expect(queriesNamed('smartflexVehicle')).toBe(1);
});

test('the other categories keep their schedule when the charging poll is added', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValueOnce(NO_DEVICES).mockResolvedValue(WITH_EV);
    await h.start();
    const accountPolls = () => graphqlPost.mock.calls.filter((c) => /getAccountBalance/.test(c[0].query)).length;
    const before = accountPolls();
    expect(before).toBe(1);
    await h.runUntil('2026-09-30T12:00:45Z');
    expect(accountPolls()).toBe(before);
});

test('a list with devices but no EV is accepted, with no further checks', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(NO_EV);
    await h.start();
    await h.advance(3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(1);
    expect(chargingPolls()).toBe(0);
});

test('a list that stays empty is checked a limited number of times, then accepted', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(NO_DEVICES);
    await h.start();
    await h.advance(6 * 3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(1 + EMPTY_DEVICES_MAX_RETRIES);
    expect(h.logs.some((m) => /no charging device/i.test(m))).toBe(true);
    await h.advance(24 * 3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(1 + EMPTY_DEVICES_MAX_RETRIES);
    expect(chargingPolls()).toBe(0);
});

test('a failed check is retried on the same schedule', async () => {
    discoverProducts.mockReset();
    discoverProducts
        .mockResolvedValueOnce(NO_DEVICES)
        .mockRejectedValueOnce(new Error('Discovery failed: KT-CT-4360'))
        .mockResolvedValue(WITH_EV);
    await h.start();
    await h.advance(30000);
    expect(discoverProducts).toHaveBeenCalledTimes(2);
    await h.advance(60000);
    expect(discoverProducts).toHaveBeenCalledTimes(3);
    await h.onTick();
    expect(chargingPolls()).toBe(1);
});

test('closing the node stops the checks', async () => {
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(NO_DEVICES);
    await h.start();
    h.close();
    await h.advance(6 * 3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(1);
});
