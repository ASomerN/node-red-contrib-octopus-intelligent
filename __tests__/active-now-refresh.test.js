// __tests__/active-now-refresh.test.js
'use strict';
/**
 * Code review 2026-10-06 F12: the "active now" fields (saving session window/active, free
 * electricity active, current/previous/next applicable rate) were only worked out when their
 * category was polled (hourly or every 30 min), so they could be wrong for most of an
 * interval: a saving session starting at 17:30 showed as inactive until the 18:00 poll.
 * They are now recomputed from the stored data on the 10 s reconciliation tick, with no API
 * calls, and published only when a value changes.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createHarness, DISCOVERED } = require('./helpers/real-node');
const activeNow = require('../lib/active-now');

const SESSION = { startAt: '2026-09-30T17:30:00+00:00', endAt: '2026-09-30T18:30:00+00:00' };
const rate = (from, to, value) => ({ node: { validFrom: from, validTo: to, value } });

let h;

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T17:00:00Z'));
    h = createHarness();
    discoverProducts.mockResolvedValue({
        ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null,
        hasElectricity: true, electricityMpan: '1900000000001', electricitySerial: '21L0000001',
    });
    h.replies.getSavingSessions = () => ({
        data: {
            savingSessions: {
                events: [{ id: 101, code: 'EVENT-101', rewardPerKwhInOctoPoints: 800, ...SESSION }],
                account: { hasJoinedCampaign: true, joinedEvents: [{ eventId: 101, ...SESSION, rewardGivenInOctoPoints: null }] },
            },
        },
    });
    h.replies.getFreeElectricity = () => ({
        data: { customerFlexibilityCampaignEvents: { edges: [{ node: { code: 'FREE-1', startAt: '2026-09-30T17:30:00+00:00', endAt: '2026-09-30T18:00:00+00:00' } }] } },
    });
    h.replies.getApplicableRates = () => ({
        data: {
            applicableRates: {
                edges: [
                    rate('2026-09-30T17:00:00Z', '2026-09-30T17:30:00Z', '20.5'),
                    rate('2026-09-30T17:30:00Z', '2026-09-30T18:00:00Z', '30.1'),
                    rate('2026-09-30T18:00:00Z', '2026-09-30T18:30:00Z', '10.0'),
                ],
            },
        },
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

const advanceTo = (iso) => h.advance(Date.parse(iso) - Date.now());
const changeSends = () => h.sends.filter((m) => m.debug && m.debug.trigger === 'active_fields_change');

describe('on the real node', () => {
    test('a saving session, free electricity and the Agile rate switch on at 17:30 without a poll', async () => {
        await h.start();
        let p = h.lastPayload();
        expect(p.saving_session_active).toBe(false);
        expect(p.free_electricity_active).toBe(false);
        expect(p.applicable_rates_current_pence).toBe(20.5);
        const calls = graphqlPost.mock.calls.length;

        await advanceTo('2026-09-30T17:29:55Z');
        expect(changeSends()).toEqual([]); // nothing changed yet: nothing sent

        await advanceTo('2026-09-30T17:30:15Z');
        expect(changeSends()).toHaveLength(1);
        p = h.lastPayload();
        expect(p.saving_session_window_active).toBe(true);
        expect(p.saving_session_active).toBe(true);
        expect(p.free_electricity_active).toBe(true);
        expect(p.applicable_rates_current_pence).toBe(30.1);
        expect(p.applicable_rates_current_gbp).toBe(0.301);
        expect(p.applicable_rates_prev_pence).toBe(20.5);
        expect(p.applicable_rates_prev_to).toBe('2026-09-30T17:30:00Z');
        expect(p.applicable_rates_next_pence).toBe(10);
        expect(p.applicable_rates_next_from).toBe('2026-09-30T18:00:00Z');
        const published = h.statePublishes().pop();
        expect(published.saving_session_active).toBe(true);
        expect(published.applicable_rates_current_pence).toBe(30.1);
        expect(graphqlPost.mock.calls.length).toBe(calls); // no API calls

        await advanceTo('2026-09-30T17:59:55Z');
        expect(changeSends()).toHaveLength(1); // unchanged values are not sent again

        await advanceTo('2026-09-30T18:00:15Z');
        expect(changeSends()).toHaveLength(2);
        p = h.lastPayload();
        expect(p.free_electricity_active).toBe(false);
        expect(p.saving_session_active).toBe(true);
        expect(p.applicable_rates_current_pence).toBe(10);
        expect(p.applicable_rates_next_pence).toBeNull();
    });
});

describe('changedActiveFields', () => {
    const slots = [
        { valid_from: '2026-09-30T17:00:00Z', valid_to: '2026-09-30T17:30:00Z', value_pence_per_kwh: 20.5 },
        { valid_from: '2026-09-30T17:30:00Z', valid_to: '2026-09-30T18:00:00Z', value_pence_per_kwh: 30.1 },
    ];

    test('returns null when nothing is stored', () => {
        expect(activeNow.changedActiveFields({ saving_session_start: null, free_electricity_start: null, applicable_rates: [], electricity_export_rate: [] }, Date.parse('2026-09-30T17:40:00Z'))).toBeNull();
    });

    test('only returns the fields that changed, export rates included', () => {
        const state = {
            saving_session_start: SESSION.startAt, saving_session_end: SESSION.endAt, saving_session_joined: false,
            saving_session_window_active: false, saving_session_active: false,
            electricity_export_rate: slots, electricity_export_rate_current_pence: 30.1, electricity_export_rate_current_gbp: 0.301,
            electricity_export_rate_prev_pence: 20.5, electricity_export_rate_prev_gbp: 0.205, electricity_export_rate_prev_to: '2026-09-30T17:30:00Z',
            electricity_export_rate_next_pence: null, electricity_export_rate_next_gbp: null, electricity_export_rate_next_from: null,
        };
        expect(activeNow.changedActiveFields(state, Date.parse('2026-09-30T17:40:00Z'))).toEqual({ saving_session_window_active: true });
    });
});
