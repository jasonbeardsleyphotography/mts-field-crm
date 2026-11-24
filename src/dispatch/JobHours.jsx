import { fmtH, useHoursUnit } from "./hours";

/* A job's hours, split: tree work (pruning, removals…) first and biggest,
   then stump grinding, stump cleanup and soil & seed in small print.
   Hours are on-site hours from the workbook, shown in the viewer's unit. */

const r1 = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString();

export function hoursParts(j) {
  const parts = [];
  if (j.grindHrs > 0) parts.push({ k: "grind", label: "stump grind", text: fmtH(j.grindHrs) });
  if (j.cleanupHrs > 0) parts.push({ k: "cleanup", label: "stump cleanup", text: fmtH(j.cleanupHrs) });
  else if (j.cleanupQty > 0) parts.push({ k: "cleanup", label: "stump cleanup", text: `×${r1(j.cleanupQty)}` });
  if (j.seedHrs > 0) parts.push({ k: "seed", label: "soil & seed", text: fmtH(j.seedHrs) });
  else if (j.seedQty > 0) parts.push({ k: "seed", label: "soil & seed", text: j.seedUnit ? `${r1(j.seedQty)} ${j.seedUnit}` : `×${r1(j.seedQty)}` });
  return parts;
}

const PART_COLOR = { grind: "#c9a0dc", cleanup: "#a8b4bf", seed: "#9fcf7a" };

export default function JobHours({ j, size = 16, align = "right" }) {
  useHoursUnit();
  const parts = hoursParts(j);
  return (
    <div style={{ textAlign: align, lineHeight: 1.15, whiteSpace: "nowrap" }}>
      <div className="mono" style={{ fontSize: size, color: "#E7E2D6" }} title="Tree work (without stump grinding, cleanup, soil & seed)">
        {fmtH(j.treeHrs ?? j.hrs)}
      </div>
      {parts.map((p) => (
        <div key={p.k} className="mono" style={{ fontSize: 10.5, color: PART_COLOR[p.k] }}>+ {p.text} {p.label}</div>
      ))}
    </div>
  );
}
