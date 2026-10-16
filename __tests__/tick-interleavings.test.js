// __tests__/tick-interleavings.test.js
'use strict';
/**
 * pollDueCategories applies only the tick's own changes onto the current state, then re-applies
 * charging_now, boosting and boost_error (review F4). tick-state-merge.test.js covers a
 * validation poll and a Charge Cap change landing while a NON-charging category waits. These
 * tests cover the harder interleavings, where the tick also ran the charging poll, whose
 * result carries charging_now / boosting / charge_cap / confirmed_limit as they were when it
 * asked Octopus.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot, pollDevice, DEVICE_ID } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');

let h;
let currentState;  // smartStatus.currentState Octopus reports
let capState;      // chargeCap.isChargingDurationCapped Octopus reports
let maxLimit;      // preferences max Octopus reports

async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());
const lastStatusText = () => h.statuses[h.statuses.length - 1].text;

// Charging poll hourly; Wheel of Fortune every minute, so the 01:01 tick polls only that
// unless the charging poll is forced too.
const CFG = { refreshInterval: 60, enableWheelOfFortune: true, wheelOfFortuneInterval: 1 };

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [];
    currentState = 'SMART_CONTROL_CAPABLE';
    capState = 'ENABLED';
    maxLimit = 90;
    h.replies.devices = () => {
        const d = pollDevice({ max: maxLimit });
        d.chargeCap = { isChargingDurationCapped: capState };
        d.smartStatus = { isSuspended: false, currentState };
        return { data: { devices: [d] } };
    };
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/updateBoostCharge/.test(body.query)) {
            currentState = body.variables.action === 'BOOST' ? 'BOOSTING' : 'SMART_CONTROL_CAPABLE';
            return { data: { data: { updateBoostCharge: { id: DEVICE_ID } } }, status: 200 };
        }
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

test('a slot that starts while the tick waits on a later category: the tick does not put charging_now back to false', async () => {
    h.plan = [slot('2026-09-30T01:01:03Z', '2026-09-30T01:30:00Z')];
    await h.start(CFG);
    expect(h.lastPayload().charging_now).toBe(false);

    await advanceTo('2026-09-30T01:01:00Z');
    h.node._handlers.input({ payload: {} });              // the charging poll runs in this tick too
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();                              // charging poll done (charging_now false), WoF waits
    await flush();
    await advanceTo('2026-09-30T01:01:05Z');              // the slot start timer fires meanwhile
    expect(h.published('charging_now').pop()).toBe('ON');

    gate.release();
    await tick;

    expect(h.lastPayload().charging_now).toBe(true);
    expect(h.statePublishes().pop().charging_now).toBe(true);
    expect(h.published('charging_now').pop()).toBe('ON');
});

test('a boost accepted while the tick waits on a later category: the tick keeps boosting and charging_now on', async () => {
    await h.start(CFG);
    expect(h.lastPayload().boosting).toBe(false);

    await advanceTo('2026-09-30T01:01:00Z');
    h.node._handlers.input({ payload: {} });
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();                              // charging poll read boosting=false
    await flush();
    h.node._handlers.input({ payload: { set_boost: true } });
    await flush();
    expect(h.logs).toContain('Boost requested');

    gate.release();
    await tick;

    const p = h.lastPayload();
    expect(p.boosting).toBe(true);
    expect(p.charging_now).toBe(true);
    expect(p.boost_error).toBeNull();
    expect(h.statePublishes().pop()).toEqual(expect.objectContaining({ boosting: true, charging_now: true }));
    expect(h.published('boost').pop()).toBe('ON');
});

test('a boost refusal while the tick waits on a later category reaches the tick\'s state', async () => {
    await h.start(CFG);
    await advanceTo('2026-09-30T01:01:00Z');
    h.node._handlers.input({ payload: {} });
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();
    await flush();

    const base = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/updateBoostCharge/.test(body.query)) {
            return { data: { data: { updateBoostCharge: null }, errors: [
                { message: 'Unable to boost charge.', path: ['updateBoostCharge'], extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-1234' } },
            ] }, status: 200 };
        }
        return base(body, ...rest);
    });
    h.node._handlers.input({ payload: { set_boost: true } });
    await flush();
    expect(h.warns).toContain('Boost request failed: KT-CT-1234: Unable to boost charge');

    gate.release();
    await tick;
    expect(h.lastPayload().boost_error).toBe('KT-CT-1234: Unable to boost charge');
    expect(h.statePublishes().pop().boost_error).toBe('KT-CT-1234: Unable to boost charge');
});

test('a Charge Cap change while the charging poll waits: the old read is shown at most until the forced re-poll', async () => {
    await h.start(CFG);
    expect(h.lastPayload().charge_cap).toBe(true);

    await advanceTo('2026-09-30T01:01:00Z');
    h.node._handlers.input({ payload: {} });
    const gate = h.hold(/getDispatches/);
    const tick = h.onTick();                              // devices read: ENABLED; dispatches wait
    await flush();
    h.node._handlers.input({ payload: { set_charge_cap: false } });
    await flush();
    expect(lastStatusText()).toBe('Charge Cap off');
    expect(capState).toBe('DISABLED');

    gate.release();
    await tick;
    await h.advance(1000);
    await h.onTick();                                     // forced during the poll, so still due

    expect(h.lastPayload().charge_cap).toBe(false);
    expect(h.statePublishes().pop().charge_cap).toBe(false);
    expect(h.published('charge_cap').pop()).toBe('OFF');
});

// FINDING: a set-limit validation poll runs outside the scheduler (fetchDataWithValidation calls
// intelligentPoll directly). When a scheduled or manual charging poll sent its devices query
// before Octopus applied the new limit, and its dispatches answer arrives after the validation
// poll confirmed the new limit, intelligentPoll writes the OLD preferences back into
// confirmedLimit / pendingLimit and the tick's changes carry confirmed_limit = old. Nothing forces
// a re-poll, so the node shows the old limit ("Confirmed: 90%") until the next scheduled charging
// poll (up to refreshInterval later), although Octopus has the new one. Correct: once both have
// finished, the newer confirmation stands (or a re-poll is forced at once).
test.skip('FINDING: a validation poll that confirms a new limit while an older charging poll is in flight is not undone', async () => {
    await h.start(CFG);
    expect(h.lastPayload().confirmed_limit).toBe(90);

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

    gate.release();                                         // the older poll finishes last
    await tick;
    for (let i = 0; i < 5; i++) {
        await h.advance(1000);
        await h.onTick();
    }

    expect(h.lastPayload().confirmed_limit).toBe(50);
    expect(h.lastPayload().pending_limit).toBe(50);
    expect(lastStatusText()).toBe('Confirmed: 50% @ 04:00');
});

test('closing the node while a tick waits: the tick applies and publishes nothing', async () => {
    await h.start(CFG);
    await advanceTo('2026-09-30T01:01:00Z');
    const gate = h.hold(/getWheelOfFortuneSpinsAllowed/);
    const tick = h.onTick();
    await flush();
    const sends = h.sends.length;
    const publishes = h.statePublishes().length;
    h.close();
    gate.release();
    await tick;
    expect(h.sends).toHaveLength(sends);
    expect(h.statePublishes()).toHaveLength(publishes);
});
