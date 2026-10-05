import { DEFAULT_DISPLAY, formatDisplayDate, formatDisplayValue, type DisplayPreferences } from "../core/display-preferences.ts";
// Browser-only presentation state. Server formatting always receives explicit preferences.
let current: DisplayPreferences = DEFAULT_DISPLAY;
export function setDisplayPreferences(preferences: DisplayPreferences): void { if (typeof window !== "undefined") current = preferences; }
export function displayNumberFormatter(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat { return new Intl.NumberFormat(current.numberFormat, options); }
export function displayDate(value: string | Date, options: Intl.DateTimeFormatOptions = {}): string { return formatDisplayDate(value, current, options); }
export function displayValue(value: string | number): string { return formatDisplayValue(value, current); }
