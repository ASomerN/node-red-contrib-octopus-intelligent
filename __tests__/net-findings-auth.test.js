// __tests__/net-findings-auth.test.js
'use strict';
/**
 * FINDING tests from the network sweep (test/v1.6.2-network, __tests__/net-tick-auth.test.js),
 * ported un-skipped: the poll's token request on the REAL node, real scheduler and real
 * lib/graphql.js over the fake https (helpers/fake-https.js).
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

// F1 (covered by round 5: the login warning in tickToken).
test('a failed poll token request writes a masked Node-RED log line', async () => {
    h.plan = [];
    await h.startAt();
    h.net.fail('obtainToken', 'http503');
    await h.at(T('01:05:01'));
    const lines = [...h.warns, ...h.errors].filter((l) => /HTTP 503/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    h.expectRedacted();
});

// F8: a 429 on the token request carries Retry-After: 120, but the node asked again after its
// own 60 s auth back-off.
test('a token request rate-limited with Retry-After: 120 is not retried sooner', async () => {
    h.plan = [];
    await h.startAt();
    h.net.fail('obtainToken', 'http429', { times: 1, when: (c) => c.startedAt >= Date.parse(T('01:05:00')) });
    await h.at(T('01:07:30'));
    const tokens = h.requests('obtainToken', T('01:05:00'));
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokens[1].startedAt - tokens[0].endedAt).toBeGreaterThanOrEqual(120000);
});
