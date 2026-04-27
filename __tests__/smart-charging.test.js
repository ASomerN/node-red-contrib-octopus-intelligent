/**
 * Smart Charging Toggle Tests
 */

describe('Smart Charging — payload field', () => {
    // Simulate the node's smart charging state variables
    let smartChargingSuspended;
    let confirmedLimit, confirmedTime, pendingLimit, pendingTime, chargingNow;

    beforeEach(() => {
        smartChargingSuspended = null;
        confirmedLimit = 80;
        confirmedTime = '08:00';
        pendingLimit = 80;
        pendingTime = '08:00';
        chargingNow = false;
    });

    function buildDefaultPayload() {
        return {
            next_start: null,
            total_energy: 0,
            next_kwh: '0',
            next_source: 'unknown',
            confirmed_limit: confirmedLimit,
            confirmed_time: confirmedTime,
            pending_limit: pendingLimit,
            pending_time: pendingTime,
            charging_now: chargingNow,
            smart_charging: smartChargingSuspended === null ? null : !smartChargingSuspended
        };
    }

    it('smart_charging is null when device ID not yet fetched', () => {
        smartChargingSuspended = null;
        const payload = buildDefaultPayload();
        expect(payload.smart_charging).toBeNull();
    });

    it('smart_charging is true when not suspended (active)', () => {
        smartChargingSuspended = false;
        const payload = buildDefaultPayload();
        expect(payload.smart_charging).toBe(true);
    });

    it('smart_charging is false when suspended', () => {
        smartChargingSuspended = true;
        const payload = buildDefaultPayload();
        expect(payload.smart_charging).toBe(false);
    });
});

describe('Smart Charging — input validation', () => {
    const warns = [];
    const node = {
        warn: (msg) => warns.push(msg),
        log: () => {},
        error: () => {},
        status: () => {}
    };

    let krakenflexDeviceId;
    let setSmartChargingCalled;
    let setSmartChargingArg;

    beforeEach(() => {
        krakenflexDeviceId = 'kf-test-device-id';
        setSmartChargingCalled = false;
        setSmartChargingArg = null;
        warns.length = 0;
    });

    function handleSetSmartCharging(val) {
        if (typeof val !== 'boolean') return; // silently ignore
        if (!krakenflexDeviceId) {
            node.warn('Device ID not available — cannot toggle smart charging');
            return;
        }
        setSmartChargingCalled = true;
        setSmartChargingArg = val;
    }

    it('calls toggle with true for set_smart_charging: true', () => {
        handleSetSmartCharging(true);
        expect(setSmartChargingCalled).toBe(true);
        expect(setSmartChargingArg).toBe(true);
    });

    it('calls toggle with false for set_smart_charging: false', () => {
        handleSetSmartCharging(false);
        expect(setSmartChargingCalled).toBe(true);
        expect(setSmartChargingArg).toBe(false);
    });

    it('silently ignores non-boolean value', () => {
        handleSetSmartCharging('ON');
        expect(setSmartChargingCalled).toBe(false);
        expect(warns).toHaveLength(0);
    });

    it('warns and does not call toggle when device ID is null', () => {
        krakenflexDeviceId = null;
        handleSetSmartCharging(true);
        expect(setSmartChargingCalled).toBe(false);
        expect(warns).toContain('Device ID not available — cannot toggle smart charging');
    });
});

describe('Smart Charging — optimistic state logic', () => {
    it('suspended=false means smart_charging=true (active)', () => {
        const suspended = false;
        const smartCharging = suspended === null ? null : !suspended;
        expect(smartCharging).toBe(true);
    });

    it('suspended=true means smart_charging=false (suspended)', () => {
        const suspended = true;
        const smartCharging = suspended === null ? null : !suspended;
        expect(smartCharging).toBe(false);
    });

    it('MQTT state ON when enable=true', () => {
        const enable = true;
        const mqttState = enable ? 'ON' : 'OFF';
        expect(mqttState).toBe('ON');
    });

    it('MQTT state OFF when enable=false', () => {
        const enable = false;
        const mqttState = enable ? 'ON' : 'OFF';
        expect(mqttState).toBe('OFF');
    });

    it('mutation action is UNSUSPEND when enable=true', () => {
        const enable = true;
        const action = enable ? 'UNSUSPEND' : 'SUSPEND';
        expect(action).toBe('UNSUSPEND');
    });

    it('mutation action is SUSPEND when enable=false', () => {
        const enable = false;
        const action = enable ? 'UNSUSPEND' : 'SUSPEND';
        expect(action).toBe('SUSPEND');
    });
});
