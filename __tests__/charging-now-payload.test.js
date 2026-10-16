// __tests__/charging-now-payload.test.js
'use strict';
/**
 * Code review 2026-10-06 F7: publishChargingState never wrote charging_now back into the
 * node's last known state. Only the charging poll refreshed it, so every other poll (Home
 * Mini every minute, rates, account) sent and published a stale charging_now in the JSON
 * payload until the next charging poll.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { discoverProducts } = require('../lib/discovery');
const { createHarness, slot, DISCOVERED } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    discoverProducts.mockResolvedValue({ ...DISCOVERED, smartMeterDeviceId: 'mini-1' });
    h.plan = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:30:00Z')];
    h.replies.getSmartMeterTelemetry = () => ({
        data: { smartMeterTelemetry: [{ readAt: '2026-09-30T01:00:00+00:00', demand: '1250.0', consumptionDelta: '310.0' }] },
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const CONFIG = { refreshInterval: 60, enableHomeMini: true, homeMiniInterval: 1 };
const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());
const homeMiniSends = () => h.sends.filter((m) => !m.debug && m.payload && m.payload.mini_read_at !== undefined);

test('a Home Mini poll after a slot starts sends and publishes charging_now true', async () => {
    await h.start(CONFIG);
    expect(h.lastPayload().charging_now).toBe(false);

    await advanceTo('2026-09-30T01:30:30Z'); // slot start timer fired at 01:30:00
    expect(h.published('charging_now')).toEqual(['OFF', 'ON']);
    const before = homeMiniSends().length;
    await h.onTick(); // only the Home Mini poll is due

    expect(homeMiniSends().length).toBe(before + 1);
    expect(h.lastPayload().charging_now).toBe(true);
    expect(h.statePublishes().pop().charging_now).toBe(true);
});

test('a poll that is waiting on Octopus when the slot starts still ends with charging_now true', async () => {
    await h.start(CONFIG);
    await advanceTo('2026-09-30T01:29:58Z');
    const gate = h.hold(/getSmartMeterTelemetry/);
    const tick = h.onTick(); // Home Mini poll starts before the slot
    await advanceTo('2026-09-30T01:30:01Z'); // slot starts while the poll waits
    gate.release();
    await tick;

    expect(h.lastPayload().charging_now).toBe(true);
    expect(h.statePublishes().pop().charging_now).toBe(true);
});
