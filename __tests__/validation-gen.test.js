// __tests__/validation-gen.test.js
'use strict';
/**
 * validationGen: each set-limit submit bumps a generation, and the mutation answer, the retry
 * timers and a check waiting on Octopus all compare it before acting. node-writes-and-commands
 * covers two submits; these cover three rapid submits whose answers arrive out of order, fail
 * late or are refused late. Kraken shapes: setDevicePreferences returns { __typename }; a
 * refusal is HTTP 200 with errors at ['setDevicePreferences'].
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, pollDevice } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');

let h;
let refuseMax;     // a setDevicePreferences with this max is refused (after any hold)
let maxLimit;      // preferences max Octopus reports

async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

const statusTexts = () => h.statuses.map((s) => s.text);
const lastStatusText = () => h.statuses[h.statuses.length - 1].text;
const prefMutations = () => graphqlPost.mock.calls.filter(([b]) => /setDevicePreferences/.test(b.query));
// The charging poll's devices query (the preferences mutation also names SmartFlexDevicePreferencesInput).
const DEVICES_QUERY = /query getDevices[\s\S]*SmartFlexDevicePreferences/;
const prefPolls = () => graphqlPost.mock.calls.filter(([b]) => DEVICES_QUERY.test(b.query)).length;
const submit = (limit) => h.node._handlers.input({ payload: { set_limit: limit } });

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    h = createHarness();
    refuseMax = null;
    maxLimit = 90;
    h.replies.devices = () => ({ data: { devices: [pollDevice({ max: maxLimit })] } });
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        const reply = await harnessReply(body, ...rest); // holds apply here
        if (/setDevicePreferences/.test(body.query) && refuseMax !== null
            && body.variables.input.schedules[0].max === refuseMax) {
            return { data: { data: { setDevicePreferences: null }, errors: [
                { message: 'Invalid data.', path: ['setDevicePreferences'], extensions: { errorType: 'VALIDATION', errorCode: 'KT-CT-4321' } },
            ] }, status: 200 };
        }
        return reply;
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('three submits answered out of order: only the last starts a check, and it confirms the last value', async () => {
    await h.start();
    const g1 = h.hold(/setDevicePreferences/);
    const g2 = h.hold(/setDevicePreferences/);
    submit(50);
    submit(60);
    submit(70);                                 // its write is answered at once
    await flush();
    expect(prefMutations().map(([b]) => b.variables.input.schedules[0].max)).toEqual([50, 60, 70]);
    expect(lastStatusText()).toBe('Verifying changes...');

    maxLimit = 70;
    const statuses = h.statuses.length;
    g2.release();                               // the older answers arrive late, newest first
    g1.release();
    await flush();
    expect(h.statuses).toHaveLength(statuses);  // they change nothing

    const base = prefPolls();
    await h.advance(15000);
    expect(prefPolls()).toBe(base + 1);         // one check, not three
    expect(lastStatusText()).toBe('Confirmed: 70% @ 04:00');
    expect(h.lastPayload().confirmed_limit).toBe(70);

    await h.advance(300000);
    expect(prefPolls()).toBe(base + 1);         // no older chain left running
});

test('an older submit whose write times out after a newer one started does not stop the newer check', async () => {
    await h.start();
    const g1 = h.hold(/setDevicePreferences/);
    submit(50);
    await flush();
    submit(60);
    submit(70);
    await flush();
    expect(lastStatusText()).toBe('Verifying changes...');

    g1.reject(new Error('Octopus API request timed out after 30s'));
    await flush();
    expect(h.warns).toContain('Preferences update not confirmed (Octopus API request timed out after 30s) - checking with Octopus');
    expect(statusTexts()).not.toContain('Update unconfirmed - checking');
    expect(lastStatusText()).toBe('Verifying changes...');

    maxLimit = 70;
    await h.advance(15000);
    expect(lastStatusText()).toBe('Confirmed: 70% @ 04:00');
});

test('an older submit refused after a newer one started reports nothing and leaves the newer check running', async () => {
    await h.start();
    refuseMax = 50;
    const g1 = h.hold(/setDevicePreferences/);
    submit(50);
    await flush();
    submit(60);
    submit(70);
    await flush();

    g1.release();                               // the refusal of 50 arrives last
    await flush();
    expect(statusTexts()).not.toContain('Update Failed');
    expect(lastStatusText()).toBe('Verifying changes...');

    const base = prefPolls();
    await h.advance(15000);                     // 70 not applied yet: the chain carries on
    expect(prefPolls()).toBe(base + 1);
    expect(lastStatusText()).toBe('Retry 1/4...');
    maxLimit = 70;
    await h.advance(30000);
    expect(prefPolls()).toBe(base + 2);
    expect(lastStatusText()).toBe('Confirmed: 70% @ 04:00');
});

test('the newest submit refused after two accepted ones: no check runs at all', async () => {
    await h.start();
    refuseMax = 70;
    submit(50);
    submit(60);
    submit(70);
    await flush();
    expect(lastStatusText()).toBe('Update Failed');
    const base = prefPolls();
    await h.advance(300000);
    expect(prefPolls()).toBe(base);
    expect(statusTexts()).not.toContain('Verifying changes...');
});

test('three submits while a check waits on Octopus: the waiting check changes nothing, one chain remains', async () => {
    await h.start();
    submit(50);
    await flush();
    const gate = h.hold(DEVICES_QUERY);
    await h.advance(15000);                     // the first chain's check is waiting on Octopus
    const base = prefPolls();

    submit(60);
    submit(70);
    submit(80);
    await flush();
    expect(lastStatusText()).toBe('Verifying changes...');
    maxLimit = 80;
    const statuses = h.statuses.length;
    gate.release();
    await flush();
    expect(h.statuses).toHaveLength(statuses);  // the old check stops quietly

    await h.advance(15000);
    expect(prefPolls()).toBe(base + 1);         // only the newest chain's 15 s check
    expect(lastStatusText()).toBe('Confirmed: 80% @ 04:00');
    await h.advance(300000);
    expect(prefPolls()).toBe(base + 1);
});

test('closing between rapid submits: the late answers start no check', async () => {
    await h.start();
    const g1 = h.hold(/setDevicePreferences/);
    const g2 = h.hold(/setDevicePreferences/);
    const g3 = h.hold(/setDevicePreferences/);
    submit(50);
    submit(60);
    submit(70);
    await flush();
    const base = prefPolls();
    const statuses = h.statuses.length;
    h.close();
    g3.release();
    g1.release();
    g2.release();
    await flush();
    await jest.advanceTimersByTimeAsync(300000);
    expect(prefPolls()).toBe(base);
    expect(h.statuses).toHaveLength(statuses);
});
