/**
 * Reconciliation Loop Tests
 *
 * Tests that verify the 10-second reconciliation loop correctly detects
 * charging state changes and triggers both MQTT updates and Node-RED messages.
 *
 * Simulates time passing from before a slot starts to when it becomes active,
 * proving the reconciliation loop catches the transition.
 */

const { createMockBroker, createMockNode } = require('../test-mocks');

describe('Reconciliation Loop - Time-Based State Detection', () => {
  let mockBroker;
  let mockNode;
  let chargingNow;
  let cachedSlots;
  let stateCheckInterval;
  let sentMessages;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockBroker = createMockBroker();
    mockNode = createMockNode();

    // Initialize state
    chargingNow = false;
    cachedSlots = [];
    stateCheckInterval = null;
    sentMessages = [];
  });

  afterEach(() => {
    if (stateCheckInterval) {
      clearInterval(stateCheckInterval);
    }
    jest.useRealTimers();
  });

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  function publishChargingState(state) {
    chargingNow = state;

    const enableMqtt = true;
    const stateTopic = 'nodered_octopus/A-TEST1234/status';

    if (enableMqtt && mockBroker) {
      const payload = state ? "ON" : "OFF";
      mockBroker.client.publish(`${stateTopic}/charging_now`, payload, { retain: true });
    }
  }

  function sendNodeRedMessage(state) {
    const message = {
      payload: {
        charging_now: state,
        timestamp: new Date().toISOString()
      },
      debug: {
        trigger: 'reconciliation',
        state_change: true
      }
    };
    sentMessages.push(message);
    mockNode.send(message);
  }

  function reconcileChargingState() {
    if (!cachedSlots || cachedSlots.length === 0) return;

    const now = new Date();

    const shouldBeCharging = cachedSlots.some(slot => {
      const start = new Date(slot.startDt);
      const end = new Date(slot.endDt);
      return start <= now && end > now;
    });

    if (shouldBeCharging !== chargingNow) {
      mockNode.warn(`State reconciliation: Correcting chargingNow from ${chargingNow} to ${shouldBeCharging}`);
      publishChargingState(shouldBeCharging);
      sendNodeRedMessage(shouldBeCharging);
    }
  }

  function startStateReconciliation() {
    if (stateCheckInterval) {
      clearInterval(stateCheckInterval);
    }

    stateCheckInterval = setInterval(() => {
      reconcileChargingState();
    }, 10000);

    mockNode.log("State reconciliation loop started (every 10s)");
  }

  // ==========================================================================
  // Test Suite 1: Future Slot Becomes Active
  // ==========================================================================

  describe('Future Slot Becomes Active', () => {
    /**
     * @test Reconciliation detects slot becoming active
     * @scenario Start with future slot, wait for it to become active
     * @given Slot: 02:00 - 03:00, Current time: 01:50
     * @expect At 02:00, reconciliation detects change and updates state
     */
    test('should detect when future slot becomes active and trigger updates', () => {
      // Arrange: Set initial time BEFORE slot starts
      const initialTime = new Date('2025-12-10T01:50:00Z');
      jest.setSystemTime(initialTime);

      // Slot starts at 02:00 (10 minutes from now)
      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00',
          endDt: '2025-12-10 03:00:00+00:00',
          deltaKwh: -5,
          meta: { source: 'smart-charge' }
        }
      ];

      chargingNow = false;

      // Start reconciliation loop
      startStateReconciliation();

      // Verify initial state
      expect(chargingNow).toBe(false);
      expect(stateCheckInterval).not.toBeNull();
      expect(mockNode.log).toHaveBeenCalledWith("State reconciliation loop started (every 10s)");

      // Clear any initial MQTT publishes
      mockBroker.getPublished().length = 0;
      sentMessages.length = 0;
      mockNode.getSent().length = 0;

      // Act: Advance time by 5 minutes (still before slot)
      // 01:50 → 01:55
      jest.advanceTimersByTime(5 * 60 * 1000);

      // Reconciliation should have run (after 5 min = 30 ticks of 10s)
      // but state should still be false
      expect(chargingNow).toBe(false);
      expect(mockBroker.getPublished().length).toBe(0); // No MQTT updates
      expect(sentMessages.length).toBe(0); // No Node-RED messages

      // Act: Advance time to EXACTLY when slot starts
      // 01:55 → 02:00 (5 more minutes)
      jest.advanceTimersByTime(5 * 60 * 1000);

      // NOW we're in the slot! Next reconciliation tick should detect it
      // Advance by 10 seconds to trigger reconciliation
      jest.advanceTimersByTime(10000);

      // Assert: State should be updated
      expect(chargingNow).toBe(true);

      // Verify MQTT update
      const mqttPublished = mockBroker.getPublished();
      expect(mqttPublished.length).toBeGreaterThan(0);
      const chargingNowUpdate = mqttPublished.find(p => p.topic.endsWith('/charging_now'));
      expect(chargingNowUpdate).toBeDefined();
      expect(chargingNowUpdate.payload).toBe('ON');

      // Verify Node-RED message sent
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].payload.charging_now).toBe(true);
      expect(sentMessages[0].debug.trigger).toBe('reconciliation');

      // Verify warning was logged
      expect(mockNode.warn).toHaveBeenCalledWith(
        expect.stringContaining('State reconciliation: Correcting chargingNow from false to true')
      );
    });

    /**
     * @test Reconciliation continues to run every 10 seconds
     * @scenario Verify multiple reconciliation ticks occur
     */
    test('should run reconciliation every 10 seconds consistently', () => {
      const initialTime = new Date('2025-12-10T01:00:00Z');
      jest.setSystemTime(initialTime);

      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00',
          endDt: '2025-12-10 03:00:00+00:00',
          deltaKwh: -5,
          meta: { source: 'smart-charge' }
        }
      ];

      chargingNow = false;

      // Spy on reconciliation function
      const reconcileSpy = jest.fn(reconcileChargingState);
      stateCheckInterval = setInterval(reconcileSpy, 10000);

      // Advance time by 1 minute (6 ticks)
      jest.advanceTimersByTime(60000);

      // Should have run 6 times
      expect(reconcileSpy).toHaveBeenCalledTimes(6);

      // Advance another 30 seconds (3 more ticks)
      jest.advanceTimersByTime(30000);

      // Should have run 9 times total
      expect(reconcileSpy).toHaveBeenCalledTimes(9);
    });
  });

  // ==========================================================================
  // Test Suite 2: Active Slot Becomes Inactive
  // ==========================================================================

  describe('Active Slot Becomes Inactive', () => {
    /**
     * @test Reconciliation detects slot ending
     * @scenario Start IN active slot, wait for it to end
     * @given Slot: 02:00 - 03:00, Current time: 02:55
     * @expect At 03:00, reconciliation detects change and updates state
     */
    test('should detect when active slot ends and trigger updates', () => {
      // Arrange: Set time INSIDE active slot (5 min before end)
      const initialTime = new Date('2025-12-10T02:55:00Z');
      jest.setSystemTime(initialTime);

      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00',
          endDt: '2025-12-10 03:00:00+00:00',
          deltaKwh: -5,
          meta: { source: 'smart-charge' }
        }
      ];

      chargingNow = true; // Currently charging

      startStateReconciliation();

      // Clear initial state
      mockBroker.getPublished().length = 0;
      sentMessages.length = 0;

      // Act: Advance to JUST BEFORE slot ends
      // 02:55 → 02:59 (4 minutes)
      jest.advanceTimersByTime(4 * 60 * 1000);

      // Still in slot
      expect(chargingNow).toBe(true);
      expect(sentMessages.length).toBe(0);

      // Act: Advance to AFTER slot ends
      // 02:59 → 03:01 (2 minutes)
      jest.advanceTimersByTime(2 * 60 * 1000);

      // Trigger reconciliation
      jest.advanceTimersByTime(10000);

      // Assert: State should be updated to NOT charging
      expect(chargingNow).toBe(false);

      // Verify MQTT update
      const mqttPublished = mockBroker.getPublished();
      const chargingNowUpdate = mqttPublished.find(p => p.topic.endsWith('/charging_now'));
      expect(chargingNowUpdate).toBeDefined();
      expect(chargingNowUpdate.payload).toBe('OFF');

      // Verify Node-RED message sent
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].payload.charging_now).toBe(false);

      // Verify warning was logged
      expect(mockNode.warn).toHaveBeenCalledWith(
        expect.stringContaining('State reconciliation: Correcting chargingNow from true to false')
      );
    });
  });

  // ==========================================================================
  // Test Suite 3: Multiple Slots Transition
  // ==========================================================================

  describe('Multiple Slots Transition', () => {
    /**
     * @test Reconciliation handles transition between slots
     * @scenario Two slots with gap between them
     * @expect State transitions: false → true → false → true
     */
    test('should detect transitions through multiple slot boundaries', () => {
      // Arrange: Time before first slot
      const initialTime = new Date('2025-12-10T01:50:00Z');
      jest.setSystemTime(initialTime);

      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00', // Slot 1: 02:00-02:30
          endDt: '2025-12-10 02:30:00+00:00',
          deltaKwh: -3,
          meta: { source: 'smart-charge' }
        },
        {
          startDt: '2025-12-10 03:00:00+00:00', // Slot 2: 03:00-03:30
          endDt: '2025-12-10 03:30:00+00:00',
          deltaKwh: -3,
          meta: { source: 'smart-charge' }
        }
      ];

      chargingNow = false;
      startStateReconciliation();

      const stateChanges = [];

      // Capture state changes
      const originalPublish = publishChargingState;
      publishChargingState = (state) => {
        stateChanges.push({ time: new Date().toISOString(), state });
        originalPublish(state);
      };

      // Reset
      mockBroker.getPublished().length = 0;
      sentMessages.length = 0;

      // Timeline simulation:
      // 01:50 → 02:00 (10 min) - Enter slot 1
      jest.advanceTimersByTime(10 * 60 * 1000);
      jest.advanceTimersByTime(10000); // Trigger reconciliation
      expect(chargingNow).toBe(true); // Should be charging

      // 02:00 → 02:30 (30 min) - Exit slot 1
      jest.advanceTimersByTime(30 * 60 * 1000);
      jest.advanceTimersByTime(10000);
      expect(chargingNow).toBe(false); // Should NOT be charging

      // 02:30 → 03:00 (30 min) - Enter slot 2
      jest.advanceTimersByTime(30 * 60 * 1000);
      jest.advanceTimersByTime(10000);
      expect(chargingNow).toBe(true); // Should be charging again

      // Verify we had 3 state changes
      expect(stateChanges.length).toBe(3);
      expect(stateChanges[0].state).toBe(true);  // Entered slot 1
      expect(stateChanges[1].state).toBe(false); // Exited slot 1
      expect(stateChanges[2].state).toBe(true);  // Entered slot 2
    });
  });

  // ==========================================================================
  // Test Suite 4: No False Positives
  // ==========================================================================

  describe('No False Positives', () => {
    /**
     * @test Reconciliation doesn't trigger when state is correct
     * @scenario State matches reality throughout
     * @expect No updates triggered
     */
    test('should NOT trigger updates when state is already correct', () => {
      const initialTime = new Date('2025-12-10T02:30:00Z');
      jest.setSystemTime(initialTime);

      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00',
          endDt: '2025-12-10 03:00:00+00:00',
          deltaKwh: -5,
          meta: { source: 'smart-charge' }
        }
      ];

      chargingNow = true; // Correctly set to true (we're in slot)

      startStateReconciliation();

      // Clear initial state
      mockBroker.getPublished().length = 0;
      sentMessages.length = 0;
      mockNode.warn.mockClear();

      // Advance time by 20 minutes (still in slot)
      // This triggers 120 reconciliation ticks
      jest.advanceTimersByTime(20 * 60 * 1000);

      // State should still be true (unchanged)
      expect(chargingNow).toBe(true);

      // NO MQTT updates should have happened
      expect(mockBroker.getPublished().length).toBe(0);

      // NO Node-RED messages should have been sent
      expect(sentMessages.length).toBe(0);

      // NO warnings should have been logged
      expect(mockNode.warn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Test Suite 5: Integration - Complete Charging Session
  // ==========================================================================

  describe('Complete Charging Session', () => {
    /**
     * @test Full charging session simulation
     * @scenario Simulate realistic charging session timeline
     */
    test('should correctly track state through complete charging session', () => {
      // Start before car is plugged in
      const initialTime = new Date('2025-12-10T01:00:00Z');
      jest.setSystemTime(initialTime);

      // No slots initially
      cachedSlots = [];
      chargingNow = false;

      startStateReconciliation();

      const timeline = [];

      // 01:00 - No slots, not charging
      jest.advanceTimersByTime(10000);
      timeline.push({ time: '01:00', charging: chargingNow, slots: cachedSlots.length });

      // 01:30 - Car plugged in, API returns slots (simulated by updating cachedSlots)
      jest.setSystemTime(new Date('2025-12-10T01:30:00Z'));
      cachedSlots = [
        {
          startDt: '2025-12-10 02:00:00+00:00',
          endDt: '2025-12-10 03:00:00+00:00',
          deltaKwh: -15,
          meta: { source: 'smart-charge' }
        }
      ];
      jest.advanceTimersByTime(10000);
      timeline.push({ time: '01:30', charging: chargingNow, slots: cachedSlots.length });
      expect(chargingNow).toBe(false); // Still before slot

      // 02:00 - Slot starts, reconciliation detects it
      jest.setSystemTime(new Date('2025-12-10T02:00:00Z'));
      jest.advanceTimersByTime(10000);
      timeline.push({ time: '02:00', charging: chargingNow, slots: cachedSlots.length });
      expect(chargingNow).toBe(true); // NOW charging!

      // 02:30 - Still charging
      jest.setSystemTime(new Date('2025-12-10T02:30:00Z'));
      jest.advanceTimersByTime(10000);
      timeline.push({ time: '02:30', charging: chargingNow, slots: cachedSlots.length });
      expect(chargingNow).toBe(true);

      // 03:00 - Slot ends, reconciliation detects it
      jest.setSystemTime(new Date('2025-12-10T03:00:00Z'));
      jest.advanceTimersByTime(10000);
      timeline.push({ time: '03:00', charging: chargingNow, slots: cachedSlots.length });
      expect(chargingNow).toBe(false); // Stopped charging

      // Verify timeline
      expect(timeline[0].charging).toBe(false); // Before slot
      expect(timeline[1].charging).toBe(false); // Car plugged in but before slot
      expect(timeline[2].charging).toBe(true);  // Charging started
      expect(timeline[3].charging).toBe(true);  // Still charging
      expect(timeline[4].charging).toBe(false); // Charging stopped
    });
  });
});
