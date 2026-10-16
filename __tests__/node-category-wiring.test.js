// __tests__/node-category-wiring.test.js
'use strict';
/**
 * Coverage sweep 2 (v1.7): the electricity, gas, Home Mini and Wheel of Fortune categories
 * as the real node wires them up in initCategories: the query each poll sends, the
 * variables (timezone override, MPANs, backend host) and the parsed fields that reach
 * msg.payload. Also the editor switches (electricityEnabled / gasEnabled / enableHomeMini /
 * enableWheelOfFortune) and the per-category intervals. Kraken is mocked: HTTP 200 bodies
 * { data, errors }, Float scalars as strings (as Kraken sometimes sends them).
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, DISCOVERED } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

const IMPORT_MPAN = '1900000000001';
const EXPORT_MPAN = '1900000000002';

const ELECTRICITY_RATES = {
    data: {
        account: {
            electricityAgreements: [
                {
                    validFrom: '2026-01-01T00:00:00+00:00', validTo: null,
                    tariff: { productCode: 'INTELLI-VAR-24-10-29', standingCharge: '53.4600', unitRate: '27.0300' },
                },
                {
                    validFrom: '2026-02-01T00:00:00+00:00', validTo: '2027-02-01T00:00:00+00:00',
                    tariff: { productCode: 'OUTGOING-VAR-24-10-26', standingCharge: '0.0000', unitRate: '15.0000' },
                },
            ],
        },
    },
};

const consumptionEdge = (startAt, endAt, value) => ({ edges: [{ node: { startAt, endAt, value } }] });

// The export meter point first: position is not reliable, the MPAN decides (seen live 2026-05-11).
const ELECTRICITY_CONSUMPTION = {
    data: {
        account: {
            properties: [{
                electricityMeterPoints: [
                    { mpan: EXPORT_MPAN, meters: [{ consumption: consumptionEdge('2026-10-06T00:00:00+01:00', '2026-10-07T00:00:00+01:00', '4.2000') }] },
                    { mpan: IMPORT_MPAN, meters: [{ consumption: consumptionEdge('2026-10-06T00:00:00+01:00', '2026-10-07T00:00:00+01:00', '12.5000') }] },
                ],
            }],
        },
    },
};

const GAS_RATES = {
    data: {
        account: {
            gasAgreements: [{
                validFrom: '2026-01-01T00:00:00+00:00', validTo: null,
                tariff: { productCode: 'VAR-22-11-01', standingCharge: '31.4300', unitRate: '6.8900' },
            }],
        },
    },
};

const GAS_CONSUMPTION = {
    data: {
        account: {
            properties: [{
                gasMeterPoints: [{ meters: [{ consumption: consumptionEdge('2026-10-06T00:00:00+01:00', '2026-10-07T00:00:00+01:00', '22.7500') }] }],
            }],
        },
    },
};

const WHEEL = { data: { electricity: { spinsAllowed: 2 }, gas: { spinsAllowed: 1 } } };

// demand in W (negative = exporting), consumptionDelta in Wh per half hour.
const TELEMETRY = {
    data: {
        smartMeterTelemetry: [
            { readAt: '2026-10-07T09:30:00+00:00', demand: '900.0', consumptionDelta: '100.0' },
            { readAt: '2026-10-07T10:00:00+00:00', demand: '1500.0', consumptionDelta: '250.0' },
        ],
    },
};

const REPLIES = [
    [/query getElectricityRates\b/, ELECTRICITY_RATES],
    [/query getElectricityConsumption\b/, ELECTRICITY_CONSUMPTION],
    [/query getGasRates\b/, GAS_RATES],
    [/query getGasConsumption\b/, GAS_CONSUMPTION],
    [/query getWheelOfFortuneSpinsAllowed\b/, WHEEL],
    [/query getSmartMeterTelemetry\b/, TELEMETRY],
];

let h;

const callsTo = (re) => graphqlPost.mock.calls.filter(([body]) => re.test(body.query));
const lastPoll = () => h.pollSends().pop().payload;

async function pollAt(iso) {
    jest.setSystemTime(new Date(iso));
    await h.onTick();
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    h = createHarness();
    discoverProducts.mockResolvedValue({
        ...DISCOVERED,
        hasElectricity: true, hasGas: true,
        electricityMpan: IMPORT_MPAN, electricityExportMpan: EXPORT_MPAN, electricitySerial: '21L0000001',
        gasMprn: '7000000001', gasSerial: 'G4A00000001',
        smartMeterDeviceId: 'mini-1',
    });
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        for (const [re, reply] of REPLIES) {
            if (re.test(body.query)) return { data: reply, status: 200 };
        }
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('categories wired by initCategories', () => {
    test('electricity rates and consumption reach the payload as numbers, import and export split by MPAN', async () => {
        await h.start();
        const p = lastPoll();
        expect(p.electricity_unit_rate).toBe(27.03);
        expect(p.electricity_standing_charge).toBe(53.46);
        expect(p.electricity_tariff_code).toBe('INTELLI-VAR-24-10-29');
        expect(p.electricity_export_unit_rate).toBe(15);
        expect(p.electricity_export_tariff_code).toBe('OUTGOING-VAR-24-10-26');
        expect(p.electricity_rates_error).toBeNull();
        expect(p.electricity_consumption_kwh).toBe(12.5);
        expect(p.electricity_export_consumption_kwh).toBe(4.2);
        expect(p.electricity_consumption_error).toBeNull();
    });

    test('gas rates and consumption reach the payload as numbers', async () => {
        await h.start();
        const p = lastPoll();
        expect(p.gas_unit_rate).toBe(6.89);
        expect(p.gas_standing_charge).toBe(31.43);
        expect(p.gas_tariff_code).toBe('VAR-22-11-01');
        expect(p.gas_consumption_kwh).toBe(22.75);
        expect(p.gas_consumption_from).toBe('2026-10-06T00:00:00+01:00');
        expect(p.gas_rates_error).toBeNull();
        expect(p.gas_consumption_error).toBeNull();
    });

    test('the consumption queries use the timezone override, and UTC without one', async () => {
        await h.start({ timezoneOverride: 'Europe/London' });
        expect(callsTo(/query getElectricityConsumption\b/)[0][0].variables.timezone).toBe('Europe/London');
        expect(callsTo(/query getGasConsumption\b/)[0][0].variables.timezone).toBe('Europe/London');
        h.close();

        graphqlPost.mockClear();
        await h.start();
        expect(callsTo(/query getElectricityConsumption\b/)[0][0].variables.timezone).toBe('UTC');
        expect(callsTo(/query getGasConsumption\b/)[0][0].variables.timezone).toBe('UTC');
    });

    test('Home Mini and Wheel of Fortune are off unless ticked in the editor', async () => {
        await h.start();
        expect(callsTo(/query getSmartMeterTelemetry\b/)).toHaveLength(0);
        expect(callsTo(/query getWheelOfFortuneSpinsAllowed\b/)).toHaveLength(0);
    });

    test('Home Mini, when ticked, queries the smart meter device and converts W / Wh to kW / kWh', async () => {
        await h.start({ enableHomeMini: true });
        const call = callsTo(/query getSmartMeterTelemetry\b/)[0];
        expect(call[0].variables.deviceId).toBe('mini-1');
        const p = lastPoll();
        expect(p.mini_demand_kw).toBe(1.5);
        expect(p.mini_consumption_delta_kwh).toBe(0.25);
        expect(p.mini_read_at).toBe('2026-10-07T10:00:00+00:00');
        expect(p.home_mini_error).toBeNull();
    });

    test('Wheel of Fortune, when ticked, goes to the backend host and reports the spins', async () => {
        await h.start({ enableWheelOfFortune: true });
        const call = callsTo(/query getWheelOfFortuneSpinsAllowed\b/)[0];
        expect(call[2]).toBe('api.backend.octopus.energy');
        const p = lastPoll();
        expect(p.wheel_of_fortune_electricity_spins).toBe(2);
        expect(p.wheel_of_fortune_gas_spins).toBe(1);
        expect(p.wheel_of_fortune_error).toBeNull();
    });

    test('electricityEnabled / gasEnabled false: no tariff or consumption queries for that fuel', async () => {
        await h.start({ electricityEnabled: false, gasEnabled: false });
        expect(callsTo(/query getElectricityRates\b/)).toHaveLength(0);
        expect(callsTo(/query getElectricityConsumption\b/)).toHaveLength(0);
        expect(callsTo(/query getGasRates\b/)).toHaveLength(0);
        expect(callsTo(/query getGasConsumption\b/)).toHaveLength(0);
        // The charging poll still runs.
        expect(callsTo(/query getDispatches\b/).length).toBeGreaterThan(0);
    });

    test('a Kraken error on the gas rates poll lands in gas_rates_error, short, and the rest still updates', async () => {
        REPLIES[2] = [/query getGasRates\b/, {
            data: null,
            errors: [{ message: 'Unable to find gas agreements.', path: ['account', 'gasAgreements'], extensions: { errorCode: 'KT-CT-4910' } }],
        }];
        try {
            await h.start();
            const p = lastPoll();
            expect(p.gas_rates_error).toBe('KT-CT-4910: Unable to find gas agreements');
            expect(p.gas_consumption_kwh).toBe(22.75);
            expect(p.gas_consumption_error).toBeNull();
        } finally {
            REPLIES[2] = [/query getGasRates\b/, GAS_RATES];
        }
    });
});

describe('per-category intervals from the editor', () => {
    test('gas rates every 120 min is not polled again at the next hour; gas consumption (60 min) is', async () => {
        await h.start({ gasRatesInterval: 120 });
        expect(callsTo(/query getGasRates\b/)).toHaveLength(1);
        expect(callsTo(/query getGasConsumption\b/)).toHaveLength(1);

        await pollAt('2026-10-07T11:00:05Z');
        expect(callsTo(/query getGasRates\b/)).toHaveLength(1);
        expect(callsTo(/query getGasConsumption\b/)).toHaveLength(2);

        await pollAt('2026-10-07T12:00:05Z');
        expect(callsTo(/query getGasRates\b/)).toHaveLength(2);
    });

    test('electricity consumption every 30 min polls twice an hour, electricity rates (60 min default) once', async () => {
        await h.start({ electricityConsumptionInterval: 30 });
        await pollAt('2026-10-07T10:30:05Z');
        expect(callsTo(/query getElectricityConsumption\b/)).toHaveLength(2);
        expect(callsTo(/query getElectricityRates\b/)).toHaveLength(1);
    });

    test('Home Mini interval 5 min: not polled again at +1 min, polled again at +5 min', async () => {
        await h.start({ enableHomeMini: true, homeMiniInterval: 5 });
        await pollAt('2026-10-07T10:01:05Z');
        expect(callsTo(/query getSmartMeterTelemetry\b/)).toHaveLength(1);
        await pollAt('2026-10-07T10:05:05Z');
        expect(callsTo(/query getSmartMeterTelemetry\b/)).toHaveLength(2);
    });
});
