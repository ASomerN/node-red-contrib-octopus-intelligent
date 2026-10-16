// __tests__/category-error-text.test.js
'use strict';
/**
 * 1.6.2: every <category>_error in msg.payload (and the MQTT state JSON) is short readable
 * text, "CODE: message" or the plain message, never the raw Kraken errors JSON, and always
 * under 255 characters. Home Assistant rejects a sensor state longer than 255 characters
 * (a 268-character error was seen rejected in the HA core log).
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, slot } = require('./helpers/real-node');

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
    h = createHarness();
    h.plan = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:30:00Z')];
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const errorFields = (p) => Object.keys(p).filter((k) => k.endsWith('_error') && p[k] != null);

test('a long Kraken error on a category poll is short in msg.payload and the MQTT state', async () => {
    h.replies.getSavingSessions = () => ({
        data: null,
        errors: [{
            message: `Unable to fetch saving sessions. ${'detail '.repeat(300)}`,
            path: ['savingSessions'],
            extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-9999', errorDescription: 'x'.repeat(500) },
        }],
    });
    await h.start();

    const p = h.lastPayload();
    expect(p.saving_sessions_error.startsWith('KT-CT-9999: Unable to fetch saving sessions')).toBe(true);
    expect(p.saving_sessions_error.length).toBeLessThan(255);
    expect(p.saving_sessions_error).not.toMatch(/errorCode|"message"/);
    expect(h.statePublishes().pop().saving_sessions_error).toBe(p.saving_sessions_error);
});

test('every category error in the payload is short text, never raw JSON', async () => {
    // Categories the harness does not answer get { errors: [{ message: 'stubbed' }] }.
    await h.start();

    const p = h.lastPayload();
    const fields = errorFields(p);
    expect(fields.length).toBeGreaterThan(0);
    for (const k of fields) {
        expect(typeof p[k]).toBe('string');
        expect(p[k].length).toBeLessThan(255);
        expect(p[k].startsWith('[')).toBe(false);
    }
    expect(p.account_error).toBe('stubbed');
});

test('a transport failure on a category poll is capped under 255 characters', async () => {
    h.replies.getSavingSessions = () => { throw new Error(`socket hang up ${'x'.repeat(2000)}`); };
    await h.start();

    const p = h.lastPayload();
    expect(p.saving_sessions_error.startsWith('socket hang up')).toBe(true);
    expect(p.saving_sessions_error.length).toBeLessThan(255);
});

test('a Kraken auth error is short on every category, never raw JSON', async () => {
    const { graphqlPost } = require('../lib/graphql');
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/obtainKrakenToken/.test(body.query)) {
            return {
                status: 200,
                data: {
                    data: { obtainKrakenToken: null },
                    errors: [{
                        message: `Invalid API key. ${'x'.repeat(2000)}`,
                        extensions: { errorType: 'AUTHORIZATION', errorCode: 'KT-CT-1139' },
                    }],
                },
            };
        }
        return harnessReply(body, ...rest);
    });
    await h.start();

    const p = h.lastPayload();
    expect(p.account_error.startsWith('Auth failed: Auth response missing token: KT-CT-1139: Invalid API key')).toBe(true);
    for (const k of errorFields(p)) {
        expect(p[k].length).toBeLessThan(255);
        expect(p[k]).not.toMatch(/errorCode|"message"/);
    }
});
