import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentUser()) redirect("/home");
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">C</div>
          <div className="text-lg font-semibold">CareerFlow AI</div>
          <div className="text-sm text-muted">Your job-application agent</div>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}
