# Debugging Guide

## Changes Made

### 1. **Comprehensive Debug Output**
Every message now includes a `debug` object alongside the `payload`:

```javascript
{
  payload: { /* your data */ },
  debug: {
    timestamp: "2025-11-29T10:30:00.000Z",
    step: "complete",  // or "authentication", "fetching_data", "processing", "validation"
    success: true,
    error: null,
    apiCalls: [
      {
        step: 1,
        name: "authentication",
        url: "https://api.octopus.energy/v1/graphql/",
        statusCode: 200,
        hasErrors: false,
        errors: null,
        tokenObtained: true
      },
      {
        step: 2,
        name: "data_query",
        url: "https://api.octopus.energy/v1/graphql/",
        accountNumber: "A-XXXXXXXX",
        statusCode: 200,
        hasErrors: false,
        errors: null,
        hasData: true,
        slotsFound: 3,
        preferencesFound: true
      }
    ]
  }
}
```

### 2. **Fixed Authorization Header**
Changed from `Authorization: token` to `Authorization: Bearer ${token}` (industry standard)

### 3. **Better Error Handling**
- Validates API responses at each step
- Catches GraphQL errors (not just HTTP errors)
- Shows which step failed
- Includes full error details in debug output

## Common Issues & Solutions

### Issue 1: Authentication Failing
**Debug Output:**
```json
{
  "debug": {
    "step": "authentication",
    "success": false,
    "error": {
      "message": "Auth failed: ...",
      "response": { "status": 401, ... }
    }
  }
}
```

**Solutions:**
- Check API key is correct
- Ensure API key has no extra spaces
- Verify API key has Intelligent Octopus permissions

### Issue 2: Data Query Failing
**Debug Output:**
```json
{
  "debug": {
    "step": "fetching_data",
    "apiCalls": [
      { "step": 1, "tokenObtained": true },
      {
        "step": 2,
        "hasErrors": true,
        "errors": [{"message": "Account not found"}]
      }
    ]
  }
}
```

**Solutions:**
- Check account number format (should be like `A-XXXXXXXX`)
- Verify account has Intelligent Octopus tariff
- Ensure account number has no extra spaces

### Issue 3: No Charging Slots
**Debug Output:**
```json
{
  "debug": {
    "success": true,
    "apiCalls": [
      { "slotsFound": 0, "preferencesFound": true }
    ]
  },
  "payload": {
    "next_start": null,
    "confirmed_limit": 80,
    "confirmed_time": "08:00"
  }
}
```

**This is NORMAL if:**
- Vehicle not plugged in
- No charging scheduled yet
- Outside charging window

### Issue 4: Missing Configuration
**Debug Output:**
```json
{
  "debug": {
    "step": "validation",
    "error": "Missing configuration: apiKey or account number not provided"
  }
}
```

**Solution:**
- Edit the node and ensure both API Key and Account Number are filled in

## How to Test

1. **Deploy your changes** in Node-RED
2. **Trigger the node** (inject timestamp)
3. **Add a Debug node** connected to the output
4. **Check `msg.debug`** in the debug panel

### Example Test Flow

```
[Inject] --> [Octopus Intelligent] --> [Debug (msg.debug)]
                                   \
                                    --> [Debug (msg.payload)]
```

## Node Status Indicators

- **Yellow ring "Authenticating..."** - Getting token
- **Yellow ring "Fetching data..."** - Querying API
- **Green dot "Limit: X% | Time: XX:XX"** - Success
- **Red ring "Error: [step]"** - Failed at specific step
- **Red ring "Config Missing"** - Missing API key or account

## Next Steps

If you're still seeing defaults after this update:
1. Check the `msg.debug.error` object for details
2. Check the `msg.debug.apiCalls` array to see which step failed
3. Look at Node-RED debug logs for full error messages
4. Verify your working manual flow uses the same account number format
