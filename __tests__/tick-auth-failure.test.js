// __tests__/tick-auth-failure.test.js
'use strict';
/**
 * Error-path sweep 2026-10-08 #3: one failed token request used to mark every due category
 * polled for its whole interval. Hourly sensors stayed blank for up to an hour after a bad
 * start, and the update check (npm, no token) failed with an auth error for a day.
 * Now the update check still runs, and the Octopus categories try again after 60 s.
 * Kraken answers HTTP 200 with GraphQL errors.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => ({ version: '1.6.2' })));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const httpGetJson = require('../lib/http-get-json');
const { discoverProducts } = require('../lib/discovery');
const { createHarness, DISCOVERED } = require('./helpers/real-node');

const AUTH_ERRORS = [{
    message: 'Too many requests.',
    path: ['obtainKrakenToken'],
    extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-1199' },
}];

let h;
let tokenFails;

// The last poll message (not a charging_now debug message).
const lastPoll = () => { const s = h.pollSends(); return s[s.length - 1].payload; };
const queries = (re) => graphqlPost.mock.calls.filter((c) => re.test(c[0].query)).length;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T12:00:10Z'));
    h = createHarness();
    discoverProducts.mockResolvedValue({ ...DISCOVERED });
    h.replies.getSavingSessions = () => ({
        data: { savingSessions: { events: [], account: { hasJoinedCampaign: false, joinedEvents: [] } } },
    });
    httpGetJson.mockClear();
    tokenFails = true;
    const base = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, token, host) => {
        if (tokenFails && /obtainKrakenToken/.test(body.query)) {
            return { status: 200, data: { data: { obtainKrakenToken: null }, errors: AUTH_ERRORS } };
        }
        return base(body, token, host);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('the update check still runs when the token request fails', async () => {
    await h.start();
    expect(httpGetJson).toHaveBeenCalledTimes(1);
    const p = lastPoll();
    expect(p.update_check_error).toBeNull();
    expect(p.latest_version).toBe('1.6.2');
    expect(p.intelligent_error).toMatch(/^Auth failed: .*KT-CT-1199/);
    expect(p.saving_sessions_error).toMatch(/^Auth failed: /);
});

test('the Octopus categories try again about 60 s after a failed token request, not an hour later', async () => {
    await h.start();
    expect(queries(/getSavingSessions/)).toBe(0);
    tokenFails = false;

    // Not every second: no new token request in the next 50 s.
    const tokensBefore = queries(/obtainKrakenToken/);
    await h.runUntil('2026-09-30T12:01:00Z');
    expect(queries(/obtainKrakenToken/)).toBe(tokensBefore);
    expect(queries(/getSavingSessions/)).toBe(0);

    // About 60 s after the failure the hourly categories run again.
    await h.runUntil('2026-09-30T12:01:20Z');
    expect(queries(/getSavingSessions/)).toBe(1);
    expect(lastPoll().saving_sessions_error).toBeNull();
    expect(lastPoll().intelligent_error).toBeNull();
    // The update check is not repeated.
    expect(httpGetJson).toHaveBeenCalledTimes(1);
});

// Observability 2026-10-09: a failed token request during a normal tick wrote nothing to the
// Node-RED log. It now warns once when a run of failures starts, and logs when it ends.
test('a run of failed token requests gives one warning, and one line when the login works again', async () => {
    const authWarns = () => h.warns.filter((w) => /Octopus login failed/.test(w));
    // Kraken can repeat the request in its message: the log shows it as it is, so a wrong key can be seen.
    AUTH_ERRORS[0].message = "Too many requests for key sk_test_fix163.";
    try {
        await h.start();
        expect(authWarns()).toHaveLength(1);
        expect(authWarns()[0]).toMatch(/KT-CT-1199/);
        expect(authWarns()[0]).toMatch(/sk_test_fix163/);

        const tokensBefore = queries(/obtainKrakenToken/);
        await h.runUntil('2026-09-30T12:01:20Z');                // the 60 s retry fails again
        expect(queries(/obtainKrakenToken/)).toBeGreaterThan(tokensBefore);
        expect(authWarns()).toHaveLength(1);

        tokenFails = false;
        await h.runUntil('2026-09-30T12:03:20Z');                // the next retry works
        expect(h.logs.filter((m) => /Octopus login working again/.test(m))).toHaveLength(1);

        tokenFails = true;
        await h.runUntil('2026-09-30T12:05:02Z');                // the next charging poll fails
        expect(authWarns()).toHaveLength(2);
    } finally {
        AUTH_ERRORS[0].message = 'Too many requests.';
    }
});
