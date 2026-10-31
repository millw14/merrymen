import { notFound } from "next/navigation";
import { perpsOffered } from "@/lib/perps-enabled";

export const dynamic = "force-dynamic";
export default function PerpsRoute() {
  if (!perpsOffered()) notFound();
  return null;
}
