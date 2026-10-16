// __tests__/net-findings-polls.test.js
'use strict';
/**
 * FINDING tests from the network sweep (test/v1.6.2-network, __tests__/net-category-polls.test.js
 * and net-charging-poll.test.js), ported un-skipped as they are fixed. REAL node, real scheduler
 * and real lib/graphql.js / lib/http-get-json.js over the fake https (helpers/fake-https.js).
 */
jest.mock('https', () => require('./helpers/fake-https').createFakeHttps());
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

// Each test runs minutes of fake time through the real once-a-second scheduler.
jest.setTimeout(30000);

const { discoverProducts } = require('../lib/discovery');
const { createNetHarness, trackEscapes, DISCOVERED_ALL, slot } = require('./helpers/network-node');

const CFG = { enableWheelOfFortune: true, enableHomeMini: true };

let h;
let escapes;

afterEach(() => {
    h.close();
    escapes.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    expect(escapes.seen).toEqual([]);
});

// F2: a failed category poll or update check was recorded only in its *_error field.
describe('Octopus category polls', () => {
    const T = (hms) => `2026-09-30T${hms}Z`;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(T('01:59:50')));
        h = createNetHarness();
        escapes = trackEscapes();
        discoverProducts.mockResolvedValue(DISCOVERED_ALL);
        h.plan = [];
    });

    test('a failed category poll writes a Node-RED log line', async () => {
        await h.startAt(CFG);
        h.net.fail('getAccountBalance', 'http502');
        await h.at(T('02:00:02'));
        const lines = [...h.warns, ...h.errors].filter((l) => /HTTP 502/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        h.expectRedacted();
    });

    test('one warning per run of failures, and one line when it works again', async () => {
        await h.startAt(CFG);                         // Home Mini polls every minute
        h.net.fail('getSmartMeterTelemetry', 'http502', { times: 2 });
        await h.at(T('02:00:02'));                    // fails at 02:00
        expect(h.warns.filter((w) => /^home_mini poll failed: HTTP 502/.test(w))).toHaveLength(1);
        await h.at(T('02:01:02'));                    // fails again at 02:01: no second warning
        expect(h.requests('getSmartMeterTelemetry', T('02:00:00')).length).toBeGreaterThanOrEqual(2);
        expect(h.warns.filter((w) => /^home_mini poll failed/.test(w))).toHaveLength(1);
        await h.at(T('02:03:02'));                    // works again
        expect(h.logs.filter((l) => l === 'home_mini poll working again')).toHaveLength(1);
        expect(h.lastPoll().home_mini_error).toBeNull();
    });
});

describe('npm update check', () => {
    const T = (hms) => `2026-09-30T${hms}Z`;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(T('23:59:50')));
        h = createNetHarness();
        escapes = trackEscapes();
        h.plan = [];
        h.server.npmVersion = '1.7.0';
    });

    test('a failed update check writes a Node-RED log line', async () => {
        await h.startAt();
        h.net.fail('npm', 'enotfound');
        await h.at('2026-10-01T00:00:02Z');
        const lines = [...h.warns, ...h.errors].filter((l) => /ENOTFOUND/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0]).toMatch(/^update_check poll failed: /);
    });
});

// F9: with an error code, the warning was built from the full Kraken message (masked but not
// shortened), so one failed poll wrote an ~8 kB log line, and again on every retry.
describe('charging poll', () => {
    const T = (hms) => `2026-09-30T${hms}Z`;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(T('01:00:00')));
        h = createNetHarness();
        escapes = trackEscapes();
    });

    test('a very long Kraken error gives a short "Charging poll failed" warning', async () => {
        h.plan = [];
        await h.startAt();
        h.net.fail('getDispatches', 'errorsLong');
        await h.at(T('01:05:01'));
        const [warn] = h.warns.filter((w) => /^Charging poll failed: /.test(w));
        expect(warn).toMatch(/^Charging poll failed: KT-CT-7899 Invalid input sk_live_AbCdEf0123456789ZyXw token eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiJ1c2VyMTIzNDU2In0\./);
        expect(warn.length).toBeLessThan(1000);
        h.expectRedacted();
    });

    // F5: the slot start timer was only set once pre-validation had finished. Pre-validation
    // makes two requests 30 s before the slot, each allowed 30 s, so a slow token reply plus a
    // dispatches query that never answers started the slot late (reconciliation at 01:02:03).
    describe('pre-validation 30 s before a slot', () => {
        const PLAN = () => [slot(T('01:02:00'), T('01:32:00'))];
        const afterFirstPoll = (c) => c.startedAt >= Date.parse(T('01:01:00'));
        const corrections = () => h.warns.filter((w) => /Correcting chargingNow/.test(w));

        test('a slow pre-validation still starts the slot on time', async () => {
            h.plan = PLAN();
            await h.startAt({ refreshInterval: 60 });
            h.net.fail('obtainToken', 'slow:20000', { when: afterFirstPoll });
            h.net.fail('getDispatches', 'hang', { when: afterFirstPoll });
            await h.at(T('01:02:00.500'));
            expect(h.published('charging_now')).toEqual(['OFF', 'ON']);
            expect(corrections()).toEqual([]);
            // pre-validation fails at 01:02:20 and falls back to the known slot: no second ON
            await h.at(T('01:02:30'));
            expect(h.published('charging_now')).toEqual(['OFF', 'ON']);
            expect(h.warns.filter((w) => /^Pre-validation failed: /.test(w))).toHaveLength(1);
        });

        test('a slot that pre-validation finds cancelled does not start', async () => {
            h.plan = PLAN();
            await h.startAt({ refreshInterval: 60 });
            h.plan = [slot(T('03:00:00'), T('03:30:00'))];   // Octopus moved it
            await h.at(T('01:02:10'));
            expect(h.warns).toContain('Slot was cancelled or modified - not setting start timer');
            expect(h.published('charging_now')).toEqual(['OFF']);
        });
    });
});

