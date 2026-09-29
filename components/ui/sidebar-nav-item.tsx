import { useId } from "react";
import { Icon, type IconName } from "./icon";

export function SidebarNavItem({ label, icon, badge, active = false, onSelect }: { label: string; icon: IconName; badge?: number; active?: boolean; onSelect: () => void }) {
  const descriptionId = useId();
  // The accessible name stays the plain label; the count is exposed as the accessible description
  // (a sibling element, so the button's own text stays just label + visual badge) instead of being
  // hidden by the aria-label.
  return (
    <>
      <button type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} aria-label={label} aria-describedby={badge ? descriptionId : undefined} onClick={onSelect}>
        <Icon name={icon}/><span>{label}</span>{badge ? <b aria-hidden="true">{badge}</b> : null}
      </button>
      {badge ? <span id={descriptionId} className="visually-hidden">{badge} {badge === 1 ? "item needs" : "items need"} attention</span> : null}
    </>
  );
}
