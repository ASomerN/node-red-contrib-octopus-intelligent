// __tests__/numeric-guard.test.js
'use strict';
/**
 * Fuzz findings (fuzz-parsers.test.js on the 1.7 fuzz branch), ported for 1.6.2: parseFloat on
 * a value that is not a number gave NaN, and on "Infinity" (or 1e400 in the JSON) Infinity.
 * Those reached msg.payload and showed as "unknown" in Home Assistant with no error. Every
 * numeric field now goes through lib/values.js toNumber: anything not finite is null. A
 * consumption reading whose value is null (realistic: Octopus is still collecting it) is
 * skipped instead of giving NaN.
 */
const { toNumber } = require('../lib/values');
const account = require('../lib/categories/account');
const applicableRates = require('../lib/categories/applicable-rates');
const completedDispatches = require('../lib/categories/completed-dispatches');
const electricity = require('../lib/categories/electricity');
const flexPlanned = require('../lib/categories/flex-planned-dispatches');
const gas = require('../lib/categories/gas');
const homeMini = require('../lib/categories/home-mini');
const intelligent = require('../lib/categories/intelligent');
const wheel = require('../lib/categories/wheel-of-fortune');

// Values a numeric leaf can hold in a broken or changed answer. JSON.parse('1e400') is Infinity.
const HOSTILE = ['Infinity', '-Infinity', 'NaN', 'abc', '', ' ', Infinity, -Infinity, NaN, JSON.parse('1e400'), true, [], {}, null];

