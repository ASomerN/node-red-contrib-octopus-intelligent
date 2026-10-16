// __tests__/error-redaction.test.js
'use strict';
/**
 * A GraphQL server can echo request variables in an error message, for example
 * "Variable '$input' got invalid value {'APIKey': 'sk_live_...'}". The Node-RED log, node status
 * and msg show that text as it is, so a wrong key can be seen. The JSON published to Home
 * Assistant over MQTT (kept in HA's history) never carries an API key or a JWT.
 * Kraken answers HTTP 200 with GraphQL errors.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { createHarness } = require('./helpers/real-node');

const KEY = 'sk_live_AbCdEf0123456789ZyXw';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXZhbHVl';
// The harness node's own (literal) API key.
const OWN_KEY = 'sk_test_fix163';

const leaks = (text) => [KEY, JWT, OWN_KEY].some((s) => String(text).includes(s));

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

// What the Node-RED user sees: log lines, node status and the *_error fields of msg.payload.
function shownInNodeRed() {
    const statusTexts = h.statuses.map((s) => (s && s.text) || '');
    const errorFields = h.sends
        .filter((m) => m && m.payload)
        .flatMap((m) => Object.keys(m.payload).filter((k) => k.endsWith('_error')).map((k) => m.payload[k]))
        .filter((v) => v != null);
    return [...h.warns, ...h.logs, ...h.errors, ...statusTexts, ...errorFields];
}

// What goes to Home Assistant: every payload published to the broker.
function published() {
    return h.broker.client.publish.mock.calls.map((c) => String(c[1]));
}

test('an auth error that echoes the API key is shown in Node-RED and masked in what is published to HA', async () => {
    const base = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, token, host) => {
        if (/obtainKrakenToken/.test(body.query)) {
            return {
                status: 200,
                data: {
                    data: null,
                    errors: [{ message: `Variable '$input' got invalid value {'APIKey': '${KEY}'}; key ${OWN_KEY}; Field 'APIKey' is not defined.` }],
                },
            };
        }
        return base(body, token, host);
    });
    await h.start();

    const payload = h.lastPayload();
    expect(payload.intelligent_error).toMatch(/Auth/);
    const shown = shownInNodeRed();
    expect(shown.some((t) => t.includes(KEY))).toBe(true);
    expect(payload.intelligent_error).toContain(KEY);
    const sent = published();
    expect(sent.length).toBeGreaterThan(0);
    sent.forEach((text) => expect(leaks(text)).toBe(false));
    expect(sent.some((t) => t.includes('sk_live_***'))).toBe(true);
});

test('a JWT in a charging poll error is shown in the warning and intelligent_error, and masked when published', async () => {
    h.replies.dispatches = () => ({
        data: { flexPlannedDispatches: null },
        errors: [{
            message: `Signature of ${JWT} has expired.`,
            path: ['flexPlannedDispatches'],
            extensions: { errorCode: 'KT-CT-1124', errorType: 'AUTHORIZATION' },
        }],
    });
    await h.start();

    const payload = h.lastPayload();
    expect(payload.intelligent_error).toMatch(/^KT-CT-1124: /);
    expect(h.warns.some((w) => /Charging poll failed: KT-CT-1124/.test(w) && w.includes(JWT))).toBe(true);
    expect(payload.intelligent_error).toContain(JWT);
    published().forEach((text) => expect(leaks(text)).toBe(false));
});

test('ordinary text and non-string arguments still reach the log unchanged', async () => {
    await h.start();
    h.node.warn('plain message');
    h.node.status({ fill: 'green', shape: 'dot', text: 'Confirmed: 80% @ 07:00' });
    expect(h.warns).toContain('plain message');
    expect(h.statuses[h.statuses.length - 1]).toEqual({ fill: 'green', shape: 'dot', text: 'Confirmed: 80% @ 07:00' });
    h.node.status({});
    expect(h.statuses[h.statuses.length - 1]).toEqual({});
});

// A long run of token characters with no dots made the JWT pattern backtrack from every
// position (quadratic): a 100 kB MQTT payload hung the node. redact must stay fast.
describe('redact on very long input', () => {
    const { redact } = require('../lib/graphql-errors');

    test('100 kB with no dots is handled in well under a second', () => {
        const t0 = Date.now();
        const out = redact('x'.repeat(100000));
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(typeof out).toBe('string');
    });

    test('a token inside long text is still masked', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
        expect(redact(`${'a b '.repeat(50)} token ${jwt} end`)).not.toContain(jwt);
    });
});
