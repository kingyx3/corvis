import type { ReactNode } from "react";

export type PageHeadingProps = {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  variant?: "page" | "hero";
  className?: string;
  id?: string;
};

/** Shared top-level heading treatment for customer workspace surfaces. */
export function PageHeading({ eyebrow, title, description, actions, children, variant = "page", className = "", id }: PageHeadingProps) {
  const base = variant === "hero" ? "hero-row" : "page-heading";
  return (
    <section className={`${base}${className ? ` ${className}` : ""}`} id={id}>
      <div>
        {eyebrow != null && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description != null && <p className="lede">{description}</p>}
        {children}
      </div>
      {actions != null && <div className="heading-actions">{actions}</div>}
    </section>
  );
}
