import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, description, children, actions, className = "" }: { title?: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, name, hint, ...rest }: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input name={name} className="input" {...rest} />
      {hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

export function TextArea({ label, name, hint, ...rest }: { label: string; name: string; hint?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <textarea name={name} className="input min-h-24" {...rest} />
      {hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

export function Select({ label, name, options, hint, ...rest }: { label: string; name: string; options: Array<[string, string]>; hint?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select name={name} className="input" {...rest}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {hint && <span className="hint block">{hint}</span>}
    </label>
  );
}

const tones = {
  neutral: "bg-slate-100 text-slate-700",
  brand: "bg-brand-50 text-brand-700",
  good: "bg-good-50 text-good",
  attention: "bg-attention-50 text-attention",
  bad: "bg-bad-50 text-bad",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Stat({ label, value, tone = "neutral", href, hint }: { label: string; value: ReactNode; tone?: keyof typeof tones; href?: string; hint?: string }) {
  const body = (
    <div className="card h-full p-4 transition hover:border-slate-300">
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-2 text-3xl font-semibold tabular-nums ${tone === "neutral" ? "" : tones[tone].split(" ")[1]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
  return href ? <a href={href}>{body}</a> : body;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white/60 px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Riyadh" }).format(date);
}

export function fmtMonth(d: string | null | undefined) {
  if (!d) return "Present";
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(new Date(d));
}
