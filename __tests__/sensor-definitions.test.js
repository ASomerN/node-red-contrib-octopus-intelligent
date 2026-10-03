// __tests__/sensor-definitions.test.js
'use strict';
const { sensors, errorSensors } = require('../lib/sensor-definitions');

describe('sensor definitions', () => {
    // entity_category: 'config' means "user-configurable setting" in HA. Every
    // entry in `sensors` is a read-only value reported from the Kraken API, so
    // none of them should ever carry it — writable command entities (timezone
    // select, smart-charging switch) are defined separately in octopus-intelligent.js,
    // not in this array. Regression coverage for the mistake fixed in v1.3.0
    // (tariff codes), then again for Octoplus binary sensors, then again for the
    // v1.5.0 rate-band sensors (day/night/EV peak/off-peak), fixed in v1.6.1.
    test('no read-only sensor carries entity_category: config', () => {
        const offenders = sensors.filter(s => s.category === 'config').map(s => s.id);
        expect(offenders).toEqual([]);
    });

    test('every sensor has a unique id', () => {
        const ids = sensors.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every error sensor has a unique id', () => {
        const ids = errorSensors.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
