/**
 * Mock API Responses for Unit Testing
 *
 * These are sanitized mock responses based on actual Octopus Energy API structure.
 * All tokens, API keys, and account numbers are FAKE and for testing only.
 */

// ============================================================================
// 1. AUTHENTICATION RESPONSES
// ============================================================================

/**
 * Successful authentication response
 * @returns {Object} Mock authentication response with fake JWT token
 */
const mockAuthSuccess = {
  status: 200,
  data: {
    data: {
      obtainKrakenToken: {
        token: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_TOKEN_PAYLOAD.FAKE_SIGNATURE"
      }
    }
  }
};

/**
 * Authentication failure - invalid API key
 * @returns {Object} Mock error response
 */
const mockAuthFailure = {
  status: 200,
  data: {
    errors: [
      {
        message: "Invalid API key provided",
        locations: [{ line: 1, column: 1 }],
        path: ["obtainKrakenToken"]
      }
    ]
  }
};

// ============================================================================
// 2. DATA QUERY RESPONSES (flexPlannedDispatches + devices)
// ============================================================================

/**
 * Data query with 2 active/future slots (based on real example)
 * Scenario: Two smart-charge slots scheduled for tonight
 */
const mockDataWithSlots = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-11-29 21:30:00+00:00",
          end: "2025-11-29 22:00:00+00:00",
          energyAddedKwh: 0,
          type: "SMART"
        },
        {
          start: "2025-11-29 23:00:00+00:00",
          end: "2025-11-30 04:00:00+00:00",
          energyAddedKwh: 12,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '04:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '04:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '04:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '04:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '04:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '04:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '04:00:00', max: 80 },
          ]
        }
      }]
    }
  }
};

/**
 * Data query with active slot (currently charging)
 * Scenario: One slot currently active, started 30 minutes ago
 */
const mockDataWithActiveSlot = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-11-29 01:30:00+00:00",
          end: "2025-11-29 05:30:00+00:00",
          energyAddedKwh: 15.5,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  }
};

// ============================================================================
// 6. REAL API RESPONSE TEST DATA (Based on User's Actual Data)
// ============================================================================

/**
 * REAL API RESPONSE - 1 Slot: Currently Active
 * Test Time: 2025-12-10T03:15:00Z (middle of slot)
 * Slot: 03:00 - 03:30 (ACTIVE at test time)
 * Expected charging_now: true
 */
const mockRealApiResponse_1Slot_Active = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 03:30:00+00:00",
          energyAddedKwh: 1,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T03:15:00Z", // 15 minutes into the slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 1 Slot: Not Active (Future)
 * Test Time: 2025-12-10T02:00:00Z (before slot)
 * Slot: 03:00 - 03:30 (NOT ACTIVE at test time)
 * Expected charging_now: false
 */
const mockRealApiResponse_1Slot_Future = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 03:30:00+00:00",
          energyAddedKwh: 1,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T02:00:00Z", // 1 hour before slot starts
  expectedChargingNow: false
};

/**
 * REAL API RESPONSE - 3 Slots: First Active
 * Test Time: 2025-12-10T01:15:00Z
 * Slot 1: 01:00 - 02:00 (ACTIVE)
 * Slot 2: 03:00 - 04:00 (future)
 * Slot 3: 05:00 - 06:00 (future)
 * Expected charging_now: true
 */
const mockRealApiResponse_3Slots_FirstActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 01:00:00+00:00",
          end: "2025-12-10 02:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 04:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 05:00:00+00:00",
          end: "2025-12-10 06:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T01:15:00Z", // 15 minutes into first slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 3 Slots: Middle Active
 * Test Time: 2025-12-10T03:30:00Z
 * Slot 1: 01:00 - 02:00 (past)
 * Slot 2: 03:00 - 04:00 (ACTIVE)
 * Slot 3: 05:00 - 06:00 (future)
 * Expected charging_now: true
 */
const mockRealApiResponse_3Slots_MiddleActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 01:00:00+00:00",
          end: "2025-12-10 02:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 04:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 05:00:00+00:00",
          end: "2025-12-10 06:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T03:30:00Z", // 30 minutes into middle slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 3 Slots: Last Active
 * Test Time: 2025-12-10T05:45:00Z
 * Slot 1: 01:00 - 02:00 (past)
 * Slot 2: 03:00 - 04:00 (past)
 * Slot 3: 05:00 - 06:00 (ACTIVE)
 * Expected charging_now: true
 */
