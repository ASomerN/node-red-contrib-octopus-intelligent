// __tests__/tick-state-merge.test.js
'use strict';
/**
 * Sweep 2026-10-08 #2: a tick used to replace the node's state with the copy it took when it
 * started plus its own results. A set-limit validation poll (or a Charge Cap change) that
 * landed while the tick waited on Octopus was then undone until the next charging poll, and
 * HA showed the old confirmed limit while the node status said the new one. The tick now
 * applies only its own changes onto the current state.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { createHarness, pollDevice } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [];
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());

// Charging poll hourly; Wheel of Fortune every minute, so the 01:01 tick polls only that.
const CFG = { refreshInterval: 60, enableWheelOfFortune: true, wheelOfFortuneInterval: 1 };

test('a validation poll that lands while a tick runs is not undone when the tick ends', async () => {
    await h.start(CFG);
    expect(h.lastPayload().confirmed_limit).toBe(90);

    await advanceTo('2026-09-30T01:00:50Z');
    h.node._handlers.input({ payload: { set_limit: 50 } });  // validation poll due at 01:01:05
    await h.advance(0);
    expect(h.statuses[h.statuses.length - 1].text).toBe('Verifying changes...');
    h.replies.devices = () => ({ data: { devices: [pollDevice({ max: 50 })] } });

    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();                                  // waits on the Wheel of Fortune query
    await advanceTo('2026-09-30T01:01:06Z');                  // the validation poll runs meanwhile
    expect(h.statuses[h.statuses.length - 1].text).toBe('Confirmed: 50% @ 04:00');
    expect(h.lastPayload().confirmed_limit).toBe(50);

    gate.release();
    await tick;
    await h.advance(0);

    expect(h.lastPayload()).toEqual(expect.objectContaining({ confirmed_limit: 50, wheel_of_fortune_error: expect.any(String) }));
    expect(h.statePublishes().pop().confirmed_limit).toBe(50);
});

test('a Charge Cap change that lands while a tick runs is not undone when the tick ends', async () => {
    await h.start(CFG);
    expect(h.lastPayload().charge_cap).toBe(true);

    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();
    await h.advance(0);
    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await h.advance(0);
    expect(h.statuses[h.statuses.length - 1].text).toBe('Charge Cap off');

    gate.release();
    await tick;
    await h.advance(0);

    expect(h.lastPayload().charge_cap).toBe(false);
    expect(h.statePublishes().pop().charge_cap).toBe(false);
});

// Review 2026-10-09 #2: the charging poll is the first category of a tick. A change confirmed
// after it returned, while a later category still ran, was undone by the tick's own changes.
// Charging poll every minute, so the 01:01 tick polls it first and then Wheel of Fortune.
const CFG_EVERY_MINUTE = { refreshInterval: 1, enableWheelOfFortune: true, wheelOfFortuneInterval: 1 };

async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

// Second-eyes review C: the tests below change things after the tick's charging poll returned.
// Without this check they would pass for the wrong reason if the poll had not returned yet.
const dispatchQueries = () => graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query)).length;
// The tick asked for Wheel of Fortune, so it is past its charging poll.
const wheelAsked = () => graphqlPost.mock.calls.some(([b]) => /getWheelOfFortuneSpinsAllowed/.test(b.query));

test('a new target confirmed after the tick\'s own charging poll returned survives the end of the tick', async () => {
    await h.start(CFG_EVERY_MINUTE);
    expect(h.lastPayload().confirmed_limit).toBe(90);

    await advanceTo('2026-09-30T01:00:50Z');
    h.node._handlers.input({ payload: { set_limit: 50 } });  // Apply; validation poll due at 01:01:05
    await h.advance(0);
    expect(h.statuses[h.statuses.length - 1].text).toBe('Verifying changes...');

    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const before = dispatchQueries();
    const tick = h.onTick();                                  // charging poll still reads 90 (the usual lag)
    await flush();
    expect(dispatchQueries()).toBe(before + 1);               // the tick's charging poll has returned
    expect(wheelAsked()).toBe(true);
    h.replies.devices = () => ({ data: { devices: [pollDevice({ max: 50 })] } });
    await advanceTo('2026-09-30T01:01:06Z');                  // the validation poll confirms 50
    expect(h.statuses[h.statuses.length - 1].text).toBe('Confirmed: 50% @ 04:00');

    gate.release();                                           // the tick ends after the confirmation
    await tick;
    await h.advance(0);

    expect(h.lastPayload()).toEqual(expect.objectContaining({ confirmed_limit: 50, confirmed_time: '04:00' }));
    expect(h.statePublishes().pop().confirmed_limit).toBe(50);
    expect(h.statuses[h.statuses.length - 1].text).toBe('Confirmed: 50% @ 04:00');
});

test('a Charge Cap change after the tick\'s own charging poll returned survives the end of the tick', async () => {
    await h.start(CFG_EVERY_MINUTE);
    expect(h.lastPayload().charge_cap).toBe(true);

    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const before = dispatchQueries();
    const tick = h.onTick();                                  // charging poll reads ENABLED, then waits on WoF
    await flush();
    expect(dispatchQueries()).toBe(before + 1);               // the tick's charging poll has returned
    expect(wheelAsked()).toBe(true);
    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await flush();
    expect(h.statuses[h.statuses.length - 1].text).toBe('Charge Cap off');

    gate.release();
    await tick;
    await h.advance(0);

    expect(h.lastPayload().charge_cap).toBe(false);
    expect(h.statePublishes().pop().charge_cap).toBe(false);
});

test('with no change during the tick, the charging poll\'s values still apply', async () => {
    await h.start(CFG_EVERY_MINUTE);
    h.replies.devices = () => ({ data: { devices: [pollDevice({ max: 70, time: '06:30:00' })] } });
    await advanceTo('2026-09-30T01:01:00Z');
    await h.onTick();
    expect(h.lastPayload()).toEqual(expect.objectContaining({ confirmed_limit: 70, pending_limit: 70, confirmed_time: '06:30' }));
});

// Second-eyes review A2: a slider or ready-by change in HA that is not applied yet sets only the
// node's pending values (no prefsGen bump). The tick's charging poll had written the old pending
// values into its changes, so the end of the tick snapped the slider back.
test('a slider and ready-by change made while a tick runs are not snapped back at the end of the tick', async () => {
    await h.start(CFG_EVERY_MINUTE);
    expect(h.lastPayload().pending_limit).toBe(90);
    const subscribed = (topic) => h.broker.subscribe.mock.calls.find((c) => c[0].endsWith(`/${topic}`))[2];

    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const before = dispatchQueries();
    const tick = h.onTick();                                  // charging poll writes pending 90 / 04:00
    await flush();
    expect(dispatchQueries()).toBe(before + 1);
    subscribed('set_limit')('t', Buffer.from('60'));          // not applied: pending only
    subscribed('set_time')('t', Buffer.from('05:30'));

    gate.release();
    await tick;
    await h.advance(0);

    expect(h.lastPayload()).toEqual(expect.objectContaining({ pending_limit: 60, pending_time: '05:30', confirmed_limit: 90 }));
    expect(h.statePublishes().pop()).toEqual(expect.objectContaining({ pending_limit: 60, pending_time: '05:30' }));
});
