// __tests__/export-rate-error.test.js
'use strict';
/**
 * The Electricity Export Rate Error sensors read `electricity_export_rate_error`, but the
 * export rates poll stored its errors only in `applicable_rates_export_error` (its category
 * id), so the sensors were always empty. Errors now go to both fields: the sensor field and
 * the documented payload field.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { runTick } = require('../lib/poll-tick');
const { createHarness, slot, DISCOVERED } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

describe('runTick errorField', () => {
    const cat = (poll) => ({ id: 'x', errorField: 'y_error', enabled: true, intervalMs: 60000, lastPolled: 0, poll });

    test('a failure is written to the category error and the errorField', async () => {
        const { state } = await runTick({
            categories: [cat(jest.fn().mockRejectedValue(new Error('boom')))],
            state: {}, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.x_error).toBe('boom');
        expect(state.y_error).toBe('boom');
    });

    test('a success clears both', async () => {
        const { state } = await runTick({
            categories: [cat(jest.fn().mockResolvedValue({}))],
            state: { x_error: 'old', y_error: 'old' }, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.x_error).toBeNull();
        expect(state.y_error).toBeNull();
    });

    test('an auth failure is written to both', async () => {
        const { state } = await runTick({
            categories: [cat(jest.fn())],
            state: {}, getToken: async () => { throw new Error('nope'); }, now: () => 1,
        });
        expect(state.x_error).toBe('Auth failed: nope');
        expect(state.y_error).toBe('Auth failed: nope');
    });
});

describe('real node: export rates error', () => {
    let h;
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T01:00:00Z'));
        h = createHarness();
        h.plan = [slot('2026-09-30T01:30:00Z', '2026-09-30T02:30:00Z')];
        discoverProducts.mockResolvedValue({
            ...DISCOVERED, hasElectricity: true, electricityMpan: 'IMP-MPAN', electricityExportMpan: 'EXP-MPAN',
        });
        const harnessReply = graphqlPost.getMockImplementation();
        graphqlPost.mockImplementation(async (body, ...rest) => {
            if (/getApplicableRates/.test(body.query) && body.variables && body.variables.mpxn === 'EXP-MPAN') {
                return { data: { data: null, errors: [{ message: 'Unable to fetch rates.', path: ['applicableRates'], extensions: { errorCode: 'KT-CT-4501' } }] }, status: 200 };
            }
            return harnessReply(body, ...rest);
        });
    });

    afterEach(() => {
        h.close();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('the export rate error reaches the Electricity Export Rate Error sensor field', async () => {
        await h.start();
        const p = h.lastPayload();
        expect(p.electricity_export_rate_error).toBe('KT-CT-4501: Unable to fetch rates');
        expect(p.applicable_rates_export_error).toBe('KT-CT-4501: Unable to fetch rates');
        expect(h.statePublishes().pop().electricity_export_rate_error).toBe('KT-CT-4501: Unable to fetch rates');
    });
});
