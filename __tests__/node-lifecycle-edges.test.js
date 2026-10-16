// __tests__/node-lifecycle-edges.test.js
'use strict';
/**
 * Coverage sweep 2 (v1.7): node paths outside the charging poll that no test drove yet.
 * - the npm update check: update entity state, the once-per-version warning
 * - the scheduler's stuck-tick warning
 * - the persisted timezone republished at startup (and a context store that throws)
 * - close when the broker's unsubscribe / deregister throw, or there is no deregister
 * - the startup device fetch with no EV, or a status without isSuspended
 * - a transport error with a response body on setPreferences
 * - smart-charging verification that finds no EV device
 * - a confirmed boosting=false that goes stale (logged, not warned)
 * Kraken is mocked: HTTP 200 bodies { data, errors: [{ message, path, extensions: { errorCode } }] }.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, pollDevice, ACCOUNT, STATUS, DEVICE_ID } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const httpGetJson = require('../lib/http-get-json');
const { createScheduler } = require('../lib/scheduler');

const INSTALLED = require('../package.json').version;

let h;

async function pollAt(iso) {
    jest.setSystemTime(new Date(iso));
    await h.onTick();
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    httpGetJson.mockReset();
    httpGetJson.mockImplementation(async () => { throw new Error('stubbed'); });
    h = createHarness();
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('npm update check through the node', () => {
    const updateWarns = () => h.warns.filter((w) => /^Update available:/.test(w));

    test('a newer version on npm sets update_available, publishes the update entity once and warns once', async () => {
        httpGetJson.mockResolvedValue({ name: 'node-red-contrib-octopus-intelligent', version: '99.0.0' });
        await h.start();
        const p = h.pollSends().pop().payload;
        expect(p.update_available).toBe(true);
        expect(p.latest_version).toBe('99.0.0');
        expect(p.update_check_error).toBeNull();

        expect(h.published('node_update')).toEqual([
            JSON.stringify({ installed_version: INSTALLED, latest_version: '99.0.0' }),
        ]);
        expect(h.publishCalls('node_update')[0][2]).toEqual({ retain: true });
        expect(updateWarns()).toEqual([
            `Update available: v99.0.0 (running v${INSTALLED}). Install via Node-RED → Manage Palette → Upgrade.`,
        ]);
    });

    test('the daily re-check with the same version neither warns again nor republishes the update entity', async () => {
        httpGetJson.mockResolvedValue({ version: '99.0.0' });
        await h.start();
        await pollAt('2026-10-08T00:00:05Z');
        expect(httpGetJson).toHaveBeenCalledTimes(2);
        expect(updateWarns()).toHaveLength(1);
        expect(h.published('node_update')).toHaveLength(1);
    });

    test('a newer release the next day warns again and republishes the update entity', async () => {
        httpGetJson.mockResolvedValue({ version: '99.0.0' });
        await h.start();
        httpGetJson.mockResolvedValue({ version: '99.0.1' });
        await pollAt('2026-10-08T00:00:05Z');
        expect(updateWarns()).toHaveLength(2);
        expect(updateWarns()[1]).toMatch(/^Update available: v99\.0\.1 /);
        expect(h.published('node_update').pop()).toBe(JSON.stringify({ installed_version: INSTALLED, latest_version: '99.0.1' }));
    });

    test('a failed check reports update_check_error and the update entity shows the installed version as latest', async () => {
        await h.start();
        const p = h.pollSends().pop().payload;
        expect(p.update_check_error).toBe('stubbed');
        expect(p.update_available).toBe(false);
        expect(updateWarns()).toEqual([]);
        expect(h.published('node_update')).toEqual([
            JSON.stringify({ installed_version: INSTALLED, latest_version: INSTALLED }),
        ]);
    });

    test('the same version as installed: no update, no warning', async () => {
        httpGetJson.mockResolvedValue({ version: INSTALLED });
        await h.start();
        expect(h.pollSends().pop().payload.update_available).toBe(false);
        expect(updateWarns()).toEqual([]);
    });
});

describe('scheduler stuck-tick warning', () => {
    test('onStuck warns with the tick age in whole seconds', async () => {
        await h.start();
        const opts = createScheduler.mock.calls[0][1];
        opts.onStuck(612400);
        expect(h.warns).toContain('Poll still running after 612s - starting a new poll');
    });
});

describe('persisted timezone at startup', () => {
    test('a timezone stored in the node context is republished (retained) to the select state topic', async () => {
        h.build();
        h.node.context().set('timezone', 'Europe/Berlin');
        await h.advance(2600);
        const calls = h.publishCalls('timezone');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toBe('Europe/Berlin');
        expect(calls[0][2]).toEqual({ retain: true });
    });

    test('nothing stored: nothing is published to the timezone topic', async () => {
        h.build();
        await h.advance(2600);
        expect(h.publishCalls('timezone')).toEqual([]);
    });

    test('a context store that throws is reported as a warning, not thrown', async () => {
        h.build();
        h.node.context = () => { throw new Error('context store unavailable'); };
        await h.advance(2600);
        expect(h.warns).toContain('Failed to republish timezone on startup: context store unavailable');
        expect(h.publishCalls('timezone')).toEqual([]);
    });

    test('an empty or blank set_timezone message is ignored', async () => {
        await h.start();
        const handler = h.broker.subscribe.mock.calls.find((c) => c[0] === `nodered_octopus/${ACCOUNT}/set_timezone`)[2];
        handler(`nodered_octopus/${ACCOUNT}/set_timezone`, Buffer.from('   '), { retain: false });
        expect(h.publishCalls('timezone')).toEqual([]);
        expect(h.node.context().get('timezone')).toBeUndefined();
    });
});

describe('close with a misbehaving broker', () => {
    function closeNow() {
        const done = jest.fn();
        const node = h.node;
        h.node = null; // afterEach must not close it again
        node._handlers.close(false, done);
        return done;
    }

    test('unsubscribe throwing is warned; the node still deregisters and close completes', async () => {
        await h.start();
        h.broker.unsubscribe.mockImplementation(() => { throw new Error('client gone'); });
        const done = closeNow();
        expect(h.warns).toContain('MQTT unsubscribe failed: client gone');
        expect(h.broker.deregister).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('deregister throwing is warned and close still completes once', async () => {
        await h.start();
        h.broker.deregister.mockImplementation(() => { throw new Error('broker closed'); });
        const done = closeNow();
        expect(h.warns).toContain('MQTT deregister failed: broker closed');
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('deregister that calls done and then throws does not call done twice', async () => {
        await h.start();
        h.broker.deregister.mockImplementation((n, cb) => { cb(); throw new Error('late failure'); });
        const done = closeNow();
        expect(h.warns).toContain('MQTT deregister failed: late failure');
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('a broker without deregister (older Node-RED) still completes close', async () => {
        await h.start();
        delete h.broker.deregister;
        const done = closeNow();
        expect(done).toHaveBeenCalledTimes(1);
        expect(h.broker.unsubscribe).toHaveBeenCalledTimes(8);
    });

    test('Node-RED calling close with done only (one argument) completes', async () => {
        await h.start();
        const done = jest.fn();
        const node = h.node;
        h.node = null;
        node._handlers.close(done);
        expect(done).toHaveBeenCalledTimes(1);
        // removed defaults to false: the broker keeps its connection for other nodes
        expect(h.broker.deregister.mock.calls[0][2]).toBe(false);
    });
});

describe('startup device fetch edges', () => {
    test('no EV on the account: warns and leaves smart charging unknown until the charging poll', async () => {
        h.replies.status = () => ({ data: { devices: [{ id: 'hp-9', deviceType: 'HEAT_PUMPS', status: { isSuspended: false } }] } });
        h.build();
        await h.advance(1600);
        expect(h.warns.some((w) => /^Failed to fetch device ID at startup: No ELECTRIC_VEHICLES device found on account\./.test(w))).toBe(true);
        expect(h.publishCalls('smart_charging')).toEqual([]);
    });

    test('a status without a boolean isSuspended caches the id but publishes no switch state', async () => {
        h.replies.status = () => ({ data: { devices: [{ id: DEVICE_ID, deviceType: 'ELECTRIC_VEHICLES', status: null }] } });
        h.build();
        await h.advance(1600);
        expect(h.logs).toContain(`Device ID cached: ${DEVICE_ID}, suspended: null`);
        expect(h.publishCalls('smart_charging')).toEqual([]);
    });

    test('a Kraken error on the startup device query is warned with the errors', async () => {
        h.replies.status = () => ({ data: null, errors: [{ message: 'Unauthorized.', path: ['devices'], extensions: { errorCode: 'KT-CT-1111' } }] });
        h.build();
        await h.advance(1600);
        expect(h.warns.some((w) => /^Failed to fetch device ID at startup: Device fetch failed: .*KT-CT-1111/.test(w))).toBe(true);
    });
});

describe('setPreferences transport error with a response body', () => {
    // Error-path fix #6: a write that fails in transport may still have reached Octopus, so it
    // is reported as unconfirmed and the next charging poll checks what Octopus has.
    test('is reported as unconfirmed, status "Update unconfirmed - checking", and a charging poll checks', async () => {
        await h.start();
        const errors = [];
        h.node.error = (m) => errors.push(String(m));
        const harnessReply = graphqlPost.getMockImplementation();
        graphqlPost.mockImplementation(async (body, ...rest) => {
            if (/setDevicePreferences/.test(body.query)) {
                const err = new Error('HTTP 502'); // the message lib/graphql.js gives a 5xx with no GraphQL errors
                err.response = { status: 502, data: { message: 'Bad Gateway' } };
                err.status = 502; // lib/graphql.js sets err.status; a 5xx is an unconfirmed write
                throw err;
            }
            return harnessReply(body, ...rest);
        });
        h.node._handlers.input({ payload: { set_limit: 70 } });
        await h.advance(10);
        expect(errors).toEqual([]);
        expect(h.warns).toContain('Preferences update not confirmed (HTTP 502) - checking with Octopus');
        expect(h.statuses.pop()).toEqual({ fill: 'yellow', shape: 'ring', text: 'Update unconfirmed - checking' });
        const dispatchCalls = () => graphqlPost.mock.calls.filter(([b]) => /getDispatches/.test(b.query)).length;
        const before = dispatchCalls();
        await h.onTick(); // the forced charging poll runs on the next tick
        expect(dispatchCalls()).toBe(before + 1);
    });
});

describe('smart-charging verification that finds no EV', () => {
    test.each([
        ['an empty device list', { devices: [] }],
        ['a null device list', { devices: null }],
    ])('%s at every check: retried at each interval, then reported unconfirmed', async (label, data) => {
        await h.start();
        h.node._handlers.input({ payload: { set_smart_charging: false } });
        await h.advance(10);
        expect(h.published('smart_charging').pop()).toBe('OFF');
        h.replies.status = () => ({ data });
        const verifyCalls = () => graphqlPost.mock.calls.filter(([b]) => /getDevices/.test(b.query) && !/SmartFlexDevicePreferences/.test(b.query)).length;
        const before = verifyCalls();
        await h.advance(15000 + 30000 + 60000 + 120000 + 1000);
        expect(verifyCalls() - before).toBe(4);
        expect(h.warns).toContain('Smart charging state could not be confirmed after all retries');
        expect(h.logs.some((l) => /^Smart charging confirmed/.test(l))).toBe(false);
    });
});

describe('a confirmed boosting=false that goes stale', () => {
    test('is set back to unknown with a log line (not a warning), and charging_now stays off', async () => {
        h.replies.devices = () => {
            const d = pollDevice();
            d.smartStatus = { isSuspended: false, currentState: 'SMART_CONTROL_IN_PROGRESS' };
            return { data: { devices: [d] } };
        };
        await h.start();
        expect(h.pollSends().pop().payload.boosting).toBe(false);
        // No ticks: nothing confirms the state for over 2 charging-poll intervals (10 min).
        await h.advance(11 * 60 * 1000);
        expect(h.logs.some((l) => /^Boost state not confirmed by Octopus for .+: treating it as unknown$/.test(l))).toBe(true);
        expect(h.warns.some((w) => /Boost state not confirmed/.test(w))).toBe(false);
        expect(h.published('charging_now').pop()).toBe('OFF');
    });
});
