# Test Report — {{DATE}} {{TIME}}

**Run type:** scheduled (06:00) / scheduled (18:00) / manual
**Dev server:** localhost:{{PORT}} — reachable: yes/no
**Tested against commit:** {{git short SHA}}
**Features in scope (new/changed since last report):** {{list}}

---

## Summary

Passed: {{n}} / Failed: {{n}} ({{n}} critical, {{n}} high, {{n}} medium, {{n}} low)

---

## Regression Suite Results

| Area | Test | Steps | Expected | Actual | Result |
|---|---|---|---|---|---|
| Auth | Login with valid credentials | 1. Go to /login 2. Enter creds 3. Submit | Redirect to dashboard | ... | Pass/Fail |

---

## New Failures

### [SEVERITY] Short bug title
- **Steps to reproduce:** 1. ... 2. ... 3. ...
- **Expected:** ...
- **Actual:** ...
- **Screenshot:** reports/screenshots/...
- **Suspected area:** file/module if known

---

## Notes for Developer Agent

Anything ambiguous, anything that might be a spec question rather than a bug, anything flaky.