const mockRealApiResponse_3Slots_LastActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 01:00:00+00:00",
          end: "2025-12-10 02:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 04:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 05:00:00+00:00",
          end: "2025-12-10 06:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T05:45:00Z", // 45 minutes into last slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 3 Slots: None Active (Between Slots)
 * Test Time: 2025-12-10T02:30:00Z
 * Slot 1: 01:00 - 02:00 (past)
 * Slot 2: 03:00 - 04:00 (future)
 * Slot 3: 05:00 - 06:00 (future)
 * Expected charging_now: false
 */
const mockRealApiResponse_3Slots_NoneActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 01:00:00+00:00",
          end: "2025-12-10 02:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 03:00:00+00:00",
          end: "2025-12-10 04:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        },
        {
          start: "2025-12-10 05:00:00+00:00",
          end: "2025-12-10 06:00:00+00:00",
          energyAddedKwh: 5,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T02:30:00Z", // Between slot 1 and slot 2
  expectedChargingNow: false
};

/**
 * REAL API RESPONSE - 6 Slots: First Active
 * Test Time: 2025-12-10T00:30:00Z
 * Expected charging_now: true
 */
const mockRealApiResponse_6Slots_FirstActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 00:00:00+00:00",
          end: "2025-12-10 01:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 02:00:00+00:00",
          end: "2025-12-10 03:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 04:00:00+00:00",
          end: "2025-12-10 05:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 06:00:00+00:00",
          end: "2025-12-10 07:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 08:00:00+00:00",
          end: "2025-12-10 09:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 10:00:00+00:00",
          end: "2025-12-10 11:00:00+00:00",
          energyAddedKwh: 3,
          type: "BOOST"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'TUESDAY',   time: '07:00:00', max: 90 },
            { dayOfWeek: 'WEDNESDAY', time: '07:00:00', max: 90 },
            { dayOfWeek: 'THURSDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'FRIDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'SATURDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'SUNDAY',    time: '07:00:00', max: 90 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T00:30:00Z", // 30 minutes into first slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 6 Slots: Third Active (Middle)
 * Test Time: 2025-12-10T04:30:00Z
 * Expected charging_now: true
 */
const mockRealApiResponse_6Slots_ThirdActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 00:00:00+00:00",
          end: "2025-12-10 01:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 02:00:00+00:00",
          end: "2025-12-10 03:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 04:00:00+00:00",
          end: "2025-12-10 05:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 06:00:00+00:00",
          end: "2025-12-10 07:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 08:00:00+00:00",
          end: "2025-12-10 09:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 10:00:00+00:00",
          end: "2025-12-10 11:00:00+00:00",
          energyAddedKwh: 3,
          type: "BOOST"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'TUESDAY',   time: '07:00:00', max: 90 },
            { dayOfWeek: 'WEDNESDAY', time: '07:00:00', max: 90 },
            { dayOfWeek: 'THURSDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'FRIDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'SATURDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'SUNDAY',    time: '07:00:00', max: 90 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T04:30:00Z", // 30 minutes into third slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 6 Slots: Last Active
 * Test Time: 2025-12-10T10:45:00Z
 * Expected charging_now: true
 */
const mockRealApiResponse_6Slots_LastActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 00:00:00+00:00",
          end: "2025-12-10 01:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 02:00:00+00:00",
          end: "2025-12-10 03:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 04:00:00+00:00",
          end: "2025-12-10 05:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 06:00:00+00:00",
          end: "2025-12-10 07:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 08:00:00+00:00",
          end: "2025-12-10 09:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 10:00:00+00:00",
          end: "2025-12-10 11:00:00+00:00",
          energyAddedKwh: 3,
          type: "BOOST"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'TUESDAY',   time: '07:00:00', max: 90 },
            { dayOfWeek: 'WEDNESDAY', time: '07:00:00', max: 90 },
            { dayOfWeek: 'THURSDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'FRIDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'SATURDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'SUNDAY',    time: '07:00:00', max: 90 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T10:45:00Z", // 45 minutes into last slot
  expectedChargingNow: true
};

