import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const reset = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const existingStates = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    for (const row of existingStates) await ctx.db.delete(row._id);

    const existingEvents = await ctx.db
      .query("events")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    for (const row of existingEvents) await ctx.db.delete(row._id);

    await ctx.db.insert("states", { key, version: 0 });
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

export const writeThenFail = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
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
    return `${state?.version ?? -1}:${events.length}`;
  },
});

export const eventCount = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    return events.length;
  },
});
