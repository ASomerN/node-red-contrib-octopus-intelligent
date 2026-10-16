// __tests__/helpers/network-node.js
'use strict';
/**
 * The real-node harness (helpers/real-node.js) with the network left in: the REAL
 * lib/graphql.js, lib/http-get-json.js and lib/scheduler.js run on the fake https module
 * (helpers/fake-https.js), against a small fake Octopus that remembers what was written.
 * The test file mocks, before requiring this helper:
 *
 *   jest.mock('https', () => require('./helpers/fake-https').createFakeHttps());
 *   jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
 *   jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
 *   jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
 *   jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));
 *
 * The mocks are then pointed back at the real modules, so the scheduler ticks once per
 * second on fake timers (with its in-flight guard) and every request goes through https.
 * Discovery stays mocked (DISCOVERED) unless h.useRealDiscovery() is called.
 */
const { createHarness, slot, DISCOVERED, ACCOUNT, STATUS, DEVICE_ID } = require('./real-node');
const { graphqlPost } = require('../../lib/graphql');
const httpGetJson = require('../../lib/http-get-json');
const { createScheduler } = require('../../lib/scheduler');
const { discoverProducts } = require('../../lib/discovery');
const { MODES, FAILURE_MODES, KEY, JWT, EXPORT_MPAN, LONG_MESSAGE } = require('./fake-https');

const actualGraphql = jest.requireActual('../../lib/graphql');
const actualHttpGetJson = jest.requireActual('../../lib/http-get-json');
const actualScheduler = jest.requireActual('../../lib/scheduler');
const actualDiscovery = jest.requireActual('../../lib/discovery');

// The harness node's own API key (helpers/real-node.js).
const OWN_KEY = 'sk_test_fix163';
const IMPORT_MPAN = 'MPAN-IMP';

// Discovery result for an account with every category (electricity import and export, gas,
// a Home Mini and a charger).
const DISCOVERED_ALL = Object.assign({}, DISCOVERED, {
    hasElectricity: true, hasGas: true, smartMeterDeviceId: 'HM-1',
    electricityMpan: IMPORT_MPAN, electricityExportMpan: EXPORT_MPAN, electricitySerial: 'E-1',
    gasMprn: 'G-1', gasSerial: 'GS-1',
});

const RATE_EDGES = [
    { node: { validFrom: '2026-09-30T02:00:00Z', validTo: '2026-09-30T02:30:00Z', value: '12.5' } },
    { node: { validFrom: '2026-09-30T02:30:00Z', validTo: '2026-09-30T03:00:00Z', value: '13.5' } },
];

