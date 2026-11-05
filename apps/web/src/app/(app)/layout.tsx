import { answers } from "@careerflow/core";
import { logoutAction } from "@/actions/auth";
import { Nav } from "@/components/nav";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const open = await answers.openQuestionCount(db(), user.id);
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
      <aside className="border-b border-line bg-white px-4 py-4 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="mb-6 hidden items-center gap-2 px-2 md:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">C</div>
          <div className="font-semibold">CareerFlow AI</div>
        </div>
        <Nav badges={{ "/profile": open }} />
        <div className="mt-6 hidden border-t border-line pt-4 md:block">
          <div className="truncate px-2 text-sm font-medium">{user.displayName ?? user.email}</div>
          <div className="truncate px-2 text-xs text-muted">{user.email}</div>
          <form action={logoutAction} className="mt-2">
            <button className="btn-ghost">Sign out</button>
          </form>
          <div className="mt-3 px-2 text-[11px] text-muted">Version {process.env.APP_VERSION ?? "dev"}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
