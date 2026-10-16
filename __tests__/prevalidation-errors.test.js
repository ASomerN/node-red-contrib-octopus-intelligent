// __tests__/prevalidation-errors.test.js
'use strict';
/**
 * Code review 2026-10-06 F3: Kraken answers a failed query with HTTP 200, GraphQL errors and
 * null data. Pre-validation (30 s before a slot) only looked for data, so on KT-CT-4340 it did
 * nothing: no warning, no fallback start timer, and the slot was only picked up by the 10 s
 * reconciliation loop. It must count as a failed check: warn with the short error and start
 * the slot on time from the cached plan.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot } = require('./helpers/real-node');

const ERR_4340 = [{ message: 'Unable to fetch planned dispatches.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];
const FAILED = 'Pre-validation failed: KT-CT-4340: Unable to fetch planned dispatches, using cached slot';

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:00:00Z')];
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());

async function expectFallbackStart() {
    await advanceTo('2026-09-30T01:29:31Z');
    expect(h.warns).toContain(FAILED);
    await advanceTo('2026-09-30T01:30:00.500Z'); // before the first 10 s reconciliation check after the start
    expect(h.warns).toContain('Charging slot started at 2026-09-30T01:30:00Z');
    expect(h.warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);
    expect(h.published('charging_now')).toEqual(['OFF', 'ON']);
}

test('errors with flexPlannedDispatches null: warns and starts the slot from the cached plan', async () => {
    await h.start({ refreshInterval: 60 });
    h.replies.dispatches = () => ({ errors: ERR_4340, data: { flexPlannedDispatches: null } });
    await expectFallbackStart();
});

test('errors with data null: warns and starts the slot from the cached plan', async () => {
    await h.start({ refreshInterval: 60 });
    h.replies.dispatches = () => ({ errors: ERR_4340, data: null });
    await expectFallbackStart();
});

test('a good answer still confirms the slot without a failure warning', async () => {
    await h.start({ refreshInterval: 60 });
    await advanceTo('2026-09-30T01:30:00.500Z');
    expect(h.warns).toContain('Slot confirmed at 2026-09-30T01:30:00Z');
    expect(h.warns.filter((w) => /Pre-validation failed/.test(w))).toEqual([]);
    expect(h.published('charging_now')).toEqual(['OFF', 'ON']);
});
