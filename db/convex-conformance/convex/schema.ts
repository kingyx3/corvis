import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  states: defineTable({
    key: v.string(),
    version: v.number(),
  }).index("by_key", ["key"]),
  events: defineTable({
    key: v.string(),
    kind: v.string(),
  }).index("by_key", ["key"]),
});
