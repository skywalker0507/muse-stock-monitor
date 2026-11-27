import { z } from "@hatch/space-sdk";

const number = z.number().nullish().catch(null);
const positive = z.number().positive().nullish().catch(null);
const string = z.string().nullish().catch(null);
const day = z.iso.date();

const tickerEnvelope = z.object({
  resolved: z.object({ matched: z.literal("exact"), symbol: z.string().nullish() }),
  instrument: z.object({ symbol: z.string(), currency: z.literal("USD") }).passthrough(),
});
const quoteFields = z.object({
  price: z.number().positive(),
  as_of: z.iso.datetime({ offset: true }),
  name: string,
  change: number,
  change_percent: number,
  high: positive,
  low: positive,
  market_cap: positive,
  beta: number,
  market_status: string,
  url: string,
});
const dailyPoint = z.object({ date: day, close: z.number().positive(), high: positive, low: positive });
const historyFields = z.object({ name: string, history: z.object({ points: z.array(z.unknown()).max(1000) }) });

function matchedInstrument(input: unknown, symbol: string) {
  const response = tickerEnvelope.safeParse(input);
  if (!response.success) return null;
  const { instrument, resolved } = response.data;
  if (instrument.symbol.toUpperCase() !== symbol || (resolved.symbol && resolved.symbol.toUpperCase() !== symbol)) return null;
  return instrument;
}

export function validatedQuote(input: unknown, symbol: string, now: number) {
  const accepted = quoteFields.safeParse(matchedInstrument(input, symbol));
  if (!accepted.success) return null;
  const observedAt = Date.parse(accepted.data.as_of);
  if (!Number.isFinite(observedAt) || observedAt > now + 60_000) return null;
  return { ...accepted.data, observedAt };
}

export function validatedHistory(input: unknown, symbol: string, lastClosedDay: string, isTradingDay: (date: string) => boolean) {
  const accepted = historyFields.safeParse(matchedInstrument(input, symbol));
  if (!accepted.success) return null;
  const byDate = new Map<string, { date: string; close: number; high: number | null; low: number | null }>();
  const conflictingDays = new Set<string>();
  for (const raw of accepted.data.history.points) {
    const parsed = dailyPoint.safeParse(raw);
    if (!parsed.success) continue;
    const { date, close, high, low } = parsed.data;
    if (date > lastClosedDay || !isTradingDay(date) || conflictingDays.has(date)) continue;
    const checked = { date, close, high: high != null && high >= close ? high : null, low: low != null && low <= close ? low : null };
    const previous = byDate.get(date);
    if (previous && (previous.close !== checked.close || previous.high !== checked.high || previous.low !== checked.low)) {
      conflictingDays.add(date);
      byDate.delete(date);
      continue;
    }
    byDate.set(date, checked);
  }
  return { points: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function compatiblePreviousClose(quote: NonNullable<ReturnType<typeof validatedQuote>>, close: number | null) {
  if (close == null || close <= 0 || quote.change_percent == null) return false;
  // The feed does not declare its split basis. Require agreement with the feed's own reported change before combining series.
  return Math.abs((quote.price / close - 1) * 100 - quote.change_percent) <= 0.5;
}

export function secureSourceUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}
