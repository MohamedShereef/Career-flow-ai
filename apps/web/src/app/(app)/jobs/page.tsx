import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Jobs" };

export default async function Jobs() {
  await requireUser();
  return (
    <>
      <PageHeader title="Jobs" subtitle="Matched opportunities with scores and the reasons behind each decision." />
      <EmptyState
        title="Job discovery isn't switched on yet"
        action={<Link href="/profile?tab=preferences" className="btn-secondary">Set target titles & locations</Link>}
      >
        The discovery and AI matching engine ships in the next release. Until then this page stays empty rather than showing sample jobs.
        Set your target titles and locations now so the first run is accurate.
      </EmptyState>
    </>
  );
}
