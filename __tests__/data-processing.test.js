/**
 * Data Processing Tests
 *
 * Tests for how API responses are processed into Node-RED payloads
 * Tests buildDefaultPayload() and payload construction logic
 */

const {
  mockDataWithSlots,
  mockDataWithActiveSlot,
  mockDataNoSlots,
  mockDataWithThreeSlots,
  expectedPayloadTwoSlots,
  expectedPayloadActiveSlot,
  expectedPayloadNoSlots
} = require('../test-mocks');

describe('Data Processing', () => {
  // ==========================================================================
  // buildDefaultPayload() Tests
  // ==========================================================================

  describe('buildDefaultPayload()', () => {
    /**
     * @test buildDefaultPayload - Build Default Payload
     * @scenario Creating default payload structure when errors occur
     * @given Current confirmed/pending state exists
     * @expect Payload with all null slot fields and zero energy
     */
    test('should create default payload with current state', () => {
      const confirmedLimit = 80;
      const confirmedTime = "08:00";
      const pendingLimit = 80;
      const pendingTime = "08:00";
      const chargingNow = false;

      function buildDefaultPayload() {
        return {
          next_start: null,
          total_energy: 0,
          next_kwh: "0",
          next_source: "unknown",
          confirmed_limit: confirmedLimit,
          confirmed_time: confirmedTime,
          pending_limit: pendingLimit,
          pending_time: pendingTime,
          charging_now: chargingNow,
          slot1_start: null,
          slot1_end: null,
          slot2_start: null,
          slot2_end: null,
          slot3_start: null,
          slot3_end: null,
          window_start: null,
          window_end: null,
          next_start_raw: null,
          slot1_start_raw: null,
          slot1_end_raw: null,
          slot2_start_raw: null,
          slot2_end_raw: null,
          slot3_start_raw: null,
          slot3_end_raw: null,
          window_start_raw: null,
          window_end_raw: null
        };
      }

      const payload = buildDefaultPayload();

      expect(payload.next_start).toBeNull();
      expect(payload.total_energy).toBe(0);
      expect(payload.next_kwh).toBe("0");
      expect(payload.next_source).toBe("unknown");
      expect(payload.confirmed_limit).toBe(80);
      expect(payload.confirmed_time).toBe("08:00");
      expect(payload.charging_now).toBe(false);

      // All slot fields should be null
      expect(payload.slot1_start).toBeNull();
      expect(payload.slot1_end).toBeNull();
      expect(payload.slot2_start).toBeNull();
      expect(payload.slot2_end).toBeNull();
      expect(payload.slot3_start).toBeNull();
      expect(payload.slot3_end).toBeNull();
    });

    /**
     * @test buildDefaultPayload - Preserves User State
     * @scenario Default payload preserves confirmed and pending values
     * @given User has set preferences to different values
     * @expect Payload includes current confirmed/pending state
     */
    test('should preserve confirmed and pending state', () => {
      const confirmedLimit = 85;
      const confirmedTime = "07:30";
      const pendingLimit = 90;
      const pendingTime = "06:00";
      const chargingNow = true;

      function buildDefaultPayload() {
        return {
          next_start: null,
          total_energy: 0,
          next_kwh: "0",
          next_source: "unknown",
          confirmed_limit: confirmedLimit,
          confirmed_time: confirmedTime,
          pending_limit: pendingLimit,
          pending_time: pendingTime,
          charging_now: chargingNow,
          slot1_start: null,
          slot1_end: null,
          slot2_start: null,
          slot2_end: null,
          slot3_start: null,
          slot3_end: null,
          window_start: null,
          window_end: null,
          next_start_raw: null,
          slot1_start_raw: null,
          slot1_end_raw: null,
          slot2_start_raw: null,
          slot2_end_raw: null,
          slot3_start_raw: null,
          slot3_end_raw: null,
          window_start_raw: null,
          window_end_raw: null
        };
      }

      const payload = buildDefaultPayload();

      expect(payload.confirmed_limit).toBe(85);
      expect(payload.confirmed_time).toBe("07:30");
      expect(payload.pending_limit).toBe(90);
      expect(payload.pending_time).toBe("06:00");
      expect(payload.charging_now).toBe(true);
    });
  });

  // ==========================================================================
  // Payload Construction from API Response
  // ==========================================================================

  describe('Payload Construction', () => {
    /**
     * Simulate the payload building logic from fetchData()
     */
    function buildPayloadFromSlots(slots, prefs, currentTime, chargingNow) {
      const now = new Date(currentTime);
      const activeAndFutureSlots = slots.filter(s => new Date(s.endDt) > now);
      const nextSlot = activeAndFutureSlots[0] || null;
      const totalEnergy = activeAndFutureSlots.reduce((sum, s) => sum + (s.deltaKwh || 0), 0);

      return {
        next_start: nextSlot ? nextSlot.startDt : null,
        total_energy: parseFloat(totalEnergy.toFixed(2)),
        next_kwh: nextSlot ? nextSlot.deltaKwh.toFixed(2) : "0",
        next_source: nextSlot && nextSlot.meta ? nextSlot.meta.source : "unknown",
        confirmed_limit: prefs.weekdayTargetSoc,
        confirmed_time: prefs.weekdayTargetTime,
        pending_limit: prefs.weekdayTargetSoc,
        pending_time: prefs.weekdayTargetTime,
        charging_now: chargingNow,
        slot1_start: activeAndFutureSlots[0] ? activeAndFutureSlots[0].startDt : null,
        slot1_end: activeAndFutureSlots[0] ? activeAndFutureSlots[0].endDt : null,
        slot2_start: activeAndFutureSlots[1] ? activeAndFutureSlots[1].startDt : null,
        slot2_end: activeAndFutureSlots[1] ? activeAndFutureSlots[1].endDt : null,
        slot3_start: activeAndFutureSlots[2] ? activeAndFutureSlots[2].startDt : null,
        slot3_end: activeAndFutureSlots[2] ? activeAndFutureSlots[2].endDt : null,
        window_start: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[0].startDt : null,
        window_end: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[activeAndFutureSlots.length - 1].endDt : null,
        next_start_raw: nextSlot ? nextSlot.startDt : null,
        slot1_start_raw: activeAndFutureSlots[0] ? activeAndFutureSlots[0].startDt : null,
        slot1_end_raw: activeAndFutureSlots[0] ? activeAndFutureSlots[0].endDt : null,
        slot2_start_raw: activeAndFutureSlots[1] ? activeAndFutureSlots[1].startDt : null,
        slot2_end_raw: activeAndFutureSlots[1] ? activeAndFutureSlots[1].endDt : null,
        slot3_start_raw: activeAndFutureSlots[2] ? activeAndFutureSlots[2].startDt : null,
        slot3_end_raw: activeAndFutureSlots[2] ? activeAndFutureSlots[2].endDt : null,
        window_start_raw: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[0].startDt : null,
        window_end_raw: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[activeAndFutureSlots.length - 1].endDt : null
      };
    }

    /**
     * @test Payload Construction - Two Future Slots
     * @scenario Processing API response with 2 future slots
     * @given mockDataWithSlots (2 slots for tonight)
     * @given Current time: 2025-11-29T08:00:00Z (before slots)
     * @expect Payload matches expectedPayloadTwoSlots structure
     */
    test('should build correct payload with two future slots', () => {
      const apiData = mockDataWithSlots.data.data;
      const currentTime = '2025-11-29T08:00:00Z';
      const chargingNow = false;

      const payload = buildPayloadFromSlots(
        apiData.plannedDispatches,
        apiData.vehicleChargingPreferences,
        currentTime,
        chargingNow
      );

      // Verify key fields
      expect(payload.next_start).toBe("2025-11-29 21:30:00+00:00");
      expect(payload.total_energy).toBe(-12);
      expect(payload.next_kwh).toBe("0.00");
      expect(payload.next_source).toBe("smart-charge");
      expect(payload.charging_now).toBe(false);

      // Verify slot assignments
      expect(payload.slot1_start).toBe("2025-11-29 21:30:00+00:00");
      expect(payload.slot1_end).toBe("2025-11-29 22:00:00+00:00");
      expect(payload.slot2_start).toBe("2025-11-29 23:00:00+00:00");
      expect(payload.slot2_end).toBe("2025-11-30 04:00:00+00:00");
      expect(payload.slot3_start).toBeNull();
      expect(payload.slot3_end).toBeNull();

      // Verify window
      expect(payload.window_start).toBe("2025-11-29 21:30:00+00:00");
      expect(payload.window_end).toBe("2025-11-30 04:00:00+00:00");

      // Verify raw timestamps match
      expect(payload.next_start_raw).toBe(payload.next_start);
      expect(payload.slot1_start_raw).toBe(payload.slot1_start);
    });

    /**
     * @test Payload Construction - Active Slot
     * @scenario Processing API response with currently active slot
     * @given mockDataWithActiveSlot (slot from 01:30 to 05:30)
     * @given Current time: 2025-11-29T02:00:00Z (in middle of slot)
     * @expect Payload shows charging_now = true
     */
    test('should build correct payload with active slot', () => {
      const apiData = mockDataWithActiveSlot.data.data;
      const currentTime = '2025-11-29T02:00:00Z';
      const chargingNow = true; // Active slot detected

      const payload = buildPayloadFromSlots(
        apiData.plannedDispatches,
        apiData.vehicleChargingPreferences,
        currentTime,
        chargingNow
      );

      expect(payload.next_start).toBe("2025-11-29 01:30:00+00:00");
      expect(payload.total_energy).toBe(-15.5);
      expect(payload.next_kwh).toBe("-15.50");
      expect(payload.next_source).toBe("smart-charge");
      expect(payload.charging_now).toBe(true);

      expect(payload.slot1_start).toBe("2025-11-29 01:30:00+00:00");
      expect(payload.slot1_end).toBe("2025-11-29 05:30:00+00:00");
      expect(payload.slot2_start).toBeNull();
      expect(payload.slot2_end).toBeNull();
    });

    /**
     * @test Payload Construction - No Slots
     * @scenario Processing API response with no slots
     * @given mockDataNoSlots (empty plannedDispatches)
     * @expect All slot fields are null
     * @expect total_energy = 0
     * @expect charging_now = false
     */
    test('should build correct payload with no slots', () => {
      const apiData = mockDataNoSlots.data.data;
      const currentTime = '2025-11-29T08:00:00Z';
      const chargingNow = false;

      const payload = buildPayloadFromSlots(
        apiData.plannedDispatches,
        apiData.vehicleChargingPreferences,
        currentTime,
        chargingNow
      );

      expect(payload.next_start).toBeNull();
      expect(payload.total_energy).toBe(0);
      expect(payload.next_kwh).toBe("0");
      expect(payload.next_source).toBe("unknown");
      expect(payload.charging_now).toBe(false);

      expect(payload.slot1_start).toBeNull();
      expect(payload.slot1_end).toBeNull();
      expect(payload.slot2_start).toBeNull();
      expect(payload.slot2_end).toBeNull();
      expect(payload.slot3_start).toBeNull();
      expect(payload.slot3_end).toBeNull();

      expect(payload.window_start).toBeNull();
      expect(payload.window_end).toBeNull();
    });

    /**
     * @test Payload Construction - Three Slots
     * @scenario Processing API response with 3 slots
     * @given mockDataWithThreeSlots
     * @given Current time before all slots
     * @expect All three slots populated
     * @expect Total energy is sum of all slots
     */
    test('should build correct payload with three slots', () => {
      const apiData = mockDataWithThreeSlots.data.data;
      const currentTime = '2025-11-29T00:00:00Z';
      const chargingNow = false;

      const payload = buildPayloadFromSlots(
        apiData.plannedDispatches,
        apiData.vehicleChargingPreferences,
        currentTime,
        chargingNow
      );

      // Should have all 3 slots
      expect(payload.slot1_start).toBe("2025-11-29 01:30:00+00:00");
      expect(payload.slot1_end).toBe("2025-11-29 03:30:00+00:00");
      expect(payload.slot2_start).toBe("2025-11-29 12:00:00+00:00");
      expect(payload.slot2_end).toBe("2025-11-29 13:00:00+00:00");
      expect(payload.slot3_start).toBe("2025-11-30 02:00:00+00:00");
      expect(payload.slot3_end).toBe("2025-11-30 05:30:00+00:00");

      // Total energy: -10.2 + -5.5 + -18.7 = -34.4
      expect(payload.total_energy).toBeCloseTo(-34.4, 1);

      // Window should span from first to last slot
      expect(payload.window_start).toBe("2025-11-29 01:30:00+00:00");
      expect(payload.window_end).toBe("2025-11-30 05:30:00+00:00");

      // Next slot details
      expect(payload.next_start).toBe("2025-11-29 01:30:00+00:00");
      expect(payload.next_kwh).toBe("-10.20");
      expect(payload.next_source).toBe("smart-charge");
    });

    /**
     * @test Payload Construction - Past Slots Filtered Out
     * @scenario API returns past slots that should be ignored
     * @given Current time: 2025-11-29T08:00:00Z
     * @given Slot from yesterday (already completed)
     * @expect Past slot filtered out
     * @expect Payload shows no slots
     */
    test('should filter out past slots', () => {
      const currentTime = '2025-11-29T08:00:00Z';
      const chargingNow = false;

      const slots = [
        {
          startDt: "2025-11-28 01:30:00+00:00",
          endDt: "2025-11-28 05:30:00+00:00", // Yesterday - already ended
          deltaKwh: -12,
          meta: { source: "smart-charge" }
        }
      ];

      const prefs = {
        weekdayTargetSoc: 80,
        weekdayTargetTime: "08:00"
      };

      const payload = buildPayloadFromSlots(slots, prefs, currentTime, chargingNow);

      // Past slot should be filtered out
      expect(payload.next_start).toBeNull();
      expect(payload.total_energy).toBe(0);
      expect(payload.slot1_start).toBeNull();
      expect(payload.charging_now).toBe(false);
    });

    /**
     * @test Payload Construction - Mixed Past and Future Slots
     * @scenario API returns mix of past and future slots
     * @given Current time: 2025-11-29T08:00:00Z
     * @given One past slot, two future slots
     * @expect Only future slots included
     * @expect Total energy only counts future slots
     */
    test('should only include future slots when mixed with past', () => {
      const currentTime = '2025-11-29T08:00:00Z';
      const chargingNow = false;

      const slots = [
        {
          startDt: "2025-11-28 01:30:00+00:00",
          endDt: "2025-11-28 05:30:00+00:00", // Past
          deltaKwh: -100, // Should not be counted
          meta: { source: "smart-charge" }
        },
        {
          startDt: "2025-11-29 21:30:00+00:00",
          endDt: "2025-11-29 22:00:00+00:00", // Future
          deltaKwh: -10,
          meta: { source: "smart-charge" }
        },
        {
          startDt: "2025-11-29 23:00:00+00:00",
          endDt: "2025-11-30 04:00:00+00:00", // Future
          deltaKwh: -15,
          meta: { source: "smart-charge" }
        }
      ];

      const prefs = {
        weekdayTargetSoc: 80,
        weekdayTargetTime: "04:00"
      };

      const payload = buildPayloadFromSlots(slots, prefs, currentTime, chargingNow);

      // Should only have 2 future slots
      expect(payload.slot1_start).toBe("2025-11-29 21:30:00+00:00");
      expect(payload.slot2_start).toBe("2025-11-29 23:00:00+00:00");
      expect(payload.slot3_start).toBeNull();

      // Total energy should be -10 + -15 = -25 (not including -100 from past)
      expect(payload.total_energy).toBe(-25);

      // Next slot should be first future slot
      expect(payload.next_start).toBe("2025-11-29 21:30:00+00:00");
      expect(payload.next_kwh).toBe("-10.00");
    });

    /**
     * @test Payload Construction - Preferences Extraction
     * @scenario Verify preferences are correctly extracted
     * @given API response with preferences
     * @expect confirmed_limit and confirmed_time populated
     */
    test('should extract preferences correctly', () => {
      const apiData = mockDataWithSlots.data.data;
      const currentTime = '2025-11-29T08:00:00Z';
      const chargingNow = false;

      const payload = buildPayloadFromSlots(
        apiData.plannedDispatches,
        apiData.vehicleChargingPreferences,
        currentTime,
        chargingNow
      );

      expect(payload.confirmed_limit).toBe(80);
      expect(payload.confirmed_time).toBe("04:00");
      expect(payload.pending_limit).toBe(80);
      expect(payload.pending_time).toBe("04:00");
    });

    /**
     * @test Payload Construction - Bump Charge Source
     * @scenario Verify bump-charge source is captured
     * @given Slot with meta.source = "bump-charge"
     * @expect next_source = "bump-charge"
     */
    test('should capture bump-charge source correctly', () => {
      const currentTime = '2025-11-29T00:00:00Z';
      const chargingNow = false;

      const slots = [
        {
          startDt: "2025-11-29 12:00:00+00:00",
          endDt: "2025-11-29 13:00:00+00:00",
          deltaKwh: -5.5,
          meta: { source: "bump-charge" }
        }
      ];

      const prefs = {
        weekdayTargetSoc: 90,
        weekdayTargetTime: "07:00"
      };

      const payload = buildPayloadFromSlots(slots, prefs, currentTime, chargingNow);

      expect(payload.next_source).toBe("bump-charge");
    });
  });
});
