import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isSideCapReached,
    isMarketFullyPaused,
    limitFillWouldExceedCap,
} from "../trading/limits";

test("unlimited mode: maxPerSide 0 never caps", () => {
    assert.equal(isSideCapReached(0, "up", 100, 0), false);
    assert.equal(isMarketFullyPaused(0, 50, 50), false);
    assert.equal(limitFillWouldExceedCap(0, "YES", 999, 0), false);
});

test("capped: side reached", () => {
    assert.equal(isSideCapReached(5, "up", 5, 0), true);
    assert.equal(isSideCapReached(5, "up", 4, 0), false);
    assert.equal(isSideCapReached(5, "down", 0, 5), true);
});

test("capped: both sides pause market", () => {
    assert.equal(isMarketFullyPaused(3, 3, 3), true);
    assert.equal(isMarketFullyPaused(3, 3, 2), false);
});

test("limit leg mapping", () => {
    assert.equal(limitFillWouldExceedCap(2, "YES", 2, 0), true);
    assert.equal(limitFillWouldExceedCap(2, "NO", 0, 2), true);
    assert.equal(limitFillWouldExceedCap(2, "YES", 1, 0), false);
});
