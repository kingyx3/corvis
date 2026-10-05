export type TableDensity = "compact" | "comfortable";

export function TableDensityToggle({ value, onChange, label = "Table density" }: { value: TableDensity; onChange: (value: TableDensity) => void; label?: string }) {
  return (
    <fieldset className="table-density-toggle">
      <legend className="visually-hidden">{label}</legend>
      {(["compact", "comfortable"] as const).map((density) => (
        <button type="button" key={density} aria-pressed={value === density} onClick={() => onChange(density)}>
          {density === "compact" ? "Compact" : "Comfortable"}
        </button>
      ))}
    </fieldset>
  );
}
