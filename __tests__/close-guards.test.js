// __tests__/close-guards.test.js
'use strict';
/**
 * Code review 2026-10-06 F5: callbacks that were waiting on Octopus when the node closed
 * (pre-validation, validation retries, smart-charging verification, a preferences update)
 * carried on afterwards and created new slot timers, retry timers or the 10 s reconciliation
 * interval on the closed node. Nothing may be scheduled or published once the node is closed.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { createHarness, slot } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());

// Close the node while `gate` holds a request, then let the request finish.
async function closeThenFinish(gate, outcome = 'release') {
    h.close();
    expect(jest.getTimerCount()).toBe(0);
    const publishedBefore = h.broker.client.publish.mock.calls.length;
    const sendsBefore = h.sends.length;
    const warnsBefore = h.warns.length;
    if (outcome === 'release') gate.release(); else gate.reject(new Error('socket hang up'));
    await h.advance(0);
    expect(jest.getTimerCount()).toBe(0);
    // Time passes; nothing fires from the closed node.
    await h.advance(60 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(h.broker.client.publish.mock.calls.length).toBe(publishedBefore);
    expect(h.sends.length).toBe(sendsBefore);
    expect(h.warns.slice(warnsBefore)).toEqual([]);
}

describe('pre-validation that answers after close', () => {
    beforeEach(() => {
        h.plan = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:00:00Z')];
    });

    test('a successful answer sets no slot timer', async () => {
        await h.start({ refreshInterval: 60 });
        const gate = h.hold(/getDispatches/);
        await advanceTo('2026-09-30T01:29:31Z'); // pre-validation (01:29:30) is waiting on Octopus
        expect(h.warns).toContain('Pre-validating slot data (30s before start)');
        await closeThenFinish(gate, 'release');
    });

    test('a failed request does not fall back to a slot timer', async () => {
        await h.start({ refreshInterval: 60 });
        const gate = h.hold(/getDispatches/);
        await advanceTo('2026-09-30T01:29:31Z');
        await closeThenFinish(gate, 'reject');
    });
});

test('a validation retry that answers after close schedules no further retry', async () => {
    h.plan = [];
    await h.start({ refreshInterval: 60 });
    h.node._handlers.input({ payload: { set_limit: 50 } });
    await h.advance(0);
    expect(h.statuses.pop().text).toBe('Verifying changes...');
    const gate = h.hold(/SmartFlexDevicePreferences/); // the retry's charging poll
    await h.advance(15000);
    await closeThenFinish(gate, 'release');
});

test('a preferences update that answers after close starts no validation retries', async () => {
    h.plan = [];
    await h.start({ refreshInterval: 60 });
    const gate = h.hold(/setDevicePreferences/);
    h.node._handlers.input({ payload: { set_limit: 50 } });
    await h.advance(0);
    await closeThenFinish(gate, 'release');
});

test('a smart-charging verification that answers after close schedules no further check', async () => {
    h.plan = [];
    await h.start({ refreshInterval: 60 });
    h.node._handlers.input({ payload: { set_smart_charging: false } });
    await h.advance(0);
    const gate = h.hold(/\$accountNumber/); // the verification's getDevices query
    await h.advance(15000);
    await closeThenFinish(gate, 'release');
});

// Sweep 2026-10-08 #4: a redeploy during a tick used to let the old node poll every
// remaining due category (and the charging poll's dispatch query) after close.
test('closing the node during a tick sends no further requests for that tick', async () => {
    h.plan = [];
    h.build();
    await h.advance(2100);                              // discovery done, scheduler captured
    const gate = h.hold(/SmartFlexDevicePreferences/);  // the first tick's charging poll waits
    const tick = h.onTick();
    await h.advance(0);
    expect(graphqlPost.mock.calls.some(([b]) => /SmartFlexDevicePreferences/.test(b.query))).toBe(true);
    h.close();
    const before = graphqlPost.mock.calls.length;
    gate.release();
    await tick;
    await h.advance(0);
    expect(graphqlPost.mock.calls.slice(before).map(([b]) => b.query.split('(')[0].trim())).toEqual([]);
});