/**
 * REAL API RESPONSE - 6 Slots: None Active (Between Slots)
 * Test Time: 2025-12-10T03:30:00Z
 * Expected charging_now: false
 */
const mockRealApiResponse_6Slots_NoneActive = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-12-10 00:00:00+00:00",
          end: "2025-12-10 01:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 02:00:00+00:00",
          end: "2025-12-10 03:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 04:00:00+00:00",
          end: "2025-12-10 05:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 06:00:00+00:00",
          end: "2025-12-10 07:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 08:00:00+00:00",
          end: "2025-12-10 09:00:00+00:00",
          energyAddedKwh: 3,
          type: "SMART"
        },
        {
          start: "2025-12-10 10:00:00+00:00",
          end: "2025-12-10 11:00:00+00:00",
          energyAddedKwh: 3,
          type: "BOOST"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'TUESDAY',   time: '07:00:00', max: 90 },
            { dayOfWeek: 'WEDNESDAY', time: '07:00:00', max: 90 },
            { dayOfWeek: 'THURSDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'FRIDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'SATURDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'SUNDAY',    time: '07:00:00', max: 90 },
          ]
        }
      }]
    }
  },
  testTime: "2025-12-10T03:30:00Z", // Between slot 2 and slot 3
  expectedChargingNow: false
};

/**
 * Data query with no slots
 * Scenario: Car not plugged in or no charging scheduled
 */
const mockDataNoSlots = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  }
};

/**
 * Data query with 3 slots (testing multiple slot handling)
 * Scenario: Complex charging schedule with boost charge
 */
const mockDataWithThreeSlots = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-11-29 01:30:00+00:00",
          end: "2025-11-29 03:30:00+00:00",
          energyAddedKwh: 10.2,
          type: "SMART"
        },
        {
          start: "2025-11-29 12:00:00+00:00",
          end: "2025-11-29 13:00:00+00:00",
          energyAddedKwh: 5.5,
          type: "BOOST"
        },
        {
          start: "2025-11-30 02:00:00+00:00",
          end: "2025-11-30 05:30:00+00:00",
          energyAddedKwh: 18.7,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'TUESDAY',   time: '07:00:00', max: 90 },
            { dayOfWeek: 'WEDNESDAY', time: '07:00:00', max: 90 },
            { dayOfWeek: 'THURSDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'FRIDAY',    time: '07:00:00', max: 90 },
            { dayOfWeek: 'SATURDAY',  time: '07:00:00', max: 90 },
            { dayOfWeek: 'SUNDAY',    time: '07:00:00', max: 90 },
          ]
        }
      }]
    }
  }
};

/**
 * Data query with past slots (should be filtered out)
 * Scenario: Old slots that have already completed
 */
