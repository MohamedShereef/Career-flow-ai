import { documents } from "@careerflow/core";
import { deleteDocumentAction, setPrimaryCvAction, uploadDocumentAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, Select, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";

const KIND: Record<string, string> = { cv_original: "CV", certificate: "Certificate", supporting: "Supporting" };

export async function DocumentsTab({ userId }: { userId: string }) {
  const docs = await documents.listDocuments(db(), userId, ["cv_original", "certificate", "supporting"]);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        {docs.length === 0 ? (
          <EmptyState title="No documents yet">Upload your main CV. Tailored versions are generated from it and your verified profile — the original is never edited.</EmptyState>
        ) : (
          <div className="card divide-y divide-line">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <a href={`/api/documents/${d.id}`} target="_blank" className="block truncate text-sm font-medium text-brand-700 hover:underline">{d.label || d.filename}</a>
                  <div className="text-xs text-muted">{KIND[d.kind]} · {(d.sizeBytes / 1024).toFixed(0)} KB · {fmtDate(d.createdAt)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {d.isPrimary ? (
                    <Badge tone="brand">Main CV</Badge>
                  ) : (
                    d.kind === "cv_original" && (
                      <form action={setPrimaryCvAction}><input type="hidden" name="id" value={d.id} /><button className="btn-ghost text-xs">Make main</button></form>
                    )
                  )}
                  <form action={deleteDocumentAction}><input type="hidden" name="id" value={d.id} /><button className="btn-danger text-xs">Delete</button></form>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="lg:col-span-2">
        <Card title="Upload" description="PDF or Word (.docx), up to 10 MB. Stored privately; only you can download.">
          <ActionForm action={uploadDocumentAction} className="space-y-3" resetOnSuccess>
            <input type="file" name="file" required accept=".pdf,.docx,.png,.jpg,.jpeg" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700" />
            <Select label="Type" name="kind" options={[["cv_original", "CV"], ["certificate", "Certificate"], ["supporting", "Supporting document"]]} />
            <Field label="Label (optional)" name="label" placeholder="Main CV – 2026" />
            <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
