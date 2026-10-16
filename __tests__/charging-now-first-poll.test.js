// __tests__/charging-now-first-poll.test.js
'use strict';
/**
 * Code review 2026-10-06 F6: charging_now starts false and was only published when it changed.
 * After a restart that spans the end of a slot, the first poll found no active slot, published
 * nothing, and the retained ON on .../status/charging_now stayed in Home Assistant.
 * The first successful poll must always publish charging_now.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T04:05:00Z')); // back after a restart; the 23:30-04:00 slot is over
    h = createHarness();
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const stateChangeSends = () => h.sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change');

test('the first poll publishes charging_now OFF (retained) when no slot is active', async () => {
    h.plan = [slot('2026-09-30T23:30:00Z', '2026-10-01T04:00:00Z')];
    h.build();
    await h.advance(2100);
    expect(h.published('charging_now')).toEqual([]);

    await h.onTick();

    const calls = h.publishCalls('charging_now');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('OFF');
    expect(calls[0][2]).toEqual({ retain: true });
    // No state actually changed, so no charging_state_change message.
    expect(stateChangeSends()).toEqual([]);
});

test('later polls with no change do not publish charging_now again', async () => {
    h.plan = [];
    await h.start();
    await h.runUntil('2026-09-30T04:10:02Z'); // next 5-minute poll
    expect(h.pollSends().length).toBeGreaterThanOrEqual(2);
    expect(h.published('charging_now')).toEqual(['OFF']);
});

test('the first poll inside an active slot still publishes ON once', async () => {
    h.plan = [slot('2026-09-30T04:00:00Z', '2026-09-30T05:00:00Z')];
    await h.start();
    expect(h.published('charging_now')).toEqual(['ON']);
    expect(stateChangeSends()).toHaveLength(1);
});