const mockDataWithPastSlots = {
  status: 200,
  data: {
    data: {
      flexPlannedDispatches: [
        {
          start: "2025-11-28 01:30:00+00:00",
          end: "2025-11-28 05:30:00+00:00",
          energyAddedKwh: 12,
          type: "SMART"
        }
      ],
      devices: [{
        id: 'test-device',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
          schedules: [
            { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
            { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
            { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
            { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
            { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
          ]
        }
      }]
    }
  }
};

// ============================================================================
// 3. PREFERENCE MUTATION RESPONSES
// ============================================================================

// NOTE: mock shape must be validated against a real setDevicePreferences API response.
const mockMutationSuccess = {
  status: 200,
  data: {
    data: {
      setDevicePreferences: {
        __typename: "SmartFlexDevicePreferences"
      }
    }
  }
};

const mockMutationFailure = {
  status: 200,
  data: {
    errors: [
      {
        message: "Failed to update preferences",
        locations: [{ line: 1, column: 1 }],
        path: ["setDevicePreferences"]
      }
    ]
  }
};

// ============================================================================
// 4. ERROR RESPONSES
// ============================================================================

/**
 * Network timeout error
 */
const mockNetworkTimeout = {
  code: "ECONNABORTED",
  message: "timeout of 10000ms exceeded"
};

/**
 * Invalid account number
 * TODO: Update with actual API response structure when available
 */
const mockInvalidAccount = {
  status: 200,
  data: {
    errors: [
      {
        message: "Account not found",
        locations: [{ line: 1, column: 1 }]
      }
    ]
  }
};

/**
 * Rate limiting error
 */
const mockRateLimitError = {
  status: 429,
  statusText: "Too Many Requests",
  data: {
    error: "Rate limit exceeded"
  }
};

// ============================================================================
// 5. EXPECTED PAYLOADS (Node-RED msg.payload format)
// ============================================================================

/**
 * Expected payload format with 2 slots (based on user's example)
 * This is what fetchData() should produce
 */
const expectedPayloadTwoSlots = {
  next_start: "2025-11-29 21:30:00+00:00",
  total_energy: 12,
  next_kwh: "0.00",
  next_source: "smart",
  confirmed_limit: 80,
  confirmed_time: "04:00",
  pending_limit: 80,
  pending_time: "04:00",
  charging_now: false,
  slot1_start: "2025-11-29 21:30:00+00:00",
  slot1_end: "2025-11-29 22:00:00+00:00",
  slot2_start: "2025-11-29 23:00:00+00:00",
  slot2_end: "2025-11-30 04:00:00+00:00",
  slot3_start: null,
  slot3_end: null,
  window_start: "2025-11-29 21:30:00+00:00",
  window_end: "2025-11-30 04:00:00+00:00",
  next_start_raw: "2025-11-29 21:30:00+00:00",
  slot1_start_raw: "2025-11-29 21:30:00+00:00",
  slot1_end_raw: "2025-11-29 22:00:00+00:00",
  slot2_start_raw: "2025-11-29 23:00:00+00:00",
  slot2_end_raw: "2025-11-30 04:00:00+00:00",
  slot3_start_raw: null,
  slot3_end_raw: null,
  window_start_raw: "2025-11-29 21:30:00+00:00",
  window_end_raw: "2025-11-30 04:00:00+00:00"
};

/**
 * Expected payload with active slot (charging_now = true)
 * Current time: 2025-11-29T02:00:00Z (in the middle of slot)
 */
const expectedPayloadActiveSlot = {
  next_start: "2025-11-29 01:30:00+00:00",
  total_energy: 15.5,
  next_kwh: "15.50",
  next_source: "smart",
  confirmed_limit: 80,
  confirmed_time: "08:00",
  pending_limit: 80,
  pending_time: "08:00",
  charging_now: true,  // KEY DIFFERENCE
  slot1_start: "2025-11-29 01:30:00+00:00",
  slot1_end: "2025-11-29 05:30:00+00:00",
  slot2_start: null,
  slot2_end: null,
  slot3_start: null,
  slot3_end: null,
  window_start: "2025-11-29 01:30:00+00:00",
  window_end: "2025-11-29 05:30:00+00:00",
  next_start_raw: "2025-11-29 01:30:00+00:00",
  slot1_start_raw: "2025-11-29 01:30:00+00:00",
  slot1_end_raw: "2025-11-29 05:30:00+00:00",
  slot2_start_raw: null,
  slot2_end_raw: null,
  slot3_start_raw: null,
  slot3_end_raw: null,
  window_start_raw: "2025-11-29 01:30:00+00:00",
  window_end_raw: "2025-11-29 05:30:00+00:00"
};

/**
 * Expected payload with no slots
 */
const expectedPayloadNoSlots = {
  next_start: null,
  total_energy: 0,
  next_kwh: "0",
  next_source: "unknown",
  confirmed_limit: 80,
  confirmed_time: "08:00",
  pending_limit: 80,
  pending_time: "08:00",
  charging_now: false,
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

// ============================================================================
// 6. HELPER FUNCTIONS FOR TESTS
// ============================================================================

/**
 * Create a mock axios instance for testing
 * @param {Array} responses - Array of mock responses in order
 * @returns {Object} Mock axios with post method
 */
function createMockAxios(responses) {
  let callCount = 0;
  return {
    post: jest.fn(() => {
      const response = responses[callCount] || responses[responses.length - 1];
      callCount++;
      return Promise.resolve(response);
    })
  };
}

/**
 * Create a mock MQTT broker for testing
 * @returns {Object} Mock broker with publish/subscribe methods
 */
function createMockBroker() {
  const published = [];
  return {
    client: {
      publish: jest.fn((topic, payload, options) => {
        published.push({ topic, payload, options });
      }),
      subscribe: jest.fn()
    },
    register: jest.fn(),
    subscribe: jest.fn(),
    getPublished: () => published
  };
}

/**
 * Create a mock Node-RED node
 * @returns {Object} Mock node with all required methods
 */
function createMockNode() {
  const sent = [];
  const errors = [];
  const warnings = [];
  const logs = [];
  const statuses = [];

  return {
    status: jest.fn((status) => statuses.push(status)),
    send: jest.fn((msg) => sent.push(msg)),
    error: jest.fn((error) => errors.push(error)),
    warn: jest.fn((warning) => warnings.push(warning)),
    log: jest.fn((log) => logs.push(log)),
    on: jest.fn(),
    getSent: () => sent,
    getErrors: () => errors,
    getWarnings: () => warnings,
    getLogs: () => logs,
    getStatuses: () => statuses
  };
}

/**
 * Generate mock data with an active slot (currently charging)
 * Slot: NOW - 30 minutes to NOW + 3.5 hours
 * This ensures the test always has an active slot regardless of when it runs
 * @returns {Object} Mock API response with active slot
 */
function generateMockDataWithActiveSlot() {
  const now = new Date();
  const startTime = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
  const endTime = new Date(now.getTime() + 3.5 * 60 * 60 * 1000); // 3.5 hrs from now

  return {
    status: 200,
    data: {
      data: {
        flexPlannedDispatches: [
          {
            start: startTime.toISOString().replace('T', ' ').replace('Z', '+00:00'),
            end: endTime.toISOString().replace('T', ' ').replace('Z', '+00:00'),
            energyAddedKwh: 15.5,
            type: "SMART"
          }
        ],
        devices: [{
          id: 'test-device',
          deviceType: 'ELECTRIC_VEHICLES',
          preferences: {
            schedules: [
              { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
              { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
              { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
              { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
              { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
              { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
              { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
            ]
          }
        }]
      }
    }
  };
}

/**
 * Generate mock data with future slot only (not currently charging)
 * Slot: NOW + 2 hours to NOW + 6 hours
 * @returns {Object} Mock API response with future slot
 */
function generateMockDataWithFutureSlot() {
  const now = new Date();
  const startTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hrs from now
  const endTime = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hrs from now

  return {
    status: 200,
    data: {
      data: {
        flexPlannedDispatches: [
          {
            start: startTime.toISOString().replace('T', ' ').replace('Z', '+00:00'),
            end: endTime.toISOString().replace('T', ' ').replace('Z', '+00:00'),
            energyAddedKwh: 15.5,
            type: "SMART"
          }
        ],
        devices: [{
          id: 'test-device',
          deviceType: 'ELECTRIC_VEHICLES',
          preferences: {
            schedules: [
              { dayOfWeek: 'MONDAY',    time: '08:00:00', max: 80 },
              { dayOfWeek: 'TUESDAY',   time: '08:00:00', max: 80 },
              { dayOfWeek: 'WEDNESDAY', time: '08:00:00', max: 80 },
              { dayOfWeek: 'THURSDAY',  time: '08:00:00', max: 80 },
              { dayOfWeek: 'FRIDAY',    time: '08:00:00', max: 80 },
              { dayOfWeek: 'SATURDAY',  time: '08:00:00', max: 80 },
              { dayOfWeek: 'SUNDAY',    time: '08:00:00', max: 80 },
            ]
          }
        }]
      }
    }
  };
}

// ============================================================================
// V2 CATEGORY MOCK RESPONSES
// ============================================================================

// Mirrors a live response: one import + one export agreement (Agile Outgoing — no unitRate).
const mockElectricityRatesResponse = {
    status: 200,
    data: {
        data: {
            account: {
                electricityAgreements: [
                    {
                        validFrom: '2024-10-01T00:00:00Z',
                        validTo: null,
                        tariff: {
                            productCode: 'INTELLI-VAR-22-10-14',
                            standingCharge: 53.37,
                            unitRate: 24.50
                        }
                    },
                    {
                        validFrom: '2024-09-01T00:00:00Z',
                        validTo: null,
                        tariff: {
                            productCode: 'AGILE-OUTGOING-19-05-13',
                            standingCharge: 0
                        }
                    }
                ]
            }
        }
    }
};

// Mirrors live shape: one import meter point + one export meter point, each
// with its own consumption value.
const mockElectricityConsumptionResponse = {
    status: 200,
    data: {
        data: {
            account: {
                properties: [{
                    electricityMeterPoints: [
                        {
                            mpan: '1610000000001',
                            meters: [{
                                consumption: {
                                    edges: [{
                                        node: {
                                            startAt: '2026-04-26T23:00:00Z',
                                            endAt: '2026-04-27T23:00:00Z',
                                            value: 12.5,
                                            unit: 'kWh'
                                        }
                                    }]
                                }
                            }]
                        },
                        {
                            mpan: '1650000000002',
                            meters: [{
                                consumption: {
                                    edges: [{
                                        node: {
                                            startAt: '2026-04-26T23:00:00Z',
                                            endAt: '2026-04-27T23:00:00Z',
                                            value: 4.2,
                                            unit: 'kWh'
                                        }
                                    }]
                                }
                            }]
                        }
                    ]
                }]
            }
        }
    }
};

const mockGasRatesResponse = {
    status: 200,
    data: {
        data: {
            account: {
                gasAgreements: [{
                    validFrom: '2024-10-01T00:00:00Z',
                    validTo: null,
                    tariff: {
                        productCode: 'VAR-22-11-01',
                        standingCharge: 29.50,
                        unitRate: 6.24
                    }
                }]
            }
        }
    }
};

const mockGasConsumptionResponse = {
    status: 200,
    data: {
        data: {
            account: {
                properties: [{
                    gasMeterPoints: [{
                        meters: [{
                            consumption: {
                                edges: [{
                                    node: {
                                        startAt: '2026-04-26T23:00:00Z',
                                        endAt: '2026-04-27T23:00:00Z',
                                        value: '8.3'
                                    }
                                }]
                            }
                        }]
                    }]
                }]
            }
        }
    }
};

// Mirrors live response from api.backend.octopus.energy 2026-05-11
const mockWheelOfFortuneResponse = {
    status: 200,
    data: {
        data: {
            electricity: { spinsAllowed: 2 },
            gas: { spinsAllowed: 0 }
        }
    }
};

const mockHomeMiniResponse = {
    status: 200,
    data: {
        data: {
            account: {
                properties: [{
                    electricityMeterPoints: [{
                        currentConsumption: {
                            demand: 1.24,
                            startAt: '2026-04-27T10:00:00Z'
                        },
                        currentAccumulativeConsumption: {
                            startAt: '2026-04-27T00:00:00Z',
                            endAt: '2026-04-27T10:00:00Z',
                            usage: 8.7
                        },
                        currentAccumulativeConsumptionCost: {
                            startAt: '2026-04-27T00:00:00Z',
                            endAt: '2026-04-27T10:00:00Z',
                            cost: 213.15,
                            offPeakCost: 85.50,
                            standardCost: 127.65
                        }
                    }]
                }]
            }
        }
    }
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Auth responses
  mockAuthSuccess,
  mockAuthFailure,

  // Data query responses
  mockDataWithSlots,
  mockDataWithActiveSlot,
  mockDataNoSlots,
  mockDataWithThreeSlots,
  mockDataWithPastSlots,

  // Real API response test data (based on user's actual data)
  mockRealApiResponse_1Slot_Active,
  mockRealApiResponse_1Slot_Future,
  mockRealApiResponse_3Slots_FirstActive,
  mockRealApiResponse_3Slots_MiddleActive,
  mockRealApiResponse_3Slots_LastActive,
  mockRealApiResponse_3Slots_NoneActive,
  mockRealApiResponse_6Slots_FirstActive,
  mockRealApiResponse_6Slots_ThirdActive,
  mockRealApiResponse_6Slots_LastActive,
  mockRealApiResponse_6Slots_NoneActive,

  // Mutation responses
  mockMutationSuccess,
  mockMutationFailure,

  // Error responses
  mockNetworkTimeout,
  mockInvalidAccount,
  mockRateLimitError,

  // Expected payloads
  expectedPayloadTwoSlots,
  expectedPayloadActiveSlot,
  expectedPayloadNoSlots,

  // V2 Category mock responses
  mockElectricityRatesResponse,
  mockElectricityConsumptionResponse,
  mockGasRatesResponse,
  mockGasConsumptionResponse,
  mockWheelOfFortuneResponse,
  mockHomeMiniResponse,

  // Helper functions
  createMockAxios,
  createMockBroker,
  createMockNode,
  generateMockDataWithActiveSlot,
  generateMockDataWithFutureSlot
};
