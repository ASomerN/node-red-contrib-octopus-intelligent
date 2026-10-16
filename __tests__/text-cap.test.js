// __tests__/text-cap.test.js
'use strict';
/**
 * Fuzz finding (fuzz-parsers.test.js on the 1.7 fuzz branch), ported for 1.6.2: text the API
 * sends was passed through uncut into fields that are Home Assistant entity states (tariff
 * codes, the charge source, times that could not be read). HA rejects a state of 255+
 * characters and the entity stops updating. Those fields are now cut to 254.
 */
const electricity = require('../lib/categories/electricity');
const gas = require('../lib/categories/gas');
const homeMini = require('../lib/categories/home-mini');
const octoplus = require('../lib/categories/octoplus');
const savingSessions = require('../lib/categories/saving-sessions');
const freeElectricity = require('../lib/categories/free-electricity');
const applicableRates = require('../lib/categories/applicable-rates');
const intelligent = require('../lib/categories/intelligent');
const { capText, MAX_STATE_LENGTH } = require('../lib/values');

const LONG = `INTELLI-VAR-22-10-14-${'X'.repeat(400)}`;
const FUTURE = new Date(Date.now() + 3600000).toISOString();

// Top-level text fields of 255 characters or more, as "field(length)".
const tooLong = (out) => Object.keys(out).filter((k) => typeof out[k] === 'string' && out[k].length > MAX_STATE_LENGTH)
    .map((k) => `${k}(${out[k].length})`);

test('capText cuts at 254 with "..." and leaves short text and other values alone', () => {
    expect(MAX_STATE_LENGTH).toBe(254);
    expect(capText(LONG)).toHaveLength(254);
    expect(capText(LONG).endsWith('...')).toBe(true);
    expect(capText('E-1R')).toBe('E-1R');
    expect(capText(12)).toBe(12);
    expect(capText(null)).toBeNull();
});

test.each([
    ['electricity rates', () => electricity.parseRatesResponse({
        account: { electricityAgreements: [{ validFrom: LONG, validTo: LONG, tariff: { productCode: LONG } }, { validFrom: LONG, tariff: { productCode: `${LONG}-OUTGOING` } }] },
    })],
    ['electricity consumption', () => electricity.parseConsumptionResponse({
        account: { properties: [{ electricityMeterPoints: [{ mpan: 'M1', meters: [{ consumption: { edges: [{ node: { startAt: LONG, endAt: LONG, value: 1 } }] } }] }] }] },
    }, 'M1', null)],
    ['gas rates', () => gas.parseRatesResponse({ account: { gasAgreements: [{ validFrom: LONG, validTo: LONG, tariff: { productCode: LONG } }] } })],
    ['gas consumption', () => gas.parseConsumptionResponse({
        account: { properties: [{ gasMeterPoints: [{ meters: [{ consumption: { edges: [{ node: { startAt: LONG, endAt: LONG, value: 1 } }] } }] }] }] },
    })],
    ['home mini', () => homeMini.parseResponse({ smartMeterTelemetry: [{ readAt: LONG, demand: 1, consumptionDelta: 1 }] })],
    ['octoplus', () => octoplus.parseResponse({ octoplusAccountInfo: { enrollmentStatus: LONG, isLoyaltyPointsUser: true } })],
    ['saving sessions', () => savingSessions.parseResponse({ savingSessions: { events: [{ id: 1, code: LONG, startAt: LONG, endAt: FUTURE }], account: {} } })],
    ['free electricity', () => freeElectricity.parseResponse({ customerFlexibilityCampaignEvents: { edges: [{ node: { code: LONG, startAt: LONG, endAt: FUTURE } }] } })],
    ['applicable rates', () => applicableRates.parseResponse({
        applicableRates: {
            edges: [
                { node: { validFrom: new Date(Date.now() - 7200000).toISOString(), validTo: LONG, value: 1 } }, // prev_to
                { node: { validFrom: new Date(Date.now() - 60000).toISOString(), validTo: FUTURE, value: 2 } },
                { node: { validFrom: FUTURE, validTo: FUTURE, value: 3 } },
            ],
        },
    })],
    ['intelligent', () => intelligent.parseResponse({
        devices: [],
        flexPlannedDispatches: [{ start: LONG, end: FUTURE, type: LONG, energyAddedKwh: '1' }],
    }, { tz: 'Europe/London', serverTz: 'UTC' })],
])('%s: every text field that becomes an HA state stays under 255 characters', (label, parse) => {
    const out = parse();
    expect(tooLong(out)).toEqual([]);
});

test('the charge source and a tariff code keep their start', () => {
    const out = intelligent.parseResponse({ devices: [], flexPlannedDispatches: [{ start: FUTURE, end: FUTURE, type: LONG }] }, { tz: 'UTC', serverTz: 'UTC' });
    expect(out.next_source.startsWith('intelli-var-22-10-14-x')).toBe(true);
    expect(out.next_source).toHaveLength(254);
    const rates = gas.parseRatesResponse({ account: { gasAgreements: [{ tariff: { productCode: LONG } }] } });
    expect(rates.gas_tariff_code.startsWith('INTELLI-VAR-22-10-14-')).toBe(true);
});
