// __tests__/prefs-generation.test.js
'use strict';
/**
 * A charging poll that asked Octopus for the device preferences BEFORE a change was made, and
 * whose answer lands AFTER that change was confirmed (or a new one sent), must not put the old
 * target, ready-by time or Charge Cap back. Before 1.6.2 it did: once the validation poll had
 * confirmed 50 %, the older poll wrote 90 % back into confirmedLimit / pendingLimit (validation
 * mode was over by then) and the tick's changes carried confirmed_limit 90, so the node showed
 * "Confirmed: 90%" until the next scheduled charging poll.
 * Now such a poll keeps its dispatches but drops its preference values and forces a fresh read.
 * Port of the cov17c tick-interleavings FINDING for 1.6.x. Kraken answers HTTP 200.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot, pollDevice } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');

let h;
let capState;  // chargeCap.isChargingDurationCapped Octopus reports
let maxLimit;  // preferences max Octopus reports

async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());
const lastStatusText = () => h.statuses[h.statuses.length - 1].text;
const lastPoll = () => { const s = h.pollSends(); return s[s.length - 1].payload; };
const chargingPolls = () => graphqlPost.mock.calls
    .filter((c) => /getDevices/.test(c[0].query) && /SmartFlexDevicePreferences/.test(c[0].query)).length;

// Charging poll hourly, so only a forced poll reads the preferences again within the test.
const CFG = { refreshInterval: 60 };

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [];
    capState = 'ENABLED';
    maxLimit = 90;
    h.replies.devices = () => {
        const d = pollDevice({ max: maxLimit });
        d.chargeCap = { isChargingDurationCapped: capState };
        return { data: { devices: [d] } };
    };
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/updateIsChargingDurationCapped/.test(body.query)) {
            capState = body.variables.input.enabled ? 'ENABLED' : 'DISABLED';
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('a validation poll that confirms a new limit while an older charging poll is in flight is not undone', async () => {
    await h.start(CFG);
    expect(lastPoll().confirmed_limit).toBe(90);

    await advanceTo('2026-09-30T01:00:10Z');
    h.node._handlers.input({ payload: { set_limit: 50 } }); // validation poll due at 01:00:25
    await flush();
    expect(lastStatusText()).toBe('Verifying changes...');

    await advanceTo('2026-09-30T01:00:20Z');
    h.node._handlers.input({ payload: {} });                // a charging poll starts
    const gate = h.hold(/getDispatches/);
    const tick = h.onTick();                                // its devices read still says 90
    await flush();
    maxLimit = 50;                                          // Octopus applies the change

    await advanceTo('2026-09-30T01:00:26Z');                // the validation poll confirms 50
    expect(lastStatusText()).toBe('Confirmed: 50% @ 04:00');

    // The older poll finishes last. Its dispatches are newer than anything known: they apply.
    h.plan = [slot('2026-09-30T03:00:00Z', '2026-09-30T03:30:00Z')];
    const pollsBefore = chargingPolls();
    gate.release();
    await tick;

    const p = lastPoll();
    expect(p.confirmed_limit).toBe(50);
    expect(p.flex_planned_dispatches_count).toBe(1);
    expect(lastStatusText()).toBe('Confirmed: 50% @ 04:00');

    // A fresh read is forced and agrees.
    for (let i = 0; i < 5; i++) {
        await h.advance(1000);
        await h.onTick();
    }
    expect(chargingPolls()).toBe(pollsBefore + 1);
    expect(lastPoll().confirmed_limit).toBe(50);
    expect(lastPoll().pending_limit).toBe(50);
    expect(lastStatusText()).toBe('Confirmed: 50% @ 04:00');
});

test('a Charge Cap change sent while a charging poll is in flight is not undone by that poll', async () => {
    await h.start(CFG);
    expect(lastPoll().charge_cap).toBe(true);

    await advanceTo('2026-09-30T01:00:20Z');
    h.node._handlers.input({ payload: {} });                // a charging poll starts
    const gate = h.hold(/getDispatches/);
    const tick = h.onTick();                                // its devices read says ENABLED
    await flush();

    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await flush();
    expect(capState).toBe('DISABLED');
    expect(h.published('charge_cap').pop()).toBe('OFF');

    gate.release();                                         // the older poll finishes last
    await tick;
    expect(h.published('charge_cap').pop()).toBe('OFF');
    expect(lastPoll().charge_cap).toBe(false);

    for (let i = 0; i < 5; i++) {
        await h.advance(1000);
        await h.onTick();
    }
    expect(h.published('charge_cap').pop()).toBe('OFF');
    expect(lastPoll().charge_cap).toBe(false);
});

test('a charging poll with no change during it still applies its preferences', async () => {
    await h.start(CFG);
    expect(lastPoll().confirmed_limit).toBe(90);
    maxLimit = 70; // changed in the Octopus app
    await advanceTo('2026-09-30T01:00:20Z');
    h.node._handlers.input({ payload: {} });
    await h.onTick();
    expect(lastPoll().confirmed_limit).toBe(70);
    expect(lastPoll().pending_limit).toBe(70);
    const polls = chargingPolls();
    for (let i = 0; i < 5; i++) {
        await h.advance(1000);
        await h.onTick();
    }
    expect(chargingPolls()).toBe(polls); // no extra read
});