// Good answers from a fake Octopus that applies the writes it accepts (h.server).
function serverReplies(h) {
    const s = h.server;
    const vars = (call) => JSON.parse(call.body).variables || {};
    const evDevice = () => ({
        id: DEVICE_ID,
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: `${s.time}:00`, max: s.max }] },
        chargeCap: { isChargingDurationCapped: s.cap ? 'ENABLED' : 'DISABLED' },
        smartStatus: { isSuspended: s.suspended },
    });
    const statusDevice = () => ({ id: DEVICE_ID, deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: s.suspended } });
    return {
        obtainToken: () => ({ data: { obtainKrakenToken: { token: JWT } } }),
        discover: () => ({
            data: {
                account: { electricityAgreements: [], gasAgreements: [], properties: [] },
                devices: [statusDevice()],
            },
        }),
        getDevices: () => ({ data: { devices: [evDevice()] } }),
        getDevicesStatus: () => ({ data: { devices: [statusDevice()] } }),
        getDispatches: () => ({ data: { flexPlannedDispatches: h.plan } }),
        setPreferences: (call) => {
            const schedule = vars(call).input.schedules[0];
            s.max = schedule.max;
            s.time = String(schedule.time).slice(0, 5);
            return { data: { setDevicePreferences: { __typename: 'SmartFlexDevicePreferences' } } };
        },
        UpdateSmartControl: (call) => {
            s.suspended = vars(call).action === 'SUSPEND';
            return { data: { updateDeviceSmartControl: { id: DEVICE_ID } } };
        },
        SetChargeCap: (call) => {
            s.cap = vars(call).input.enabled === true;
            return { data: { updateIsChargingDurationCapped: { __typename: 'UpdateIsChargingDurationCappedOutput' } } };
        },
        getElectricityRates: () => ({
            data: { account: { electricityAgreements: [{ validFrom: '2026-01-01T00:00:00Z', tariff: { productCode: 'INTELLI-VAR-24-10-29', unitRate: '24.5', standingCharge: '50.1' } }] } },
        }),
        getElectricityConsumption: () => ({
            data: {
                account: {
                    properties: [{
                        electricityMeterPoints: [{
                            mpan: IMPORT_MPAN,
                            meters: [{ consumption: { edges: [{ node: { value: '1.25', startAt: '2026-09-29T00:00:00Z', endAt: '2026-09-30T00:00:00Z' } }] } }],
                        }],
                    }],
                },
            },
        }),
        getGasRates: () => ({
            data: { account: { gasAgreements: [{ validFrom: '2026-01-01T00:00:00Z', tariff: { productCode: 'VAR-GAS-1', unitRate: '6.1', standingCharge: '30.0' } }] } },
        }),
        getGasConsumption: () => ({
            data: {
                account: {
                    properties: [{
                        gasMeterPoints: [{
                            meters: [{ consumption: { edges: [{ node: { value: '3.5', startAt: '2026-09-29T00:00:00Z', endAt: '2026-09-30T00:00:00Z' } }] } }],
                        }],
                    }],
                },
            },
        }),
        getWheelOfFortuneSpinsAllowed: () => ({ data: { electricity: { spinsAllowed: 3 }, gas: { spinsAllowed: 2 } } }),
        getSmartMeterTelemetry: () => ({
            data: { smartMeterTelemetry: [{ readAt: '2026-09-30T01:59:00Z', demand: '1500', consumptionDelta: '250' }] },
        }),
        getSavingSessions: () => ({
            data: {
                savingSessions: {
                    events: [{ id: 7, code: 'EVENT-7', rewardPerKwhInOctoPoints: 100, startAt: '2026-10-01T17:00:00Z', endAt: '2026-10-01T18:00:00Z' }],
                    account: { hasJoinedCampaign: true, joinedEvents: [] },
                },
            },
        }),
        getCompletedDispatches: () => ({
            data: { completedDispatches: [{ start: '2026-09-29T01:00:00Z', end: '2026-09-29T02:00:00Z', delta: '-3.2', meta: { source: 'smart-charge', location: 'AT_HOME' } }] },
        }),
        getApplicableRates: () => ({ data: { applicableRates: { edges: RATE_EDGES } } }),
        getApplicableRatesExport: () => ({ data: { applicableRates: { edges: RATE_EDGES } } }),
        getFreeElectricity: () => ({
            data: { customerFlexibilityCampaignEvents: { edges: [{ node: { code: 'FE-1', startAt: '2026-10-02T12:00:00Z', endAt: '2026-10-02T13:00:00Z' } }] } },
        }),
        getAccountBalance: () => ({ data: { account: { balance: '1234' } } }),
        getOctoplusInfo: () => ({ data: { octoplusAccountInfo: { enrollmentStatus: 'ENROLLED', isLoyaltyPointsUser: true } } }),
        npm: () => ({ name: 'node-red-contrib-octopus-intelligent', version: s.npmVersion }),
    };
}

// Every *_error value in the node's output messages (null values left out).
function errorValues(h) {
    return h.sends
        .filter((m) => m && m.payload && typeof m.payload === 'object')
        .flatMap((m) => Object.keys(m.payload).filter((k) => k.endsWith('_error')).map((k) => m.payload[k]))
        .filter((v) => v !== null && v !== undefined);
}

const leaks = (text) => [KEY, OWN_KEY, JWT].some((s) => String(text).includes(s));

