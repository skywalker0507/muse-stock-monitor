import { describe, expect, test } from "bun:test";
import { compatiblePreviousClose, validatedHistory, validatedQuote } from "../server/src/market-evidence";

const asOf = "2026-11-27T14:45:00Z";
const now = Date.parse(asOf);
const quote = { resolved: { matched: "exact" }, instrument: { symbol: "GOOG", currency: "USD", price: 108, change_percent: -10, as_of: asOf } };

describe("market evidence", () => {
  test("both quote and history reject alternate share class even if the tool reports a result", () => {
    const raw = { ...quote, resolved: { matched: "best", symbol: "GOOGL" }, instrument: {
      ...quote.instrument, symbol: "GOOGL", history: { points: [{ date: "2026-11-25", close: 120 }] },
    }};
    expect(validatedQuote(raw, "GOOG", now)).toBeNull();
    expect(validatedHistory(raw, "GOOG", "2026-11-25", () => true)).toBeNull();
    expect(validatedQuote({ ...quote, resolved: { matched: "exact", symbol: "GOOGL" } }, "GOOG", now)).toBeNull();
  });

  test("require USD and verify time before accepting quotes", () => {
    expect(validatedQuote(quote, "GOOG", now)?.observedAt).toBe(now);
    expect(validatedQuote(quote, "GOOG", now - 61_000)).toBeNull();
    expect(validatedQuote({ ...quote, instrument: { ...quote.instrument, as_of: "2026-11-27" } }, "GOOG", now)).toBeNull();
    expect(validatedQuote({ ...quote, instrument: { ...quote.instrument, currency: "CAD" } }, "GOOG", now)).toBeNull();
  });

  test("only accept completed sessions with an unambiguous close", () => {
    const raw = { ...quote, instrument: { ...quote.instrument, history: { points: [
      { date: "2026-11-27", close: 150 },
      { date: "2026-11-26", close: 140 },
      { date: "2026-11-25", close: 120, high: 121, low: 119 },
      { date: "2026-11-24", close: 100 },
      { date: "2026-11-24", close: 111 },
      { date: "2026-11-23", close: 110, high: 109, low: 114 },
    ] } }};
    const bars = validatedHistory(raw, "GOOG", "2026-11-26", (date) => date !== "2026-11-26");
    expect(bars?.points).toEqual([
      { date: "2026-11-23", close: 110, high: null, low: null },
      { date: "2026-11-25", close: 120, high: 121, low: 119 },
    ]);
  });

  test("do not compare a price and previous close with inconsistent split bases", () => {
    const accepted = validatedQuote(quote, "GOOG", now)!;
    expect(compatiblePreviousClose(accepted, 120)).toBe(true);
    expect(compatiblePreviousClose(accepted, 216)).toBe(false);
    expect(compatiblePreviousClose(accepted, null)).toBe(false);
    expect(compatiblePreviousClose({ ...accepted, change_percent: null }, 120)).toBe(false);
  });
});
