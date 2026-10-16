// __tests__/net-findings-writes.test.js
'use strict';
/**
 * FINDING tests from the network sweep (test/v1.6.2-network, __tests__/net-writes.test.js),
 * ported un-skipped as they are fixed. REAL node, real scheduler and real lib/graphql.js over
 * the fake https (helpers/fake-https.js).
 */
jest.mock('https', () => require('./helpers/fake-https').createFakeHttps());
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

// Each test runs minutes of fake time through the real once-a-second scheduler.
jest.setTimeout(30000);

const { createNetHarness, trackEscapes } = require('./helpers/network-node');

const T = (hms) => `2026-09-30T${hms}Z`;
const SUBMIT = T('01:01:00');

let h;
let escapes;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T('01:00:00')));
    h = createNetHarness();
    escapes = trackEscapes();
});

afterEach(() => {
    h.close();
    escapes.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    expect(escapes.seen).toEqual([]);
});

// First poll at 01:00:03 (90% @ 04:00, Charge Cap on, smart charging on), then wait to 01:01:00.
async function setup() {
    h.plan = [];
    await h.startAt({ refreshInterval: 60 });
    await h.at(SUBMIT);
}

const lastStatus = () => h.statuses[h.statuses.length - 1];
const input = (payload) => h.node._handlers.input({ payload });

// F7 (fixed by review 5 R1): an HTTP 429 or 403 is a refusal, not "no answer".
describe('a refused write (HTTP 4xx) is a failure', () => {
    test.each(['http429', 'http403'])('a preferences change answered %s shows Update Failed', async (mode) => {
        await setup();
        h.net.fail('setPreferences', mode);
        input({ set_limit: 50 });
        await h.advance(2000);
        expect(h.errors.some((e) => /^Failed to set preferences: HTTP 4\d\d/.test(e))).toBe(true);
        expect(lastStatus()).toEqual({ fill: 'red', shape: 'ring', text: 'Update Failed' });
        expect(h.warns.some((w) => /not confirmed/.test(w))).toBe(false);
    });

    test.each(['http429', 'http403'])('a Charge Cap change answered %s shows failed', async (mode) => {
        await setup();
        h.net.fail('SetChargeCap', mode);
        input({ set_charge_cap: false });
        await h.advance(2000);
        expect(h.errors.some((e) => /^Failed to change Charge Cap: HTTP 4\d\d/.test(e))).toBe(true);
        expect(h.warns.some((w) => /not confirmed/.test(w))).toBe(false);
    });
});

// F6 (network sweep): set_smart_charging treated a mutation with no answer as refused: it
// logged "Failed to toggle smart charging", put the switch back and never checked.
describe('smart charging change with no answer', () => {
    test.each(['http503', 'hang', 'resetMidBody'])('a smart charging change answered %s is checked with Octopus, not reported as failed', async (mode) => {
        await setup();
        h.net.fail('UpdateSmartControl', mode);
        input({ set_smart_charging: false });
        await h.advance(31000);
        const [mutation] = h.requests('UpdateSmartControl');
        expect(h.errors.filter((e) => /Failed to toggle smart charging/.test(e))).toEqual([]);
        expect(h.warns.some((w) => /not confirmed/i.test(w))).toBe(true);
        await h.advance(20000);
        const checks = [...h.requests('getDevicesStatus'), ...h.requests('getDevices')]
            .filter((c) => c.startedAt >= mutation.endedAt);
        expect(checks.length).toBeGreaterThan(0);
    });

    test.each(['enotfound', 'http403'])('a smart charging change answered %s is still a failure', async (mode) => {
        await setup();
        h.net.fail('UpdateSmartControl', mode);
        input({ set_smart_charging: false });
        await h.advance(2000);
        expect(h.errors.some((e) => /^Failed to toggle smart charging: /.test(e))).toBe(true);
        expect(lastStatus()).toEqual({ fill: 'red', shape: 'ring', text: 'Smart charging update failed' });
    });
});