function createNetHarness() {
    const h = createHarness();
    const net = require('https').__net;
    if (!net) throw new Error("mock 'https' with helpers/fake-https before requiring helpers/network-node");
    net.reset();
    h.net = net;
    h.server = { max: 90, time: '04:00', cap: true, suspended: false, npmVersion: '1.6.1' };
    Object.assign(net.replies, serverReplies(h));

    graphqlPost.mockImplementation(actualGraphql.graphqlPost);
    httpGetJson.mockImplementation(actualHttpGetJson);
    createScheduler.mockImplementation((fn, options) => {
        h.onTick = fn;
        return actualScheduler.createScheduler(fn, options);
    });

    h.useRealDiscovery = () => discoverProducts.mockImplementation(actualDiscovery.discoverProducts);

    // Advance fake time to an ISO instant.
    h.at = (iso) => h.advance(Math.max(0, Date.parse(iso) - Date.now()));

    // Build the node and run to just after the first poll (scheduler ticks on whole seconds,
    // first tick 3 s after start).
    h.startAt = async (cfg) => {
        h.build(cfg);
        await h.advance(3500);
    };

    // Requests for `op`, optionally only those started at or after `fromIso`.
    h.requests = (op, fromIso) => net.calls.filter((c) => c.op === op
        && (!fromIso || c.startedAt >= Date.parse(fromIso)));

    h.lastPoll = () => {
        const polls = h.pollSends();
        return polls.length ? polls[polls.length - 1].payload : null;
    };

    // Everything the node showed: log lines, status texts, *_error fields, MQTT payloads.
    h.shown = () => {
        const statusTexts = h.statuses
            .map((s) => (s && typeof s === 'object' ? s.text : s))
            .filter((t) => typeof t === 'string');
        const published = h.broker.client.publish.mock.calls.map((c) => String(c[1]));
        return [...h.warns, ...h.logs, ...h.errors, ...statusTexts, ...errorValues(h), ...published];
    };

    // Keys and tokens are masked in what is published to Home Assistant (MQTT), and only there:
    // the Node-RED log, status and msg show the real text.
    h.expectRedacted = () => {
        const published = h.broker.client.publish.mock.calls.map((c) => String(c[1]));
        expect(published.filter(leaks).map((t) => t.slice(0, 200))).toEqual([]);
    };

    // Every *_error the node sent is text under 255 characters (the HA state limit).
    h.expectShortErrors = () => {
        errorValues(h).forEach((v) => {
            expect(typeof v).toBe('string');
            expect(v.length).toBeLessThan(255);
        });
    };

    // Close the node, run `afterClose` (e.g. release a held request), let 31 s pass (any
    // request in flight times out), and report what happened after the close.
    h.closeAndDrain = async (afterClose) => {
        const mark = {
            sends: h.sends.length,
            publishes: h.broker.client.publish.mock.calls.length,
            warns: h.warns.length,
            logs: h.logs.length,
            errors: h.errors.length,
            calls: net.calls.length,
        };
        h.close();
        if (afterClose) afterClose();
        await h.advance(31000);
        return {
            sends: h.sends.slice(mark.sends),
            publishes: h.broker.client.publish.mock.calls.slice(mark.publishes).map((c) => c[0]),
            warns: h.warns.slice(mark.warns),
            logs: h.logs.slice(mark.logs),
            errors: h.errors.slice(mark.errors),
            requests: net.calls.slice(mark.calls).map((c) => c.op),
            timers: jest.getTimerCount(),
        };
    };

    return h;
}

// After close: no timer left, nothing sent, published, logged or requested.
function expectQuietAfterClose(after) {
    expect(after.timers).toBe(0);
    expect(after.sends).toEqual([]);
    expect(after.publishes).toEqual([]);
    expect(after.warns).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(after.logs).toEqual([]);
    expect(after.requests).toEqual([]);
}

/**
 * Collects unhandled rejections and uncaught exceptions while a test runs. jest-circus also
 * fails the running test on either (it listens on the real process); this listener is the
 * explicit check the tests assert on.
 */
function trackEscapes() {
    const seen = [];
    const onRejection = (reason) => { seen.push(reason); };
    const onException = (err) => { seen.push(err); };
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onException);
    return {
        seen,
        stop() {
            process.removeListener('unhandledRejection', onRejection);
            process.removeListener('uncaughtException', onException);
        },
    };
}

module.exports = {
    createNetHarness, expectQuietAfterClose, trackEscapes, errorValues, leaks,
    slot, DISCOVERED, DISCOVERED_ALL, ACCOUNT, STATUS, DEVICE_ID, OWN_KEY, IMPORT_MPAN,
    MODES, FAILURE_MODES, KEY, JWT, EXPORT_MPAN, LONG_MESSAGE,
};
