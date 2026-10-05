import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Reference semantics Corvis database adapters must preserve. The Postgres
// counterpart lives in db/postgres/tests/convex-parity.mjs and asserts the same
// invariants against Corvis's NativePostgresSqlApi; keep the two in step.

export const reset = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    for (const table of ["states", "events", "counters"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_key", (q) => q.eq("key", key))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    await ctx.db.insert("states", { key, version: 0 });
    await ctx.db.insert("counters", { key, value: 0 });
  },
});

export const compareAndSet = mutation({
  args: {
    key: v.string(),
    expected: v.number(),
    next: v.number(),
  },
  handler: async (ctx, { key, expected, next }) => {
    const state = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!state) throw new Error(`missing state: ${key}`);
    if (state.version !== expected) return false;

    await ctx.db.patch(state._id, { version: next });
    await ctx.db.insert("events", { key, kind: `version:${next}` });
    return true;
  },
});

// Read-modify-write with no explicit lock. Serializable isolation (optimistic
// concurrency control + automatic retry) must make N concurrent calls end at N:
// a lost update here means the backend is not serializing conflicting writers.
export const increment = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!counter) throw new Error(`missing counter: ${key}`);
    await ctx.db.patch(counter._id, { value: counter.value + 1 });
    return counter.value + 1;
  },
});

// Insert, then throw. The event must not remain visible.
export const writeThenFail = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    await ctx.db.insert("events", { key, kind: "must-roll-back" });
    throw new Error("intentional conformance rollback");
  },
});

// Update an existing row and insert a new one, then throw. Neither the update
// nor the insert may remain visible (rollback covers patches, not just inserts).
export const patchThenFail = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const state = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!state) throw new Error(`missing state: ${key}`);
    await ctx.db.patch(state._id, { version: 999 });
    await ctx.db.insert("events", { key, kind: "must-roll-back" });
    throw new Error("intentional conformance rollback");
  },
});

export const summary = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const state = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const events = await ctx.db
      .query("events")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    return { version: state?.version ?? -1, events: events.length };
  },
});

export const counterValue = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    return counter?.value ?? -1;
  },
});
