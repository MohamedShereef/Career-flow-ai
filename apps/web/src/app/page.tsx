import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

export default async function Root() {
  redirect((await getCurrentUser()) ? "/home" : "/login");
}