// Every number anywhere in `value` (depth-limited) that is not finite, as "path=value".
function nonFinite(value, path = '', depth = 4, out = []) {
    if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${path}=${value}`);
    else if (value && typeof value === 'object' && depth > 0) {
        for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, depth - 1, out);
    }
    return out;
}

describe('toNumber', () => {
    test('finite numbers and numeric strings pass', () => {
        expect(toNumber(12.5)).toBe(12.5);
        expect(toNumber(0)).toBe(0);
        expect(toNumber(-3)).toBe(-3);
        expect(toNumber('12.5')).toBe(12.5);
        expect(toNumber(' 7 ')).toBe(7);
    });
    test.each(HOSTILE.map((v) => [v]))('%p is null', (v) => {
        expect(toNumber(v)).toBeNull();
    });
});

function withoutActiveSlots({ _activeSlots, ...rest }) {
    return rest;
}

describe('no parser publishes NaN or Infinity', () => {
    const NOW = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const parsers = {
        account: (v) => account.parseResponse({ account: { balance: v } }),
        electricity_rates: (v) => electricity.parseRatesResponse({
            account: {
                electricityAgreements: [
                    { validFrom: iso(NOW), tariff: { productCode: 'E-1R', standingCharge: v, unitRate: v, dayRate: v, nightRate: v, evDevicePeakRate: v, evDeviceOffPeakRate: v } },
                    { validFrom: iso(NOW), tariff: { productCode: 'AGILE-OUTGOING', standingCharge: v, unitRate: v } },
                ],
            },
        }),
        electricity_consumption: (v) => electricity.parseConsumptionResponse({
            account: {
                properties: [{
                    electricityMeterPoints: ['M1', 'M2'].map((mpan) => ({ mpan, meters: [{ consumption: { edges: [{ node: { startAt: iso(NOW), endAt: iso(NOW), value: v } }] } }] })),
                }],
            },
        }, 'M1', 'M2'),
        gas_rates: (v) => gas.parseRatesResponse({ account: { gasAgreements: [{ validFrom: iso(NOW), tariff: { productCode: 'G-1R', standingCharge: v, unitRate: v } }] } }),
        gas_consumption: (v) => gas.parseConsumptionResponse({
            account: { properties: [{ gasMeterPoints: [{ meters: [{ consumption: { edges: [{ node: { startAt: iso(NOW), endAt: iso(NOW), value: v } }] } }] }] }] },
        }),
        home_mini: (v) => homeMini.parseResponse({ smartMeterTelemetry: [{ readAt: iso(NOW), demand: v, consumptionDelta: v }] }),
        applicable_rates: (v) => applicableRates.parseResponse({
            applicableRates: {
                edges: [-1, 0, 1].map((i) => ({ node: { validFrom: iso(NOW + i * 1800000), validTo: iso(NOW + (i + 1) * 1800000), value: v } })),
            },
        }),
        completed_dispatches: (v) => completedDispatches.parseResponse({ completedDispatches: [{ start: iso(NOW), end: iso(NOW), delta: v, meta: null }] }),
        flex_planned_dispatches: (v) => flexPlanned.parseResponse({ flexPlannedDispatches: [{ start: iso(NOW), end: iso(NOW + 1800000), type: 'SMART', energyAddedKwh: v }] }),
        // _activeSlots is internal (the node strips it): it holds the raw dispatches.
        intelligent: (v) => withoutActiveSlots(intelligent.parseResponse({
            devices: [{ id: 'd', deviceType: 'ELECTRIC_VEHICLES', preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '04:00', max: v }] } }],
            flexPlannedDispatches: [{ start: iso(NOW + 60000), end: iso(NOW + 1800000), type: 'SMART', energyAddedKwh: v }],
        }, { tz: 'UTC', serverTz: 'UTC' })),
        wheel_of_fortune: (v) => wheel.parseResponse({ electricity: { spinsAllowed: v }, gas: { spinsAllowed: v } }),
    };

    for (const [id, parse] of Object.entries(parsers)) {
        test(`${id}: hostile numeric values give null, never NaN or Infinity`, () => {
            const bad = [];
            for (const v of HOSTILE) bad.push(...nonFinite(parse(v)).map((f) => `${JSON.stringify(String(v))}: ${f}`));
            expect(bad).toEqual([]);
        });
    }

    test('string "Infinity" and 1e400 become null in the account balance and the rate stats', () => {
        expect(account.parseResponse({ account: { balance: 'Infinity' } }).account_balance_pence).toBeNull();
        expect(account.parseResponse({ account: { balance: 'Infinity' } }).account_balance_pounds).toBeNull();
        const rates = parsers.applicable_rates(JSON.parse('1e400'));
        expect(rates.applicable_rates_current_pence).toBeNull();
        expect(rates.applicable_rates_max_pence).toBeNull();
        expect(rates.applicable_rates_avg_pence).toBeNull();
    });

    test('finite values that add up past the largest number never give an Infinity average', () => {
        const rates = parsers.applicable_rates(1e308);
        expect(rates.applicable_rates_max_pence).toBe(1e308);
        expect(rates.applicable_rates_avg_pence).toBeNull();
        expect(nonFinite(rates)).toEqual([]);
    });

    test('ordinary values are unchanged', () => {
        expect(account.parseResponse({ account: { balance: '-512' } }).account_balance_pounds).toBe(-5.12);
        expect(parsers.home_mini('1500').mini_demand_kw).toBe(1.5);
        expect(parsers.completed_dispatches('2.5').completed_dispatches[0].delta_kwh).toBe(2.5);
        expect(parsers.flex_planned_dispatches(3).flex_planned_dispatches[0].energy_kwh).toBe(3);
        expect(parsers.intelligent('85').confirmed_limit).toBe(85);
        expect(parsers.intelligent('4.5').total_energy).toBe(4.5);
        expect(parsers.wheel_of_fortune('2').wheel_of_fortune_gas_spins).toBe(2);
    });
});

describe('a consumption reading with no value', () => {
    // Ported from the fuzz FINDING "a null consumption value gives null, not NaN".
    test('gives null, not NaN', () => {
        const node = { startAt: '2026-10-08T00:00:00Z', endAt: '2026-10-09T00:00:00Z', value: null };
        const elec = { account: { properties: [{ electricityMeterPoints: [{ mpan: 'M1', meters: [{ consumption: { edges: [{ node }] } }] }] }] } };
        const gasData = { account: { properties: [{ gasMeterPoints: [{ meters: [{ consumption: { edges: [{ node }] } }] }] }] } };
        expect(electricity.parseConsumptionResponse(elec, 'M1', null).electricity_consumption_kwh).toBeNull();
        expect(gas.parseConsumptionResponse(gasData).gas_consumption_kwh).toBeNull();
    });

    test('is skipped: the latest reading that has a value is used', () => {
        const edges = [
            { node: { startAt: '2026-10-07T00:00:00Z', endAt: '2026-10-08T00:00:00Z', value: '7.25' } },
            { node: { startAt: '2026-10-08T00:00:00Z', endAt: '2026-10-09T00:00:00Z', value: null } },
        ];
        const elec = { account: { properties: [{ electricityMeterPoints: [{ mpan: 'M1', meters: [{ consumption: { edges } }] }] }] } };
        const out = electricity.parseConsumptionResponse(elec, 'M1', null);
        expect(out.electricity_consumption_kwh).toBe(7.25);
        expect(out.electricity_consumption_from).toBe('2026-10-07T00:00:00Z');
        const g = gas.parseConsumptionResponse({ account: { properties: [{ gasMeterPoints: [{ meters: [{ consumption: { edges } }] }] }] } });
        expect(g.gas_consumption_kwh).toBe(7.25);
        expect(g.gas_consumption_to).toBe('2026-10-08T00:00:00Z');
    });
});
