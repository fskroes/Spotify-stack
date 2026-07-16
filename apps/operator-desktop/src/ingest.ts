/**
 * Ingestion at the operator's edge — the two refresh envelopes (`/api/ledger`,
 * `/api/inflight`) turned from wire bytes into trusted records, with the
 * operator's tolerance policy layered over the contract's record schemas.
 *
 * The contract parses an envelope all-or-nothing; the operator wants more give
 * on the parts that are lists of independent records. So the split here is:
 *  - the envelope's own container fields (an object, a `generatedAt` stamp) are
 *    required — a broken container is a loud WireParseError carrying the
 *    endpoint and field path, which the UI renders as a banner over the
 *    last-good data.
 *  - the record arrays (ledger entries, live runs, the co-sign map) are read
 *    per element: a record that fails its schema is dropped and counted, never
 *    fatal. One corrupt entry must not blank the whole queue, and `unreadable`
 *    lets the UI own up to the gap.
 *
 * Record shapes stay the contract's — this module declares no schemas, it only
 * decides how much of a bad envelope is still worth showing.
 */
import {
  Endpoints,
  InflightRecordSchema,
  InflightResponseSchema,
  LedgerEntrySchema,
  LedgerResponseSchema,
  parseWire,
  PrLiveStateSchema,
  safeParseWire,
  type InflightRecord,
  type LedgerEntry,
  type PrLiveState,
  type WireResult,
} from "@fleet/contract";

// The container schemas: each refresh envelope minus the record collections the
// operator reads per element. The contract still owns the container's own
// fields (an object with a `generatedAt` stamp) — a broken container is its
// WireParseError, endpoint and field path attached — while the record arrays
// are pulled from the raw body and read one at a time below.
const LedgerEnvelopeSchema = LedgerResponseSchema.omit({ entries: true, cosigns: true });
const InflightEnvelopeSchema = InflightResponseSchema.omit({ runs: true });

/** A ledger read whose bad entries were skipped rather than fatal. */
export interface LedgerIngest {
  generatedAt: string;
  entries: LedgerEntry[];
  /** Live PR co-sign state keyed by PR URL. Absent = the serve is offline (no
   *  --cosign polling), distinct from an empty map ("nothing is merged"). */
  cosigns?: Record<string, PrLiveState>;
  /** How many entries or co-sign values could not be read this refresh. */
  unreadable: number;
}

/** A live-runs read whose unreadable records were skipped rather than fatal. */
export interface InflightIngest {
  runs: InflightRecord[];
  unreadable: number;
}

/** Keep every record the schema accepts; count the rest. A non-array field
 *  degrades to an empty list — the missing records are the failure, not a throw. */
function tolerantRecords<T>(
  items: unknown,
  parse: (value: unknown) => WireResult<T>,
): { values: T[]; unreadable: number } {
  if (!Array.isArray(items)) return { values: [], unreadable: 0 };
  const values: T[] = [];
  let unreadable = 0;
  for (const item of items) {
    const result = parse(item);
    if (result.ok) values.push(result.value);
    else unreadable += 1;
  }
  return { values, unreadable };
}

/** Read the co-sign map per key: a bad value drops out, the good ones stay.
 *  Undefined (serve offline) is preserved; any non-object collapses to empty. */
function tolerantCosigns(raw: unknown): { cosigns: Record<string, PrLiveState> | undefined; unreadable: number } {
  if (raw === undefined) return { cosigns: undefined, unreadable: 0 };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { cosigns: {}, unreadable: 0 };
  const cosigns: Record<string, PrLiveState> = {};
  let unreadable = 0;
  for (const [key, value] of Object.entries(raw)) {
    const result = safeParseWire(PrLiveStateSchema, value);
    if (result.ok) cosigns[key] = result.value;
    else unreadable += 1;
  }
  return { cosigns, unreadable };
}

export function ingestLedger(raw: unknown): LedgerIngest {
  // Container validated by the contract; a bad envelope throws here. `raw` is
  // proven an object by that parse, so its record fields are read directly.
  const { generatedAt } = parseWire(LedgerEnvelopeSchema, raw, { endpoint: Endpoints.ledger.name });
  const obj = raw as Record<string, unknown>;
  const entries = tolerantRecords(obj.entries, (value) => safeParseWire(LedgerEntrySchema, value));
  const cosigns = tolerantCosigns(obj.cosigns);
  return {
    generatedAt,
    entries: entries.values,
    cosigns: cosigns.cosigns,
    unreadable: entries.unreadable + cosigns.unreadable,
  };
}

export function ingestInflight(raw: unknown): InflightIngest {
  parseWire(InflightEnvelopeSchema, raw, { endpoint: Endpoints.inflight.name });
  const obj = raw as Record<string, unknown>;
  const runs = tolerantRecords(obj.runs, (value) => safeParseWire(InflightRecordSchema, value));
  return { runs: runs.values, unreadable: runs.unreadable };
}
