// __tests__/mqtt-raw-subscribe.test.js
'use strict';
/**
 * Code review 2026-10-06 F11 follow-up: announceControls also called the raw
 * node.broker.client.subscribe() on the 7 command topics and never removed them. The broker
 * API (broker.subscribe(topic, options, callback, ref)) already subscribes the client when
 * connected and again on every reconnect, so the raw calls were duplicates outside the
 * broker's bookkeeping. Only broker.subscribe may be used.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, ACCOUNT } = require('./helpers/real-node');

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

test('announcing the controls does not subscribe the raw MQTT client', async () => {
    h.build();
    await h.advance(2100); // announceControls runs at 2 s
    expect(h.broker.client.publish).toHaveBeenCalled(); // the discovery configs went out
    expect(h.broker.client.subscribe).not.toHaveBeenCalled();
});

test('the 8 command topics (v1.7 adds set_boost) are subscribed once each through the broker with this node as ref', async () => {
    h.build();
    await h.advance(2100);
    const topics = h.broker.subscribe.mock.calls.map((c) => c[0]);
    expect(topics.sort()).toEqual([
        'refresh', 'set_boost', 'set_charge_cap', 'set_limit', 'set_smart_charging', 'set_time', 'set_timezone', 'submit_changes',
    ].map((t) => `nodered_octopus/${ACCOUNT}/${t}`).sort());
    for (const c of h.broker.subscribe.mock.calls) expect(c[3]).toBe('oi-fix163');
});
