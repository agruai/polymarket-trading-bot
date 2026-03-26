import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assertMarketIntervalMinutes,
    isMinuteAtIntervalBoundary,
    msUntilNextIntervalBoundary,
    msUntilSlotEnd,
    slugForCryptoUpdown,
    slotStartUnixSeconds,
} from "../utils/marketInterval";

test("assertMarketIntervalMinutes accepts 5 and 15 only", () => {
    assert.equal(assertMarketIntervalMinutes(5), 5);
    assert.equal(assertMarketIntervalMinutes(15), 15);
    assert.throws(() => assertMarketIntervalMinutes(10), /Invalid market interval/);
});

test("5m: slot start aligns to 5-minute marks (local clock)", () => {
    const d = new Date(2026, 2, 23, 14, 7, 30, 0);
    const start = slotStartUnixSeconds(5, d);
    const rounded = new Date(start * 1000);
    assert.equal(rounded.getMinutes() % 5, 0);
    assert.equal(rounded.getSeconds(), 0);
});

test("isMinuteAtIntervalBoundary for 5m", () => {
    assert.equal(isMinuteAtIntervalBoundary(0, 5), true);
    assert.equal(isMinuteAtIntervalBoundary(5, 5), true);
    assert.equal(isMinuteAtIntervalBoundary(7, 5), false);
});

test("slug uses interval in path segment", () => {
    const s = slugForCryptoUpdown("btc", 5);
    assert.match(s, /^btc-updown-5m-\d+$/);
});

test("msUntilNextIntervalBoundary is non-negative", () => {
    assert.ok(msUntilNextIntervalBoundary(5) >= 0);
    assert.ok(msUntilNextIntervalBoundary(15) >= 0);
});

test("msUntilSlotEnd returns correct remaining ms", () => {
    const d = new Date(2026, 2, 23, 14, 7, 30, 0); // 14:07:30 → slot 14:05, ends 14:10
    const ms = msUntilSlotEnd(5, d);
    // 14:10:00 - 14:07:30 = 150 seconds = 150_000 ms
    assert.equal(ms, 150_000);
});

test("msUntilSlotEnd at boundary returns full interval", () => {
    const d = new Date(2026, 2, 23, 14, 5, 0, 0); // exactly 14:05:00
    const ms = msUntilSlotEnd(5, d);
    assert.equal(ms, 5 * 60 * 1000); // full 5 minutes
});

test("msUntilSlotEnd is always non-negative and <= interval", () => {
    const ms5 = msUntilSlotEnd(5);
    assert.ok(ms5 >= 0);
    assert.ok(ms5 <= 5 * 60 * 1000);
    const ms15 = msUntilSlotEnd(15);
    assert.ok(ms15 >= 0);
    assert.ok(ms15 <= 15 * 60 * 1000);
});
