/**
 * MQTT Refresh Button Cooldown Tests
 *
 * Test 1.2: MQTT Button - Rapid Clicking During Cooldown
 * Test 4.2: Countdown Doesn't Go Negative (validated within Test 1.2)
 *
 * These tests verify:
 * - MQTT button has hardcoded 30-second rate limiting
 * - Rapid clicks are blocked during cooldown
 * - Only first click executes
 * - Node-RED logs warnings for blocked attempts
 * - Countdown expires correctly and doesn't go negative
 * - MQTT publishes correct timestamps and null at expiry
 */

describe('MQTT Refresh Button Cooldown', () => {
    let node;
    let publishedMessages;
    let warnings;
    let currentTime;
    let timers;

    // Persistent state across button presses
    let lastManualRefresh;
    let cooldownExpiryTimer;
    let lastKnownState;

    beforeEach(() => {
        // Reset time tracking
        currentTime = Date.now();
        timers = [];

        // Reset persistent state
        lastManualRefresh = 0;
        cooldownExpiryTimer = null;
        lastKnownState = {
            next_start: null,
            total_energy: 0,
            confirmed_limit: 80,
            confirmed_time: "04:00"
        };

        // Mock node state
        node = {
            broker: {
                client: {
                    publish: jest.fn((topic, payload, options) => {
                        publishedMessages.push({
                            topic,
                            payload: JSON.parse(payload),
                            options,
                            timestamp: currentTime
                        });
                    })
                }
            },
            warn: jest.fn((message) => {
                warnings.push({
                    message,
                    timestamp: currentTime
                });
            }),
            status: jest.fn(),
            log: jest.fn()
        };

        // Reset tracking arrays
        publishedMessages = [];
        warnings = [];

        // Mock Date.now() to control time
        jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

        // Mock setTimeout to track timers
        jest.spyOn(global, 'setTimeout').mockImplementation((callback, delay) => {
            const timer = {
                callback,
                delay,
                scheduledAt: currentTime,
                executeAt: currentTime + delay
            };
            timers.push(timer);
            return timer;
        });

        // Mock clearTimeout
        jest.spyOn(global, 'clearTimeout').mockImplementation((timer) => {
            const index = timers.indexOf(timer);
            if (index > -1) {
                timers.splice(index, 1);
            }
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    /**
     * Helper: Simulate MQTT refresh button press
     */
    function pressMqttRefreshButton() {
        const MANUAL_REFRESH_COOLDOWN = 30000; // 30 seconds
        const account = "A-TEST123";
        const stateTopic = `nodered_octopus/${account}/status`;
        const enableMqtt = true;

        // Helper functions
        function canManualRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            return lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN;
        }

        function getSecondsUntilNextRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            const timeRemaining = MANUAL_REFRESH_COOLDOWN - timeSinceLastRefresh;
            return Math.max(0, Math.ceil(timeRemaining / 1000));
        }

        function getRefreshAvailableAt() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;

            if (lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN) {
                return null;
            }

            return new Date(lastManualRefresh + MANUAL_REFRESH_COOLDOWN).toISOString();
        }

        function publishRefreshCooldownState() {
            if (enableMqtt && node.broker) {
                const fullState = {
                    ...lastKnownState,
                    refresh_available_at: getRefreshAvailableAt()
                };
                node.broker.client.publish(stateTopic, JSON.stringify(fullState), { retain: true });
            }
        }

        // MQTT Refresh button handler (from actual code)
        if (!canManualRefresh()) {
            const secondsRemaining = getSecondsUntilNextRefresh();
            node.status({
                fill: "red",
                shape: "dot",
                text: `Cooldown: ${secondsRemaining}s`
            });
            node.warn(`MQTT refresh blocked. Please wait ${secondsRemaining} seconds.`);
            return { blocked: true, secondsRemaining };
        }

        // Refresh allowed - set cooldown timestamp
        lastManualRefresh = Date.now();

        // Publish immediate update with countdown timestamp
        publishRefreshCooldownState();

        // Schedule cleanup at exactly 30 seconds to clear countdown
        if (cooldownExpiryTimer) clearTimeout(cooldownExpiryTimer);
        cooldownExpiryTimer = setTimeout(() => {
            publishRefreshCooldownState();
            cooldownExpiryTimer = null;
        }, MANUAL_REFRESH_COOLDOWN);

        node.status({ fill: "yellow", shape: "ring", text: "Manual refresh..." });

        return {
            blocked: false,
            lastManualRefresh,
            timer: cooldownExpiryTimer
        };
    }

    /**
     * Helper: Advance time and execute any timers that should fire
     */
    function advanceTime(milliseconds) {
        currentTime += milliseconds;

        // Execute any timers that should fire
        const timersToExecute = timers.filter(t => t.executeAt <= currentTime);
        timersToExecute.forEach(timer => {
            timer.callback();
            const index = timers.indexOf(timer);
            if (index > -1) {
                timers.splice(index, 1);
            }
        });
    }

    /**
     * @test MQTT Rapid Click - Test 1.2
     * @scenario User rapidly clicks MQTT refresh button 5 times in 2 seconds
     * @given Fresh start, no previous refresh
     * @expect First click works, 4 subsequent clicks blocked
     */
    test('Test 1.2: Should block rapid MQTT button clicks during cooldown', () => {
        // STEP 1: First click - should work
        const result1 = pressMqttRefreshButton();

        expect(result1.blocked).toBe(false);
        expect(publishedMessages).toHaveLength(1);
        expect(publishedMessages[0].payload.refresh_available_at).not.toBeNull();
        expect(publishedMessages[0].payload.refresh_available_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        const firstClickTime = result1.lastManualRefresh;
        const expectedExpiryTime = new Date(firstClickTime + 30000).toISOString();

        // STEP 2: Advance 500ms and click again - should be blocked
        advanceTime(500);
        const result2 = pressMqttRefreshButton();

        expect(result2.blocked).toBe(true);
        expect(result2.secondsRemaining).toBe(30); // 29.5s rounds up to 30
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('MQTT refresh blocked');
        expect(warnings[0].message).toContain('30 seconds');

        // STEP 3: Advance 500ms and click again - should be blocked
        advanceTime(500);
        const result3 = pressMqttRefreshButton();

        expect(result3.blocked).toBe(true);
        expect(result3.secondsRemaining).toBe(29);
        expect(warnings).toHaveLength(2);

        // STEP 4: Advance 500ms and click again - should be blocked
        advanceTime(500);
        const result4 = pressMqttRefreshButton();

        expect(result4.blocked).toBe(true);
        expect(result4.secondsRemaining).toBe(29);
        expect(warnings).toHaveLength(3);

        // STEP 5: Advance 500ms and click again - should be blocked
        advanceTime(500);
        const result5 = pressMqttRefreshButton();

        expect(result5.blocked).toBe(true);
        expect(result5.secondsRemaining).toBe(28);
        expect(warnings).toHaveLength(4);

        // VERIFY: Only 1 MQTT message published (the first click)
        expect(publishedMessages).toHaveLength(1);

        // VERIFY: All blocked attempts logged warnings
        expect(warnings).toHaveLength(4);
        warnings.forEach(w => {
            expect(w.message).toContain('MQTT refresh blocked');
        });

        // VERIFY: Node status called for each blocked attempt
        expect(node.status).toHaveBeenCalledWith({
            fill: "red",
            shape: "dot",
            text: expect.stringMatching(/Cooldown: \d+s/)
        });
    });

    /**
     * @test Cooldown Expiry - Test 4.2 validation
     * @scenario Wait for 30-second cooldown to expire and verify countdown doesn't go negative
     * @given MQTT button pressed, cooldown active
     * @expect After 30s, refresh_available_at becomes null (not negative time)
     */
    test('Test 4.2: Should clear countdown at expiry and not go negative', () => {
        // STEP 1: Press button to start cooldown
        const result = pressMqttRefreshButton();

        expect(result.blocked).toBe(false);
        expect(timers).toHaveLength(1);
        expect(timers[0].delay).toBe(30000);

        // Initial publish with timestamp
        expect(publishedMessages).toHaveLength(1);
        const initialPayload = publishedMessages[0].payload;
        expect(initialPayload.refresh_available_at).not.toBeNull();
        expect(initialPayload.refresh_available_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const expiryTimestamp = new Date(initialPayload.refresh_available_at);
        const startTime = currentTime;
        const expectedExpiry = startTime + 30000;

        // Verify the timestamp is exactly 30 seconds in the future
        expect(expiryTimestamp.getTime()).toBe(expectedExpiry);

        // STEP 2: Advance time to just before expiry (29 seconds)
        advanceTime(29000);

        // No new messages should be published yet
        expect(publishedMessages).toHaveLength(1);

        // STEP 3: Advance time to exactly 30 seconds (expiry)
        advanceTime(1000); // Total: 30s

        // Timer should have fired and published null
        expect(publishedMessages).toHaveLength(2);
        const expiryPayload = publishedMessages[1].payload;

        // CRITICAL: refresh_available_at should be null, NOT a past timestamp
        expect(expiryPayload.refresh_available_at).toBeNull();

        // STEP 4: Advance time beyond expiry (35 seconds total)
        advanceTime(5000);

        // Should still be null (not going negative like "5 seconds ago")
        // No additional messages should be published
        expect(publishedMessages).toHaveLength(2);

        // STEP 5: Verify we can refresh again now
        const newResult = pressMqttRefreshButton();
        expect(newResult.blocked).toBe(false);

        // New cooldown should start with new timestamp
        expect(publishedMessages).toHaveLength(3);
        const newPayload = publishedMessages[2].payload;
        expect(newPayload.refresh_available_at).not.toBeNull();
        expect(newPayload.refresh_available_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    /**
     * @test MQTT Payload Values During Cooldown Lifecycle
     * @scenario Verify exact payload values at different points in cooldown
     * @given MQTT button pressed
     * @expect Correct timestamp values at T+0s, T+15s, T+30s, T+31s
     */
    test('Should publish correct timestamp values throughout cooldown lifecycle', () => {
        const startTime = currentTime;

        // T+0s: Press button
        pressMqttRefreshButton();

        expect(publishedMessages).toHaveLength(1);
        const msg0 = publishedMessages[0];
        expect(msg0.payload.refresh_available_at).toBe(new Date(startTime + 30000).toISOString());
        expect(msg0.options.retain).toBe(true);

        // T+15s: Mid-cooldown (no publish expected)
        advanceTime(15000);
        expect(publishedMessages).toHaveLength(1); // Still only 1 message

        // T+30s: Expiry (timer fires)
        advanceTime(15000);
        expect(publishedMessages).toHaveLength(2);
        const msg30 = publishedMessages[1];
        expect(msg30.payload.refresh_available_at).toBeNull();
        expect(msg30.options.retain).toBe(true);

        // T+31s: After expiry (no publish expected)
        advanceTime(1000);
        expect(publishedMessages).toHaveLength(2); // Still only 2 messages

        // Verify EXACTLY 2 messages were sent (start + expiry)
        expect(publishedMessages).toHaveLength(2);
    });

    /**
     * @test Timer Cleanup
     * @scenario Verify cooldown timer is properly cleaned up
     * @given MQTT button pressed
     * @expect Timer exists initially, then is cleaned up after expiry
     */
    test('Should properly clean up cooldown timer after expiry', () => {
        // Press button
        const result = pressMqttRefreshButton();

        // Timer should be scheduled
        expect(timers).toHaveLength(1);
        expect(timers[0].delay).toBe(30000);

        // Advance to expiry
        advanceTime(30000);

        // Timer should have been executed and removed
        expect(timers).toHaveLength(0);

        // Press button again
        pressMqttRefreshButton();

        // New timer should be created
        expect(timers).toHaveLength(1);
    });

    /**
     * @test MQTT Message Structure
     * @scenario Verify published MQTT messages have correct structure
     * @given MQTT button pressed
     * @expect Messages contain all required fields with correct types
     */
    test('Should publish MQTT messages with correct structure', () => {
        pressMqttRefreshButton();

        const msg = publishedMessages[0];

        // Check message structure
        expect(msg).toHaveProperty('topic');
        expect(msg).toHaveProperty('payload');
        expect(msg).toHaveProperty('options');
        expect(msg).toHaveProperty('timestamp');

        // Check topic
        expect(msg.topic).toBe('nodered_octopus/A-TEST123/status');

        // Check payload structure
        expect(msg.payload).toHaveProperty('refresh_available_at');
        expect(msg.payload).toHaveProperty('next_start');
        expect(msg.payload).toHaveProperty('total_energy');
        expect(msg.payload).toHaveProperty('confirmed_limit');
        expect(msg.payload).toHaveProperty('confirmed_time');

        // Check options
        expect(msg.options.retain).toBe(true);

        // Check timestamp is ISO 8601 format
        expect(msg.payload.refresh_available_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});
