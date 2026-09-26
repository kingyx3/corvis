import { Icon, type IconName } from "./icon";

export function SidebarNavItem({ label, icon, badge, active = false, onSelect }: { label: string; icon: IconName; badge?: number; active?: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} aria-label={label} onClick={onSelect}>
      <Icon name={icon}/><span>{label}</span>{badge ? <b>{badge}</b> : null}
    </button>
  );
}
