// __tests__/intelligent-poll-edges.test.js
'use strict';
/**
 * Coverage sweep 2 (v1.7): charging poll and slot timer paths of the real node that no test
 * drove yet: replies without data or without an EV, a NOT_APPLICABLE Charge Cap, a poll
 * superseded by a newer tick, a pre-validation that finds the slot cancelled or cannot
 * authenticate, a poll inside the last 30 s before a slot, back-to-back slots, and a slot
 * more than 24 h ahead. Kraken is mocked: HTTP 200 bodies
 * { data, errors: [{ message, path, extensions: { errorCode } }] }, numbers as strings.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot, pollDevice, DISCOVERED } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

let h;
let authBroken; // when true, obtainKrakenToken answers with a Kraken error

const dispatchCalls = () => graphqlPost.mock.calls.filter(([b]) => /query getDispatches\b/.test(b.query)).length;
const lastPoll = () => h.pollSends().pop().payload;

async function pollAt(iso) {
    jest.setSystemTime(new Date(iso));
    await h.onTick();
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    h = createHarness();
    authBroken = false;
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (authBroken && /obtainKrakenToken/.test(body.query)) {
            return { data: { data: null, errors: [{ message: 'Invalid API key.', path: ['obtainKrakenToken'], extensions: { errorCode: 'KT-CT-1139' } }] }, status: 200 };
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('charging poll replies the node cannot use', () => {
    test('a device list with no EV fails the poll before the dispatches query', async () => {
        h.replies.devices = () => ({ data: { devices: [{ ...pollDevice(), id: 'hp-9', deviceType: 'HEAT_PUMPS' }] } });
        await h.start();
        expect(lastPoll().intelligent_error).toBe('No ELECTRIC_VEHICLES device found on account');
        expect(dispatchCalls()).toBe(0);
        expect(h.statuses.pop()).toEqual({ fill: 'red', shape: 'ring', text: 'Error: No ELECTRIC_VEHICLES device found on account' });
        expect(h.warns.some((w) => /^Charging poll failed: No ELECTRIC_VEHICLES device found on account/.test(w))).toBe(true);
    });

    test('a devices reply with neither data nor errors fails the poll with "Devices response missing data"', async () => {
        h.replies.devices = () => ({ data: null });
        await h.start();
        expect(lastPoll().intelligent_error).toBe('Devices response missing data');
        expect(dispatchCalls()).toBe(0);
    });

    test('a dispatches reply with neither data nor errors fails the poll with "Dispatches response missing data"', async () => {
        h.replies.dispatches = () => ({ data: null });
        await h.start();
        expect(lastPoll().intelligent_error).toBe('Dispatches response missing data');
    });

    test('flexPlannedDispatches null (no plan) is an empty plan, not an error', async () => {
        h.replies.dispatches = () => ({ data: { flexPlannedDispatches: null } });
        await h.start();
        const p = lastPoll();
        expect(p.intelligent_error).toBeNull();
        expect(p.slot1_start).toBeNull();
        expect(p.charging_now).toBe(false);
    });
});

// Review L4: discovery prefers the LIVE EV. The charging poll and boost use that same
// device, even when a RETIRED car is listed first.
describe('a RETIRED car listed before the LIVE one', () => {
    const retired = () => ({ ...pollDevice({ suspended: true, max: 50 }), id: 'old-car' });
    const live = () => ({ ...pollDevice({ suspended: false, max: 90 }), id: 'new-car' });
    beforeEach(() => {
        discoverProducts.mockResolvedValue({ ...DISCOVERED, deviceId: 'new-car', vehicleDeviceId: 'new-car', deviceSuspended: false });
        h.replies.devices = () => ({ data: { devices: [retired(), live()] } });
    });

    test('the charging poll reads the discovered (LIVE) car and asks for its dispatches', async () => {
        await h.start();
        const dispatchQueries = graphqlPost.mock.calls.filter(([b]) => /query getDispatches\b/.test(b.query));
        expect(dispatchQueries.length).toBeGreaterThan(0);
        for (const [b] of dispatchQueries) expect(b.variables.deviceId).toBe('new-car');
        const p = lastPoll();
        expect(p.confirmed_limit).toBe(90);
        expect(p.smart_charging).toBe(true);
    });

    test('a boost targets the discovered (LIVE) car', async () => {
        await h.start();
        h.node._handlers.input({ payload: { set_boost: true } });
        await jest.advanceTimersByTimeAsync(2000);
        const boosts = graphqlPost.mock.calls.filter(([b]) => /updateBoostCharge/.test(b.query));
        expect(boosts.length).toBe(1);
        expect(JSON.stringify(boosts[0][0].variables)).toContain('new-car');
        expect(JSON.stringify(boosts[0][0].variables)).not.toContain('old-car');
    });
});

describe('Charge Cap NOT_APPLICABLE', () => {
    test('warns once over several polls, publishes no switch state and reports charge_cap null', async () => {
        h.replies.devices = () => {
            const d = pollDevice();
            d.chargeCap = { isChargingDurationCapped: 'NOT_APPLICABLE' };
            return { data: { devices: [d] } };
        };
        await h.start();
        await pollAt('2026-10-07T10:05:05Z');
        await pollAt('2026-10-07T10:10:05Z');
        const naWarns = h.warns.filter((w) => w === 'Charge Cap not applicable for this device — switch will show unknown');
        expect(naWarns).toHaveLength(1);
        expect(h.publishCalls('charge_cap')).toEqual([]);
        expect(lastPoll().charge_cap).toBeNull();
    });

    test('ENABLED publishes the switch state ON (retained) on each poll', async () => {
        await h.start();
        const calls = h.publishCalls('charge_cap');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toBe('ON');
        expect(calls[0][2]).toEqual({ retain: true });
        expect(lastPoll().charge_cap).toBe(true);
    });
});

describe('a charging poll superseded by a newer tick', () => {
    test('throws away its answer: no message, no failure warning, no slot timer', async () => {
        await h.start();
        const sendsBefore = h.pollSends().length;
        const statusesBefore = h.statuses.length;
        jest.setSystemTime(new Date('2026-10-07T10:05:05Z'));
        h.plan = [slot('2026-10-07T10:06:00Z', '2026-10-07T10:36:00Z')];
        const gate = h.hold(/query getDispatches\b/);
        let stale = false;
        const tick = h.onTick(() => stale);
        await h.advance(0);
        stale = true;            // a newer tick has taken over while Octopus was answering
        gate.release();
        await tick;
        expect(h.pollSends()).toHaveLength(sendsBefore);
        expect(h.statuses.length).toBe(statusesBefore);
        expect(h.warns.some((w) => /Charging poll failed/.test(w))).toBe(false);
        expect(h.logs.some((l) => /Pre-validation timer set|Slot start timer set/.test(l))).toBe(false);
        // The slot from the discarded answer never switches charging_now on.
        await h.advance(2 * 60 * 1000);
        expect(h.published('charging_now')).not.toContain('ON');
    });
});

describe('pre-validation (30 s before a slot)', () => {
    test('a slot cancelled since the poll is not started, and the changed plan forces a poll', async () => {
        h.plan = [slot('2026-10-07T10:30:00Z', '2026-10-07T11:00:00Z')];
        await h.start();
        h.plan = []; // Octopus dropped the slot
        await h.advance(Date.parse('2026-10-07T10:31:00Z') - Date.now());
        expect(h.warns).toContain('Pre-validating slot data (30s before start)');
        expect(h.warns).toContain('Charging plan changed since last poll - refreshing');
        expect(h.warns).toContain('Slot was cancelled or modified - not setting start timer');
        expect(h.published('charging_now')).not.toContain('ON');
        expect(h.warns.some((w) => /Charging slot started/.test(w))).toBe(false);
    });

    test('an auth failure falls back to the cached slot, which still starts on time', async () => {
        h.plan = [slot('2026-10-07T10:30:00Z', '2026-10-07T11:00:00Z')];
        await h.start();
        authBroken = true;
        const dispatchesBefore = dispatchCalls();
        await h.advance(Date.parse('2026-10-07T10:30:05Z') - Date.now());
        expect(h.warns).toContain('Pre-validation failed: Pre-validation auth failed, using cached slot');
        expect(dispatchCalls()).toBe(dispatchesBefore); // stopped before the dispatches query
        expect(h.warns).toContain('Charging slot started at 2026-10-07T10:30:00Z');
        expect(h.published('charging_now').pop()).toBe('ON');
    });

    test('a poll inside the last 30 s before a slot sets the start timer directly (no pre-validation)', async () => {
        jest.setSystemTime(new Date('2026-10-07T10:29:45Z'));
        h.plan = [slot('2026-10-07T10:30:00Z', '2026-10-07T11:00:00Z')];
        await h.start(); // first poll at about 10:29:47
        const dispatchesAfterPoll = dispatchCalls();
        await h.advance(Date.parse('2026-10-07T10:30:01Z') - Date.now());
        expect(h.warns).not.toContain('Pre-validating slot data (30s before start)');
        expect(dispatchCalls()).toBe(dispatchesAfterPoll);
        expect(h.warns).toContain('Charging slot started at 2026-10-07T10:30:00Z');
        expect(h.published('charging_now').pop()).toBe('ON');
    });

    test('a slot more than 24 h ahead gets no pre-validation timer', async () => {
        h.plan = [slot('2026-10-08T12:00:00Z', '2026-10-08T13:00:00Z')];
        await h.start();
        expect(h.logs).toContain('Next slot at 2026-10-08T12:00:00Z');
        expect(h.logs.some((l) => /^Pre-validation timer set/.test(l))).toBe(false);
    });
});

describe('back-to-back slots', () => {
    test('charging_now stays on across the join and goes off at the end of the second slot', async () => {
        h.plan = [
            slot('2026-10-07T10:30:00Z', '2026-10-07T11:00:00Z'),
            slot('2026-10-07T11:00:00Z', '2026-10-07T11:30:00Z'),
        ];
        await h.start();
        await h.advance(Date.parse('2026-10-07T10:30:05Z') - Date.now());
        expect(h.published('charging_now').pop()).toBe('ON');

        await h.advance(Date.parse('2026-10-07T11:00:05Z') - Date.now());
        expect(h.warns).toContain('Charging slot ended at 2026-10-07T11:00:00Z');
        expect(h.warns).toContain('Next slot starting immediately');
        expect(h.published('charging_now').pop()).toBe('ON');
        const offBetween = h.sends.filter((m) => m.debug && m.debug.trigger === 'charging_state_change' && m.debug.new_state === false);
        expect(offBetween).toEqual([]);

        await h.advance(Date.parse('2026-10-07T11:30:05Z') - Date.now());
        expect(h.warns).toContain('Charging slot ended at 2026-10-07T11:30:00Z');
        expect(h.published('charging_now').pop()).toBe('OFF');
        expect(h.warns.filter((w) => /Correcting chargingNow/.test(w))).toEqual([]);
    });
});
