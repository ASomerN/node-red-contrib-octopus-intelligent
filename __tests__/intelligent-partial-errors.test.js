// __tests__/intelligent-partial-errors.test.js
'use strict';
/**
 * 1.6.2: the REAL node's charging (intelligent) poll when Kraken answers HTTP 200 with
 * GraphQL errors.
 * - KT-CT-4339 on devices.preferences must not fail the poll: keep the last confirmed
 *   limit/time and still read the dispatches (cached device id if the device list is null).
 * - intelligent_error and the node status carry a short "CODE: message", not raw JSON.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};
const DEVICES = [{
    id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
    preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '04:00:00', max: 90 }] },
    chargeCap: { isChargingDurationCapped: 'ENABLED' },
}];
const slot = (start, end) => ({ start, end, type: 'SMART', energyAddedKwh: '3.0' });
const PLAN = [slot('2026-09-30T01:40:00Z', '2026-09-30T01:45:00Z')];
const NEW_PLAN = [slot('2026-09-30T01:50:00Z', '2026-09-30T01:55:00Z')];

// Kraken shapes: the same preferences resolver backs both aliases, so a KT-CT-4339 gives one
// error per alias and nulls both fields; the rest of the device is still returned.
const PREFS_MSG = 'Your device charging preferences could not be fetched.';
const prefsError = (alias) => ({ message: PREFS_MSG, path: ['devices', 0, alias], extensions: { errorCode: 'KT-CT-4339' } });
const DISPATCH_4340 = [{ message: 'Unable to fetch planned dispatches.', path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];

let plan;
let dispatchErrors;
let devicesReply;
let sends;
let statuses;
let warns;
let logs;
let onTick;
let node;

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(n, config) {
                const handlers = {};
                const store = {};
                n.id = config.id;
                n._handlers = handlers;
                n.credentials = { apiKey: 'sk_test_partial' };
                n.on = (evt, fn) => { handlers[evt] = fn; };
                n.log = (m) => { logs.push(String(m)); };
                n.warn = (m) => { warns.push(String(m)); };
                n.error = () => {};
                n.status = (s) => { statuses.push(s); };
                n.send = (msg) => { sends.push(msg); };
                n.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: () => null,
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED);
    return new NodeCtor({ id: 'oi-partial', accountNumber: 'A-PARTIAL1', enableMqtt: false, refreshInterval: 60 });
}

const dispatchCallArgs = () => graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query));
const pollSends = () => sends.filter((m) => m.payload && !m.debug && 'intelligent_error' in m.payload);
const lastPoll = () => pollSends().pop().payload;
const lastStatus = () => statuses[statuses.length - 1];

beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    sends = []; statuses = []; warns = []; logs = [];
    plan = PLAN; dispatchErrors = undefined; devicesReply = undefined;
    graphqlPost.mockReset();
    graphqlPost.mockImplementation(async (body) => {
        if (/obtainKrakenToken/.test(body.query)) return { data: { data: { obtainKrakenToken: { token: 'jwt' } } } };
        if (/getDevices/.test(body.query)) return { data: devicesReply || { data: { devices: DEVICES } }, status: 200 };
        if (/getDispatches/.test(body.query)) {
            if (dispatchErrors) return { data: { errors: dispatchErrors, data: { flexPlannedDispatches: null } }, status: 200 };
            return { data: { data: { flexPlannedDispatches: plan } }, status: 200 };
        }
        return { data: { errors: [{ message: 'stubbed' }] } };
    });
    discoverProducts.mockReset();
    discoverProducts.mockResolvedValue(DISCOVERED);
    createScheduler.mockReset();
    createScheduler.mockImplementation((fn) => { onTick = fn; return { start: jest.fn(), stop: jest.fn() }; });

    node = buildNode();
    await jest.advanceTimersByTimeAsync(2100); // discovery + scheduler created
    await onTick();                              // first (good) poll
    expect(lastPoll().intelligent_error).toBeNull();
    expect(lastPoll().confirmed_limit).toBe(90);
});

afterEach(() => {
    if (node) node._handlers.close();
    node = null;
    jest.clearAllTimers();
    jest.useRealTimers();
});

async function refreshPoll() {
    node._handlers.input({ payload: {} }); // manual refresh: forces the intelligent category due
    await onTick();
}

describe('KT-CT-4339 on devices.preferences keeps the schedule', () => {
    test('keeps the last confirmed limit, time and Charge Cap and still updates the plan', async () => {
        devicesReply = {
            data: { devices: [{ ...DEVICES[0], preferences: null, chargeCap: null }] },
            errors: [prefsError('preferences'), prefsError('chargeCap')],
        };
        plan = NEW_PLAN;
        const before = dispatchCallArgs().length;
        await refreshPoll();

        const p = lastPoll();
        expect(dispatchCallArgs().length).toBe(before + 1);
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start_raw).toBe('2026-09-30T01:50:00Z');
        expect(p.confirmed_limit).toBe(90);
        expect(p.confirmed_time).toBe('04:00');
        expect(p.pending_limit).toBe(90);
        expect(p.pending_time).toBe('04:00');
        expect(p.charge_cap).toBe(true);
        expect(lastStatus().fill).toBe('green');
        expect(lastStatus().text).toBe('Confirmed: 90% @ 04:00');
        expect(warns.filter((w) => /not applicable/i.test(w))).toEqual([]);
        expect(warns.filter((w) => /Charging poll failed/.test(w))).toEqual([]);
        // one warning line for the partial answer, naming the code
        expect(warns.filter((w) => /KT-CT-4339/.test(w))).toHaveLength(1);
    });

    test('an error on the preferences alias alone is tolerated too', async () => {
        devicesReply = {
            data: { devices: [{ ...DEVICES[0], preferences: null }] },
            errors: [prefsError('preferences')],
        };
        plan = NEW_PLAN;
        await refreshPoll();
        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.confirmed_limit).toBe(90);
        expect(p.confirmed_time).toBe('04:00');
        expect(p.slot1_start_raw).toBe('2026-09-30T01:50:00Z');
    });

    test('a null device list with KT-CT-4339 falls back to the cached device id for the dispatches', async () => {
        devicesReply = {
            data: { devices: null },
            errors: [{ message: PREFS_MSG, path: ['devices', 0, 'preferences'], extensions: { errorCode: 'KT-CT-4339' } }],
        };
        plan = NEW_PLAN;
        await refreshPoll();

        const calls = dispatchCallArgs();
        expect(calls[calls.length - 1][0].variables).toEqual({ deviceId: 'dev-1' });
        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start_raw).toBe('2026-09-30T01:50:00Z');
        expect(p.confirmed_limit).toBe(90);
        expect(p.confirmed_time).toBe('04:00');
        expect(p.charge_cap).toBe(true);
    });

    test('the next good poll uses the new preferences again', async () => {
        devicesReply = {
            data: { devices: [{ ...DEVICES[0], preferences: null, chargeCap: null }] },
            errors: [prefsError('preferences'), prefsError('chargeCap')],
        };
        await refreshPoll();
        devicesReply = { data: { devices: [{ ...DEVICES[0], preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '06:30:00', max: 70 }] } }] } };
        await refreshPoll();
        expect(lastPoll().confirmed_limit).toBe(70);
        expect(lastPoll().confirmed_time).toBe('06:30');
    });
});

describe('short error text', () => {
    test('a KT-CT-4340 shows as "code: message" in intelligent_error and the node status', async () => {
        dispatchErrors = DISPATCH_4340;
        await refreshPoll();
        const p = lastPoll();
        expect(p.intelligent_error).toBe('KT-CT-4340: Unable to fetch planned dispatches');
        expect(p.intelligent_error).not.toMatch(/[{}[\]]/);
        expect(lastStatus().fill).toBe('red');
        expect(lastStatus().text).toBe('Error: KT-CT-4340: Unable to fetch planned dispatches');
        // the last known plan is kept
        expect(p.slot1_start_raw).toBe('2026-09-30T01:40:00Z');
    });

    test('a very long Kraken message is cut to under 255 characters', async () => {
        dispatchErrors = [{ message: 'y'.repeat(2000), path: ['flexPlannedDispatches'], extensions: { errorCode: 'KT-CT-4340' } }];
        await refreshPoll();
        const p = lastPoll();
        expect(p.intelligent_error.length).toBeLessThan(255);
        expect(p.intelligent_error.startsWith('KT-CT-4340: yyy')).toBe(true);
    });

    test('a devices error that is not on preferences still fails the poll, with a short message', async () => {
        devicesReply = {
            data: { devices: null },
            errors: [{ message: 'Account not found.', path: ['devices'], extensions: { errorCode: 'KT-CT-1111' } }],
        };
        const before = dispatchCallArgs().length;
        await refreshPoll();
        expect(dispatchCallArgs().length).toBe(before);
        expect(lastPoll().intelligent_error).toBe('KT-CT-1111: Account not found');
        expect(lastStatus().fill).toBe('red');
    });
});
