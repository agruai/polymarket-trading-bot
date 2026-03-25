import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assertMarketIntervalMinutes,
    isMinuteAtIntervalBoundary,
    msUntilNextIntervalBoundary,
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
