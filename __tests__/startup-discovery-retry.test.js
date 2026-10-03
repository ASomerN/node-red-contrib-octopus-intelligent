// __tests__/startup-discovery-retry.test.js
'use strict';
/**
 * Startup discovery must retry with backoff instead of leaving the node with no scheduler
 * (live bug: one transient KT-CT-4360 at startup). Also guards against duplicate schedulers
 * and orphan retry timers after close.
 */
jest.mock('../lib/graphql', () => ({
    graphqlPost: jest.fn(async () => ({ data: { errors: [{ message: 'stubbed' }] }, status: 200, headers: {} })),
}));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ createScheduler: jest.fn() }));

const { discoverProducts } = require('../lib/discovery');
const { createScheduler } = require('../lib/scheduler');

const ACCOUNT = 'A-RETRY001';
const DISCOVERED = {
    hasIntelligent: true, hasElectricity: false, hasGas: false, deviceId: 'dev-1', deviceSuspended: null,
    smartMeterDeviceId: null, electricityMpan: null, electricityExportMpan: null, electricitySerial: null,
    gasMprn: null, gasSerial: null,
};

let scheduler;
let warns;
let statuses;

function buildNode() {
    let NodeCtor = null;
    const RED = {
        nodes: {
            createNode(node) {
                const handlers = {};
                const store = {};
                node._handlers = handlers;
                node.credentials = { apiKey: 'sk_test_retry' };
                node.on = (evt, fn) => { handlers[evt] = fn; };
                node.log = () => {};
                node.warn = (m) => { warns.push(String(m)); };
                node.error = () => {};
                node.status = (s) => { statuses.push(s); };
                node.send = () => {};
                node.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
            },
            getNode: () => null,
            registerType: (type, ctor) => { NodeCtor = ctor; },
        },
    };
    require('../octopus-intelligent.js')(RED);
    return new NodeCtor({ id: 'oi-1', accountNumber: ACCOUNT, enableMqtt: false, refreshInterval: 5 });
}

beforeEach(() => {
    jest.useFakeTimers();
    warns = [];
    statuses = [];
    scheduler = { start: jest.fn(), stop: jest.fn() };
    discoverProducts.mockReset();
    createScheduler.mockReset();
    createScheduler.mockImplementation(() => scheduler);
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('retries a failed startup discovery and starts the scheduler once it succeeds', async () => {
    discoverProducts
        .mockRejectedValueOnce(new Error('Discovery failed: KT-CT-4360'))
        .mockRejectedValueOnce(new Error('Discovery failed: KT-CT-4360'))
        .mockResolvedValue(DISCOVERED);
    const node = buildNode();
    try {
        await jest.advanceTimersByTimeAsync(2100);
        expect(discoverProducts).toHaveBeenCalledTimes(1);
        expect(warns.some((w) => w.includes('retrying in 30s') || w.includes('Retrying in 30s'))).toBe(true);
        expect(statuses.some((s) => s && /retrying in 30s/i.test(s.text))).toBe(true);
        expect(createScheduler).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(30000);
        expect(discoverProducts).toHaveBeenCalledTimes(2);
        expect(warns.some((w) => /retrying in 60s/i.test(w))).toBe(true);
        expect(statuses.some((s) => s && /retrying in 60s/i.test(s.text))).toBe(true);
        expect(createScheduler).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60000);
        expect(discoverProducts).toHaveBeenCalledTimes(3);
        expect(createScheduler).toHaveBeenCalledTimes(1);
        expect(scheduler.start).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(600000);
        expect(discoverProducts).toHaveBeenCalledTimes(3);
        expect(createScheduler).toHaveBeenCalledTimes(1);
        expect(scheduler.start).toHaveBeenCalledTimes(1);
    } finally {
        node._handlers.close();
    }
});

test('closing the node during a pending retry starts nothing', async () => {
    discoverProducts.mockRejectedValue(new Error('Discovery failed: KT-CT-4360'));
    const node = buildNode();
    await jest.advanceTimersByTimeAsync(2100);
    expect(discoverProducts).toHaveBeenCalledTimes(1);
    node._handlers.close();
    await jest.advanceTimersByTimeAsync(3600000);
    expect(discoverProducts).toHaveBeenCalledTimes(1);
    expect(createScheduler).not.toHaveBeenCalled();
});

test('success on the first attempt behaves as before (one discovery, one scheduler)', async () => {
    discoverProducts.mockResolvedValue(DISCOVERED);
    const node = buildNode();
    try {
        await jest.advanceTimersByTimeAsync(2100);
        expect(discoverProducts).toHaveBeenCalledTimes(1);
        expect(createScheduler).toHaveBeenCalledTimes(1);
        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(warns.some((w) => /retrying/i.test(w))).toBe(false);
    } finally {
        node._handlers.close();
    }
});
