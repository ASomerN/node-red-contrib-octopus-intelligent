// __tests__/mqtt-retained-commands.test.js
'use strict';
/**
 * 1.7 edge sweep #1: a retained message on a command topic is replayed by the broker on every
 * restart, redeploy and reconnect (MQTT sets the retain flag on that replay). A retained ON on
 * set_boost would boost again each time. Action commands (they write to Octopus or force a
 * poll) ignore retained messages and warn once per topic. A live publish reaches the node with
 * the retain flag off and still works. The Node-RED broker calls subscribe callbacks with
 * (topic, payload, packet). Kraken is mocked.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, ACCOUNT, DEVICE_ID } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');

const topic = (t) => `nodered_octopus/${ACCOUNT}/${t}`;
const RETAINED = { retain: true, topic: '', payload: Buffer.from('') };
const LIVE = { retain: false };

let h;

const callsMatching = (re) => graphqlPost.mock.calls.filter(([body]) => re.test(body.query)).length;
const devicesQueries = () => callsMatching(/SmartFlexDevicePreferences/);
const handler = (t) => h.broker.subscribe.mock.calls.find((c) => c[0] === topic(t))[2];
const send = (t, value, packet) => handler(t)(topic(t), Buffer.from(value), packet);
const retainedWarns = () => h.warns.filter((w) => /Ignored a retained message/.test(w));

async function settle() {
    for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(1000);
        await h.onTick();
    }
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    h = createHarness();
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/updateBoostCharge/.test(body.query)) {
            return { data: { data: { updateBoostCharge: { id: DEVICE_ID, status: { currentState: 'BOOSTING' } } } }, status: 200 };
        }
        if (/updateIsChargingDurationCapped/.test(body.query)) {
            return { data: { data: { updateIsChargingDurationCapped: { __typename: 'SmartFlexDevicePreferences' } } }, status: 200 };
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('retained messages on action command topics are ignored', () => {
    test.each([
        ['set_boost', 'ON', /updateBoostCharge/],
        ['set_boost', 'OFF', /updateBoostCharge/],
        ['set_smart_charging', 'OFF', /updateDeviceSmartControl/],
        ['set_charge_cap', 'ON', /updateIsChargingDurationCapped/],
        ['submit_changes', 'SUBMIT', /setDevicePreferences/],
    ])('a retained %s %s sends nothing to Octopus', async (t, value, mutation) => {
        await h.start();
        send(t, value, RETAINED);
        await settle();
        expect(callsMatching(mutation)).toBe(0);
        expect(retainedWarns()).toEqual([
            `Ignored a retained message on ${topic(t)}. Commands are never taken from retained messages. Clear it by publishing an empty retained message to that topic.`,
        ]);
    });

    test('a retained refresh does not force a poll', async () => {
        await h.start();
        const polls = devicesQueries();
        send('refresh', 'REFRESH', RETAINED);
        await settle();
        expect(devicesQueries()).toBe(polls);
        expect(retainedWarns()).toHaveLength(1);
    });

    test('one warning per topic, however often the message is replayed (reconnects)', async () => {
        await h.start();
        for (let i = 0; i < 5; i++) send('set_boost', 'ON', RETAINED);
        for (let i = 0; i < 3; i++) send('set_smart_charging', 'OFF', RETAINED);
        await settle();
        expect(callsMatching(/updateBoostCharge|updateDeviceSmartControl/)).toBe(0);
        expect(retainedWarns()).toHaveLength(2);
    });

    test('a live (not retained) command on the same topic still works', async () => {
        await h.start();
        send('set_boost', 'ON', RETAINED);
        await settle();
        send('set_boost', 'ON', LIVE);
        await settle();
        expect(callsMatching(/updateBoostCharge/)).toBe(1);
    });

    test('a callback with no packet (older brokers, tests) is treated as live', async () => {
        await h.start();
        handler('set_charge_cap')(topic('set_charge_cap'), Buffer.from('ON'));
        await settle();
        expect(callsMatching(/updateIsChargingDurationCapped/)).toBe(1);
        expect(retainedWarns()).toEqual([]);
    });

    test('set_limit and set_time only change the pending values, so a retained one still applies', async () => {
        await h.start();
        send('set_limit', '60', RETAINED);
        send('set_time', '06:30', RETAINED);
        await settle();
        expect(retainedWarns()).toEqual([]);
        expect(callsMatching(/setDevicePreferences/)).toBe(0);
        const state = h.broker.client.publish.mock.calls
            .filter((c) => c[0] === `nodered_octopus/${ACCOUNT}/status`)
            .map((c) => JSON.parse(c[1]))
            .pop();
        expect(state.pending_limit).toBe(60);
        expect(state.pending_time).toBe('06:30');
    });
});
